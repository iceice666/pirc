import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InnerJournal } from '../src/environment/inner-journal.js';
import { digest } from '../src/environment/json.js';
import {
  intentDigest,
  RESULT_BYTES,
  type ExecutionIntent,
  type Terminal,
} from '../src/environment/protocol.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-inner-journal-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'journal.sqlite');
  let db = new Database(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  let journal = new InnerJournal(db);
  cleanups.push(() => db.close());
  const value = {
    binding: {
      nodeId: 'test',
      workspaceId: 'test:workspace',
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    },
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    capability: 'ptc',
    arguments: { code: 'await tools.schedule({});' },
    budgetMs: 120_000,
  };
  const parent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
  journal.register(parent, ['schedule', 'read']);
  function inner(patch: Partial<ExecutionIntent> = {}): ExecutionIntent {
    const value = {
      ...parent,
      executionId: randomUUID(),
      parentExecutionId: parent.executionId,
      innerOperationId: randomUUID(),
      capability: 'schedule',
      arguments: {},
      ...patch,
    };
    return { ...value, argumentDigest: intentDigest(value) };
  }
  return {
    parent,
    inner,
    get db() {
      return db;
    },
    get journal() {
      return journal;
    },
    restart() {
      db.close();
      db = new Database(file);
      journal = new InnerJournal(db);
    },
  };
}
const completed: Terminal = {
  state: 'completed',
  effect: 'completed',
  artifacts: [],
  truncated: false,
  output: { id: 'schedule' },
};

test('inner identities deduplicate arguments and enforce parent binding, manifest and budgets', () => {
  const f = fixture(),
    a = f.inner();
  expect(f.journal.accept(a).fresh).toBe(true);
  expect(f.journal.accept(a).fresh).toBe(false);
  expect(() =>
    f.journal.accept(
      f.inner({
        executionId: a.executionId,
        innerOperationId: a.innerOperationId,
        arguments: { changed: true },
      }),
    ),
  ).toThrow('conflict');
  expect(() => f.journal.accept(f.inner({ innerOperationId: a.innerOperationId }))).toThrow(
    'conflict',
  );
  expect(() => f.journal.accept(f.inner({ capability: 'bash' }))).toThrow('manifest');
  expect(() => f.journal.accept(f.inner({ runId: randomUUID() }))).toThrow('identity');
  expect(() =>
    f.journal.accept(f.inner({ binding: { ...a.binding, sessionId: randomUUID() } })),
  ).toThrow('parent');
  expect(() => f.journal.accept(f.inner({ budgetMs: 120_001 }))).toThrow('budget');
});

test('central mutation and result share one transaction, lost replies never repeat mutation', () => {
  const f = fixture(),
    a = f.inner();
  f.db.exec('CREATE TABLE schedules(id TEXT PRIMARY KEY);');
  f.journal.accept(a);
  let calls = 0;
  const mutate = (db: Database) => {
    calls++;
    db.query('INSERT INTO schedules VALUES (?)').run('job');
    return completed;
  };
  expect(f.journal.transact(a.binding, a.parentExecutionId!, a.innerOperationId!, mutate)).toEqual(
    completed,
  );
  f.restart();
  expect(f.journal.transact(a.binding, a.parentExecutionId!, a.innerOperationId!, mutate)).toEqual(
    completed,
  );
  expect(calls).toBe(1);
  expect(f.journal.status(a.binding, a.parentExecutionId!, a.innerOperationId!).delivered).toBe(
    false,
  );
  expect(() =>
    f.journal.delivered(a.binding, a.parentExecutionId!, a.innerOperationId!, 'forged'),
  ).toThrow('digest');
  f.journal.delivered(
    a.binding,
    a.parentExecutionId!,
    a.innerOperationId!,
    digest(completed, RESULT_BYTES),
  );
  expect(f.journal.status(a.binding, a.parentExecutionId!, a.innerOperationId!).delivered).toBe(
    true,
  );
});

