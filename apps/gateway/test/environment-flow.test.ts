import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EnvironmentFlow } from '../src/environment/flow.js';
import { ChunkStore } from '../src/environment/chunks.js';
import { intentDigest, type EnvironmentMessage } from '../src/environment/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const request = (text: string): EnvironmentMessage => {
  const value = {
    binding: {
      nodeId: 'n',
      workspaceId: 'n:w',
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
    capability: 'write',
    arguments: { text },
    budgetMs: 1000,
  };
  return {
    type: 'execution.start',
    version: 1,
    requestId: randomUUID(),
    intent: { ...value, argumentDigest: intentDigest(value) },
  };
};
function pair(appendGate?: Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-flow-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stores = [new ChunkStore(path.join(root, 'a')), new ChunkStore(path.join(root, 'b'))];
  const received: EnvironmentMessage[] = [];
  const errors: Error[] = [];
  const frames: string[] = [];
  let left!: EnvironmentFlow;
  let right!: EnvironmentFlow;
  const make = (index: number, peer: () => EnvironmentFlow) =>
    new EnvironmentFlow({
      send: async (raw) => {
        frames.push(raw);
        queueMicrotask(() => {
          void peer()
            .receive(raw)
            .catch(() => undefined);
        });
      },
      append: async (...args) => {
        if (index === 1) await appendGate;
        await stores[index]!.append(...args);
      },
      take: (id) => stores[index]!.take(id),
      discard: (id) => stores[index]!.discard(id),
      receive: async (message) => {
        received.push(message);
      },
      failed: (error) => errors.push(error),
    });
  left = make(0, () => right);
  right = make(1, () => left);
  cleanups.push(() => {
    left.close();
    right.close();
  });
  return { left, right, received, errors, frames };
}

test('chunked messages cross a 4 MiB credit window without exceeding frame bounds', async () => {
  const p = pair();
  const message = request('x'.repeat(5 * 1024 * 1024));
  await p.left.send(message);
  for (let n = 0; !p.received.length && n < 200; n++) await Bun.sleep(10);
  expect(p.received).toEqual([message]);
  expect(p.errors).toEqual([]);
  expect(p.frames.every((frame) => Buffer.byteLength(frame) <= 65_536)).toBe(true);
}, 15_000);

test('control cancellation progresses while data credit is exhausted', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const p = pair(blocked);
  const message = request('x'.repeat(5 * 1024 * 1024));
  let sent = false;
  const sending = p.left.send(message).then(() => {
    sent = true;
  });
  for (
    let n = 0;
    p.frames.filter((raw) => JSON.parse(raw).kind === 'chunk').length < 128 && n < 100;
    n++
  )
    await Bun.sleep(5);
  expect(p.frames.filter((raw) => JSON.parse(raw).kind === 'chunk')).toHaveLength(128);
  expect(sent).toBe(false);
  await p.left.send({
    type: 'execution.cancel',
    version: 1,
    requestId: randomUUID(),
    binding: (message as any).intent.binding,
    executionId: (message as any).intent.executionId,
  });
  for (let n = 0; !p.received.length && n < 100; n++) await Bun.sleep(5);
  expect(p.received.map((item) => item.type)).toEqual(['execution.cancel']);
  expect(sent).toBe(false);
  release();
  await sending;
  for (let n = 0; p.received.length < 2 && n < 100; n++) await Bun.sleep(5);
  expect(p.errors).toEqual([]);
});

test('closed link cannot dispatch a complete message whose durable take was still pending', async () => {
  const message = request('small');
  const source = JSON.stringify(message);
  let release!: () => void;
  let entered!: () => void;
  const taking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delivered = 0;
  const flow = new EnvironmentFlow({
    send: async () => {},
    append: async () => {},
    take: async () => {
      entered();
      await blocked;
      return source;
    },
    discard: async () => {},
    receive: async () => {
      delivered++;
    },
    failed: () => {},
  });
  const receiving = flow.receive(
    JSON.stringify({
      type: 'environment.frame',
      kind: 'chunk',
      id: randomUUID(),
      offset: 0,
      total: Buffer.byteLength(source),
      data: Buffer.from(source).toString('base64'),
    }),
  );
  await taking;
  flow.close();
  release();
  await receiving;
  expect(delivered).toBe(0);
});

test('escaped near-limit events are chunked rather than double-escaped control frames', async () => {
  const p = pair();
  const value = request('');
  if (value.type !== 'execution.start') throw new Error('fixture');
  const event: EnvironmentMessage = {
    type: 'execution.event',
    version: 1,
    requestId: randomUUID(),
    event: {
      binding: value.intent.binding,
      executionId: value.intent.executionId,
      seq: 1,
      kind: 'output',
      payload: '\\'.repeat(20_000),
    },
  };
  await p.left.send(event);
  for (let n = 0; !p.received.length && n < 100; n++) await Bun.sleep(5);
  expect(p.received).toEqual([event]);
  expect(p.errors).toEqual([]);
});

test('exclusive staging restart discards orphan chunks without adopting them', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-orphan-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const orphan = path.join(root, randomUUID());
  writeFileSync(orphan, 'partial');
  const unrelated = path.join(root, 'supervisor-note');
  writeFileSync(unrelated, 'retain');
  new ChunkStore(root);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(unrelated)).toBe(true);
});

test('rejects forged credit, duplicate JSON keys and oversized raw frames', async () => {
  const p = pair();
  await expect(
    p.left.receive('{"type":"environment.frame","kind":"credit","bytes":1}'),
  ).rejects.toThrow('Forged');
  const q = pair();
  await expect(
    q.left.receive('{"type":"environment.frame","kind":"credit","bytes":1,"bytes":2}'),
  ).rejects.toThrow('Duplicate');
  const r = pair();
  await expect(r.left.receive('x'.repeat(65_537))).rejects.toThrow('large');
});
