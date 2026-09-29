/**
 * Where the user gets push notifications: this browser (Web Push) or a
 * paired phone (UnifiedPush). A device token subscribes its own phone, and
 * the subscription goes with the token.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../util.js';
import { subscriptionBody, type Push } from './push.js';

const removeBody = z
  .object({ endpoint: z.string().max(2000).optional(), id: z.string().max(100).optional() })
  .strict()
  .refine((body) => body.endpoint || body.id, 'endpoint or id is required');

export function registerPushRoutes(app: FastifyInstance, push: Push): void {
  /** The key a browser subscribes with, and where notifications go now. */
  app.get('/api/push', async (request) => ({
    publicKey: push.publicKey,
    subscriptions: push.list(request.identity!.user),
  }));

  app.post('/api/push/subscriptions', async (request, reply) => {
    const body = parse(subscriptionBody, request.body);
    const subscription = push.subscribe(
      request.identity!.user,
      body,
      request.identity!.deviceId ?? null,
    );
    return reply.status(201).send({ subscription });
  });

  app.delete('/api/push/subscriptions', async (request, reply) => {
    const body = parse(removeBody, request.body ?? {});
    push.unsubscribe(request.identity!.user, body);
    return reply.status(204).send();
  });

  /** A test notification to every place; answers how many took it. */
  app.post('/api/push/test', async (request) => ({
    delivered: await push.notify(request.identity!.user, {
      title: 'pirc notifications work',
      body: 'Scheduled runs and anything waiting for you will show up here.',
      tag: 'test',
      target: { schedules: true },
    }),
  }));
}
