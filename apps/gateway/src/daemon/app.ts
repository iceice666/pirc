/**
 * `pirc-gateway`: the central daemon. It authenticates browsers (forward
 * auth), indexes sessions and mirrors control leases, buffers each
 * session's events, and routes every session request to the node that owns
 * it. It never runs agents, terminals or workspace inspection itself.
 *
 * Browser-visible IDs are the daemon's; the node's own session and
 * workspace IDs (`piSessionId`, `<nodeId>:<id>`) never leave this process.
 */
import websocket from '@fastify/websocket';
import type WebSocket from 'ws';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DaemonConfig } from '../config.js';
import { GatewayDatabase, workspaceCapabilitiesSchema, type SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import { EventHub } from '../events.js';
import { registerErrorHandler, registerImageParsers } from '../http.js';
import { listModels, loadModelsFile, ModelStore } from '../models.js';
import { Readable } from 'node:stream';
import { NODE_FRAME_MAX_BYTES, RECORDING_CHUNK_BYTES, type NodeHttpRequest } from '../protocol.js';
import { applySessionName, publicSession } from '../session-name.js';
import type { EventCursor, RunStatus } from '../types.js';
import { parse, payloadHash } from '../util.js';
import { authHook, validateRequest } from './auth.js';
import { DeviceTokens, registerDeviceRoutes } from './devices.js';
import { runAgentOp } from './agent-ops.js';
import { Delegations } from './delegations.js';
import { MemoryInteractions } from './memory-interactions.js';
import { MemoryStore } from './memory.js';
import { MemoryRecords } from './memory-records.js';
import { registerMemoryRoutes } from './memory-routes.js';
import { registerPushRoutes } from './push-routes.js';
import { loadVapidKeys, Push, watchInteractions } from './push.js';
import { registerScheduleRoutes } from './schedule-routes.js';
import { Schedules } from './schedules.js';
import { NodeRegistry, validNodeToken } from './nodes.js';
import { limitIncoming, relaySocket, wsCloseCode } from './socket-relay.js';
import { BackendService } from '../backends/service.js';
import { registerBackendRoutes } from '../backends/routes.js';
import { GatewayInference } from '../backends/inference.js';
import { WebSearch } from './web-search.js';

const sessionParams = z.object({ id: z.string().min(1) });
type LiveActivity = { run?: RunStatus | undefined; writeLease?: boolean | undefined };
/** Browsers send nothing on the event socket; anything large is abuse. */
const EVENTS_MESSAGE_MAX_BYTES = 4 * 1024;

/** A node answered with an error; passed through to the client unchanged. */
class NodeReplyError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Node answered ${status}`);
  }
}
const nodeIdField = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const createWorkspaceBody = z.union([
  // A chat project on a chat node, which picks and hides its directory.
  z.object({
    nodeId: nodeIdField,
    kind: z.literal('chat'),
    displayName: z.string().trim().min(1).max(200),
  }),
  z.object({
    nodeId: nodeIdField,
    kind: z.literal('directory').optional(),
    path: z.string().trim().min(1).max(4096),
    displayName: z.string().trim().min(1).max(200),
  }),
]);
const createSessionBody = z.object({ workspaceId: z.string().min(1) });
/** Rename, pin and settle, in any combination. Only a rename reaches the node. */
const updateSessionBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    settled: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });
const leaseBody = z.object({
  clientId: z.string().min(1).max(200),
  generation: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
});
const heldLeaseBody = leaseBody.extend({ generation: z.number().int().positive() });
/** The node validates the payload itself; the daemon needs the ID and lease. */
const commandBody = z
  .object({
    commandId: z.string().min(1).max(200),
    clientId: z.string().min(1),
    generation: z.number().int().positive(),
    payload: z.object({ type: z.string() }).passthrough(),
  })
  .passthrough();
const answerBody = z
  .object({ clientId: z.string().min(1), generation: z.number().int().positive() })
  .passthrough();

/**
 * Session sub-paths relayed verbatim to the owning node (read-only side
 * panel, terminal REST). Anything else under a session is refused.
 */
const RELAYED_GET =
  /^(?:git\/(?:status|diff|log|commits\/[0-9a-fA-F]{4,64})|files(?:\/content)?|panel\/(?:state|context|background\/[^/?]+)|terminals)$/;
const RELAYED_POST = /^(?:terminals(?:\/[^/?]+\/close)?|panel\/background\/[^/?]+\/stop)$/;

function cursorFrom(value: unknown): EventCursor | null {
  if (typeof value !== 'string' || !value) return null;
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) throw new ApiError(400, 'invalid_input', 'cursor must be epoch:sequence');
  return { epoch: Number(match[1]), sequence: Number(match[2]) };
}

export interface DaemonServices {
  db: GatewayDatabase;
  events: EventHub;
  nodes: NodeRegistry;
  models: ModelStore;
  backends: BackendService;
  devices: DeviceTokens;
  /** The assistant's memory, per user (plans/assistant.md). */
  memory: MemoryStore;
  /** Tasks the assistant hands to other workspaces (plans/assistant.md). */
  delegations: Delegations;
  /** Workspace memory mirrored from the nodes, for the assistant's search. */
  records: MemoryRecords;
  /** Scheduled agent runs (docs/history/cron.md). */
  schedules: Schedules;
  /** Push notifications to browsers and phones. */
  push: Push;
  /**
   * Re-read the gateway baseline and publish its secret-free catalog.
   * Subsequent inference calls use current credentials, including live agents.
   */
  reloadModels(): void;
}

export async function buildDaemonApp(
  config: DaemonConfig,
): Promise<{ app: FastifyInstance; services: DaemonServices }> {
  const app = Fastify({ logger: true, bodyLimit: config.uploadMaxBytes });
  await app.register(websocket, { options: { maxPayload: NODE_FRAME_MAX_BYTES } });
  registerImageParsers(app, config.uploadMaxBytes);
  const db = new GatewayDatabase(config.databasePath);
  const recovery = db.recoverStartup();
  app.log.info({ recovery }, 'daemon startup recovery complete');
  if (!config.proxySecret)
    app.log.warn(
      'PIRC_PROXY_SECRET is not set: any process that can reach the gateway port from a trusted ' +
        'proxy address (PIRC_TRUSTED_PROXIES) can claim to be any allowed user. Set it and have ' +
        'the proxy send it as x-pirc-proxy-secret (docs/deploy).',
    );
  const events = new EventHub(config.eventBufferSize);
  const models = new ModelStore();
  // Invalid baseline/state at startup is fatal. Never log raw key-command output.
  const baseline = loadModelsFile(config.modelsFile) ?? { providers: {} };
  const nodes = new NodeRegistry(models);
  let inference: GatewayInference | undefined;
  const backends = new BackendService({
    stateDir: config.stateDir,
    baseline,
    onChange: () => {
      inference?.cancelAll();
      models.set(backends.models);
      nodes.broadcastModels();
    },
  });
  models.set(backends.models);
  inference = new GatewayInference(backends);
  nodes.onInference = (request, signal, onDelta, nodeId) =>
    inference!.run(request, signal, onDelta, nodeId);
  const reloadModels = () => {
    try {
      backends.setBaseline(loadModelsFile(config.modelsFile) ?? { providers: {} });
    } catch {
      app.log.error('models reload failed; keeping the previous providers');
    }
  };
  const devices = new DeviceTokens(db.raw, {
    idleMs: config.deviceTokenIdleMs,
    maxAgeMs: config.deviceTokenMaxAgeMs,
  });
  const memory = new MemoryStore(db.raw, config.memoryBudgets);
  const records = new MemoryRecords(db);
  const webSearch = new WebSearch(config.exaApiKey);
  /** Close a device's WebSocket once its token is revoked or expires. */
  const trackDevice = (
    request: FastifyRequest,
    socket: { close(code: number, reason: string): void },
  ) => {
    const deviceId = request.identity!.deviceId;
    return deviceId
      ? devices.track(deviceId, () => socket.close(4401, 'device token revoked or expired'))
      : () => {};
  };

  /**
   * Browsers refresh their node and workspace lists when a node connects or
   * leaves or a workspace is added. Sent outside the session's sequence (not
   * replayed: a client that reconnects reloads the lists anyway), and only on
   * event sockets that ask for it with `directory=1`, so clients that treat
   * an unknown event as a reset are unaffected.
   */
  const directoryListeners = new Set<() => void>();
  const directoryChanged = () => {
    for (const listener of directoryListeners) listener();
  };
  /** Like directory changes, but per user and opted into with `memory=1`. */
  const memoryListeners = new Map<string, Set<() => void>>();
  const memoryInteractions = new MemoryInteractions(db, memory, events);
  const memoryChanged = (user: string) => {
    memoryInteractions.changed(user);
    for (const listener of memoryListeners.get(user) ?? []) listener();
  };
  const push = new Push({
    db,
    vapid: loadVapidKeys(config.stateDir),
    subject: config.vapidSubject,
    allowInsecureEndpoints: config.pushAllowHttp,
    warn: (message, error) => app.log.warn({ error }, message),
  });
  const stopWatchingInteractions = watchInteractions({
    db,
    push,
    subscribeAll: (listener) => events.subscribeAll(listener),
  });
  const delegations = new Delegations({
    db,
    events,
    nodes,
    models,
    ttlMs: config.delegationTtlMs,
    directoryChanged,
    announce: (delegation) => {
      // Waiting: the session's own push ("... is waiting for you") says it already.
      if (delegation.status === 'waiting_input') return;
      void push.notify(delegation.ownerUser, {
        title: `Delegation ${delegation.status === 'completed' ? 'finished' : 'failed'}: ${delegation.title}`,
        body: 'Your assistant will tell you what came of it.',
        tag: `delegation:${delegation.id}`,
        target: { sessionId: delegation.targetSessionId ?? delegation.assistantSessionId },
      });
    },
    warn: (message, error) => app.log.warn({ error }, message),
  });
  /**
   * Like memory changes, but for the session list (`sessions=1`): a run
   * started or ended, a write lease was taken or given back somewhere.
   */
  const sessionListeners = new Map<string, Set<() => void>>();
  const sessionsChanged = (user: string | null | undefined) => {
    if (user) for (const listener of sessionListeners.get(user) ?? []) listener();
  };
  /** Open runs and write leases each node reported, by gateway session id. */
  const activity = new Map<string, Map<string, LiveActivity>>();
  /**
   * `settled`: the node reported its runs, so a run it no longer lists has
   * finished; a disconnect only forgets them (they were interrupted, not done).
   */
  const replaceActivity = (nodeId: string, next: Map<string, LiveActivity>, settled = true) => {
    const before = activity.get(nodeId) ?? new Map();
    if (next.size) activity.set(nodeId, next);
    else activity.delete(nodeId);
    const owners = new Set<string>();
    for (const sessionId of new Set([...before.keys(), ...next.keys()])) {
      const a = before.get(sessionId);
      const b = next.get(sessionId);
      if (a?.run === b?.run && !!a?.writeLease === !!b?.writeLease) continue;
      // Something for the user to read: the run finished, or it asks a question.
      const finished = settled && !!a?.run && !b?.run;
      const asks = b?.run === 'waiting_input' && a?.run !== 'waiting_input';
      try {
        if (finished || asks) db.markSessionActivity(sessionId);
        const owner = db.getSession(sessionId).ownerUser;
        if (owner) owners.add(owner);
      } catch {
        /* session row gone */
      }
    }
    for (const owner of owners) sessionsChanged(owner);
  };
  const activityOf = (session: { id: string; nodeId: string | null }) =>
    session.nodeId ? activity.get(session.nodeId)?.get(session.id) : undefined;
  /** Like memory changes: per user, opted into with `schedules=1`. */
  const scheduleListeners = new Map<string, Set<() => void>>();
  const schedulesChanged = (user: string) => {
    for (const listener of scheduleListeners.get(user) ?? []) listener();
  };
  const defaultTimezone = config.timezone;
  const schedules = new Schedules({
    db,
    events,
    nodes,
    models,
    allowedUsers: config.allowedUsers,
    proposalTtlMs: config.delegationTtlMs,
    defaultTimezone,
    directoryChanged,
    changed: schedulesChanged,
    announce: (schedule, run) => {
      const what: Record<string, string> = {
        completed: 'finished',
        failed: 'failed',
        missed: 'was missed',
        waiting_input: 'is waiting for you',
      };
      void push.notify(schedule.ownerUser, {
        title: `${schedule.title} ${what[run.status] ?? run.status}`,
        body:
          run.status === 'missed'
            ? 'Allow it to run it now, or dismiss it.'
            : run.status === 'waiting_input'
              ? 'The scheduled run needs your answer to go on.'
              : 'Scheduled run: open it to read the result.',
        // One notification per run session: its "waiting" push is the same one.
        tag: run.sessionId ? `session:${run.sessionId}` : `run:${run.id}`,
        target:
          run.sessionId && run.status !== 'missed'
            ? { sessionId: run.sessionId }
            : { schedules: true, scheduleId: schedule.id },
      });
    },
    warn: (message, error) => app.log.warn({ error }, message),
  });
  const services = {
    db,
    events,
    nodes,
    models,
    backends,
    devices,
    memory,
    delegations,
    records,
    schedules,
    push,
    reloadModels,
  };

  // ---- node link ------------------------------------------------------------

  nodes.acceptRole = (nodeId, role) =>
    role === 'chat' ? db.claimAssistantNode(nodeId) : db.assistantNode() !== nodeId;
  nodes.onRegister = (node) => {
    db.syncRemoteWorkspaces(node.id, node.workspaces);
    directoryChanged();
    for (const sessionId of db.remoteSessionIds(node.id)) {
      const epoch = db.incrementEpoch(sessionId);
      events.publish(sessionId, epoch, 'node_reconnected', { nodeId: node.id });
    }
  };
  nodes.resolveSession = (nodeId, remoteId) => db.resolveRemoteSession(nodeId, remoteId);
  nodes.mirrorWatermarks = (nodeId) => records.watermarks(nodeId);
  nodes.onMirror = (nodeId, frame) => records.ingest(nodeId, frame);
  nodes.onAgentRequest = async (nodeId, request) =>
    runAgentOp(
      {
        db,
        allowedUsers: config.allowedUsers,
        memory,
        memoryChanged,
        delegations,
        records,
        nodes,
        webSearch,
        schedules,
        push,
      },
      nodeId,
      request,
    );
  nodes.onEvent = (nodeId, sessionId, event) => {
    try {
      const session = db.getSession(sessionId);
      if (session.nodeId !== nodeId) return;
      if (event.type === 'session_renamed' && event.data && typeof event.data === 'object') {
        applySessionName(
          db,
          events,
          sessionId,
          session.runnerEpoch,
          event.data as Record<string, unknown>,
        );
        sessionsChanged(session.ownerUser);
      } else if (typeof event.type === 'string')
        events.publish(sessionId, session.runnerEpoch, event.type, event.data);
    } catch {
      /* ignore unknown sessions */
    }
  };
  nodes.onActivity = (nodeId, sessions) => {
    const next = new Map<string, LiveActivity>();
    for (const item of sessions) {
      const sessionId = db.resolveRemoteSession(nodeId, item.id);
      if (sessionId) next.set(sessionId, { run: item.run, writeLease: item.writeLease });
    }
    replaceActivity(nodeId, next);
  };
  nodes.onDisconnect = (nodeId) => {
    replaceActivity(nodeId, new Map(), false);
    for (const sessionId of db.remoteSessionIds(nodeId)) {
      db.interruptRemoteSession(sessionId);
      db.setRunnerState(sessionId, 'failed');
      events.publish(sessionId, db.getSession(sessionId).runnerEpoch, 'node_offline', { nodeId });
    }
    directoryChanged();
  };

  /** The session, if the user owns it, together with its node. */
  const claim = (request: FastifyRequest, sessionId = parse(sessionParams, request.params).id) => {
    const session = db.claimSession(sessionId, request.identity!.user);
    if (!session.nodeId || !session.piSessionId)
      throw new ApiError(404, 'not_found', 'Session not found');
    return session as SessionRow & { nodeId: string; piSessionId: string };
  };
  const nodeUrl = (session: { piSessionId: string }, rest = '') =>
    `/api/sessions/${encodeURIComponent(session.piSessionId)}${rest}`;

  /** Replay on the node; node errors keep their status and body. */
  const relay = async (
    nodeId: string,
    request: FastifyRequest,
    data: Omit<NodeHttpRequest, 'user'>,
  ) => {
    const response = await nodes.request(nodeId, { ...data, user: request.identity!.user });
    return response;
  };
  const forward = async (
    reply: FastifyReply,
    nodeId: string,
    request: FastifyRequest,
    data: Omit<NodeHttpRequest, 'user'>,
  ) => {
    const response = await relay(nodeId, request, data);
    return response.status === 204
      ? reply.status(204).send()
      : reply.status(response.status).send(response.body);
  };
  /** Relay and require success; a failure is passed through to the browser unchanged. */
  const expectOk = async (
    reply: FastifyReply,
    nodeId: string,
    request: FastifyRequest,
    data: Omit<NodeHttpRequest, 'user'>,
  ): Promise<any> => {
    const response = await relay(nodeId, request, data);
    if (response.status >= 400) {
      await reply.status(response.status).send(response.body);
      return undefined;
    }
    return response.body ?? {};
  };

  registerErrorHandler(app);
  app.addHook('onRequest', async (request, reply) => {
    if (
      request.url.split('?', 1)[0] === '/node/connect' &&
      request.headers.upgrade?.toLowerCase() === 'websocket'
    )
      return;
    return authHook(config, devices)(request, reply);
  });

  app.get('/node/connect', { websocket: true }, (socket, request) => {
    const nodeId = request.headers['x-pirc-node-id'];
    const auth = request.headers.authorization;
    const token = typeof auth === 'string' && /^Bearer [^ ]+$/.test(auth) ? auth.slice(7) : '';
    if (typeof nodeId !== 'string' || !validNodeToken(config.nodeTokens, nodeId, token)) {
      socket.close(4401, 'invalid node credentials');
      return;
    }
    nodes.attach(nodeId, socket);
  });

  // ---- browser API ----------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true, version: 2, nodes: nodes.list().length }));
  app.get('/api/nodes', async () => ({ nodes: nodes.list() }));

  const assistantNode = () => {
    const nodeId = db.assistantNode();
    if (!nodeId || nodes.get(nodeId)?.role !== 'chat')
      throw new ApiError(503, 'node_offline', 'The chat node is offline or not registered');
    return nodeId;
  };
  app.get('/api/assistant/node', async () => {
    const nodeId = db.assistantNode();
    return { nodeId, online: !!nodeId && nodes.get(nodeId)?.role === 'chat' };
  });
  app.post('/api/assistant/node/release', async (request) => {
    const { nodeId } = parse(z.object({ nodeId: z.string().min(1) }).strict(), request.body);
    if (!db.releaseAssistantNode(nodeId))
      throw new ApiError(
        409,
        'binding_changed',
        'Chat node binding changed; refresh before releasing',
      );
    nodes.disconnect(nodeId);
    directoryChanged();
    return { nodeId: null, online: false };
  });
  app.get('/api/assistant/prompts', async (request, reply) => {
    const nodeId = assistantNode();
    const response = await relay(nodeId, request, { method: 'GET', url: '/api/assistant/prompts' });
    if (response.status !== 200) return reply.status(response.status).send(response.body);
    return { ...(response.body as Record<string, unknown>), nodeId };
  });
  app.put('/api/assistant/prompts/:name', async (request, reply) => {
    const { name } = parse(z.object({ name: z.enum(['soul', 'chat']) }), request.params);
    const { text, nodeId } = parse(
      z.object({ text: z.string(), nodeId: z.string().min(1) }).strict(),
      request.body,
    );
    if (db.assistantNode() !== nodeId)
      throw new ApiError(
        409,
        'binding_changed',
        'Chat node binding changed; refresh and review before saving',
      );
    return forward(reply, assistantNode(), request, {
      method: 'PUT',
      url: '/api/assistant/prompts/' + name,
      payload: { text },
    });
  });

  app.get('/api/workspaces', async () => ({
    workspaces: db
      .listWorkspaces()
      .filter((workspace) => workspace.id.includes(':'))
      .map((workspace) => ({ ...workspace, canonicalPath: undefined })),
  }));
  app.get('/api/workspaces/:workspaceId/capabilities', async (request) => {
    const { workspaceId } = parse(z.object({ workspaceId: z.string().min(1) }), request.params);
    return { capabilities: db.getWorkspaceCapabilities(workspaceId) };
  });
  app.patch('/api/workspaces/:workspaceId/capabilities', async (request) => {
    const { workspaceId } = parse(z.object({ workspaceId: z.string().min(1) }), request.params);
    const body = parse(
      z.object({ capabilities: workspaceCapabilitiesSchema.partial() }).strict(),
      request.body,
    );
    const capabilities = db.patchWorkspaceCapabilities(workspaceId, body.capabilities);
    directoryChanged();
    return { capabilities };
  });
  /**
   * A chat project's instructions (plans/assistant.md §5). The node keeps
   * them (node/chat.ts); the gateway only relays the user's edit and stores
   * nothing. No agent operation reaches these routes.
   */
  const chatProjectOnNode = (request: FastifyRequest) => {
    const { workspaceId } = parse(z.object({ workspaceId: z.string().min(1) }), request.params);
    const workspace = db.getWorkspace(workspaceId);
    if (workspace.kind !== 'chat' || !workspace.id.startsWith(`${workspace.hostId}:`))
      throw new ApiError(400, 'invalid_input', 'Only chat projects have instructions');
    if (!nodes.get(workspace.hostId))
      throw new ApiError(503, 'node_offline', `${workspace.hostId} is offline`);
    const local = workspace.id.slice(workspace.hostId.length + 1);
    return {
      nodeId: workspace.hostId,
      url: `/api/workspaces/${encodeURIComponent(local)}/instructions`,
    };
  };
  app.get('/api/workspaces/:workspaceId/instructions', async (request, reply) => {
    const target = chatProjectOnNode(request);
    return forward(reply, target.nodeId, request, { method: 'GET', url: target.url });
  });
  app.patch('/api/workspaces/:workspaceId/instructions', async (request, reply) => {
    const target = chatProjectOnNode(request);
    const body = parse(z.object({ text: z.string().max(100_000) }).strict(), request.body);
    return forward(reply, target.nodeId, request, {
      method: 'PATCH',
      url: target.url,
      payload: { text: body.text },
    });
  });
  /**
   * A directory workspace's project config and its trust (agent/config.ts):
   * the node keeps both; the gateway only relays the user's decision.
   */
  const directoryOnNode = (request: FastifyRequest, rest: string) => {
    const { workspaceId } = parse(z.object({ workspaceId: z.string().min(1) }), request.params);
    const workspace = db.getWorkspace(workspaceId);
    if (workspace.kind !== 'directory' || !workspace.id.startsWith(`${workspace.hostId}:`))
      throw new ApiError(400, 'invalid_input', 'Only directory workspaces have a project config');
    if (!nodes.get(workspace.hostId))
      throw new ApiError(503, 'node_offline', `${workspace.hostId} is offline`);
    const local = workspace.id.slice(workspace.hostId.length + 1);
    return { nodeId: workspace.hostId, url: `/api/workspaces/${encodeURIComponent(local)}${rest}` };
  };
  app.get('/api/workspaces/:workspaceId/project-config', async (request, reply) => {
    const target = directoryOnNode(request, '/project-config');
    return forward(reply, target.nodeId, request, { method: 'GET', url: target.url });
  });
  app.post('/api/workspaces/:workspaceId/project-trust', async (request, reply) => {
    const target = directoryOnNode(request, '/project-trust');
    const body = parse(
      z.union([
        z.object({ trusted: z.literal(true), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
        z.object({ trusted: z.literal(false) }).strict(),
      ]),
      request.body,
    );
    return forward(reply, target.nodeId, request, {
      method: 'POST',
      url: target.url,
      payload: body,
    });
  });
  app.post('/api/workspaces', async (request, reply) => {
    const body = parse(createWorkspaceBody, request.body);
    if (!nodes.get(body.nodeId)) throw new ApiError(503, 'node_offline', 'Node is offline');
    const remote = await expectOk(reply, body.nodeId, request, {
      method: 'POST',
      url: '/api/workspaces',
      payload:
        body.kind === 'chat'
          ? { kind: 'chat', displayName: body.displayName }
          : { path: body.path, displayName: body.displayName },
    });
    if (!remote) return reply;
    // A lost acknowledgement is reconciled when the node registers again.
    db.syncRemoteWorkspaces(body.nodeId, [remote.workspace]);
    nodes.addWorkspace(body.nodeId, remote.workspace);
    directoryChanged();
    return reply.status(201).send({
      workspace: {
        ...db.getWorkspace(`${body.nodeId}:${remote.workspace.id}`),
        canonicalPath: undefined,
      },
    });
  });

  app.get('/api/sessions', async (request) => {
    const user = request.identity!.user;
    const origins = db.sessionOrigins(user);
    return {
      sessions: db
        .listSessions()
        .filter((session) => session.nodeId && session.ownerUser === user)
        .map((session) => {
          const live = activityOf(session);
          const origin = origins.get(session.id);
          return {
            ...publicSession(session),
            // The node reports open runs; the gateway's own table only has finished ones.
            runStatus: live?.run ?? session.runStatus,
            ...(live?.writeLease ? { writeLease: true } : {}),
            ...(origin ? { origin } : {}),
          };
        }),
    };
  });
  app.post('/api/sessions', async (request, reply) => {
    const body = parse(createSessionBody, request.body);
    const workspace = db.getWorkspace(body.workspaceId);
    const nodeId = workspace.hostId;
    if (!nodes.get(nodeId)?.workspaces.some((w) => `${nodeId}:${w.id}` === workspace.id))
      throw new ApiError(503, 'node_offline', 'Node or workspace is offline');
    const remote = await expectOk(reply, nodeId, request, {
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: workspace.id.slice(nodeId.length + 1) },
    });
    if (!remote) return reply;
    const session = db.createSession(
      workspace.id,
      `node://${nodeId}/${remote.session.id}`,
      nodeId,
      remote.session.id,
      request.identity!.user,
    );
    return reply.status(201).send({ session: publicSession(session) });
  });

  app.delete('/api/sessions/:id', async (request, reply) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    const user = request.identity!.user;
    const deletion = db.sessionDeletion(sessionId);
    if (deletion && deletion.owner_user !== user)
      throw new ApiError(403, 'forbidden', 'Chat belongs to another user');
    if (deletion?.status === 'deleted') return reply.status(204).send();
    const session = db.claimSession(sessionId, user, true);
    if (db.getWorkspace(session.workspaceId).kind !== 'chat')
      throw new ApiError(400, 'invalid_input', 'Only chats can be deleted');
    if (!session.nodeId || !session.piSessionId || !nodes.get(session.nodeId))
      throw new ApiError(503, 'node_offline', 'Connect the chat node before deleting this chat');
    // Persist intent before the remote call: delayed agent operations cannot add memory.
    db.beginSessionDeletion(sessionId, user);
    const response = await relay(session.nodeId, request, {
      method: 'DELETE',
      url: nodeUrl({ piSessionId: session.piSessionId }),
    });
    if (response.status >= 400) return reply.status(response.status).send(response.body);
    db.raw.transaction(() => {
      memory.forgetSession(user, sessionId);
      db.finishSessionDeletion(sessionId);
    })();
    memoryChanged(user);
    events.publish(sessionId, session.runnerEpoch, 'session_deleted', { sessionId });
    events.forget(sessionId);
    sessionsChanged(user);
    schedulesChanged(user);
    return reply.status(204).send();
  });

  app.patch('/api/sessions/:id', async (request, reply) => {
    const session = claim(request);
    const { name, pinned, settled } = parse(updateSessionBody, request.body);
    if (name !== undefined) {
      const remote = await expectOk(reply, session.nodeId, request, {
        method: 'PATCH',
        url: nodeUrl(session),
        payload: { name },
      });
      if (!remote) return reply;
      applySessionName(db, events, session.id, session.runnerEpoch, { name, source: 'user' });
    }
    if (pinned !== undefined || settled !== undefined)
      db.setSessionFlags(session.id, { pinned, settled });
    return { session: publicSession(db.getSession(session.id)) };
  });
  /** The user has read the session: its unread mark clears on every device. */
  app.post('/api/sessions/:id/read', async (request) => {
    const session = claim(request);
    if (db.markSessionRead(session.id)) sessionsChanged(session.ownerUser);
    return { session: publicSession(db.getSession(session.id)) };
  });

  app.get('/api/sessions/:id/snapshot', async (request, reply) => {
    const session = claim(request);
    const remote = await expectOk(reply, session.nodeId, request, {
      method: 'GET',
      url: nodeUrl(session, '/snapshot'),
    });
    if (!remote) return reply;
    // Node event sequence numbers are not the daemon's: the browser resumes from ours.
    return {
      ...remote,
      session: { ...publicSession(session), runnerState: remote.session?.runnerState },
      // Delegations waiting for the user's approval are the gateway's own confirmations.
      interactions: [
        ...(Array.isArray(remote.interactions) ? remote.interactions : []),
        ...delegations.pendingInteractions(session.id),
        ...schedules.pendingInteractions(session.id),
        ...memoryInteractions.pendingInteractions(session.id, request.identity!.user),
      ],
      watermark: events.watermark(session.id, session.runnerEpoch),
    };
  });

  app.post('/api/sessions/:id/commands', async (request, reply) => {
    const session = claim(request);
    const body = parse(commandBody, request.body);
    const user = request.identity!.user;
    db.validateLease(session.id, body.clientId, body.generation);
    db.validateLeaseUser(session.id, user);
    const received = db.receiveCommand(
      body.commandId,
      session.id,
      payloadHash(body.payload),
      body.payload,
    );
    if (received.duplicate) return { command: received.row, duplicate: true };
    if (!nodes.get(session.nodeId)) {
      db.updateCommand(body.commandId, 'rejected', undefined, 'Node is offline');
      throw new ApiError(503, 'node_offline', 'Node is offline');
    }
    db.updateCommand(body.commandId, 'dispatched');
    try {
      const remote = await relay(session.nodeId, request, {
        method: 'POST',
        url: nodeUrl(session, '/commands'),
        payload: body,
      });
      const command = (remote.body as any)?.command;
      if (remote.status >= 400 && !command) {
        const message = (remote.body as any)?.error?.message ?? 'Node rejected the command';
        db.updateCommand(body.commandId, 'rejected', undefined, message);
        return reply.status(remote.status).send(remote.body);
      }
      db.updateCommand(body.commandId, command.status, command.result, command.error);
    } catch (error) {
      db.updateCommand(body.commandId, 'outcome_unknown', undefined, (error as Error).message);
      return reply.status(503).send({ command: db.getCommand(body.commandId), duplicate: false });
    }
    const command = db.getCommand(body.commandId);
    return reply
      .status(command.status === 'accepted' ? 202 : 503)
      .send({ command, duplicate: false });
  });

  app.get('/api/sessions/:id/control', async (request) => ({
    lease: db.getLease(claim(request).id),
  }));
  app.post('/api/sessions/:id/control/acquire', async (request, reply) => {
    const session = claim(request);
    const body = parse(leaseBody, request.body);
    const user = request.identity!.user;
    db.checkLeaseUser(session.id, user, body.force ?? false);
    const remote = await expectOk(reply, session.nodeId, request, {
      method: 'POST',
      url: nodeUrl(session, '/control/acquire'),
      payload: body,
    });
    if (!remote) return reply;
    db.mirrorLease(session.id, remote.lease, user, body.force ?? false);
    return remote;
  });
  app.post('/api/sessions/:id/control/heartbeat', async (request, reply) => {
    const session = claim(request);
    const body = parse(heldLeaseBody, request.body);
    const user = request.identity!.user;
    db.validateLeaseUser(session.id, user);
    db.validateLease(session.id, body.clientId, body.generation);
    const remote = await expectOk(reply, session.nodeId, request, {
      method: 'POST',
      url: nodeUrl(session, '/control/heartbeat'),
      payload: body,
    });
    if (!remote) return reply;
    db.mirrorLease(session.id, remote.lease, user, false);
    return remote;
  });
  app.post('/api/sessions/:id/control/release', async (request, reply) => {
    const session = claim(request);
    const body = parse(heldLeaseBody, request.body);
    db.validateLeaseUser(session.id, request.identity!.user);
    db.validateLease(session.id, body.clientId, body.generation);
    const remote = await expectOk(reply, session.nodeId, request, {
      method: 'POST',
      url: nodeUrl(session, '/control/release'),
      payload: body,
    });
    if (remote === undefined) return reply;
    db.clearRemoteLease(session.id);
    return reply.status(204).send();
  });

  app.post('/api/sessions/:id/interactions/:interactionId/answer', async (request, reply) => {
    const { interactionId } = parse(
      z.object({ id: z.string().min(1), interactionId: z.string().min(1) }),
      request.params,
    );
    const session = claim(request);
    const body = parse(answerBody, request.body);
    db.validateLease(session.id, body.clientId, body.generation);
    db.validateLeaseUser(session.id, request.identity!.user);
    const memoryAnswer = memoryInteractions.answer(
      session.id,
      interactionId,
      request.identity!.user,
      (body as { answer?: unknown }).answer,
    );
    if (memoryAnswer) {
      memoryChanged(request.identity!.user);
      return memoryAnswer;
    }
    // A delegation's confirmation is answered here; the node never saw it.
    const delegation = delegations.answer(
      session.id,
      interactionId,
      request.identity!.user,
      (body as { answer?: unknown }).answer,
    );
    if (delegation) return delegation;
    // So is an agent's schedule proposal.
    const proposal = schedules.answer(
      session.id,
      interactionId,
      request.identity!.user,
      (body as { answer?: unknown }).answer,
    );
    if (proposal) return proposal;
    return forward(reply, session.nodeId, request, {
      method: 'POST',
      url: nodeUrl(session, `/interactions/${encodeURIComponent(interactionId)}/answer`),
      payload: body,
    });
  });

  /** Images and generic files are stored on the session's node, where its agent reads them. */
  app.post('/api/sessions/:id/uploads', async (request, reply) => {
    const session = claim(request);
    if (!Buffer.isBuffer(request.body))
      throw new ApiError(400, 'invalid_input', 'Upload body must be raw bytes');
    if (!request.body.length || request.body.length > config.uploadMaxBytes)
      throw new ApiError(413, 'payload_too_large', 'Upload exceeds configured limit');
    const filename = (request.query as { filename?: string } | undefined)?.filename;
    const suffix = filename ? `?filename=${encodeURIComponent(filename)}` : '';
    return forward(reply, session.nodeId, request, {
      method: 'POST',
      url: nodeUrl(session, `/uploads${suffix}`),
      bodyBase64: request.body.toString('base64'),
      contentType: request.headers['content-type']?.split(';', 1)[0] ?? 'application/octet-stream',
    });
  });

  registerBackendRoutes(app, backends);
  registerDeviceRoutes(app, devices);
  registerMemoryRoutes(app, { db, memory, memoryChanged });
  registerScheduleRoutes(app, { db, schedules, defaultTimezone });
  registerPushRoutes(app, push);

  /** Every node's agents use the gateway's providers, so one list serves all sessions. */
  app.get('/api/models', async (request) => {
    const query = parse(z.object({ sessionId: z.string().optional() }), request.query);
    if (query.sessionId) claim(request, query.sessionId);
    return { models: listModels(models.current) };
  });

  // Side panel and terminal REST: relayed verbatim.
  const relayPanel = (method: 'GET' | 'POST') =>
    async function (request: FastifyRequest, reply: FastifyReply) {
      const session = claim(request);
      const [pathname, query] = request.url.split('?', 2) as [string, string | undefined];
      const rest = pathname.split('/').slice(4).join('/');
      if (!(method === 'GET' ? RELAYED_GET : RELAYED_POST).test(rest))
        throw new ApiError(404, 'not_found', 'Route not found');
      return forward(reply, session.nodeId, request, {
        method,
        url: nodeUrl(session, `/${rest}${query ? `?${query}` : ''}`),
        ...(method === 'POST' ? { payload: request.body ?? {} } : {}),
      });
    };
  for (const route of [
    '/api/sessions/:id/git/*',
    '/api/sessions/:id/files',
    '/api/sessions/:id/files/content',
    '/api/sessions/:id/panel/*',
    '/api/sessions/:id/terminals',
  ])
    app.get(route, relayPanel('GET'));
  app.post('/api/sessions/:id/terminals', relayPanel('POST'));
  app.post('/api/sessions/:id/terminals/:terminalId/close', relayPanel('POST'));
  app.post('/api/sessions/:id/panel/background/:taskId/stop', relayPanel('POST'));

  // ---- WebSockets -----------------------------------------------------------

  app.get('/api/events', { websocket: true }, (socket, request) => {
    limitIncoming(socket, EVENTS_MESSAGE_MAX_BYTES);
    try {
      validateRequest(request, config, devices, true);
      const query = parse(
        z.object({
          sessionId: z.string().min(1),
          cursor: z.string().optional(),
          directory: z.literal('1').optional(),
          memory: z.literal('1').optional(),
          schedules: z.literal('1').optional(),
          sessions: z.literal('1').optional(),
        }),
        request.query,
      );
      const session = claim(request, query.sessionId);
      const replay = events.replay(session.id, cursorFrom(query.cursor), session.runnerEpoch);
      const send = (message: unknown) => {
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > config.websocketMaxBufferedBytes) {
          socket.send(
            JSON.stringify({
              type: 'reset',
              reason: 'backpressure',
              watermark: events.watermark(session.id, session.runnerEpoch),
            }),
          );
          socket.close(1013, 'resync required');
          return;
        }
        socket.send(JSON.stringify(message));
      };
      if (replay.reset)
        send({
          type: 'reset',
          reason: 'cursor_expired_or_epoch_changed',
          watermark: replay.watermark,
        });
      else for (const event of replay.events) send(event);
      const unsubscribe = events.subscribe(session.id, send);
      const onDirectory = () => send({ type: 'directory_changed' });
      if (query.directory) directoryListeners.add(onDirectory);
      const user = request.identity!.user;
      const onMemory = () => send({ type: 'memory_changed' });
      if (query.memory) {
        let listeners = memoryListeners.get(user);
        if (!listeners) memoryListeners.set(user, (listeners = new Set()));
        listeners.add(onMemory);
      }
      const onSchedules = () => send({ type: 'schedules_changed' });
      if (query.schedules) {
        let listeners = scheduleListeners.get(user);
        if (!listeners) scheduleListeners.set(user, (listeners = new Set()));
        listeners.add(onSchedules);
      }
      const onSessions = () => send({ type: 'sessions_changed' });
      if (query.sessions) {
        let listeners = sessionListeners.get(user);
        if (!listeners) sessionListeners.set(user, (listeners = new Set()));
        listeners.add(onSessions);
      }
      const untrack = trackDevice(request, socket);
      const done = () => {
        unsubscribe();
        const sessionWatchers = sessionListeners.get(user);
        sessionWatchers?.delete(onSessions);
        if (sessionWatchers?.size === 0) sessionListeners.delete(user);
        directoryListeners.delete(onDirectory);
        const listeners = memoryListeners.get(user);
        listeners?.delete(onMemory);
        if (listeners?.size === 0) memoryListeners.delete(user);
        const scheduled = scheduleListeners.get(user);
        scheduled?.delete(onSchedules);
        if (scheduled?.size === 0) scheduleListeners.delete(user);
        untrack();
      };
      socket.once('close', done);
      socket.once('error', done);
    } catch (error) {
      socket.close(
        wsCloseCode(error),
        error instanceof Error ? error.message.slice(0, 120) : 'invalid request',
      );
    }
  });

  /** Both browser-facing relays keep authentication and ownership checks here. */
  const streamRoute =
    (kind: 'terminal' | 'browser') => (socket: WebSocket, request: FastifyRequest) => {
      relaySocket(socket, {
        kind,
        maxBufferedBytes: config.websocketMaxBufferedBytes,
        open(handlers) {
          validateRequest(request, config, devices, true);
          const session = claim(request);
          const terminalId =
            kind === 'browser'
              ? 'browser'
              : parse(
                  z.object({ id: z.string(), terminalId: z.string().min(1).max(100) }),
                  request.params,
                ).terminalId;
          return nodes.openTerminal(
            session.nodeId,
            {
              user: request.identity!.user,
              sessionId: session.piSessionId,
              terminalId,
              ...(kind === 'browser' ? { kind } : {}),
            },
            handlers,
          );
        },
        track: (close) => trackDevice(request, { close }),
      });
    };

  app.get(
    '/api/sessions/:id/terminals/:terminalId/stream',
    { websocket: true },
    streamRoute('terminal'),
  );
  app.get('/api/sessions/:id/browser/stream', { websocket: true }, streamRoute('browser'));

  /**
   * A browser recording (`.pirc/recordings/*.webm` in the session's
   * workspace), fetched from the node in chunks. Supports Range so video
   * players can seek.
   */
  app.get('/api/sessions/:id/browser/recording', async (request, reply) => {
    const session = claim(request);
    const { path: file } = parse(z.object({ path: z.string().min(1).max(300) }), request.query);
    const chunk = async (offset: number, length: number) => {
      const response = await relay(session.nodeId, request, {
        method: 'GET',
        url: nodeUrl(
          session,
          `/browser/recording?${new URLSearchParams({ path: file, offset: String(offset), length: String(length) })}`,
        ),
      });
      if (response.status >= 400) throw new NodeReplyError(response.status, response.body);
      const body = response.body as { size: number; dataBase64: string };
      return { size: body.size, data: Buffer.from(body.dataBase64, 'base64') };
    };
    let first: { size: number; data: Buffer };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
    let start = range?.[1] ? Number(range[1]) : 0;
    try {
      first = await chunk(start, RECORDING_CHUNK_BYTES);
    } catch (error) {
      if (error instanceof NodeReplyError) return reply.status(error.status).send(error.body);
      throw error;
    }
    const size = first.size;
    if (range && !range[1] && range[2]) {
      // Suffix range: the last N bytes.
      start = Math.max(0, size - Number(range[2]));
      first = await chunk(start, RECORDING_CHUNK_BYTES);
    }
    const end = range?.[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size && size > 0)
      return reply.status(416).header('content-range', `bytes */${size}`).send();
    const length = Math.max(0, end - start + 1);
    async function* body() {
      let offset = start;
      let next: Buffer = first.data;
      while (offset <= end && next.length) {
        const part = next.subarray(0, end - offset + 1);
        yield part;
        offset += part.length;
        if (offset > end) break;
        next = (await chunk(offset, RECORDING_CHUNK_BYTES)).data;
      }
    }
    reply
      .header('content-type', 'video/webm')
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=3600')
      .header('content-length', String(length));
    if (range) reply.status(206).header('content-range', `bytes ${start}-${end}/${size}`);
    return reply.send(Readable.from(body()));
  });

  app.addHook('onClose', async () => {
    inference?.cancelAll();
    delegations.close();
    schedules.close();
    stopWatchingInteractions();
    devices.close();
    await backends.close();
    nodes.close();
    db.close();
  });
  return { app, services };
}
