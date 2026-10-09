import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { buildNodeApp } from '../src/node/app.js';
import { testConfig, nodeHeaders } from './helpers.js';
import type { FastifyInstance } from 'fastify';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

test('real node startup restores quarantine before leases and fences all legacy dispatch paths across restart', async () => {
  const config = testConfig();
  const first = await buildNodeApp(config);
  apps.push(first.app);
  const created = await first.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: nodeHeaders,
    payload: { workspaceId: 'test' },
  });
  const id = created.json().session.id;
  const binding = {
    nodeId: 'test',
    workspaceId: 'test:test',
    sessionId: randomUUID(),
    writerEpoch: randomUUID(),
    executorEpoch: randomUUID(),
  };
  first.services.environmentJournal.provision(binding, 'a'.repeat(64), 'b'.repeat(64));
  first.services.environmentJournal.quarantine(binding, [config.workspaces[0]!.path]);
  await first.services.writerFence.fence(
    { transferId: randomUUID(), binding, legacySessionIds: [id] },
    async () => {},
  );
  await first.app.close();
  apps.splice(apps.indexOf(first.app), 1);
  const second = await buildNodeApp(config);
  apps.push(second.app);
  expect(second.services.writes.acquire(randomUUID(), config.workspaces[0]!.path).granted).toBe(
    false,
  );
  expect(second.services.writes.acquire(randomUUID(), '/unrelated-workspace').granted).toBe(true);
  await expect(
    second.services.runners.dispatch(
      id,
      randomUUID(),
      { type: 'prompt', message: 'must not launch' },
      'test@example.com',
    ),
  ).rejects.toThrow('fenced');
  await expect(
    second.services.runners.deliver(id, {
      customType: 'scheduled-run',
      content: 'must not launch',
    }),
  ).rejects.toThrow('fenced');
  expect(second.services.runners.get(id)).toBeUndefined();
});
