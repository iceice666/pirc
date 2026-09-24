import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authHook, validateRequest } from './auth.js';
import type { GatewayConfig } from './config.js';
import { GatewayDatabase } from './database.js';
import { ApiError, errorBody } from './errors.js';
import { EventHub } from './events.js';
import { WorkspaceLocks } from './locks.js';
import { NodeRegistry, validNodeToken } from './nodes.js';
import { RunnerManager } from './runner.js';
import type { CommandPayload, EventCursor, Snapshot } from './types.js';
import { id, payloadHash } from './util.js';

const sessionParams = z.object({ id: z.string().min(1) });
const interactionParams = z.object({ id: z.string().min(1), interactionId: z.string().min(1) });
const createSessionBody = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
});
const renameBody = z.object({ name: z.string().trim().min(1).max(200) });
const leaseBody = z.object({
  clientId: z.string().min(1).max(200),
  generation: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
});
const commandPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['prompt', 'steer', 'follow_up']),
    message: z.string().min(1).max(1_000_000),
    uploadIds: z.array(z.string().min(1)).max(16).optional(),
  }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('clear_queue') }),
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
const answerBody = z.object({
  clientId: z.string().min(1),
  generation: z.number().int().positive(),
  answer: z.union([
    z.object({ cancelled: z.literal(true) }),
    z.object({ value: z.string() }),
    z.object({ confirmed: z.boolean() }),
  ]),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(400, 'invalid_input', 'Invalid request', result.error.flatten());
  return result.data;
}

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

function cursorFrom(value: unknown): EventCursor | null {
  if (typeof value !== 'string' || !value) return null;
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) throw new ApiError(400, 'invalid_input', 'cursor must be epoch:sequence');
  return { epoch: Number(match[1]), sequence: Number(match[2]) };
}

export interface GatewayServices {
  db: GatewayDatabase;
  events: EventHub;
  runners: RunnerManager;
  locks: WorkspaceLocks;
  nodes: NodeRegistry;
}

