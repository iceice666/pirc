import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentAdmission } from '../src/environment/admission.js';
import { ApprovalAuthority } from '../src/environment/approvals.js';
import { EnvironmentCodeError, ExecutionJournal } from '../src/environment/journal.js';
import { EnvironmentRequestError, isEnvironmentRequestError } from '../src/environment/remote.js';
import {
  LocalEnvironment,
  environmentError,
  type EnvironmentExecutor,
} from '../src/environment/service.js';
import { NodeWriterFence } from '../src/gateway-runtime/node-writer-fence.js';
import { replaceEnvironment } from '../src/node/environment-refresh.js';
import { WriteBroker } from '../src/node/write-broker.js';
import {
  descriptorDigest,
  intentDigest,
  type Binding,
  type Descriptor,
  type ExecutionIntent,
  type Terminal,
} from '../src/environment/protocol.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const binding = (overrides: Partial<Binding> = {}): Binding => ({
  nodeId: 'n',
  workspaceId: 'n:w',
  sessionId: randomUUID(),
  writerEpoch: randomUUID(),
  executorEpoch: randomUUID(),
  ...overrides,
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
    limits: { maxActive: 1, maxBudgetMs: 5000 },
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
    budgetMs: 5000,
  };
  return { ...value, argumentDigest: intentDigest(value) };
}
const completed: Terminal = {
  state: 'completed',
  effect: 'completed',
  artifacts: [],
  truncated: false,
};
/** The first execution blocks until release(); later ones complete immediately. */
function gated(): EnvironmentExecutor & { runs: number; release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const value = {
    healthy: true,
    runs: 0,
    release: () => release(),
    async execute() {
      if (++value.runs === 1) await gate;
      return completed;
    },
  };
  return value;
}
const counting = (): EnvironmentExecutor & { runs: number } => {
  const value = {
    healthy: true,
    runs: 0,
    async execute() {
      value.runs++;
      return completed;
    },
  };
  return value;
};
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 500 && !check(); n++) await Bun.sleep(2);
  expect(check()).toBe(true);
}
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pirc-m6-gen-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function fenced(file = ':memory:', journalFile = ':memory:') {
  const journal = new ExecutionJournal(journalFile);
  const fence = new NodeWriterFence(file, 'n', journal);
  cleanups.push(
    () => journal.close(),
    () => fence.close(),
  );
  const faults: Error[] = [];
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    fence,
    admission: new EnvironmentAdmission(),
    fault: (error) => faults.push(error),
  });
  cleanups.push(() => local.close());
  const transfer = (bound: Binding) =>
    fence.fence({ transferId: randomUUID(), binding: bound, legacySessionIds: [] }, async () => {});
  return { journal, fence, local, faults, transfer };
}

test('finding 1: revoking a session with queued work cancels it atomically; other sessions keep working', async () => {
  const f = fenced();
  const a = descriptorFor(binding());
  const b = descriptorFor(binding());
  await f.transfer(a.binding);
  await f.transfer(b.binding);
  const runA = gated();
  const runB = counting();
  f.local.provision(a, runA);
  f.local.provision(b, runB);
  const first = intentFor(a);
  const queued = intentFor(a);
  await f.local.start(first);
  await until(() => f.journal.status(a.binding, first.executionId).state === 'running');
  expect((await f.local.start(queued)).state).toBe('accepted');
  f.fence.revoke(a.binding);
  // Committed with the retirement: the queued item can never start.
  expect(f.journal.isRetired(a.binding)).toBe(true);
  expect(f.journal.status(a.binding, queued.executionId)).toMatchObject({
    state: 'cancelled',
    effect: 'not_started',
    terminal: { error: { code: 'stale_epoch' } },
  });
  // Running work is not interrupted by revocation; it still reports its terminal.
  runA.release();
  await until(() => f.journal.status(a.binding, first.executionId).state === 'completed');
  const other = intentFor(b);
  await f.local.start(other);
  await until(() => f.journal.status(b.binding, other.executionId).state === 'completed');
  expect(runA.runs).toBe(1);
  expect(f.faults).toEqual([]);
  await expect(f.local.start(intentFor(a))).rejects.toThrow('Retired generation');
  // A later session still admits after the revocation.
  const late = intentFor(b);
  await f.local.start(late);
  await until(() => f.journal.status(b.binding, late.executionId).state === 'completed');
  expect(f.faults).toEqual([]);
});

