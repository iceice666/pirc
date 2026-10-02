/**
 * Browser API for the single operator's model backends. Routes sit behind the
 * gateway's global forward-auth hook (trusted proxy, Host/Origin, identity).
 * Responses are secret-free snapshots; credentials never leave the gateway.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../util.js';
import type { BackendService } from './service.js';

const idParams = z.object({ id: z.string().min(1).max(200) });
const startBody = z
  .object({ providerId: z.string().min(1).max(100), policyConsent: z.boolean().optional() })
  .strict();
const inputBody = z
  .object({ promptId: z.string().min(1).max(100), value: z.string().max(16_384).optional() })
  .strict();

export function registerBackendRoutes(app: FastifyInstance, backends: BackendService): void {
  app.register(async (scope) => {
    // Settings and authorization state must never be cached by the browser or a proxy.
    scope.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    const owner = (request: { identity?: { user: string } }) => request.identity!.user;

    scope.get('/api/providers', async () => backends.snapshot());
    scope.get('/api/providers/presets', async () => ({ presets: backends.presets() }));
    // Probes of an unsaved form: keys are write-only and never returned.
    scope.post('/api/providers/discover', async (request) => ({
      models: await backends.discover(request.body ?? {}),
    }));
    scope.post('/api/providers/test', async (request) => backends.testProvider(request.body ?? {}));
    scope.post('/api/providers', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { id, ...rest } = body;
      backends.saveProvider(typeof id === 'string' ? id : '', rest, true);
      return reply.status(201).send(backends.snapshot());
    });
    // Static route wins over `:id`; `default-model` is not a valid backend ID.
    scope.put('/api/providers/default-model', async (request) => {
      backends.setDefault(request.body ?? null);
      return backends.snapshot();
    });
    scope.put('/api/providers/:id', async (request) => {
      backends.saveProvider(parse(idParams, request.params).id, request.body ?? {});
      return backends.snapshot();
    });
    scope.delete('/api/providers/:id', async (request) => {
      backends.deleteProvider(parse(idParams, request.params).id);
      return backends.snapshot();
    });

    scope.post('/api/provider-auth/sessions', async (request, reply) => {
      const body = parse(startBody, request.body ?? {});
      return reply
        .status(201)
        .send(backends.startAuth(owner(request), body.providerId, body.policyConsent === true));
    });
    scope.get('/api/provider-auth/sessions/:id', async (request) =>
      backends.authStatus(owner(request), parse(idParams, request.params).id),
    );
    scope.post('/api/provider-auth/sessions/:id/input', async (request) => {
      const body = parse(inputBody, request.body ?? {});
      return backends.authInput(
        owner(request),
        parse(idParams, request.params).id,
        body.promptId,
        body.value,
      );
    });
    scope.delete('/api/provider-auth/sessions/:id', async (request) =>
      backends.cancelAuth(owner(request), parse(idParams, request.params).id),
    );
  });
}
