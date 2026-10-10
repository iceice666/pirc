import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { canonicalJson, parseJson } from '../src/environment/json.js';
import { relaxedTransaction } from '../src/environment/durability.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import {
  CONTROL_BYTES,
  REQUEST_BYTES,
  descriptorDigest,
  intentDigest,
  textMemo,
  validateIntent,
  validateIntentText,
  type Descriptor,
  type EnvironmentMessage,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { LocalEnvironment, dispatchEnvironment } from '../src/environment/service.js';

const binding = {
  nodeId: 'node',
  workspaceId: 'node:workspace',
  sessionId: randomUUID(),
  writerEpoch: randomUUID(),
  executorEpoch: randomUUID(),
};
function intent(
  argumentsValue: ExecutionIntent['arguments'] = { path: 'a' },
  descriptorRevision = 'a'.repeat(64),
): ExecutionIntent {
  const value = {
    binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision,
    policyRevision: 'b'.repeat(64),
    capability: 'read',
    arguments: argumentsValue,
    budgetMs: 1000,
  };
  return { ...value, argumentDigest: intentDigest(value) };
}

test('strict JSON keeps whitespace, number and byte semantics on the fast paths', () => {
  expect(parseJson(' \t\n\r{"a" :\t[1, -2.5e3, true, null, "x"]}\r\n', CONTROL_BYTES)).toEqual({
    a: [1, -2500, true, null, 'x'],
  });
  for (const space of ['\u000b', '\u000c', '\u00a0', '\u1680', '\u2028', '\u3000', '\ufeff'])
    expect(() => parseJson(`[1,${space}2]`, CONTROL_BYTES)).toThrow('whitespace');
  // Numbers deep inside a long document are matched in place, not on a sliced suffix.
  const long = `[${'"x",'.repeat(5000)}12.5e-1]`;
  expect((parseJson(long, REQUEST_BYTES) as unknown[]).at(-1)).toBe(1.25);
  for (const bad of ['[01]', '[1.]', '[-]', '[1e]', '{"a":1,"a":2}', '[1]x'])
    expect(() => parseJson(bad, CONTROL_BYTES)).toThrow();
  const mixed = { b: '漢字', a: ['ascii', 'é', '\u0001'], c: { d: 1.5 } };
  const text = canonicalJson(mixed, 1000);
  expect(text).toBe('{"a":["ascii","é","\\u0001"],"b":"漢字","c":{"d":1.5}}');
  expect(() => canonicalJson(mixed, Buffer.byteLength(text) - 1)).toThrow('byte');
  expect(canonicalJson(mixed, Buffer.byteLength(text))).toBe(text);
});

test('memoized validation returns independent copies and never caches failures', () => {
  const memo = textMemo<{ items: number[] }>();
  let computed = 0;
  const first = memo('k', () => (computed++, { items: [1] }));
  first.items.push(2);
  expect(memo('k', () => (computed++, { items: [9] }))).toEqual({ items: [1] });
  expect(computed).toBe(1);
  expect(() =>
    memo('bad', () => {
      throw new Error('invalid');
    }),
  ).toThrow('invalid');
  expect(memo('bad', () => ({ items: [3] }))).toEqual({ items: [3] });
  // Total retained text is capped (LRU) and oversized texts are never retained.
  const small = textMemo<number>(40, 16);
  let misses = 0;
  for (const key of ['aaaaaaaaaa', 'bbbbbbbbbb', 'aaaaaaaaaa']) small(key, () => ++misses);
  expect(misses).toBe(2);
  small('cccccccccc', () => ++misses);
  small('bbbbbbbbbb', () => ++misses);
  expect(misses).toBe(4); // 'bbbbbbbbbb' was evicted when 'cccccccccc' exceeded 40 bytes
  small('x'.repeat(17), () => ++misses);
  small('x'.repeat(17), () => ++misses);
  expect(misses).toBe(6);
  const value = intent();
  const text = canonicalJson(value, REQUEST_BYTES);
  const parsed = validateIntentText(text);
  parsed.arguments = { path: 'mutated' };
  expect(validateIntentText(text).arguments).toEqual({ path: 'a' });
  expect(validateIntent(value)).toEqual(validateIntent(JSON.parse(text)));
  expect(() => validateIntent({ ...value, budgetMs: 2000 })).toThrow('digest');
  // The start envelope bound still applies to the memoized path.
  // One nesting level deeper in the envelope: intents valid alone but unsendable fail.
  let nested: ExecutionIntent['arguments'] = 0;
  for (let depth = 0; depth < 62; depth++) nested = [nested];
  expect(() => validateIntent(intent({ nested }))).toThrow('nesting');
  const base = canonicalJson(intent({ blob: '' }), REQUEST_BYTES).length;
  const big = intent({ blob: 'x'.repeat(REQUEST_BYTES - base - 10) });
  expect(canonicalJson(big, REQUEST_BYTES).length).toBeLessThanOrEqual(REQUEST_BYTES);
  expect(() => validateIntent(big)).toThrow('byte');
});

