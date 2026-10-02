/**
 * The node's local router. It never listens on a port: the node runtime
 * replays daemon requests on it with `app.inject`, so every request carries
 * the browser user the daemon authenticated. Sessions are owned by the user
 * who created them, and every session route checks that owner.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { NodeConfig } from '../config.js';
import { GatewayDatabase } from '../database.js';
import { ApiError } from '../errors.js';
import { EventHub } from '../events.js';
import { registerErrorHandler, registerImageParsers } from '../http.js';
import { ModelStore, defaultConfigDir } from '../models.js';
import { inspectAssistantPrompt, writeAssistantPrompt } from '../assistant-prompts.js';
import { NODE_USER_HEADER } from '../protocol.js';
import { applySessionName, publicSession } from '../session-name.js';
import type { CommandPayload, Snapshot } from '../types.js';
import { id, parse, payloadHash } from '../util.js';
import {
  loadAgentConfig,
  parseTrustHash,
  projectTrustEmpty,
  projectTrustFields,
  projectTrustHash,
  readProjectConfig,
  sessionSettings,
} from '../agent/config.js';
import { recall } from '../agent/features/memory/index.js';
import { WorkspaceLedger, recallFromWorkspace } from '../agent/features/memory/workspace.js';
import { historyOf } from '../agent/session-store.js';
import { offlineGateway, type AgentGateway } from './agent-gateway.js';
import { BranchCache } from './branch-cache.js';
import {
  chatWorkspaceDir,
  ensureTopLevelChats,
  INSTRUCTIONS_MAX_CHARS,
  readProjectInstructions,
  sessionRoot,
  writeProjectInstructions,
} from './chat.js';
import { WriteBroker } from './write-broker.js';
import { registerPanelRoutes, type BrowserStreams, type TerminalStreams } from './panel-routes.js';
import { RunnerManager } from './runner.js';
import { NodeSandbox } from './sandbox.js';
import { SENSITIVE_HOME_PATHS, isInside, realResolve } from '../sandbox-policy.js';
import type { TerminalManager } from './terminals.js';
import { BrowserManager } from './browser.js';
import { loadRoles, roleBriefs } from '../agent/roles.js';

const sessionParams = z.object({ id: z.string().min(1) });
const createWorkspaceBody = z.union([
  // A chat project: the node picks and hides its directory.
  z.object({ kind: z.literal('chat'), displayName: z.string().trim().min(1).max(200) }),
  z.object({
    kind: z.literal('directory').optional(),
    path: z.string().trim().min(1).max(4096),
    displayName: z.string().trim().min(1).max(200),
  }),
]);
const interactionParams = z.object({ id: z.string().min(1), interactionId: z.string().min(1) });
const uploadQuery = z.object({ filename: z.string().trim().min(1).max(255).optional() });
/** Sessions are never named at creation: the agent titles them; rename later with PATCH. */
const createSessionBody = z.object({ workspaceId: z.string().min(1) });
const renameBody = z.object({ name: z.string().trim().min(1).max(200) });
const leaseBody = z.object({
  clientId: z.string().min(1).max(200),
  generation: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
});
const heldLeaseBody = leaseBody.extend({ generation: z.number().int().positive() });
const commandPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['prompt', 'steer', 'follow_up']),
    message: z.string().min(1).max(1_000_000),
    uploadIds: z.array(z.string().min(1)).max(16).optional(),
  }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('clear_queue') }),
  z.object({
    type: z.literal('send_now'),
    queue: z.enum(['steering', 'followUp']),
    index: z.number().int().nonnegative(),
    message: z.string().min(1).max(1_000_000),
  }),
  z.object({
    type: z.literal('set_model'),
    provider: z.string().min(1),
    modelId: z.string().min(1),
  }),
  z.object({
    type: z.literal('set_thinking'),
    level: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  }),
]);
const commandBody = z.object({
  commandId: z.string().min(1).max(200),
  clientId: z.string().min(1),
  generation: z.number().int().positive(),
  payload: commandPayload,
});
const workspaceRecallBody = z
  .object({
    ledgerKey: z.string().regex(/^[0-9a-f]{16}$/),
    id: z.string().regex(/^[a-f0-9]{12}$/),
  })
  .strict();
