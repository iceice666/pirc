import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalEnvironment,
  dispatchEnvironment,
  type EnvironmentExecutor,
} from '../src/environment/service.js';
import { EnvironmentCodeError, ExecutionJournal } from '../src/environment/journal.js';
import {
  descriptorDigest,
  intentDigest,
  type Binding,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const binding = (): Binding => ({
  nodeId: 'n',
  workspaceId: 'n:w',
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
function intentFor(descriptor: Descriptor, executionId = randomUUID()): ExecutionIntent {
  const value = {
    binding: descriptor.binding,
    executionId,
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
const counting = (): EnvironmentExecutor & { runs: number } => {
  const value = {
    healthy: true,
    runs: 0,
    async execute() {
      value.runs++;
      return {
        state: 'completed' as const,
        effect: 'completed' as const,
        artifacts: [],
        truncated: false,
      };
    },
  };
  return value;
};
const errorCode = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof EnvironmentCodeError ? error.code : (error as Error).message;
  }
  return undefined;
};
const tempFile = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pirc-m6-tomb-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'journal.sqlite');
};
const tombstones = (file: string) => {
  const db = new Database(file, { readonly: true });
  try {
    return (db.query('SELECT count(*) AS n FROM env_tombstones').get() as { n: number }).n;
  } finally {
    db.close();
  }
};

test('R1: status of a never-accepted ID tombstones it durably; a late start never runs, even after restart', async () => {
  const file = tempFile();
  let journal = new ExecutionJournal(file);
  const descriptor = descriptorFor(binding());
  let run = counting();
  let local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  local.provision(descriptor, run);
  const lost = intentFor(descriptor);
  const reply = await dispatchEnvironment(local, {
    version: 1,
    requestId: randomUUID(),
    type: 'execution.status',
    binding: descriptor.binding,
    executionId: lost.executionId,
  });
  expect(reply.type === 'environment.error' && reply.error.code).toBe('unknown_execution');
  // Committed (FULL) before the reply: visible to an independent connection.
  expect(tombstones(file)).toBe(1);
  // Repeated queries stay stable and do not add rows.
  await expect(local.status(descriptor.binding, lost.executionId)).rejects.toThrow(
    'never accepted',
  );
  expect(tombstones(file)).toBe(1);
  const late = await dispatchEnvironment(local, {
    version: 1,
    requestId: randomUUID(),
    type: 'execution.start',
    intent: lost,
  });
  expect(late.type === 'environment.error' && late.error.code).toBe('conflict');
  expect(errorCode(() => journal.status(descriptor.binding, lost.executionId))).toBe('unknown');
  await Bun.sleep(10);
  expect(run.runs).toBe(0);
  // Restart: the tombstone survives; the swept/retired generation still refuses it,
  // and the ID still reports unknown_execution through the adopted generation.
  await local.close();
  journal.close();
  journal = new ExecutionJournal(file);
  cleanups.push(() => journal.close());
  expect(errorCode(() => journal.accept(lost))).toBe('conflict');
  journal.sweepStartup();
  run = counting();
  local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  local.adoptRetired(descriptor.binding);
  await expect(local.status(descriptor.binding, lost.executionId)).rejects.toThrow(
    'never accepted',
  );
  expect(run.runs).toBe(0);
});

test('R1: cancel of a never-accepted ID tombstones it as well', async () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const descriptor = descriptorFor(binding());
  const run = counting();
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  local.provision(descriptor, run);
  const lost = intentFor(descriptor);
  const reply = await dispatchEnvironment(local, {
    version: 1,
    requestId: randomUUID(),
    type: 'execution.cancel',
    binding: descriptor.binding,
    executionId: lost.executionId,
  });
  expect(reply.type === 'environment.error' && reply.error.code).toBe('unknown_execution');
  await expect(local.start(lost)).rejects.toThrow('tombstoned');
  await Bun.sleep(10);
  expect(run.runs).toBe(0);
});

test('R1: tombstones and lookups are strictly per binding; guessing across bindings leaks nothing', async () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const a = descriptorFor(binding());
  const b = descriptorFor(binding());
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  const runs = counting();
  local.provision(a, runs);
  local.provision(b, counting());
  // A real execution of A, guessed from B: same answer as a random ID, A unaffected.
  const real = intentFor(a);
  await local.start(real);
  await Bun.sleep(10);
  await expect(local.status(b.binding, real.executionId)).rejects.toThrow('never accepted');
  expect((await local.status(a.binding, real.executionId)).state).toBe('completed');
  // An ID tombstoned in A does not affect B's lookups or admission.
  const shared = randomUUID();
  await expect(local.status(a.binding, shared)).rejects.toThrow('never accepted');
  const inB = intentFor(b, shared);
  expect((await local.start(inB)).executionId).toBe(shared);
  await Bun.sleep(10);
  expect((await local.status(b.binding, shared)).state).toBe('completed');
  await expect(local.status(a.binding, shared)).rejects.toThrow('never accepted');
  expect(errorCode(() => journal.accept(intentFor(a, shared)))).toBe('conflict');
});

test('R1: retired generations answer unknown_execution without tombstones; unknown bindings stay invalid', () => {
  const file = tempFile();
  const journal = new ExecutionJournal(file);
  cleanups.push(() => journal.close());
  const descriptor = descriptorFor(binding());
  journal.provision(descriptor.binding, descriptor.revision, descriptor.policyRevision);
  journal.retire(descriptor.binding);
  expect(errorCode(() => journal.query(descriptor.binding, randomUUID()))).toBe(
    'unknown_execution',
  );
  expect(errorCode(() => journal.cancel(descriptor.binding, randomUUID()))).toBe(
    'unknown_execution',
  );
  expect(tombstones(file)).toBe(0);
  expect(errorCode(() => journal.query(binding(), randomUUID()))).toBe('invalid_binding');
  expect(tombstones(file)).toBe(0);
});

test('R1: compacted (acknowledged and reclaimed) records report expired, never unknown_execution', () => {
  let now = 1_000_000;
  const journal = new ExecutionJournal(':memory:', () => now);
  cleanups.push(() => journal.close());
  const descriptor = descriptorFor(binding());
  journal.provision(descriptor.binding, descriptor.revision, descriptor.policyRevision);
  const intent = intentFor(descriptor);
  journal.accept(intent);
  journal.claim(descriptor.binding, intent.executionId);
  const done = journal.finish(descriptor.binding, intent.executionId, {
    state: 'completed',
    effect: 'completed',
    artifacts: [],
    truncated: false,
  });
  journal.ack(descriptor.binding, intent.executionId, done.resultDigest!);
  now += 2 * 86_400_000;
  journal.retire(descriptor.binding);
  expect(journal.compactRetired(descriptor.binding)).toBe(1);
  expect(errorCode(() => journal.query(descriptor.binding, intent.executionId))).toBe('expired');
});
