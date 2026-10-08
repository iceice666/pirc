import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionJournal } from '../src/environment/journal.js';
import { ApprovalAuthority } from '../src/environment/approvals.js';
import { intentDigest } from '../src/environment/protocol.js';
import type { LocalEnvironment } from '../src/environment/service.js';
import {
  EnvironmentCleanupUnverified,
  type SandboxedEnvironmentExecutor,
} from '../src/node/environment-executor.js';
import {
  fenceEnvironment,
  restoreEnvironmentQuarantines,
} from '../src/node/environment-supervisor.js';
import { WriteBroker } from '../src/node/write-broker.js';
import { replaceEnvironment } from '../src/node/environment-refresh.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function fixture(error?: Error) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-supervisor-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'journal.sqlite');
  let journal = new ExecutionJournal(file);
  cleanups.push(() => journal.close());
  const approvals = new ApprovalAuthority(':memory:', () => {});
  cleanups.push(() => approvals.close());
  const binding = {
    nodeId: 'n',
    workspaceId: 'n:w',
    sessionId: randomUUID(),
    writerEpoch: randomUUID(),
    executorEpoch: randomUUID(),
  };
  const value = {
    binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    capability: 'bash',
    arguments: {},
    budgetMs: 10_000,
  };
  const intent = { ...value, argumentDigest: intentDigest(value) };
  journal.provision(binding, intent.descriptorRevision, intent.policyRevision);
  journal.accept(intent);
  journal.claim(binding, intent.executionId);
  const writes = new WriteBroker();
  writes.acquire(binding.sessionId, root);
  const executor = {
    async closeAndWait() {
      if (error) throw error;
    },
  } as SandboxedEnvironmentExecutor;
  const environment = { async quiesceBinding() {} } as unknown as LocalEnvironment;
  const fence = () =>
    fenceEnvironment({ binding, journal, writes, approvals, executor, environment });
  const reopen = () => {
    journal.close();
    journal = new ExecutionJournal(file);
    return journal;
  };
  return {
    root,
    binding,
    intent,
    writes,
    journal,
    approvals,
    executor,
    environment,
    fence,
    reopen,
  };
}

test('drained executor with unverified descendants reconciles but retains a durable quarantine', async () => {
  const f = fixture(new EnvironmentCleanupUnverified('cleanup unverified'));
  expect(await f.fence()).toMatchObject({
    quarantined: 'cleanup unverified',
    recovered: [{ state: 'unknown' }],
  });
  const journal = f.reopen();
  const writes = new WriteBroker();
  restoreEnvironmentQuarantines(journal, writes);
  writes.release(f.binding.sessionId);
  expect(writes.acquire(f.binding.sessionId, f.root).granted).toBe(false);
  expect(writes.acquire(randomUUID(), path.join(f.root, 'nested')).granted).toBe(false);
  expect(() =>
    journal.provision(
      { ...f.binding, executorEpoch: randomUUID() },
      'a'.repeat(64),
      'b'.repeat(64),
    ),
  ).toThrow('quarantined');
  const record = journal.status(f.binding, f.intent.executionId);
  expect(journal.ack(f.binding, f.intent.executionId, record.resultDigest!).acknowledged).toBe(
    true,
  );
  // Retrying close after restart must not change the persisted recovery decision.
  f.executor.closeAndWait = async () => {};
  expect((await f.fence()).quarantined).toContain('remains quarantined');
  expect(f.writes.acquire(f.binding.sessionId, f.root).granted).toBe(false);
});

test('an undrained shutdown failure is denied durably without pretending recovery is safe', async () => {
  const error = new Error('Executor descriptors unclosed; binding quarantined');
  const f = fixture(error);
  await expect(f.fence()).rejects.toBe(error);
  expect(f.journal.status(f.binding, f.intent.executionId).state).toBe('running');
  expect(f.journal.quarantines()).toHaveLength(1);
  expect(f.writes.acquire(f.binding.sessionId, f.root).granted).toBe(false);
  expect(() =>
    f.journal.provision(
      { ...f.binding, sessionId: randomUUID(), executorEpoch: randomUUID() },
      'a'.repeat(64),
      'b'.repeat(64),
    ),
  ).toThrow('quarantined');
});

test('independently verified aggregate cleanup reconciles and releases the write lease', async () => {
  const f = fixture();
  expect(await f.fence()).toMatchObject({ recovered: [{ state: 'unknown' }] });
  expect(f.journal.quarantines()).toEqual([]);
  expect(f.writes.acquire(randomUUID(), f.root).granted).toBe(true);
  expect(() =>
    f.journal.provision(
      { ...f.binding, executorEpoch: randomUUID() },
      'a'.repeat(64),
      'b'.repeat(64),
    ),
  ).not.toThrow();
});

test('policy refresh retains quarantine instead of constructing a replacement executor', async () => {
  const f = fixture(new EnvironmentCleanupUnverified('cleanup unverified'));
  let created = false;
  const options = {
    ...f,
    previous: { binding: f.binding },
    next: { binding: { ...f.binding, executorEpoch: randomUUID() } },
    authority: { invalidate() {} },
    receipts: { invalidate() {} },
    backgroundActive: () => false,
    create: async () => {
      created = true;
      return f.executor;
    },
  } as unknown as Parameters<typeof replaceEnvironment>[0];
  await expect(replaceEnvironment(options)).rejects.toBeInstanceOf(EnvironmentCleanupUnverified);
  expect(created).toBe(false);
  expect(f.journal.quarantines()).toHaveLength(1);
  expect(f.writes.acquire(f.binding.sessionId, f.root).granted).toBe(false);
});