test('finding 1: a retirement the environment was not told about is a per-item outcome on claim', async () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const faults: Error[] = [];
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
    admission: new EnvironmentAdmission(),
    fault: (error) => faults.push(error),
  });
  cleanups.push(() => local.close());
  const a = descriptorFor(binding());
  const b = descriptorFor(binding());
  const runA = gated();
  local.provision(a, runA);
  local.provision(b, counting());
  const first = intentFor(a);
  const queued = intentFor(a);
  await local.start(first);
  await until(() => journal.status(a.binding, first.executionId).state === 'running');
  await local.start(queued);
  // Retired behind the environment's back (e.g. quarantine): the queue entry survives.
  journal.retire(a.binding);
  runA.release();
  await until(() => journal.status(a.binding, first.executionId).state === 'completed');
  await Bun.sleep(10);
  expect(journal.status(a.binding, queued.executionId).state).toBe('cancelled');
  expect(runA.runs).toBe(1);
  const other = intentFor(b);
  await local.start(other);
  await until(() => journal.status(b.binding, other.executionId).state === 'completed');
  expect(faults).toEqual([]);
});

test('finding 1: claim on a retired generation finishes still-accepted work as not_started', () => {
  const dir = tempDir();
  const file = path.join(dir, 'journal.sqlite');
  const journal = new ExecutionJournal(file);
  cleanups.push(() => journal.close());
  const a = descriptorFor(binding());
  journal.provision(a.binding, a.revision, a.policyRevision);
  const intent = intentFor(a);
  journal.accept(intent);
  // A generation retired by an older build that did not cancel its queue.
  const raw = new Database(file);
  raw.query('UPDATE env_bindings SET retired=1').run();
  raw.close();
  expect(journal.claim(a.binding, intent.executionId)).toMatchObject({
    state: 'cancelled',
    effect: 'not_started',
  });
  const error = (() => {
    try {
      journal.claim(a.binding, intent.executionId);
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(EnvironmentCodeError);
  expect((error as EnvironmentCodeError).code).toBe('stale_epoch');
});

test('finding 2: only the newest fenced generation of a session provisions; superseded ones stay refused', async () => {
  const dir = tempDir();
  const fenceFile = path.join(dir, 'fence.sqlite');
  const f = fenced(fenceFile);
  const session = randomUUID();
  const g0 = descriptorFor(binding({ sessionId: session }));
  const g1 = descriptorFor(binding({ sessionId: session }));
  await f.transfer(g0.binding);
  await f.transfer(g1.binding);
  f.local.provision(g1, counting());
  expect(() => f.local.provision(g0, counting())).toThrow('superseded');
  expect(f.journal.isProvisioned(g0.binding)).toBe(false);
  // Durable across restart, and a superseded generation cannot be fenced back.
  f.fence.close();
  const reopened = new NodeWriterFence(fenceFile, 'n');
  cleanups.push(() => reopened.close());
  expect(() => reopened.assertProvisioned(g0.binding)).toThrow('superseded');
  reopened.assertProvisioned(g1.binding);
  await expect(
    reopened.fence(
      { transferId: randomUUID(), binding: g0.binding, legacySessionIds: [] },
      async () => {},
    ),
  ).rejects.toThrow('superseded');
  reopened.assertProvisioned(g1.binding);
});

test('finding 2: fencing a newer generation supersedes and retires the live one first', async () => {
  const f = fenced();
  const session = randomUUID();
  const g0 = descriptorFor(binding({ sessionId: session }));
  const g1 = descriptorFor(binding({ sessionId: session }));
  await f.transfer(g0.binding);
  const run0 = gated();
  f.local.provision(g0, run0);
  const running = intentFor(g0);
  const queued = intentFor(g0);
  await f.local.start(running);
  await until(() => f.journal.status(g0.binding, running.executionId).state === 'running');
  await f.local.start(queued);
  // Without a fence for G1, provisioning it alongside live G0 is refused.
  expect(() => f.local.provision(g1, counting())).toThrow('Unfenced');
  await f.transfer(g1.binding);
  expect(f.journal.isRetired(g0.binding)).toBe(true);
  expect(f.journal.status(g0.binding, queued.executionId).state).toBe('cancelled');
  await expect(f.local.start(intentFor(g0))).rejects.toThrow('Retired generation');
  const run1 = counting();
  f.local.provision(g1, run1);
  const next = intentFor(g1);
  await f.local.start(next);
  run0.release();
  await until(() => f.journal.status(g1.binding, next.executionId).state === 'completed');
  await until(() => f.journal.status(g0.binding, running.executionId).state === 'completed');
  expect(f.faults).toEqual([]);
});

test('finding 2: revocation covers the writer across executor epochs', async () => {
  const f = fenced();
  const writer = binding();
  const e1 = descriptorFor(writer);
  const e2 = descriptorFor({ ...writer, executorEpoch: randomUUID() });
  await f.transfer(e1.binding);
  f.local.provision(e1, counting());
  f.fence.revoke(e1.binding);
  expect(() => f.fence.assertProvisioned(e2.binding)).toThrow('revoked');
  await expect(f.transfer(e2.binding)).rejects.toThrow('revoked');
  expect(() => f.local.provision(e2, counting())).toThrow('revoked');
  // A different writer of the same session is a new generation and may be fenced.
  const fresh = descriptorFor({ ...writer, writerEpoch: randomUUID() });
  await f.transfer(fresh.binding);
  f.local.provision(fresh, counting());
});

test('finding 2: two live generations of one session never coexist, even unfenced', () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  const g0 = descriptorFor(binding());
  const g1 = descriptorFor({ ...g0.binding, executorEpoch: randomUUID() });
  local.provision(g0, counting());
  expect(() => local.provision(g1, counting())).toThrow('still live');
  expect(() =>
    journal.provision(g1.binding, g1.revision, g1.policyRevision, { fresh: true }),
  ).toThrow('still live');
  journal.retire(g0.binding);
  local.provision(g1, counting());
});

test('finding 3: LocalEnvironment refuses to construct without a fence or explicit harness opt-out', () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  expect(() => new LocalEnvironment({ nodeId: 'n', journal, authorize: () => {} })).toThrow(
    'requires a writer fence',
  );
});

function refreshFixture() {
  const f = fenced();
  const approvals = new ApprovalAuthority(':memory:', () => {});
  cleanups.push(() => approvals.close());
  const previous = descriptorFor(binding());
  const next = descriptorFor({ ...previous.binding, executorEpoch: randomUUID() });
  const sandboxed = (run: EnvironmentExecutor) =>
    Object.assign(run, { started: Promise.resolve(), async closeAndWait() {} });
  let created = 0;
  const options = (nextExecutor = counting()) =>
    ({
      previous,
      next,
      environment: f.local,
      executor: sandboxed(counting()),
      authority: { invalidate() {} },
      approvals,
      receipts: { invalidate() {} },
      journal: f.journal,
      writes: new WriteBroker(),
      backgroundActive: () => false,
      create: async () => {
        created++;
        return sandboxed(nextExecutor);
      },
    }) as unknown as Parameters<typeof replaceEnvironment>[0];
  return { ...f, previous, next, options, created: () => created };
}

test('finding 4: refresh checks the replacement before quiescing the old generation', async () => {
  const f = refreshFixture();
  await f.transfer(f.previous.binding);
  const run = counting();
  f.local.provision(f.previous, run);
  // `next` was never fenced: refused up front; the session keeps its environment.
  await expect(replaceEnvironment(f.options())).rejects.toThrow('Unfenced');
  expect(f.created()).toBe(0);
  expect(f.journal.isRetired(f.previous.binding)).toBe(false);
  const still = intentFor(f.previous);
  await f.local.start(still);
  await until(() => f.journal.status(f.previous.binding, still.executionId).state === 'completed');
  // Once fenced, the replacement goes through and only `next` serves.
  await f.transfer(f.next.binding);
  const nextRun = counting();
  await replaceEnvironment(f.options(nextRun));
  expect(f.created()).toBe(1);
  expect(f.journal.isRetired(f.previous.binding)).toBe(true);
  const after = intentFor(f.next);
  await f.local.start(after);
  await until(() => f.journal.status(f.next.binding, after.executionId).state === 'completed');
  expect(nextRun.runs).toBe(1);
  expect(f.faults).toEqual([]);
});

test('finding 4: a replacement that conflicts with another live generation is refused before quiescing', async () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  const previous = descriptorFor(binding());
  const next = descriptorFor({ ...previous.binding, executorEpoch: randomUUID() });
  local.provision(previous, counting());
  // Replacing `previous` itself is allowed; replacing an unrelated binding is not.
  expect(local.assertProvisionable(next, previous.binding).binding).toEqual(next.binding);
  expect(() =>
    local.assertProvisionable(next, { ...previous.binding, executorEpoch: randomUUID() }),
  ).toThrow('still live');
  expect(() => local.assertProvisionable(next)).toThrow('still live');
});