/** What the gateway may push into a session (see the deliver route). */
const deliverBody = z
  .object({
    customType: z.enum(['assistant-delegation', 'assistant-delegation-update', 'scheduled-run']),
    content: z.string().min(1).max(100_000),
    details: z.record(z.unknown()).optional(),
    /** Start the new session in this role (a delegation's); before model and thinking. */
    role: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .optional(),
    /** Run it on this model (the user's choice); the session keeps it. */
    model: z
      .object({ provider: z.string().min(1), id: z.string().min(1) })
      .strict()
      .optional(),
    thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  })
  .strict();
const answerBody = z.object({
  clientId: z.string().min(1),
  generation: z.number().int().positive(),
  answer: z.union([
    z.object({ cancelled: z.literal(true) }),
    z.object({ value: z.string(), values: z.array(z.string()).max(64).optional() }),
    z.object({ confirmed: z.boolean() }),
  ]),
});

function sniffImage(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii')))
    return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export interface NodeServices {
  db: GatewayDatabase;
  events: EventHub;
  runners: RunnerManager;
  writes: WriteBroker;
  /** Providers from the daemon, used for agents started from now on. */
  models: ModelStore;
  terminals: TerminalManager;
  terminalStreams: TerminalStreams;
  browser: BrowserManager;
  browserStreams: BrowserStreams;
}

export async function buildNodeApp(
  config: NodeConfig,
  /** The daemon link agents reach the gateway through; offline without one. */
  options: { gateway?: AgentGateway } = {},
): Promise<{ app: FastifyInstance; services: NodeServices }> {
  const app = Fastify({ logger: true, bodyLimit: config.uploadMaxBytes });
  registerImageParsers(app, config.uploadMaxBytes);
  if (config.chat && config.workspaces.length)
    throw new Error(
      'The chat node (pirc-chat) hosts chat workspaces only; PIRC_WORKSPACES must be empty',
    );
  const db = new GatewayDatabase(config.databasePath);
  // Role is fixed even across restarts: do not silently expose another role's
  // persisted workspaces when an operator points the wrong executable at state.
  const expectedKind = config.chat ? 'chat' : 'directory';
  if (db.listWorkspaces().some((workspace) => workspace.kind !== expectedKind)) {
    db.close();
    throw new Error(
      `State contains workspaces incompatible with pirc-${config.chat ? 'chat' : 'node'}; use the matching executable or a separate state directory`,
    );
  }
  db.syncWorkspaces(config.nodeId, config.workspaces);
  if (config.chat) ensureTopLevelChats(config, db);
  const recovery = db.recoverStartup();
  app.log.info({ recovery }, 'node startup recovery complete');
  const events = new EventHub(config.eventBufferSize);
  const writes = new WriteBroker();
  // Filled by the daemon on registration; agents started before that get no providers.
  const models = new ModelStore();
  const browser = new BrowserManager(config.browser);
  // Mandatory: say at startup whether agents can start at all.
  const sandbox = new NodeSandbox(config);
  void sandbox
    .check()
    .then((status) =>
      status.active
        ? app.log.info({ srt: status.srt }, 'agent sandbox ready')
        : app.log.error(`agent sandbox unavailable, no agent can start: ${status.reason}`),
    );
  const runners = new RunnerManager(
    config,
    db,
    events,
    writes,
    models,
    options.gateway ?? offlineGateway,
    browser,
    sandbox,
  );
  const branches = new BranchCache();
  const claim = (request: FastifyRequest, sessionId = parse(sessionParams, request.params).id) =>
    db.claimSession(sessionId, request.identity!.user);

  registerErrorHandler(app);
  app.addHook('onRequest', async (request) => {
    const user = request.headers[NODE_USER_HEADER];
    if (typeof user !== 'string' || !config.allowedUsers.has(user))
      throw new ApiError(403, 'forbidden', 'User is not allowed on this node');
    request.identity = { user };
  });

  app.post('/api/workspaces', async (request, reply) => {
    const body = parse(createWorkspaceBody, request.body);
    if (body.kind === 'chat') {
      if (!config.chat)
        throw new ApiError(403, 'forbidden', 'This node does not host chats (pirc-chat)');
      const workspaceId = id('workspace').replaceAll('-', '_');
      const workspace = db.addWorkspace(
        workspaceId,
        config.nodeId,
        body.displayName,
        chatWorkspaceDir(config, workspaceId),
        'chat',
      );
      return reply.status(201).send({ workspace });
    }
    if (config.chat)
      throw new ApiError(403, 'forbidden', 'The chat node hosts chat workspaces only (pirc-chat)');
    const home = realpathSync(process.env.HOME ?? os.homedir());
    const requested = body.path.startsWith('~/') ? path.join(home, body.path.slice(2)) : body.path;
    if (!path.isAbsolute(requested))
      throw new ApiError(400, 'invalid_input', 'Workspace must use an absolute path or ~/path');
    let canonical: string;
    try {
      canonical = realpathSync(requested);
      if (!statSync(canonical).isDirectory())
        throw new ApiError(400, 'invalid_input', 'Workspace path must be a directory');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'invalid_input', 'Workspace directory must already exist');
    }
    if (!canonical.startsWith(`${home}${path.sep}`))
      throw new ApiError(403, 'forbidden', 'Workspace must stay within the node home directory');
    // A workspace is writable from its sessions' sandboxes: it must not hold
    // (or sit inside) the node's own state or a credential store.
    const off = [
      config.stateDir,
      config.sessionsDir,
      config.uploadsDir,
      path.dirname(config.databasePath),
      config.browser.profilesDir,
      config.workspaceMemoryDir,
      ...SENSITIVE_HOME_PATHS.map((item) => path.join(home, item)),
    ].map((item) => realResolve(item));
    const clash = off.find((item) => isInside(item, canonical) || isInside(canonical, item));
    if (clash)
      throw new ApiError(
        403,
        'forbidden',
        `Workspace must not contain or sit inside ${clash} (pirc's state or a credential store)`,
      );
    const workspace = db.addWorkspace(
      id('workspace').replaceAll('-', '_'),
      config.nodeId,
      body.displayName,
      canonical,
    );
    // Its roles, as registration reports them (node/runtime.ts), for delegations.
    let roles: ReturnType<typeof roleBriefs> | undefined;
    try {
      roles = roleBriefs(loadRoles(canonical));
    } catch (error) {
      request.log.warn(`roles of ${canonical}: ${(error as Error).message}`);
    }
    return reply.status(201).send({ workspace: { ...workspace, ...(roles ? { roles } : {}) } });
  });

  if (config.chat) {
    const promptDir = defaultConfigDir();
    app.get('/api/assistant/prompts', async () => ({
      soul: inspectAssistantPrompt(promptDir, 'soul'),
      chat: inspectAssistantPrompt(promptDir, 'chat'),
    }));
    app.put('/api/assistant/prompts/:name', async (request) => {
      const { name } = parse(z.object({ name: z.enum(['soul', 'chat']) }), request.params);
      const { text } = parse(z.object({ text: z.string() }).strict(), request.body);
      return { prompt: writeAssistantPrompt(promptDir, name, text) };
    });
  }

  /** A chat project's instructions (node/chat.ts); only the web edits them, through the gateway. */
  const chatProject = (request: FastifyRequest) => {
    const { id: workspaceId } = parse(z.object({ id: z.string().min(1) }), request.params);
    const workspace = db.getWorkspace(workspaceId);
    if (workspace.kind !== 'chat')
      throw new ApiError(400, 'invalid_input', 'Only chat projects have instructions');
    return workspace;
  };
  app.get('/api/workspaces/:id/instructions', async (request) => ({
    instructions: {
      text: readProjectInstructions(chatProject(request)),
      maxChars: INSTRUCTIONS_MAX_CHARS,
    },
  }));
  app.patch('/api/workspaces/:id/instructions', async (request) => {
    const workspace = chatProject(request);
    const body = parse(z.object({ text: z.string() }).strict(), request.body);
    return {
      instructions: {
        text: writeProjectInstructions(workspace, body.text),
        maxChars: INSTRUCTIONS_MAX_CHARS,
      },
    };
  });

  /**
   * A directory workspace's project config (`.pirc/config.json`): its hooks,
   * env and allowedPaths reach agents only once the user trusted exactly
   * these values here (agent/config.ts, PIRC_PROJECT_TRUST in runner.ts).
   */
  const directoryWorkspace = (request: FastifyRequest) => {
    const { id: workspaceId } = parse(z.object({ id: z.string().min(1) }), request.params);
    const workspace = db.getWorkspace(workspaceId);
    if (workspace.kind !== 'directory')
      throw new ApiError(400, 'invalid_input', 'Only directory workspaces have a project config');
    return workspace;
  };
  const projectSummary = (workspace: { id: string; canonicalPath: string }) => {
    const trustedHash = db.getWorkspaceTrust(workspace.id);
    try {
      const fields = projectTrustFields(readProjectConfig(workspace.canonicalPath));
      const hash = projectTrustHash(fields);
      return {
        ...fields,
        hash,
        trustedHash,
        trusted: trustedHash === hash,
        empty: projectTrustEmpty(fields),
      };
    } catch (error) {
      return {
        error: (error as Error).message.slice(0, 2000),
        hash: null,
        trustedHash,
        trusted: false,
        empty: true,
      };
    }
  };
  app.get('/api/workspaces/:id/project-config', async (request) => ({
    project: projectSummary(directoryWorkspace(request)),
  }));
  app.post('/api/workspaces/:id/project-trust', async (request) => {
    const workspace = directoryWorkspace(request);
    const body = parse(
      z.union([
        z.object({ trusted: z.literal(true), hash: z.string() }).strict(),
        z.object({ trusted: z.literal(false) }).strict(),
      ]),
      request.body,
    );
    if (!body.trusted) {
      db.setWorkspaceTrust(workspace.id, null, request.identity!.user);
      return { project: projectSummary(workspace) };
    }
    const hash = parseTrustHash(body.hash);
    if (!hash) throw new ApiError(400, 'invalid_input', 'hash must be a sha256 hex digest');
    const current = projectSummary(workspace);
    if ('error' in current)
      throw new ApiError(400, 'invalid_input', `The project config is invalid: ${current.error}`);
    // Trust only what the user reviewed: the config may have changed since.
    if (current.hash !== hash)
      throw new ApiError(
        409,
        'conflict',
        'The project config changed since it was shown; review it again before trusting it',
      );
    db.setWorkspaceTrust(workspace.id, hash, request.identity!.user);
    return { project: projectSummary(workspace) };
  });

  app.post('/api/sessions', async (request, reply) => {
    const body = parse(createSessionBody, request.body);
    const workspace = db.getWorkspace(body.workspaceId);
    const sessionStorage = path.join(config.sessionsDir, id('pi'));
    mkdirSync(sessionStorage, { recursive: true, mode: 0o700 });
    const session = db.createSession(
      workspace.id,
      sessionStorage,
      null,
      null,
      request.identity!.user,
    );
    return reply.status(201).send({ session: publicSession(session) });
  });

  const deletingSessions = new Map<string, Promise<void>>();
  app.delete('/api/sessions/:id', async (request, reply) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    const user = request.identity!.user;
    const deletion = db.sessionDeletion(sessionId);
    if (deletion && deletion.owner_user !== user)
      throw new ApiError(403, 'forbidden', 'Chat belongs to another user');
    if (deletion?.status === 'deleted') return reply.status(204).send();
    const session = db.claimSession(sessionId, user, true);
    const workspace = db.getWorkspace(session.workspaceId);
    if (workspace.kind !== 'chat')
      throw new ApiError(400, 'invalid_input', 'Only chats can be deleted');
    db.beginSessionDeletion(sessionId, user);
    let task = deletingSessions.get(sessionId);
    if (!task) {
      task = (async () => {
        await runners.stopSession(sessionId);
        await terminals.disposeSession(sessionId);
        await browser.closeSession(sessionId);
        // Both paths are allocated by the node, never supplied by the caller.
        if (
          !isInside(session.privateSessionPath, config.sessionsDir) ||
          path.resolve(session.privateSessionPath) === path.resolve(config.sessionsDir)
        )
          throw new Error('Invalid private session path');
        rmSync(session.privateSessionPath, { recursive: true, force: true });
        rmSync(path.join(workspace.canonicalPath, 'sessions', path.basename(sessionId)), {
          recursive: true,
          force: true,
        });
        branches.forget(session.privateSessionPath);
        db.finishSessionDeletion(sessionId);
        events.forget(sessionId);
      })().finally(() => deletingSessions.delete(sessionId));
      deletingSessions.set(sessionId, task);
    }
    await task;
    return reply.status(204).send();
  });

  app.patch('/api/sessions/:id', async (request) => {
    const session = claim(request);
    const { name } = parse(renameBody, request.body);
    const active = runners.get(session.id);
    if (active) {
      const response = await active.request({ type: 'set_session_name', name });
      if (!response.success)
        throw new ApiError(503, 'runner_unavailable', response.error ?? 'Agent rejected the name');
    }
    // Also notifies connected clients; a no-op when the runner's echo already applied it.
    applySessionName(db, events, session.id, session.runnerEpoch, { name, source: 'user' });
    return { session: publicSession(db.getSession(session.id)) };
  });

  app.get('/api/sessions/:id/snapshot', async (request) => {
    const { id: sessionId, privateSessionPath } = claim(request);
    const active = runners.get(sessionId);
    let agent: Snapshot['agent'] = null;
    if (active) {
      try {
        const response = await active.request({ type: 'get_state' });
        if (response.success && response.data)
          agent = {
            model: response.data.model
              ? { provider: response.data.model.provider, id: response.data.model.id }
              : null,
            thinkingLevel: response.data.thinkingLevel ?? null,
          };
      } catch {
        /* model/thinking are advisory */
      }
    }
    // Read after the RPCs: the runner may have started and bumped the epoch meanwhile.
    const session = db.getSession(sessionId);
    // History comes from the session file, not the agent: it is there with no
    // runner at all (stopped, crashed, evicted), and a long transcript never
    // has to fit through one RPC line. The agent writes each message before
    // announcing it, so the file is never behind the watermark taken below.
    const branch = branches.read(privateSessionPath);
    const history = historyOf(branch);
    // No live runner: report the settings the next agent will start with (the
    // session file's, else the default model), so the client does not fall back
    // to another model and overwrite them on the next prompt.
    if (!agent) {
      try {
        const root = sessionRoot(db.getWorkspace(session.workspaceId), sessionId);
        const settings = sessionSettings(branch, loadAgentConfig(root, models.current));
        agent = { model: settings.model, thinkingLevel: settings.thinking };
      } catch {
        /* invalid config: model/thinking are advisory */
      }
    }
    const snapshot: Snapshot = {
      session: publicSession(session),
      history,
      partialMessage: active?.state.partialMessage ?? null,
      queue: active?.state.queue ?? { steering: [], followUp: [] },
      run: db.latestRun(sessionId),
      interactions: db.pendingInteractions(sessionId),
      notifications: active?.state.notifications ?? [],
      widgets: active?.state.widgets ?? {},
      statuses: active?.state.statuses ?? {},
      agent,
      watermark: events.watermark(sessionId, session.runnerEpoch),
      partialOutputLost: session.partialOutputLost,
      sandbox: active?.alive ? active.sandboxStatus : null,
    };
    return snapshot;
  });

  /**
   * The gateway pushes a message into a session: a delegated task, or news of
   * a delegation for the chat that asked (plans/assistant.md). The daemon
   * never relays browser requests here. No control lease is needed or taken:
   * a push must not take a chat away from the user typing in it.
   */
  app.post('/api/sessions/:id/deliver', async (request, reply) => {
    const session = claim(request);
    const body = parse(deliverBody, request.body);
    await runners.deliver(session.id, body);
    return reply.status(202).send({ delivered: true });
  });

  /**
   * The gateway recalls a workspace-memory note the assistant found by search
   * (plans/assistant.md). Only the owner of the session that wrote it may read
   * that session; a forgotten note answers without its content.
   */
  app.post('/api/workspace-memory/recall', async (request) => {
    const { ledgerKey, id } = parse(workspaceRecallBody, request.body);
    const fold = new WorkspaceLedger(config.workspaceMemoryDir, ledgerKey, '').fold();
    const item = fold.items.get(id);
    const owner = item
      ? (
          db.raw
            .prepare('SELECT owner_user FROM sessions WHERE private_session_path=?')
            .get(item.sessionDir) as { owner_user: string | null } | undefined
        )?.owner_user
      : undefined;
    const result =
      item && owner !== request.identity!.user ? undefined : recallFromWorkspace(fold, id, recall);
    if (!result) throw new ApiError(404, 'not_found', `No workspace memory note ${id}`);
    return result;
  });

  app.post('/api/sessions/:id/commands', async (request, reply) => {
    const { id: sessionId } = claim(request);
    const body = parse(commandBody, request.body);
    db.validateLease(sessionId, body.clientId, body.generation);
    const received = db.receiveCommand(
      body.commandId,
      sessionId,
      payloadHash(body.payload),
      body.payload,
    );
    if (received.duplicate) return { command: received.row, duplicate: true };
    try {
      await runners.dispatch(
        sessionId,
        body.commandId,
        body.payload as CommandPayload,
        request.identity!.user,
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      app.log.error({ error, commandId: body.commandId }, 'command dispatch failed');
    }
    const command = db.getCommand(body.commandId);
    return reply
      .status(command.status === 'accepted' ? 202 : 503)
      .send({ command, duplicate: false });
  });

  app.get('/api/sessions/:id/control', async (request) => ({
    lease: db.getLease(claim(request).id),
  }));
  app.post('/api/sessions/:id/control/acquire', async (request) => {
    const { id: sessionId } = claim(request);
    const body = parse(leaseBody, request.body);
    return {
      lease: db.acquireLease(sessionId, body.clientId, body.force ?? false, config.leaseTtlMs),
    };
  });
  app.post('/api/sessions/:id/control/heartbeat', async (request) => {
    const { id: sessionId } = claim(request);
    const body = parse(heldLeaseBody, request.body);
    return {
      lease: db.heartbeatLease(sessionId, body.clientId, body.generation, config.leaseTtlMs),
    };
  });
  app.post('/api/sessions/:id/control/release', async (request, reply) => {
    const { id: sessionId } = claim(request);
    const body = parse(heldLeaseBody, request.body);
    db.releaseLease(sessionId, body.clientId, body.generation);
    return reply.status(204).send();
  });

  app.post('/api/sessions/:id/interactions/:interactionId/answer', async (request) => {
    const params = parse(interactionParams, request.params);
    const session = claim(request, params.id);
    const body = parse(answerBody, request.body);
    db.validateLease(session.id, body.clientId, body.generation);
    const active = runners.get(session.id);
    if (!active || active.epoch !== session.runnerEpoch)
      throw new ApiError(409, 'stale_interaction', 'Interaction belongs to an inactive runner');
    const interaction = db.claimInteraction(
      params.interactionId,
      session.id,
      active.epoch,
      body.answer,
    );
    await runners.answer(session.id, active.epoch, interaction.rpcId, body.answer);
    events.publish(session.id, active.epoch, 'interaction_answered', {
      interactionId: interaction.id,
    });
    return { interactionId: interaction.id, status: 'answered' };
  });

  /** Images and generic files are stored on the node that runs the session's agent. */
  app.post('/api/sessions/:id/uploads', async (request, reply) => {
    claim(request);
    if (!Buffer.isBuffer(request.body))
      throw new ApiError(400, 'invalid_input', 'Upload body must be raw bytes');
    const buffer = request.body;
    if (!buffer.length || buffer.length > config.uploadMaxBytes)
      throw new ApiError(413, 'payload_too_large', 'Upload exceeds configured limit');
    const query = parse(uploadQuery, request.query);
    const sniffed = sniffImage(buffer);
    let mimeType: string;
    let kind: 'image' | 'file';
    let filename: string | null = null;
    if (sniffed) {
      const declared = request.headers['content-type']?.split(';', 1)[0];
      if (declared && declared !== 'application/octet-stream' && declared !== sniffed)
        throw new ApiError(
          400,
          'invalid_input',
          'Declared Content-Type does not match image content',
        );
      mimeType = sniffed;
      kind = 'image';
    } else {
      // Not a recognized image: treat as a generic file the agent can read
      // from the workspace once the prompt is sent.
      if (!query.filename)
        throw new ApiError(400, 'invalid_input', 'filename is required for non-image uploads');
      const cleaned = path.basename(query.filename).trim();
      if (!cleaned) throw new ApiError(400, 'invalid_input', 'filename is invalid');
      filename = cleaned;
      mimeType = request.headers['content-type']?.split(';', 1)[0] || 'application/octet-stream';
      kind = 'file';
    }
    const uploadId = id('upload');
    const storageName = `${randomBytes(24).toString('hex')}.bin`;
    writeFileSync(path.join(config.uploadsDir, storageName), buffer, { mode: 0o600, flag: 'wx' });
    db.createUpload(
      uploadId,
      request.identity!.user,
      mimeType,
      buffer.length,
      storageName,
      createHash('sha256').update(buffer).digest('hex'),
      kind,
      filename,
    );
    return reply
      .status(201)
      .send({ upload: { id: uploadId, mimeType, byteSize: buffer.length, kind, filename } });
  });

  const { terminals, terminalStreams, browserStreams } = registerPanelRoutes(app, {
    config,
    db,
    runners,
    models,
    branches,
    browser,
    claim,
  });

  app.addHook('onClose', async () => {
    terminals.shutdown();
    await runners.shutdown();
    await browser.shutdown();
    db.close();
  });
  return {
    app,
    services: {
      db,
      events,
      runners,
      writes,
      models,
      terminals,
      terminalStreams,
      browser,
      browserStreams,
    },
  };
}
