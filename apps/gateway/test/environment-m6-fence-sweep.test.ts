import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { LocalEnvironment, type EnvironmentExecutor } from '../src/environment/service.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { NodeWriterFence } from '../src/gateway-runtime/node-writer-fence.js';
import { adoptRetiredGenerations } from '../src/node/environment-supervisor.js';
import { buildNodeApp } from '../src/node/app.js';
import {
  descriptorDigest,
  intentDigest,
  type Binding,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
import { testConfig } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const binding = (nodeId = 'n'): Binding => ({
  nodeId,
  workspaceId: `${nodeId}:w`,
  sessionId: randomUUID(),
  writerEpoch: randomUUID(),
  executorEpoch: randomUUID(),
});
function descriptorFor(bound: Binding): Descriptor {
  const content: Omit<Descriptor, 'revision'> = {
    binding: bound,
    version: 1,
    policyRevision: 'a'.repeat(64),
    capabilityCatalog: [
      {
        name: 'read',
        argumentSchema: {},
        resultSchema: {},
        placement: 'node',
        effects: 'read',
        concurrency: 'read',
        approval: 'policy',
        hookRevision: 'b'.repeat(64),
      },
    ],
    instructions: '',
    skills: [],
    role: 'coding',
    platform: 'linux',
    cwdDisplay: '/fixture',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  return { ...content, revision: descriptorDigest(content) };
}
function intentFor(descriptor: Descriptor): ExecutionIntent {
  const value = {
    binding: descriptor.binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    capability: 'read',
    arguments: {},
    descriptorRevision: descriptor.revision,
    policyRevision: descriptor.policyRevision,
    budgetMs: 1000,
  };
  return { ...value, argumentDigest: intentDigest(value) };
}
const never: EnvironmentExecutor = {
  healthy: true,
  async execute() {
    throw new Error('must not execute');
  },
};

test('R4: provisioning requires the durable writer fence; revocation retires the journal generation', async () => {
  const journal = new ExecutionJournal(':memory:');
  const fence = new NodeWriterFence(':memory:', 'n', journal);
  cleanups.push(
    () => journal.close(),
    () => fence.close(),
  );
  const local = new LocalEnvironment({ nodeId: 'n', journal, authorize: () => {}, fence });
  const unfenced = descriptorFor(binding());
  expect(() => local.provision(unfenced, never)).toThrow('Unfenced');
  expect(journal.isProvisioned(unfenced.binding)).toBe(false);
  const descriptor = descriptorFor(binding());
  await fence.fence(
    { transferId: randomUUID(), binding: descriptor.binding, legacySessionIds: [] },
    async () => {},
  );
  local.provision(descriptor, never);
  expect(journal.isRetired(descriptor.binding)).toBe(false);
  fence.revoke(descriptor.binding);
  expect(journal.isRetired(descriptor.binding)).toBe(true);
  await expect(local.start(intentFor(descriptor))).rejects.toThrow('Retired generation');
  // A fresh environment (e.g. after restart) cannot provision a revoked generation.
  const again = new LocalEnvironment({ nodeId: 'n', journal, authorize: () => {}, fence });
  expect(() => again.provision(descriptor, never)).toThrow('revoked');
  // Revoking a generation the journal never saw only records the fence.
  const other = binding();
  fence.revoke(other);
  expect(journal.isProvisioned(other)).toBe(false);
});

test('R4: an existing un-retired generation is never re-provisioned with a new executor', () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const descriptor = descriptorFor(binding());
  new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  }).provision(descriptor, never);
  // Simulated restart without a sweep: a new LocalEnvironment on the same journal.
  const restarted = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  expect(() => restarted.provision(descriptor, never)).toThrow('already provisioned');
  // The adoption path stays read-only and requires the generation to be fenced first.
  expect(() => restarted.adoptRetired(descriptor.binding)).toThrow('not fenced');
  journal.recoverAndRetire(descriptor.binding);
  restarted.adoptRetired(descriptor.binding);
});