test('finding 5: refusals are typed at the origin; the gateway gets a type guard', async () => {
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  const d = descriptorFor(binding());
  local.provision(d, counting());
  await local.quiesceBinding(d.binding);
  const refusal = await local.start(intentFor(d)).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(EnvironmentCodeError);
  expect(environmentError(refusal)).toEqual({
    code: 'unavailable_sandbox',
    message: 'Sandbox unavailable',
  });
  // Artifact ownership is an origin-typed refusal, not a prefix-mapped string.
  const intent = intentFor(descriptorFor(binding()));
  journal.provision(intent.binding, intent.descriptorRevision, intent.policyRevision);
  journal.accept(intent);
  journal.claim(intent.binding, intent.executionId);
  const mismatch = (() => {
    try {
      journal.finish(intent.binding, intent.executionId, {
        ...completed,
        artifacts: [
          {
            nodeId: 'n',
            workspaceId: 'n:w',
            sessionId: randomUUID(),
            artifactId: randomUUID(),
            digest: 'c'.repeat(64),
            bytes: 1,
            mimeType: 'text/plain',
            availability: 'available',
          },
        ],
      } as Terminal);
    } catch (error) {
      return error;
    }
  })();
  expect(environmentError(mismatch).code).toBe('invalid_binding');
  const remote = new EnvironmentRequestError('unknown_execution', 'Unknown execution');
  expect(isEnvironmentRequestError(remote)).toBe(true);
  expect(isEnvironmentRequestError(remote, 'unknown_execution')).toBe(true);
  expect(isEnvironmentRequestError(remote, 'conflict')).toBe(false);
  expect(isEnvironmentRequestError(new Error('unknown_execution: x'), 'unknown_execution')).toBe(
    false,
  );
});