test('pushed results wake waiters with the verified receipt; timeouts and disconnects do not', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-await-result-'));
  const node = new ExecutionJournal(path.join(root, 'node.sqlite'));
  const gateway = new ExecutionJournal(path.join(root, 'gateway.sqlite'));
  try {
    const authorize = () => {};
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const local = new LocalEnvironment({
      nodeId: 'node',
      journal: node,
      authorize,
      unfencedHarness: true,
      result: (record) =>
        void remote.receive({
          version: 1,
          requestId: randomUUID(),
          type: 'execution.result',
          record,
        }),
    });
    const descriptor: Descriptor = {
      binding,
      version: 1,
      revision: '',
      policyRevision: 'b'.repeat(64),
      capabilityCatalog: [
        {
          name: 'read',
          argumentSchema: {},
          resultSchema: {},
          placement: 'node',
          effects: 'read',
          concurrency: 'read',
          approval: 'policy',
          hookRevision: 'c'.repeat(64),
        },
      ],
      instructions: '',
      skills: [],
      role: 'coding',
      platform: 'linux',
      cwdDisplay: '/w',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 1000 },
    };
    descriptor.revision = descriptorDigest(descriptor);
    local.provision(descriptor, {
      healthy: true,
      async execute() {
        await finished;
        return {
          state: 'completed',
          effect: 'completed',
          truncated: false,
          artifacts: [],
          output: 'done',
        };
      },
    });
    gateway.provision(binding, descriptor.revision, descriptor.policyRevision);
    const remote: RemoteEnvironment = new RemoteEnvironment({
      nodeId: 'node',
      journal: gateway,
      authorize,
      send: async (message: EnvironmentMessage) =>
        remote.receive(await dispatchEnvironment(local, message)),
    });
    const started = await remote.start(intent({ path: 'a' }, descriptor.revision));
    expect(started.terminal).toBeUndefined();
    const id = started.executionId;
    expect(await remote.awaitResult(binding, id, 10)).toBeUndefined();
    const waiting = remote.awaitResult(binding, id, 5000);
    finish();
    const pushed = await waiting;
    expect(pushed?.state).toBe('completed');
    expect(pushed?.resultDigest).toBe(gateway.receipt(binding, id)!.resultDigest);
    // Already received: immediate. Disconnect wakes a pending waiter without inventing one.
    expect((await remote.awaitResult(binding, id, 0))?.state).toBe('completed');
    const other = remote.awaitResult(binding, randomUUID(), 5000);
    remote.disconnect();
    const at = performance.now();
    await expect(other).resolves.toBeUndefined();
    expect(performance.now() - at).toBeLessThan(1000);
    await local.close();
  } finally {
    node.close();
    gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('relaxed transactions restore FULL durability and nest inside FULL transactions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-relaxed-'));
  const db = new Database(path.join(root, 'a.sqlite'), { create: true });
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE t(v TEXT);');
    const level = () =>
      (db.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous;
    expect(relaxedTransaction(db, () => db.query("INSERT INTO t VALUES ('a')").run().changes)).toBe(
      1,
    );
    expect(level()).toBe(2);
    expect(() =>
      relaxedTransaction(db, () => {
        db.query("INSERT INTO t VALUES ('rolled back')").run();
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(level()).toBe(2);
    // Inside an outer transaction the outer FULL commit applies; no safety-level error.
    db.transaction(() =>
      relaxedTransaction(db, () => db.query("INSERT INTO t VALUES ('b')").run()),
    ).immediate();
    expect(level()).toBe(2);
    expect(
      (db.query('SELECT v FROM t ORDER BY rowid').all() as { v: string }[]).map((r) => r.v),
    ).toEqual(['a', 'b']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
