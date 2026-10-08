import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildNodeApp } from '../src/node/app.js';
import { EnvironmentInteractions } from '../src/node/environment-interactions.js';
import { ApprovalAuthority } from '../src/environment/approvals.js';
import { intentDigest } from '../src/environment/protocol.js';
import { nodeHeaders, testConfig } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
test('human owner/control ingress answers provisioned approvals without a legacy runner', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-ui-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let interactions!: EnvironmentInteractions;
  const { app, services } = await buildNodeApp(testConfig(), {
    environmentInteractions: (db, events) =>
      (interactions = new EnvironmentInteractions(db, events)),
  });
  cleanup.push(() => app.close());
  const session = (
    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: nodeHeaders,
      payload: { workspaceId: 'test' },
    })
  ).json().session;
  const freshId = randomUUID();
  services.db.raw.query('UPDATE sessions SET id=? WHERE id=?').run(freshId, session.id);
  session.id = freshId;
  const generation = (
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/control/acquire`,
      headers: nodeHeaders,
      payload: { clientId: 'human' },
    })
  ).json().lease.generation;
  const epoch = services.db.getSession(session.id).runnerEpoch;
  let authority!: ApprovalAuthority;
  authority = new ApprovalAuthority(path.join(root, 'approvals.sqlite'), (approval) =>
    interactions.publish(approval, epoch, authority),
  );
  cleanup.push(() => authority.close());
  const value = {
    binding: {
      nodeId: 'n',
      workspaceId: 'n:test',
      sessionId: session.id,
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    },
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    capability: 'bash',
    arguments: { command: 'echo test' },
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    budgetMs: 1000,
  };
  // Trusted provisioning maps the qualified transport workspace to the local DB ID.
  const pending = authority.request(
    { ...value, argumentDigest: intentDigest(value) },
    { action: 'danger', title: 'Approve?', message: 'test', finalArgumentDigest: 'c'.repeat(64) },
    new AbortController().signal,
  );
  const interaction = services.db.pendingInteractions(session.id)[0]!;
  expect(services.runners.get(session.id)).toBeUndefined();
  const answer = (generation_: number) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/interactions/${interaction.id}/answer`,
      headers: nodeHeaders,
      payload: { clientId: 'human', generation: generation_, answer: { confirmed: true } },
    });
  expect((await answer(generation + 1)).statusCode).toBe(409);
  expect((await answer(generation)).statusCode).toBe(200);
  expect(await pending).toBe(true);
  expect((await answer(generation)).statusCode).toBe(409);
});
