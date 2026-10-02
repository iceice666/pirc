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
import {
  accessSync,
  constants,
  closeSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readContext, type ContextSnapshot } from '../agent/context.js';
import { loadAgentConfig } from '../agent/config.js';
import { memoryConfigFrom } from '../agent/features/memory/index.js';
import { memoryPanel } from '../agent/features/memory/panel.js';
import type { NodeConfig } from '../config.js';
import type { ModelStore } from '../models.js';
import type { GatewayDatabase, SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import { RECORDING_CHUNK_BYTES } from '../protocol.js';
import { parse } from '../util.js';
import {
  gitDiff,
  gitLog,
  gitShow,
  gitStatus,
  listDirectory,
  readWorkspaceFile,
} from './inspect.js';
import type { BranchCache } from './branch-cache.js';
import { sessionRoot } from './chat.js';
import type { RunnerManager } from './runner.js';
import { withoutSecrets } from './secrets.js';
import { TerminalManager } from './terminals.js';
import type { BrowserFrame, BrowserManager } from './browser.js';

const flag = z
  .enum(['1', '0', 'true', 'false'])
  .optional()
  .transform((value) => value === '1' || value === 'true');
const leaseBody = z.object({
  clientId: z.string().min(1).max(200),
  generation: z.number().int().positive(),
});

export interface PanelContext {
  config: NodeConfig;
  db: GatewayDatabase;
  runners: RunnerManager;
  models: ModelStore;
  /** Shared with the snapshot route. */
  branches: BranchCache;
  browser: BrowserManager;
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

export interface BrowserStreams {
  /**
   * Watch a session's browser. Anyone who may view the session may watch and
   * page through the action log; everything else (take over, input, record)
   * requires the control lease.
   */
  open(
    target: { user: string; sessionId: string },
    send: (frame: BrowserFrame) => void,
  ): TerminalConnection;
}

const RECORDING_PATH = /^\.pirc\/recordings\/[A-Za-z0-9_.-]{1,200}\.webm$/;

export function registerPanelRoutes(
  app: FastifyInstance,
  ctx: PanelContext,
): {
  terminals: TerminalManager;
  terminalStreams: TerminalStreams;
  browserStreams: BrowserStreams;
} {
  const { config, db, runners, models, branches: branchCache, browser, claim } = ctx;
  const terminals = new TerminalManager(() => withoutSecrets(process.env), config.terminalShell);

  const local = <T>(
    handler: (
      local: { session: SessionRow; root: string },
      request: FastifyRequest,
    ) => T | Promise<T>,
  ) =>
    async function (request: FastifyRequest) {
      const session = claim(request);
      return handler(
        { session, root: sessionRoot(db.getWorkspace(session.workspaceId), session.id) },
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
    '/api/sessions/:id/panel/context',
    local(async ({ session, root }) => {
      const runner = runners.get(session.id);
      let snapshot: ContextSnapshot | null = null;
      let live = false;
      if (runner?.alive) {
        try {
          const response = await runner.request({
            type: 'get_context',
            maxBytes: Math.max(0, config.rpcMaxLineBytes - 1024),
          });
          if (response.success && response.data) {
            snapshot = response.data as ContextSnapshot;
            live = true;
          }
        } catch {
          /* A stopped or older agent can still have a disk snapshot. */
        }
      }
      snapshot ??= readContext(session.privateSessionPath);
      if (!snapshot)
        throw new ApiError(404, 'no_context', 'Send a message first to inspect its context');
      const sections = snapshot.sections.map((section) => {
        if (!path.isAbsolute(section.source)) return section;
        try {
          const canonicalRoot = realpathSync(root);
          const file = realpathSync(section.source);
          const relative = path.relative(canonicalRoot, file);
          if (
            relative === '..' ||
            relative.startsWith('..' + path.sep) ||
            path.isAbsolute(relative)
          )
            return section;
          if (!statSync(file).isFile()) return section;
          accessSync(file, constants.R_OK);
          return { ...section, filePath: relative };
        } catch {
          return section;
        }
      });
      return {
        snapshot: { ...snapshot, sections },
        agentRunning: !!runner?.alive,
        source: live ? 'live' : 'snapshot',
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
    const terminal = terminals.create(session.id, sessionRoot(workspace, session.id), {
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

  // ---- browser -------------------------------------------------------------------

  /** A chunk of a browser recording (`.pirc/recordings/*.webm`), base64 in JSON. */
  app.get(
    '/api/sessions/:id/browser/recording',
    local(({ root }, request) => {
      const query = parse(
        z.object({
          path: z.string().regex(RECORDING_PATH),
          offset: z.coerce.number().int().min(0).default(0),
          length: z.coerce
            .number()
            .int()
            .min(1)
            .max(RECORDING_CHUNK_BYTES)
            .default(RECORDING_CHUNK_BYTES),
        }),
        request.query,
      );
      return readRecordingChunk(root, query.path, query.offset, query.length);
    }),
  );

  const browserStreams: BrowserStreams = {
    open({ user, sessionId }, send) {
      if (!browser.enabled)
        throw new ApiError(403, 'forbidden', 'The browser is not available on this node');
      if (!config.allowedUsers.has(user))
        throw new ApiError(403, 'forbidden', 'User is not allowed on this node');
      const session = db.claimSession(sessionId, user);
      const workspace = db.getWorkspace(session.workspaceId);
      const target = {
        sessionId: session.id,
        workspaceId: workspace.id,
        root: sessionRoot(workspace, session.id),
      };
      const detach = browser.attach(session.id, send);
      let open = true;
      return {
        input(raw) {
          const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          if (message.type !== 'log_image')
            try {
              db.validateLease(
                session.id,
                String(message.clientId ?? ''),
                Number(message.generation),
              );
            } catch {
              send({
                type: 'error',
                code: 'lost_control',
                message: 'Take control of the session to use the browser',
              });
              return;
            }
          void browser.input(target, message).then(
            (frame) => {
              if (frame && open) send(frame);
            },
            (error: unknown) => {
              if (open)
                send({
                  type: 'error',
                  code: error instanceof ApiError ? error.code : 'browser_error',
                  message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
                });
            },
          );
        },
        detach() {
          open = false;
          detach();
        },
      };
    },
  };

  return { terminals, terminalStreams, browserStreams };
}

function readRecordingChunk(root: string, relative: string, offset: number, length: number) {
  const file = path.join(root, relative);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(file);
  } catch {
    throw new ApiError(404, 'not_found', 'Recording not found');
  }
  if (!stat.isFile()) throw new ApiError(404, 'not_found', 'Recording not found');
  const size = stat.size;
  const start = Math.min(offset, size);
  const buffer = Buffer.alloc(Math.min(length, size - start));
  const fd = openSync(file, 'r');
  try {
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!n) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  return { size, offset: start, mimeType: 'video/webm', dataBase64: buffer.toString('base64') };
}
