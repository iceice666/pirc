/**
 * `pirc gateway`: the central daemon. It authenticates browsers (forward
 * auth), indexes sessions and mirrors control leases, buffers each
 * session's events, and routes every session request to the node that owns
 * it. It never runs agents, terminals or workspace inspection itself.
 *
 * Browser-visible IDs are the daemon's; the node's own session and
 * workspace IDs (`piSessionId`, `<nodeId>:<id>`) never leave this process.
 */
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DaemonConfig } from '../config.js';
import { GatewayDatabase, type SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import { EventHub } from '../events.js';
import { registerErrorHandler, registerImageParsers } from '../http.js';
import { listModels, loadModelsFile, ModelStore } from '../models.js';
import { Readable } from 'node:stream';
import { NODE_FRAME_MAX_BYTES, RECORDING_CHUNK_BYTES, type NodeHttpRequest } from '../protocol.js';
import { applySessionName, publicSession } from '../session-name.js';
import type { EventCursor } from '../types.js';
import { parse, payloadHash } from '../util.js';
import { authHook, validateRequest } from './auth.js';
import { DeviceTokens, registerDeviceRoutes } from './devices.js';
import { runAgentOp } from './agent-ops.js';
import { Delegations } from './delegations.js';
import { MemoryStore } from './memory.js';
import { MemoryRecords } from './memory-records.js';
import { registerMemoryRoutes } from './memory-routes.js';
import { NodeRegistry, validNodeToken } from './nodes.js';
import { BackendService } from '../backends/service.js';
import { registerBackendRoutes } from '../backends/routes.js';
import { GatewayInference } from '../backends/inference.js';
import { WebSearch } from './web-search.js';

const sessionParams = z.object({ id: z.string().min(1) });
/** Live browser frames are skipped while this much is queued to the client. */
const BROWSER_SOCKET_BACKLOG_BYTES = 2 * 1024 * 1024;

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
  /^(?:git\/(?:status|diff|log|commits\/[0-9a-fA-F]{4,64})|files(?:\/content)?|panel\/(?:state|background\/[^/?]+)|terminals)$/;
const RELAYED_POST = /^(?:terminals(?:\/[^/?]+\/close)?|panel\/background\/[^/?]+\/stop)$/;

function cursorFrom(value: unknown): EventCursor | null {
  if (typeof value !== 'string' || !value) return null;
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) throw new ApiError(400, 'invalid_input', 'cursor must be epoch:sequence');
  return { epoch: Number(match[1]), sequence: Number(match[2]) };
}

const wsCloseCode = (error: unknown) => {
  const status = error instanceof ApiError ? error.statusCode : 500;
  return status === 401 ? 4401 : status === 403 ? 4403 : status === 404 ? 4404 : 4400;
};

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
  const memoryChanged = (user: string) => {
    for (const listener of memoryListeners.get(user) ?? []) listener();
  };
  const delegations = new Delegations({
    db,
    events,
    nodes,
    ttlMs: config.delegationTtlMs,
    directoryChanged,
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
    reloadModels,
  };

  // ---- node link ------------------------------------------------------------

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
      },
      nodeId,
      request,
    );
  nodes.onEvent = (nodeId, sessionId, event) => {
    try {
      const session = db.getSession(sessionId);
      if (session.nodeId !== nodeId) return;
      if (event.type === 'session_renamed' && event.data && typeof event.data === 'object')
        applySessionName(
          db,
          events,
          sessionId,
          session.runnerEpoch,
          event.data as Record<string, unknown>,
        );
      else if (typeof event.type === 'string')
        events.publish(sessionId, session.runnerEpoch, event.type, event.data);
    } catch {
      /* ignore unknown sessions */
    }
  };
  nodes.onDisconnect = (nodeId) => {
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

  app.get('/api/workspaces', async () => ({
    workspaces: db
      .listWorkspaces()
      .filter((workspace) => workspace.id.includes(':'))
      .map((workspace) => ({ ...workspace, canonicalPath: undefined })),
  }));
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

  app.get('/api/sessions', async (request) => ({
    sessions: db
      .listSessions()
      .filter((session) => session.nodeId && session.ownerUser === request.identity!.user)
      .map(publicSession),
  }));
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
    // A delegation's confirmation is answered here; the node never saw it.
    const delegation = delegations.answer(
      session.id,
      interactionId,
      request.identity!.user,
      (body as { answer?: unknown }).answer,
    );
    if (delegation) return delegation;
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
    try {
      validateRequest(request, config, devices, true);
      const query = parse(
        z.object({
          sessionId: z.string().min(1),
          cursor: z.string().optional(),
          directory: z.literal('1').optional(),
          memory: z.literal('1').optional(),
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
      const untrack = trackDevice(request, socket);
      const done = () => {
        unsubscribe();
        directoryListeners.delete(onDirectory);
        const listeners = memoryListeners.get(user);
        listeners?.delete(onMemory);
        if (listeners?.size === 0) memoryListeners.delete(user);
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

  /** Terminal stream, relayed to the session's node over the node link. */
  app.get(
    '/api/sessions/:id/terminals/:terminalId/stream',
    { websocket: true },
    (socket, request) => {
      try {
        validateRequest(request, config, devices, true);
        const session = claim(request);
        const { terminalId } = parse(
          z.object({ id: z.string(), terminalId: z.string().min(1).max(100) }),
          request.params,
        );
        const stream = nodes.openTerminal(
          session.nodeId,
          { user: request.identity!.user, sessionId: session.piSessionId, terminalId },
          {
            onFrame(frame) {
              if (socket.readyState !== socket.OPEN) return;
              if (socket.bufferedAmount > config.websocketMaxBufferedBytes) {
                // The client reconnects and gets the scrollback replayed.
                socket.close(1013, 'resync required');
                return;
              }
              socket.send(JSON.stringify(frame));
            },
            onClose(code, reason) {
              if (socket.readyState === socket.OPEN) socket.close(code, reason.slice(0, 120));
            },
          },
        );
        socket.on('message', (raw) => {
          let message: unknown;
          try {
            message = JSON.parse(String(raw));
          } catch {
            return;
          }
          stream.send(message);
        });
        const untrack = trackDevice(request, socket);
        const done = () => {
          stream.close();
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
    },
  );

  /**
   * Browser live view, relayed like a terminal stream. Live frames are
   * dropped (not queued) while the socket is backed up; the next one catches up.
   */
  app.get('/api/sessions/:id/browser/stream', { websocket: true }, (socket, request) => {
    try {
      validateRequest(request, config, devices, true);
      const session = claim(request);
      const stream = nodes.openTerminal(
        session.nodeId,
        {
          user: request.identity!.user,
          sessionId: session.piSessionId,
          terminalId: 'browser',
          kind: 'browser',
        },
        {
          onFrame(frame) {
            if (socket.readyState !== socket.OPEN) return;
            const live = (frame as { type?: unknown })?.type === 'frame';
            if (live && socket.bufferedAmount > BROWSER_SOCKET_BACKLOG_BYTES) return;
            if (socket.bufferedAmount > config.websocketMaxBufferedBytes) {
              socket.close(1013, 'resync required');
              return;
            }
            socket.send(JSON.stringify(frame));
          },
          onClose(code, reason) {
            if (socket.readyState === socket.OPEN) socket.close(code, reason.slice(0, 120));
          },
        },
      );
      socket.on('message', (raw) => {
        let message: unknown;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        stream.send(message);
      });
      const untrack = trackDevice(request, socket);
      const done = () => {
        stream.close();
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
    devices.close();
    await backends.close();
    nodes.close();
    db.close();
  });
  return { app, services };
}
