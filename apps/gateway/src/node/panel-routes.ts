/**
 * The web side panel on the node: workspace files, Git, session memory /
 * background tasks / team state, and interactive terminals.
 *
 * Terminal REST routes live on the router; the live terminal stream is not
 * a route (the node has no WebSocket listener) but `TerminalStreams`, which
 * the node runtime drives for streams the daemon relays. Creating, typing
 * into or closing a terminal requires the session's control lease (the
 * same authority as prompting the agent).
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadAgentConfig } from '../agent/config.js';
import { memoryConfigFrom } from '../agent/features/memory/index.js';
import { memoryPanel } from '../agent/features/memory/panel.js';
import { readSessionBranch, SESSION_FILE } from '../agent/session-store.js';
import type { NodeConfig } from '../config.js';
import type { ModelStore } from '../models.js';
import type { GatewayDatabase, SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import { parse } from '../util.js';
import {
  gitDiff,
  gitLog,
  gitShow,
  gitStatus,
  listDirectory,
  readWorkspaceFile,
} from './inspect.js';
import type { RunnerManager } from './runner.js';
import { TerminalManager } from './terminals.js';

const flag = z
  .enum(['1', '0', 'true', 'false'])
  .optional()
  .transform((value) => value === '1' || value === 'true');
const leaseBody = z.object({
  clientId: z.string().min(1).max(200),
  generation: z.number().int().positive(),
});

/** Environment secrets the node holds that a user shell has no business seeing. */
const SECRET_ENV = /^(PIRC_NODE_TOKENS?|PIRC_.*SECRET.*)$/;

/**
 * Session branches keyed by file size + mtime: the panel polls after every
 * turn, and session files only grow, so an unchanged stat means unchanged content.
 */
class BranchCache {
  private readonly entries = new Map<
    string,
    { size: number; mtimeMs: number; branch: ReturnType<typeof readSessionBranch> }
  >();
  read(dir: string) {
    let stat: { size: number; mtimeMs: number };
    try {
      stat = statSync(path.join(dir, SESSION_FILE));
    } catch {
      return [];
    }
    const cached = this.entries.get(dir);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs)
      return cached.branch;
    const branch = readSessionBranch(dir);
    this.entries.delete(dir);
    this.entries.set(dir, { size: stat.size, mtimeMs: stat.mtimeMs, branch });
    // Small LRU: a handful of sessions are viewed at a time.
    if (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!);
    return branch;
  }
}

export interface PanelContext {
  config: NodeConfig;
  db: GatewayDatabase;
  runners: RunnerManager;
  models: ModelStore;
  claim(request: FastifyRequest, sessionId?: string): SessionRow;
}

/** A frame sent to the browser's terminal socket. */
export type TerminalFrame =
  | { type: 'ready'; terminal: unknown; replay: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number | null }
  | { type: 'error'; code: string; message: string };

export interface TerminalConnection {
  /** Browser → terminal message (input/resize), checked against the lease per message. */
  input(message: unknown): void;
  detach(): void;
}

export interface TerminalStreams {
  /**
   * Attach to a terminal for `user`. Anyone who may view the session may
   * watch; input and resize require the control lease. Throws ApiError
   * when the session or terminal is not available.
   */
  open(
    target: { user: string; sessionId: string; terminalId: string },
    send: (frame: TerminalFrame) => void,
    close: (code: number, reason: string) => void,
  ): TerminalConnection;
}

