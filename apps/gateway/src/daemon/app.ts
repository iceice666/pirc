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
import { NODE_FRAME_MAX_BYTES, type NodeHttpRequest } from '../protocol.js';
import { applySessionName, publicSession } from '../session-name.js';
import type { EventCursor } from '../types.js';
import { parse, payloadHash } from '../util.js';
import { authHook, validateRequest } from './auth.js';
import { NodeRegistry, validNodeToken } from './nodes.js';

const sessionParams = z.object({ id: z.string().min(1) });
const createWorkspaceBody = z.object({
  nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  path: z.string().trim().min(1).max(4096),
  displayName: z.string().trim().min(1).max(200),
});
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
const RELAYED_POST = /^terminals(?:\/[^/?]+\/close)?$/;

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
  /**
   * Re-read the models file and push it to every node; agents started
   * afterwards use it. On error the current providers stay in effect.
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
  const readModels = () => {
    const loaded = loadModelsFile(config.modelsFile);
    if (!loaded)
      app.log.warn(
        { file: config.modelsFile },
        'models file not found: agents have no providers until it exists and is reloaded',
      );
    models.set(loaded ?? { providers: {} });
    app.log.info(
      { file: config.modelsFile, providers: Object.keys(models.current.providers) },
      'models loaded',
    );
  };
  // An invalid file at startup is fatal; on reload it only logs.
  readModels();
  const nodes = new NodeRegistry(models);
  const reloadModels = () => {
    try {
      readModels();
    } catch (error) {
      app.log.error(
        { error: (error as Error).message },
        'models reload failed; keeping the previous providers',
      );
      return;
    }
    nodes.broadcastModels();
  };
  const services = { db, events, nodes, models, reloadModels };

  // ---- node link ------------------------------------------------------------

  nodes.onRegister = (node) => {
    db.syncRemoteWorkspaces(node.id, node.workspaces);
    for (const sessionId of db.remoteSessionIds(node.id)) {
      const epoch = db.incrementEpoch(sessionId);
      events.publish(sessionId, epoch, 'node_reconnected', { nodeId: node.id });
    }
  };
  nodes.resolveSession = (nodeId, remoteId) => db.resolveRemoteSession(nodeId, remoteId);
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
    return authHook(config)(request, reply);
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
      payload: { path: body.path, displayName: body.displayName },
    });
    if (!remote) return reply;
    // A lost acknowledgement is reconciled when the node registers again.
    db.syncRemoteWorkspaces(body.nodeId, [remote.workspace]);
    nodes.addWorkspace(body.nodeId, remote.workspace);
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
    return forward(reply, session.nodeId, request, {
      method: 'POST',
      url: nodeUrl(session, `/interactions/${encodeURIComponent(interactionId)}/answer`),
      payload: body,
    });
  });

  /** Images are stored on the session's node, where its agent reads them. */
  app.post('/api/sessions/:id/uploads', async (request, reply) => {
    const session = claim(request);
    if (!Buffer.isBuffer(request.body))
      throw new ApiError(400, 'invalid_input', 'Upload body must be raw image bytes');
    if (!request.body.length || request.body.length > config.uploadMaxBytes)
      throw new ApiError(413, 'payload_too_large', 'Image exceeds configured limit');
    return forward(reply, session.nodeId, request, {
      method: 'POST',
      url: nodeUrl(session, '/uploads'),
      bodyBase64: request.body.toString('base64'),
      contentType: request.headers['content-type']?.split(';', 1)[0] ?? 'application/octet-stream',
    });
  });

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

  // ---- WebSockets -----------------------------------------------------------

  app.get('/api/events', { websocket: true }, (socket, request) => {
    try {
      validateRequest(request, config, true);
      const query = parse(
        z.object({ sessionId: z.string().min(1), cursor: z.string().optional() }),
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
      socket.once('close', unsubscribe);
      socket.once('error', unsubscribe);
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
        validateRequest(request, config, true);
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
        socket.once('close', stream.close);
        socket.once('error', stream.close);
      } catch (error) {
        socket.close(
          wsCloseCode(error),
          error instanceof Error ? error.message.slice(0, 120) : 'invalid request',
        );
      }
    },
  );

  app.addHook('onClose', async () => {
    nodes.close();
    db.close();
  });
  return { app, services };
}
