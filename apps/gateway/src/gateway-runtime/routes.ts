import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { parse } from '../util.js';
import type { GatewayAgentRuntime } from './runtime.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import { turnInputSchema } from './turn-contracts.js';
import { thinkingLevels } from '../models.js';

/**
 * Explicit opt-in route registrar for a fresh-runtime app. Never registered by
 * the production daemon while platform/cutover gates remain open. The host app
 * supplies the existing forward/device authentication and trusted writer lookup.
 */
export function registerGatewayRuntimeRoutes(
  app: FastifyInstance,
  options: {
    runtime: GatewayAgentRuntime;
    authority: GatewaySessionAuthority;
    authenticate(request: FastifyRequest, mutation: boolean): void;
    writer(sessionId: string, owner: string): WriterLease;
  },
) {
  const session = (request: FastifyRequest, mutation = false) => {
    options.authenticate(request, mutation);
    const owner = request.identity?.user;
    if (!owner) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    const { id } = parse(z.object({ id: z.string().uuid() }).strict(), request.params);
    try {
      options.authority.assertOwner(id, owner);
    } catch {
      throw new ApiError(403, 'forbidden', 'Session unavailable to this user');
    }
    return { id, owner };
  };
  app.get('/api/sessions/:id/snapshot', async (request) => {
    const { id, owner } = session(request);
    const { offset } = parse(
      z.object({ offset: z.coerce.number().int().nonnegative().default(0) }).strict(),
      request.query,
    );
    return { authority: 'gateway', ...options.runtime.project(id, owner, undefined, offset) };
  });
  app.get('/api/sessions/:id/panel/context', async (request) => {
    const { id, owner } = session(request);
    const snapshot = options.authority.contextSnapshot(id, owner);
    if (!snapshot)
      throw new ApiError(404, 'no_context', 'Send a message first to inspect its context');
    return { snapshot, source: 'gateway-authority' };
  });
  app.get('/api/sessions/:id/events', async (request) => {
    const { id, owner } = session(request);
    const { after } = parse(
      z.object({ after: z.coerce.number().int().nonnegative().default(0) }).strict(),
      request.query,
    );
    return { events: options.authority.events(id, owner, after) };
  });
  app.get('/api/sessions/:id/recap', async (request) => {
    const { id, owner } = session(request);
    const lease = options.writer(id, owner);
    if (lease.binding.sessionId !== id)
      throw new ApiError(403, 'forbidden', 'Writer session mismatch');
    const { days } = parse(
      z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).strict(),
      request.query,
    );
    return options.authority.recap(lease.binding.workspaceId, owner, days);
  });
  const file = (request: FastifyRequest) => {
    options.authenticate(request, false);
    const owner = request.identity?.user;
    if (!owner) throw new ApiError(401, 'unauthenticated', 'Authentication required');
    const params = parse(
      z.object({ id: z.string().uuid(), artifactId: z.string().uuid() }).strict(),
      request.params,
    );
    try {
      options.authority.assertOwner(params.id, owner);
    } catch {
      throw new ApiError(403, 'forbidden', 'Session unavailable to this user');
    }
    return { ...params, owner };
  };
  app.get('/api/sessions/:id/artifacts/:artifactId', async (request) => {
    const { id, owner, artifactId } = file(request);
    return options.runtime.fileReference(id, owner, artifactId);
  });
  app.get('/api/sessions/:id/artifacts/:artifactId/content', async (request, reply) => {
    const { id, owner, artifactId } = file(request);
    const reference = options.runtime.fileReference(id, owner, artifactId);
    if (reference.availability !== 'available')
      throw new ApiError(503, 'node_offline', 'Artifact node unavailable');
    const bytes = await options.runtime.fileContent(id, owner, artifactId);
    // An untrusted node MIME cannot turn private artifacts into active origin content.
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .type(
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(reference.mimeType)
          ? reference.mimeType
          : 'application/octet-stream',
      )
      .send(bytes);
  });
  app.post('/api/sessions/:id/commands', async (request) => {
    const { id, owner } = session(request, true);
    const command = parse(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('prompt'), input: turnInputSchema }).strict(),
        z.object({ type: z.literal('steer'), input: turnInputSchema }).strict(),
        z.object({ type: z.literal('stop') }).strict(),
        z
          .object({
            type: z.literal('set_model'),
            provider: z.string().min(1).max(256),
            modelId: z.string().min(1).max(256),
          })
          .strict(),
        z.object({ type: z.literal('set_thinking'), thinking: z.enum(thinkingLevels) }).strict(),
      ]),
      request.body,
    );
    const lease = options.writer(id, owner);
    if (lease.binding.sessionId !== id)
      throw new ApiError(403, 'forbidden', 'Writer session mismatch');
    if (command.type === 'prompt')
      return { run: await options.runtime.run(lease, owner, command.input) };
    if (command.type === 'steer') options.runtime.steer(lease, owner, command.input);
    else if (command.type === 'set_model')
      options.runtime.selectModel(lease, owner, command.provider, command.modelId);
    else if (command.type === 'set_thinking')
      options.runtime.selectThinking(lease, owner, command.thinking);
    else await options.runtime.cancel(id, owner);
    return { ok: true };
  });
  app.post('/api/sessions/:id/reconcile', async (request) => {
    const { id, owner } = session(request, true);
    const { after } = parse(
      z.object({ after: z.number().int().nonnegative().default(0) }).strict(),
      request.body ?? {},
    );
    return options.runtime.reconcile(id, owner, after);
  });
}
