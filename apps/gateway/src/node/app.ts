/**
 * The node's local router. It never listens on a port: the node runtime
 * replays daemon requests on it with `app.inject`, so every request carries
 * the browser user the daemon authenticated. Sessions are owned by the user
 * who created them, and every session route checks that owner.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { NodeConfig } from '../config.js';
import { GatewayDatabase } from '../database.js';
import { ApiError } from '../errors.js';
import { EventHub } from '../events.js';
import { registerErrorHandler, registerImageParsers } from '../http.js';
import { ModelStore } from '../models.js';
import { NODE_USER_HEADER } from '../protocol.js';
import { applySessionName, publicSession } from '../session-name.js';
import type { CommandPayload, Snapshot } from '../types.js';
import { id, parse, payloadHash } from '../util.js';
import { WorkspaceLocks } from './locks.js';
import { registerPanelRoutes, type TerminalStreams } from './panel-routes.js';
import { RunnerManager } from './runner.js';
import type { TerminalManager } from './terminals.js';

const sessionParams = z.object({ id: z.string().min(1) });
const createWorkspaceBody = z.object({
  path: z.string().trim().min(1).max(4096),
  displayName: z.string().trim().min(1).max(200),
});
const interactionParams = z.object({ id: z.string().min(1), interactionId: z.string().min(1) });
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
  locks: WorkspaceLocks;
  /** Providers from the daemon, used for agents started from now on. */
  models: ModelStore;
  terminals: TerminalManager;
  terminalStreams: TerminalStreams;
}

export async function buildNodeApp(
  config: NodeConfig,
): Promise<{ app: FastifyInstance; services: NodeServices }> {
  const app = Fastify({ logger: true, bodyLimit: config.uploadMaxBytes });
  registerImageParsers(app, config.uploadMaxBytes);
  const db = new GatewayDatabase(config.databasePath);
  db.syncWorkspaces(config.nodeId, config.workspaces);
  const recovery = db.recoverStartup();
  app.log.info({ recovery }, 'node startup recovery complete');
  const events = new EventHub(config.eventBufferSize);
  const locks = new WorkspaceLocks(config.runnerLimit);
  // Filled by the daemon on registration; agents started before that get no providers.
  const models = new ModelStore();
  const runners = new RunnerManager(config, db, events, locks, models);
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
    const workspace = db.addWorkspace(
      id('workspace').replaceAll('-', '_'),
      config.nodeId,
      body.displayName,
      canonical,
    );
    return reply.status(201).send({ workspace });
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
    const { id: sessionId } = claim(request);
    const active = runners.get(sessionId);
    let history: unknown[] = active?.state.history ?? [];
    let agent: Snapshot['agent'] = null;
    if (active) {
      try {
        const response = await active.request({ type: 'get_messages' });
        if (response.success && Array.isArray(response.data?.messages))
          history = response.data.messages;
      } catch {
        /* in-memory view is still consistent with watermark */
      }
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
    };
    return snapshot;
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

  /** Images are stored on the node that runs the session's agent. */
  app.post('/api/sessions/:id/uploads', async (request, reply) => {
    claim(request);
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

  const { terminals, terminalStreams } = registerPanelRoutes(app, {
    config,
    db,
    runners,
    models,
    claim,
  });

  app.addHook('onClose', async () => {
    terminals.shutdown();
    await runners.shutdown();
    db.close();
  });
  return { app, services: { db, events, runners, locks, models, terminals, terminalStreams } };
}