export function registerPanelRoutes(
  app: FastifyInstance,
  ctx: PanelContext,
): { terminals: TerminalManager; terminalStreams: TerminalStreams } {
  const { config, db, runners, models, claim } = ctx;
  const branchCache = new BranchCache();
  const terminals = new TerminalManager(
    () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV.test(key))),
    config.terminalShell,
  );

  const local = <T>(
    handler: (
      local: { session: SessionRow; root: string },
      request: FastifyRequest,
    ) => T | Promise<T>,
  ) =>
    async function (request: FastifyRequest) {
      const session = claim(request);
      return handler(
        { session, root: db.getWorkspace(session.workspaceId).canonicalPath },
        request,
      );
    };

  app.get(
    '/api/sessions/:id/git/status',
    local(({ root }) => gitStatus(root)),
  );
  app.get(
    '/api/sessions/:id/git/diff',
    local(({ root }, request) => {
      const query = parse(
        z.object({ path: z.string().max(4096).optional(), staged: flag, untracked: flag }),
        request.query,
      );
      return gitDiff(root, query);
    }),
  );
  app.get(
    '/api/sessions/:id/git/log',
    local(({ root }, request) => {
      const query = parse(
        z.object({
          skip: z.coerce.number().int().min(0).max(1_000_000).default(0),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        request.query,
      );
      return gitLog(root, query);
    }),
  );
  app.get(
    '/api/sessions/:id/git/commits/:sha',
    local(({ root }, request) =>
      gitShow(root, parse(z.object({ sha: z.string().min(4).max(64) }), request.params).sha),
    ),
  );
  app.get(
    '/api/sessions/:id/files',
    local(({ root }, request) =>
      listDirectory(
        root,
        parse(z.object({ path: z.string().max(4096).default('') }), request.query).path,
      ),
    ),
  );
  app.get(
    '/api/sessions/:id/files/content',
    local(({ root }, request) =>
      readWorkspaceFile(
        root,
        parse(z.object({ path: z.string().min(1).max(4096) }), request.query).path,
      ),
    ),
  );

  /**
   * Memory (from the session file, so it works while the agent is stopped),
   * plus live feature state (background tasks, team) when the agent runs.
   */
  app.get(
    '/api/sessions/:id/panel/state',
    local(async ({ session, root }) => {
      const runner = runners.get(session.id);
      let live: Record<string, unknown> = {};
      let contextWindow: number | undefined;
      if (runner?.alive) {
        const [panel, state] = await Promise.allSettled([
          runner.request({ type: 'get_panel_state' }),
          runner.request({ type: 'get_state' }),
        ]);
        if (panel.status === 'fulfilled' && panel.value.success && panel.value.data)
          live = panel.value.data;
        if (state.status === 'fulfilled' && state.value.success)
          contextWindow = state.value.data?.model?.contextWindow;
      }
      let features: Record<string, unknown> = {};
      const branch = branchCache.read(session.privateSessionPath);
      try {
        const config = loadAgentConfig(root, models.current);
        features = config.features;
        // Stopped agent: the session's current model decides a ratio-mode threshold.
        if (contextWindow === undefined) {
          const change = branch.findLast((entry) => entry.type === 'model_change');
          const ref =
            change?.type === 'model_change'
              ? { provider: change.provider, id: change.modelId }
              : config.defaultModel;
          contextWindow = ref
            ? config.providers[ref.provider]?.models.find((model) => model.id === ref.id)
                ?.contextWindow
            : undefined;
        }
      } catch {
        /* invalid config: fall back to defaults */
      }
      let memory: ReturnType<typeof memoryPanel> | null = null;
      try {
        memory = memoryPanel(branch, memoryConfigFrom(features), contextWindow);
      } catch (error) {
        app.log.warn({ error }, 'memory panel unavailable');
      }
      return {
        agentRunning: Boolean(runner?.alive),
        memory,
        memoryRuntime: live.memoryRuntime ?? null,
        backgroundTasks: live.backgroundTasks ?? [],
        team: live.team ?? { agents: [] },
      };
    }),
  );
  app.get(
    '/api/sessions/:id/panel/background/:taskId',
    local(async ({ session }, request) => {
      const { taskId } = parse(z.object({ taskId: z.string().min(1).max(100) }), request.params);
      const { lines } = parse(
        z.object({ lines: z.coerce.number().int().min(1).max(2000).default(400) }),
        request.query,
      );
      const runner = runners.get(session.id);
      if (!runner?.alive) throw new ApiError(409, 'runner_unavailable', 'The agent is not running');
      const response = await runner.request({ type: 'background_output', taskId, lines });
      if (!response.success)
        throw new ApiError(404, 'not_found', response.error ?? 'Background task not found');
      return response.data;
    }),
  );
  /** Stopping a background task needs the control lease, like prompting the agent. */
  app.post('/api/sessions/:id/panel/background/:taskId/stop', async (request) => {
    const session = claim(request);
    const { taskId } = parse(
      z.object({ id: z.string(), taskId: z.string().min(1).max(100) }),
      request.params,
    );
    const body = parse(leaseBody, request.body);
    db.validateLease(session.id, body.clientId, body.generation);
    const runner = runners.get(session.id);
    if (!runner?.alive) throw new ApiError(409, 'runner_unavailable', 'The agent is not running');
    const response = await runner.request({ type: 'background_stop', taskId });
    if (!response.success)
      throw new ApiError(404, 'not_found', response.error ?? 'Background task not found');
    return response.data;
  });

  // ---- terminals ----------------------------------------------------------

  const terminalsEnabled = () => {
    if (!config.terminalsEnabled)
      throw new ApiError(403, 'forbidden', 'Terminals are disabled on this node');
  };
  const terminalSession = (request: FastifyRequest) => {
    terminalsEnabled();
    return claim(request);
  };

  app.get('/api/sessions/:id/terminals', async (request) => ({
    terminals: terminals.list(terminalSession(request).id),
  }));
  app.post('/api/sessions/:id/terminals', async (request, reply) => {
    const session = terminalSession(request);
    const body = parse(
      leaseBody.extend({
        cols: z.number().int().optional(),
        rows: z.number().int().optional(),
      }),
      request.body,
    );
    db.validateLease(session.id, body.clientId, body.generation);
    const workspace = db.getWorkspace(session.workspaceId);
    const terminal = terminals.create(session.id, workspace.canonicalPath, {
      cols: body.cols ?? 80,
      rows: body.rows ?? 24,
    });
    return reply.status(201).send({ terminal });
  });
  app.post('/api/sessions/:id/terminals/:terminalId/close', async (request, reply) => {
    const session = terminalSession(request);
    const { terminalId } = parse(z.object({ terminalId: z.string().min(1) }), request.params);
    const body = parse(leaseBody, request.body);
    db.validateLease(session.id, body.clientId, body.generation);
    terminals.close(session.id, terminalId);
    return reply.status(204).send();
  });

  const terminalStreams: TerminalStreams = {
    open({ user, sessionId, terminalId }, send, close) {
      terminalsEnabled();
      if (!config.allowedUsers.has(user))
        throw new ApiError(403, 'forbidden', 'User is not allowed on this node');
      const session = db.claimSession(sessionId, user);
      const attached = terminals.attach(session.id, terminalId, (event) => {
        send(event);
        if (event.type === 'exit') close(1000, 'terminal exited');
      });
      send({ type: 'ready', terminal: attached.info, replay: attached.replay });
      if (attached.info.exited) send({ type: 'exit', exitCode: attached.info.exitCode });
      return {
        input(raw) {
          const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          try {
            db.validateLease(
              session.id,
              String(message.clientId ?? ''),
              Number(message.generation),
            );
          } catch {
            send({ type: 'error', code: 'lost_control', message: 'Take control to type here' });
            return;
          }
          try {
            if (message.type === 'input' && typeof message.data === 'string')
              terminals.input(session.id, terminalId, message.data);
            else if (message.type === 'resize')
              terminals.resize(session.id, terminalId, Number(message.cols), Number(message.rows));
          } catch (error) {
            send({ type: 'error', code: 'not_found', message: (error as Error).message });
          }
        },
        detach: attached.detach,
      };
    },
  };

  return { terminals, terminalStreams };
}