test('finding 6: status of a known ID takes no write lock; compaction drops never_accepted tombstones', () => {
  let now = 1_000_000;
  const file = path.join(tempDir(), 'journal.sqlite');
  const journal = new ExecutionJournal(file, () => now);
  cleanups.push(() => journal.close());
  const d = descriptorFor(binding());
  journal.provision(d.binding, d.revision, d.policyRevision);
  const intent = intentFor(d);
  journal.accept(intent);
  const lost = randomUUID();
  expect(() => journal.query(d.binding, lost)).toThrow('never accepted');
  // Another writer holds the write lock: known IDs and tombstones still answer.
  const other = new Database(file);
  other.exec('BEGIN IMMEDIATE');
  try {
    expect(journal.query(d.binding, intent.executionId).state).toBe('accepted');
    expect(() => journal.query(d.binding, lost)).toThrow('never accepted');
    // Only a brand-new ID of an active generation needs the write transaction.
    expect(() => journal.query(d.binding, randomUUID())).toThrow(/locked|busy/i);
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
  journal.claim(d.binding, intent.executionId);
  const done = journal.finish(d.binding, intent.executionId, completed);
  journal.ack(d.binding, intent.executionId, done.resultDigest!);
  now += 2 * 86_400_000;
  journal.retire(d.binding);
  expect(journal.compactRetired(d.binding)).toBe(1);
  const raw = new Database(file, { readonly: true });
  const kinds = raw.query('SELECT kind FROM env_tombstones').all() as { kind: string }[];
  raw.close();
  expect(kinds).toEqual([{ kind: 'reclaimed' }]);
  // The retired generation still reports unknown_execution and refuses the start.
  expect(() => journal.query(d.binding, lost)).toThrow('never accepted');
  expect(() => journal.accept(intentFor(d, lost))).toThrow('Retired generation');
  expect(() => journal.query(d.binding, intent.executionId)).toThrow('reclaimed');
});

test('finding 1 (round 2): a fence retry redoes a superseded retirement that failed after commit', async () => {
  const journal = new ExecutionJournal(':memory:');
  let failNext = true;
  const flaky = {
    bindings: () => journal.bindings(),
    isRetired: (bound: Binding) => journal.isRetired(bound),
    retire: (bound: Binding) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk I/O error');
      }
      return journal.retire(bound);
    },
  };
  const fence = new NodeWriterFence(':memory:', 'n', flaky);
  cleanups.push(
    () => journal.close(),
    () => fence.close(),
  );
  const local = new LocalEnvironment({ nodeId: 'n', journal, authorize: () => {}, fence });
  cleanups.push(() => local.close());
  const session = randomUUID();
  const g0 = descriptorFor(binding({ sessionId: session }));
  const g1 = descriptorFor(binding({ sessionId: session }));
  await fence.fence(
    { transferId: randomUUID(), binding: g0.binding, legacySessionIds: [] },
    async () => {},
  );
  local.provision(g0, counting());
  const transfer = { transferId: randomUUID(), binding: g1.binding, legacySessionIds: [] };
  await expect(fence.fence(transfer, async () => {})).rejects.toThrow('disk I/O error');
  expect(journal.isRetired(g0.binding)).toBe(false);
  // The retry must not report success while the superseded generation is still live.
  await fence.fence(transfer, async () => {});
  expect(journal.isRetired(g0.binding)).toBe(true);
  await expect(local.start(intentFor(g0))).rejects.toThrow('Retired generation');
  local.provision(g1, counting());
});