export async function buildApp(
  config: GatewayConfig,
): Promise<{ app: FastifyInstance; services: GatewayServices }> {
  const app = Fastify({ logger: true, bodyLimit: config.uploadMaxBytes });
  await app.register(websocket, { options: { maxPayload: 16_777_216 } });
  for (const mime of [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/octet-stream',
  ]) {
    app.addContentTypeParser(
      mime,
      { parseAs: 'buffer', bodyLimit: config.uploadMaxBytes },
      (_request, body, done) => done(null, body),
    );
  }
  const db = new GatewayDatabase(config.databasePath);
  db.syncWorkspaces(config);
  const recovery = db.recoverStartup();
  app.log.info({ recovery }, 'gateway startup recovery complete');
  const events = new EventHub(config.eventBufferSize);
  const locks = new WorkspaceLocks(config.runnerLimit);
  const runners = new RunnerManager(config, db, events, locks);
  const nodes = new NodeRegistry();
  const services = { db, events, runners, locks, nodes };
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
      if (typeof event.type === 'string')
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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.status(error.statusCode).send(errorBody(error));
    if ((error as any).code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return reply
        .status(413)
        .send(
          errorBody(
            new ApiError(413, 'payload_too_large', 'Request body exceeds configured limit'),
          ),
        );
    app.log.error(error);
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (
      !config.nodeAuthSecret &&
      request.url.split('?', 1)[0] === '/node/connect' &&
      request.headers.upgrade?.toLowerCase() === 'websocket'
    )
      return;
    if (config.nodeAuthSecret) {
      if (request.headers.upgrade?.toLowerCase() === 'websocket')
        throw new ApiError(403, 'forbidden', 'Node HTTP adapter does not expose WebSocket routes');
      const token = request.headers.authorization;
      if (token !== `Bearer ${config.nodeAuthSecret}`)
        throw new ApiError(
          401,
          'unauthenticated',
          'Node request requires its transport credential',
        );
      const user = request.headers[config.identityHeader];
      if (typeof user !== 'string' || !config.allowedUsers.has(user))
        throw new ApiError(403, 'forbidden', 'User is not allowed on this node');
      request.identity = { user };
      return;
    }
    return authHook(config)(request, reply);
  });

  app.get('/node/connect', { websocket: true }, (socket, request) => {
    const nodeId = request.headers['x-pirc-node-id'];
    const auth = request.headers.authorization;
    const token = typeof auth === 'string' && /^Bearer [^ ]+$/.test(auth) ? auth.slice(7) : '';
    if (
      config.nodeAuthSecret ||
      typeof nodeId !== 'string' ||
      !validNodeToken(config, nodeId, token)
    ) {
      socket.close(4401, 'invalid node credentials');
      return;
    }
    nodes.attach(nodeId, socket);
  });
  app.get('/api/nodes', async () => ({ nodes: nodes.list() }));

  app.get('/api/health', async () => ({ ok: true, version: 1, activeRunners: locks.activeCount }));
  app.get('/api/workspaces', async () => ({
    workspaces: db
      .listWorkspaces()
      .map((workspace) =>
        workspace.hostId === config.hostId ? workspace : { ...workspace, canonicalPath: undefined },
      ),
  }));
  app.get('/api/sessions', async (request) => ({
    sessions: db
      .listSessions()
      .filter(
        (session) =>
          (!session.nodeId && !config.nodeAuthSecret) ||
          session.ownerUser === request.identity!.user,
      )
      .map(
        ({
          privateSessionPath: _,
          piSessionId: __,
          partialOutputLost: ___,
          ownerUser: ____,
          ...session
        }) => session,
      ),
  }));
  app.post('/api/sessions', async (request, reply) => {
    const body = parse(createSessionBody, request.body);
    const workspace = db.getWorkspace(body.workspaceId);
    const nodeId = workspace.hostId === config.hostId ? null : workspace.hostId;
    if (nodeId) {
      if (config.nodeAuthSecret)
        throw new ApiError(403, 'forbidden', 'Nodes cannot route to another node');
      if (!nodes.get(nodeId)?.workspaces.some((w) => `${nodeId}:${w.id}` === workspace.id))
        throw new ApiError(503, 'node_offline', 'Node or workspace is offline');
      const remote = await nodes.request(nodeId, 'create', {
        method: 'POST',
        url: '/api/sessions',
        user: request.identity!.user,
        payload: { workspaceId: workspace.id.slice(nodeId.length + 1), name: body.name },
      });
      const session = db.createSession(
        workspace.id,
        body.name,
        `node://${nodeId}/${remote.session.id}`,
        nodeId,
        remote.session.id,
        request.identity!.user,
      );
      return reply.status(201).send({
        session: {
          ...session,
          privateSessionPath: undefined,
          piSessionId: undefined,
          ownerUser: undefined,
          partialOutputLost: undefined,
        },
      });
    }
    const sessionStorage = path.join(config.sessionsDir, id('pi'));
    mkdirSync(sessionStorage, { recursive: true, mode: 0o700 });
    const session = db.createSession(
      workspace.id,
      body.name,
      sessionStorage,
      null,
      null,
      config.nodeAuthSecret ? request.identity!.user : null,
    );
    return reply.status(201).send({
      session: {
        ...session,
        privateSessionPath: undefined,
        piSessionId: undefined,
        ownerUser: undefined,
        partialOutputLost: undefined,
      },
    });
  });
  app.patch('/api/sessions/:id', async (request) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    db.claimRemoteSession(sessionId, request.identity!.user, Boolean(config.nodeAuthSecret));
    const { name } = parse(renameBody, request.body);
    const row = db.getSession(sessionId);
    if (row.nodeId)
      await nodes.request(row.nodeId, 'rename', {
        method: 'PATCH',
        url: `/api/sessions/${encodeURIComponent(row.piSessionId!)}`,
        user: request.identity!.user,
        payload: { name },
      });
    const active = runners.get(sessionId);
    if (active) {
      const response = await active.request({ type: 'set_session_name', name });
      if (!response.success)
        throw new ApiError(503, 'runner_unavailable', response.error ?? 'Pi rejected session name');
    }
    const session = db.renameSession(sessionId, name);
    return {
      session: {
        ...session,
        privateSessionPath: undefined,
        piSessionId: undefined,
        ownerUser: undefined,
        partialOutputLost: undefined,
      },
    };
  });
  app.get('/api/sessions/:id/snapshot', async (request) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    db.claimRemoteSession(sessionId, request.identity!.user, Boolean(config.nodeAuthSecret));
    const sessionRow = db.getSession(sessionId);
    if (sessionRow.nodeId) {
      const remote = await nodes.request(sessionRow.nodeId, 'snapshot', {
        method: 'GET',
        url: `/api/sessions/${encodeURIComponent(sessionRow.piSessionId!)}/snapshot`,
        user: request.identity!.user,
      });
      const {
        privateSessionPath: _remotePath,
        piSessionId: _remotePiId,
        ownerUser: _owner,
        ...publicSession
      } = sessionRow;
      return {
        ...remote,
        session: {
          ...remote.session,
          ...publicSession,
          privateSessionPath: undefined,
          piSessionId: undefined,
          partialOutputLost: undefined,
          ownerUser: undefined,
          runnerState: remote.session.runnerState,
        },
        watermark: events.watermark(sessionId, sessionRow.runnerEpoch),
      };
    }
    const active = runners.get(sessionId);
    let history: unknown[] = active?.state.history ?? [];
    let partialMessage = active?.state.partialMessage ?? null;
    let queue = active?.state.queue ?? { steering: [], followUp: [] };
    let notifications = active?.state.notifications ?? [];
    if (active) {
      try {
        const response = await active.request({ type: 'get_messages' });
        if (response.success && Array.isArray(response.data?.messages))
          history = response.data.messages;
      } catch {
        /* in-memory view is still consistent with watermark */
      }
    }
    const {
      privateSessionPath: _,
      piSessionId: __,
      ownerUser: ___,
      partialOutputLost,
      ...session
    } = db.getSession(sessionId);
    const snapshot: Snapshot = {
      session,
      history,
      partialMessage,
      queue,
      run: db.latestRun(sessionId),
      interactions: db.pendingInteractions(sessionId),
      notifications,
      watermark: events.watermark(sessionId, sessionRow.runnerEpoch),
      partialOutputLost,
    };
    return snapshot;
  });
  app.post('/api/sessions/:id/commands', async (request, reply) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    db.claimRemoteSession(sessionId, request.identity!.user, Boolean(config.nodeAuthSecret));
    const targetSession = db.getSession(sessionId);
    const body = parse(commandBody, request.body);
    db.validateLease(sessionId, body.clientId, body.generation);
    if (targetSession.nodeId) db.validateLeaseUser(sessionId, request.identity!.user);
    const hash = payloadHash(body.payload);
    const received = db.receiveCommand(body.commandId, sessionId, hash, body.payload);
    if (received.duplicate) return { command: received.row, duplicate: true };
    if (targetSession.nodeId) {
      if ('uploadIds' in body.payload && body.payload.uploadIds?.length) {
        db.updateCommand(
          body.commandId,
          'rejected',
          undefined,
          'Remote image uploads are not supported',
        );
        throw new ApiError(400, 'invalid_input', 'Remote image uploads are not supported');
      }
      if (!nodes.get(targetSession.nodeId)) {
        db.updateCommand(body.commandId, 'rejected', undefined, 'Node is offline');
        throw new ApiError(503, 'node_offline', 'Node is offline');
      }
      db.updateCommand(body.commandId, 'dispatched');
      try {
        const remote = await nodes.request(targetSession.nodeId, 'command', {
          method: 'POST',
          url: `/api/sessions/${encodeURIComponent(targetSession.piSessionId!)}/commands`,
          user: request.identity!.user,
          payload: { ...body, generation: body.generation },
        });
        db.updateCommand(
          body.commandId,
          remote.command.status,
          remote.command.result,
          remote.command.error,
        );
      } catch (error) {
        db.updateCommand(body.commandId, 'outcome_unknown', undefined, (error as Error).message);
        const command = db.getCommand(body.commandId);
        return reply.status(503).send({ command, duplicate: false });
      }
      const command = db.getCommand(body.commandId);
      return reply
        .status(command.status === 'accepted' ? 202 : 503)
        .send({ command, duplicate: false });
    }
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

  app.get('/api/sessions/:id/control', async (request) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    db.claimRemoteSession(sessionId, request.identity!.user, Boolean(config.nodeAuthSecret));
    db.getSession(sessionId);
    return { lease: db.getLease(sessionId) };
  });
  app.post('/api/sessions/:id/control/acquire', async (request) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    db.claimRemoteSession(sessionId, request.identity!.user, Boolean(config.nodeAuthSecret));
    const body = parse(leaseBody, request.body);
    const session = db.getSession(sessionId);
    if (session.nodeId) {
      db.checkLeaseUser(sessionId, request.identity!.user, body.force ?? false);
      const remote = await nodes.request(session.nodeId, 'lease', {
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(session.piSessionId!)}/control/acquire`,
        user: request.identity!.user,
        payload: body,
      });
      db.mirrorLease(sessionId, remote.lease, request.identity!.user, body.force ?? false);
      return remote;
    }
    return {
      lease: db.acquireLease(sessionId, body.clientId, body.force ?? false, config.leaseTtlMs),
    };
  });
  app.post('/api/sessions/:id/control/heartbeat', async (request) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    db.claimRemoteSession(sessionId, request.identity!.user, Boolean(config.nodeAuthSecret));
    const body = parse(leaseBody.extend({ generation: z.number().int().positive() }), request.body);
    const session = db.getSession(sessionId);
    if (session.nodeId) {
      db.validateLeaseUser(sessionId, request.identity!.user);
      db.validateLease(sessionId, body.clientId, body.generation);
      const remote = await nodes.request(session.nodeId, 'leaseHeartbeat', {
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(session.piSessionId!)}/control/heartbeat`,
        user: request.identity!.user,
        payload: body,
      });
      db.mirrorLease(sessionId, remote.lease, request.identity!.user, false);
      return remote;
    }
    return {
      lease: db.heartbeatLease(sessionId, body.clientId, body.generation, config.leaseTtlMs),
    };
  });
  app.post('/api/sessions/:id/control/release', async (request, reply) => {
    const { id: sessionId } = parse(sessionParams, request.params);
    db.claimRemoteSession(sessionId, request.identity!.user, Boolean(config.nodeAuthSecret));
    const body = parse(leaseBody.extend({ generation: z.number().int().positive() }), request.body);
    const session = db.getSession(sessionId);
    if (session.nodeId) {
      db.validateLeaseUser(sessionId, request.identity!.user);
      db.validateLease(sessionId, body.clientId, body.generation);
      await nodes.request(session.nodeId, 'leaseRelease', {
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(session.piSessionId!)}/control/release`,
        user: request.identity!.user,
        payload: body,
      });
    }
    if (session.nodeId) db.clearRemoteLease(sessionId);
    else db.releaseLease(sessionId, body.clientId, body.generation);
    return reply.status(204).send();
  });

  app.post('/api/sessions/:id/interactions/:interactionId/answer', async (request) => {
    const params = parse(interactionParams, request.params);
    db.claimRemoteSession(params.id, request.identity!.user, Boolean(config.nodeAuthSecret));
    const body = parse(answerBody, request.body);
    const session = db.getSession(params.id);
    db.validateLease(params.id, body.clientId, body.generation);
    if (session.nodeId) db.validateLeaseUser(params.id, request.identity!.user);
    if (session.nodeId) {
      return nodes.request(session.nodeId, 'answer', {
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(session.piSessionId!)}/interactions/${encodeURIComponent(params.interactionId)}/answer`,
        user: request.identity!.user,
        payload: body,
      });
    }
    const active = runners.get(params.id);
    if (!active || active.epoch !== session.runnerEpoch)
      throw new ApiError(409, 'stale_interaction', 'Interaction belongs to an inactive runner');
    const interaction = db.claimInteraction(
      params.interactionId,
      params.id,
      active.epoch,
      body.answer,
    );
    await runners.answer(params.id, active.epoch, interaction.rpcId, body.answer);
    events.publish(params.id, active.epoch, 'interaction_answered', {
      interactionId: interaction.id,
    });
    return { interactionId: interaction.id, status: 'answered' };
  });

  app.post('/api/uploads', async (request, reply) => {
    if (!Buffer.isBuffer(request.body))
      throw new ApiError(400, 'invalid_input', 'Upload body must be raw image bytes');
    const buffer = request.body;
    if (!buffer.length || buffer.length > config.uploadMaxBytes)
      throw new ApiError(413, 'payload_too_large', 'Image exceeds configured limit');
    const mimeType = sniffImage(buffer);
    if (!mimeType) throw new ApiError(400, 'invalid_input', 'Unsupported or invalid image content');
    const declared = request.headers['content-type']?.split(';', 1)[0];
    if (declared && declared !== 'application/octet-stream' && declared !== mimeType)
      throw new ApiError(
        400,
        'invalid_input',
        'Declared Content-Type does not match image content',
      );
    if (config.nodeTokens?.size)
      throw new ApiError(400, 'invalid_input', 'Uploads are not yet available in multi-node mode');
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
    );
    return reply.status(201).send({ upload: { id: uploadId, mimeType, byteSize: buffer.length } });
  });
  app.get('/api/models', async (request) => {
    const query = parse(z.object({ sessionId: z.string().optional() }), request.query);
    if (!query.sessionId && db.listSessions().every((session) => session.nodeId))
      return { models: [] };
    if (query.sessionId) {
      db.claimRemoteSession(
        query.sessionId,
        request.identity!.user,
        Boolean(config.nodeAuthSecret),
      );
      const session = db.getSession(query.sessionId);
      if (session.nodeId) {
        const remote = await nodes.request(session.nodeId, 'models', {
          method: 'GET',
          url: `/api/models?sessionId=${encodeURIComponent(session.piSessionId!)}`,
          user: request.identity!.user,
        });
        return remote;
      }
    }
    const response = await runners.models(query.sessionId);
    if (!response.success)
      throw new ApiError(503, 'runner_unavailable', response.error ?? 'Unable to list models');
    return response.data;
  });

  app.get('/api/events', { websocket: true }, (socket, request) => {
    try {
      if (!config.nodeAuthSecret) validateRequest(request, config, true);
      else if (!request.identity)
        throw new ApiError(401, 'unauthenticated', 'Node credential required');
      const query = parse(
        z.object({ sessionId: z.string().min(1), cursor: z.string().optional() }),
        request.query,
      );
      db.claimRemoteSession(
        query.sessionId,
        request.identity!.user,
        Boolean(config.nodeAuthSecret),
      );
      const session = db.getSession(query.sessionId);
      const replay = events.replay(query.sessionId, cursorFrom(query.cursor), session.runnerEpoch);
      const send = (message: unknown) => {
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > config.websocketMaxBufferedBytes) {
          socket.send(
            JSON.stringify({
              type: 'reset',
              reason: 'backpressure',
              watermark: events.watermark(query.sessionId, session.runnerEpoch),
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
      const unsubscribe = events.subscribe(query.sessionId, send);
      socket.once('close', unsubscribe);
      socket.once('error', unsubscribe);
    } catch (error) {
      const status = error instanceof ApiError ? error.statusCode : 500;
      socket.close(
        status === 401 ? 4401 : status === 403 ? 4403 : 4400,
        error instanceof Error ? error.message.slice(0, 120) : 'invalid request',
      );
    }
  });

  app.addHook('onClose', async () => {
    nodes.close();
    await runners.shutdown();
    db.close();
  });
  return { app, services };
}