test('R5: recover and retire commit together', () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const descriptor = descriptorFor(binding());
  journal.provision(descriptor.binding, descriptor.revision, descriptor.policyRevision);
  const running = intentFor(descriptor);
  const accepted = intentFor(descriptor);
  journal.accept(running);
  journal.claim(descriptor.binding, running.executionId);
  journal.accept(accepted);
  const recovered = journal.recoverAndRetire(descriptor.binding);
  expect(recovered.map((record) => [record.state, record.effect]).sort()).toEqual([
    ['failed', 'not_started'],
    ['unknown', 'unknown'],
  ]);
  expect(journal.isRetired(descriptor.binding)).toBe(true);
  // A failure inside the transaction rolls back both halves.
  const broken = descriptorFor(binding());
  journal.provision(broken.binding, broken.revision, broken.policyRevision);
  const work = intentFor(broken);
  journal.accept(work);
  journal.claim(broken.binding, work.executionId);
  const original = (journal as unknown as { retire(binding: Binding): void }).retire;
  (journal as unknown as { retire(binding: Binding): void }).retire = () => {
    throw new Error('crash before retire');
  };
  expect(() => journal.recoverAndRetire(broken.binding)).toThrow('crash before retire');
  (journal as unknown as { retire(binding: Binding): void }).retire = original;
  expect(journal.status(broken.binding, work.executionId).state).toBe('running');
  expect(journal.isRetired(broken.binding)).toBe(false);
});

test('R5: node startup sweeps generations left by an abrupt crash before admitting work; no replay', async () => {
  const config = testConfig();
  const first = await buildNodeApp(config);
  let firstOpen = true;
  cleanups.push(() => firstOpen && first.app.close());
  const journal = first.services.environmentJournal;
  const live = descriptorFor(binding('test'));
  const local = new LocalEnvironment({
    nodeId: 'test',
    journal,
    authorize: () => {},
    fence: first.services.writerFence,
  });
  await first.services.writerFence.fence(
    { transferId: randomUUID(), binding: live.binding, legacySessionIds: [] },
    async () => {},
  );
  local.provision(live, never);
  const running = intentFor(live);
  const accepted = intentFor(live);
  journal.accept(running);
  journal.claim(live.binding, running.executionId);
  journal.accept(accepted);
  // A quarantined generation keeps its quarantine; a retired one with a stuck record is recovered too.
  const fenced = descriptorFor(binding('test'));
  journal.provision(fenced.binding, fenced.revision, fenced.policyRevision);
  const stuck = intentFor(fenced);
  journal.accept(stuck);
  journal.claim(fenced.binding, stuck.executionId);
  journal.retire(fenced.binding);
  // Abrupt stop: nothing fenced or recovered the live generation.
  firstOpen = false;
  await first.app.close();

  const second = await buildNodeApp(config);
  cleanups.push(() => second.app.close());
  const swept = second.services.sweptGenerations.map((entry) => entry.sessionId).sort();
  expect(swept).toEqual([live.binding.sessionId, fenced.binding.sessionId].sort());
  const after = second.services.environmentJournal;
  expect(after.isRetired(live.binding)).toBe(true);
  expect(after.status(live.binding, running.executionId)).toMatchObject({
    state: 'unknown',
    effect: 'unknown',
  });
  expect(after.status(live.binding, accepted.executionId)).toMatchObject({
    state: 'failed',
    effect: 'not_started',
  });
  expect(after.status(fenced.binding, stuck.executionId).state).toBe('unknown');
  // The old executor epoch cannot come back, and its IDs cannot start again.
  const restarted = new LocalEnvironment({
    nodeId: 'test',
    journal: after,
    authorize: () => {},
    fence: second.services.writerFence,
  });
  expect(() => restarted.provision(live, never)).toThrow('Retired generation');
  expect(() => after.accept(intentFor(live))).toThrow('Retired generation');
  // The swept generations are adopted read-only for gateway reconciliation.
  const adopted = adoptRetiredGenerations(restarted, after, 'test');
  expect(adopted.map((entry) => entry.sessionId).sort()).toEqual(swept);
  expect((await restarted.status(live.binding, running.executionId)).state).toBe('unknown');
  await expect(restarted.status(live.binding, randomUUID())).rejects.toThrow('never accepted');
  // A second restart has nothing left to sweep.
  await second.app.close();
  cleanups.pop();
  const third = await buildNodeApp(config);
  cleanups.push(() => third.app.close());
  expect(third.services.sweptGenerations).toEqual([]);
});