test('transaction failure rolls back mutation; interrupted guest seals unknown effects without replay', () => {
  const f = fixture(),
    a = f.inner(),
    b = f.inner();
  f.db.exec('CREATE TABLE effects(id TEXT PRIMARY KEY);');
  f.journal.accept(a);
  expect(() =>
    f.journal.transact(a.binding, a.parentExecutionId!, a.innerOperationId!, (db) => {
      db.exec("INSERT INTO effects VALUES ('bad');");
      throw new Error('failure before result commit');
    }),
  ).toThrow('before result');
  expect(f.db.query('SELECT * FROM effects').all()).toEqual([]);
  f.journal.claim(a.binding, a.parentExecutionId!, a.innerOperationId!);
  f.journal.accept(b);
  f.restart();
  f.journal.seal(a.binding, a.parentExecutionId!);
  expect(
    f.journal.status(a.binding, a.parentExecutionId!, a.innerOperationId!).result?.effect,
  ).toBe('unknown');
  expect(
    f.journal.status(b.binding, b.parentExecutionId!, b.innerOperationId!).result?.effect,
  ).toBe('not_started');
  expect(f.journal.accept(a).fresh).toBe(false);
  expect(() => f.journal.accept(f.inner())).toThrow('sealed');
  expect(() => f.journal.claim(a.binding, a.parentExecutionId!, a.innerOperationId!)).toThrow(
    'sealed',
  );
});

test('lost central reply reconciles original inner ID after node guest loss without replay', () => {
  const f = fixture(),
    a = f.inner();
  f.journal.accept(a);
  f.journal.claim(a.binding, a.parentExecutionId!, a.innerOperationId!);
  // Central service independently committed this result before the node lost its reply.
  const centralResult = completed;
  f.restart();
  f.journal.seal(a.binding, a.parentExecutionId!);
  const uncertain = f.journal.status(a.binding, a.parentExecutionId!, a.innerOperationId!).result!;
  f.journal.delivered(
    a.binding,
    a.parentExecutionId!,
    a.innerOperationId!,
    digest(uncertain, RESULT_BYTES),
  );
  expect(
    f.journal.reconcile(a.binding, a.parentExecutionId!, a.innerOperationId!, centralResult),
  ).toEqual(completed);
  expect(f.journal.status(a.binding, a.parentExecutionId!, a.innerOperationId!).delivered).toBe(
    false,
  );
  expect(f.journal.accept(a).operation.result).toEqual(completed);
  expect(() => f.journal.accept(f.inner())).toThrow('sealed');
  expect(f.db.query('SELECT previous FROM ptc_inner_reconciliations').all()).toHaveLength(1);
  expect(() =>
    f.journal.delivered(
      a.binding,
      a.parentExecutionId!,
      a.innerOperationId!,
      digest(uncertain, RESULT_BYTES),
    ),
  ).toThrow('digest');
  f.journal.delivered(
    a.binding,
    a.parentExecutionId!,
    a.innerOperationId!,
    digest(completed, RESULT_BYTES),
  );
});

test('unclaimed effects, conflicting terminals and foreign artifact ownership are rejected', () => {
  const f = fixture(),
    a = f.inner();
  f.journal.accept(a);
  expect(() =>
    f.journal.finish(a.binding, a.parentExecutionId!, a.innerOperationId!, completed),
  ).toThrow('Unclaimed');
  f.journal.claim(a.binding, a.parentExecutionId!, a.innerOperationId!);
  expect(() => f.journal.claim(a.binding, a.parentExecutionId!, a.innerOperationId!)).toThrow(
    'claimed',
  );
  expect(() =>
    f.journal.finish(a.binding, a.parentExecutionId!, a.innerOperationId!, {
      ...completed,
      artifacts: [
        {
          nodeId: 'test',
          workspaceId: 'test:workspace',
          sessionId: randomUUID(),
          artifactId: randomUUID(),
          digest: 'a'.repeat(64),
          bytes: 1,
          mimeType: 'image/png',
          availability: 'available',
        },
      ],
    }),
  ).toThrow('ownership');
  f.journal.finish(a.binding, a.parentExecutionId!, a.innerOperationId!, completed);
  expect(f.journal.finish(a.binding, a.parentExecutionId!, a.innerOperationId!, completed)).toEqual(
    completed,
  );
  expect(() =>
    f.journal.finish(a.binding, a.parentExecutionId!, a.innerOperationId!, {
      ...completed,
      output: null,
    }),
  ).toThrow('conflict');
});
