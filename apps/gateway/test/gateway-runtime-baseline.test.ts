import { expect, spyOn, test } from 'bun:test';
import { WebSocket } from 'ws';
import { SessionStore } from '../src/agent/session-store.js';
import { measureCell, parseArgs } from './gateway-runtime/report.js';
import { DelayQueue, distribution, FIXTURES, runSample } from './gateway-runtime/baseline.js';

test('CLI rejects unknown, duplicate and missing arguments before starting measurements', () => {
  for (const args of [
    ['--typo'],
    ['--output'],
    ['--repeats', '1'],
    ['--output', 'x', '--output', 'y'],
  ])
    expect(() => parseArgs(args)).toThrow();
  expect(parseArgs([]).repeats).toBe(10);
  expect(parseArgs(['--repeats', '2', '--output', '/tmp/result.json'])).toEqual({
    repeats: 2,
    output: '/tmp/result.json',
  });
});

test('thrown measurements remain failures in the success denominator', async () => {
  const cell = { fixture: 'chat' as const, rttMs: 0, contextBytes: 1024, sessions: 1 };
  let calls = 0;
  const result = await measureCell(cell, 2, async () => {
    calls++;
    throw new Error('transport failed');
  });
  expect(calls).toBe(3);
  expect(result.failures).toHaveLength(3);
  expect(result.summary.runs).toBe(2);
  expect(result.summary.successRate).toBe(0);
  expect(result.summary.taskMs.p50).toBeNull();
});

test('baseline percentiles use nearest rank and empty spans stay unavailable', () => {
  expect(distribution([])).toEqual({ n: 0, p50: null, p95: null });
  expect(distribution([4, 1, 3, 2])).toEqual({ n: 4, p50: 2, p95: 4 });
});

test('delay queue preserves frames and drops pending deliveries on close', async () => {
  const queue = new DelayQueue(10);
  const frames: number[] = [];
  queue.send('a', () => frames.push(1));
  queue.send('bb', () => frames.push(2));
  expect(queue.bytes).toBe(3);
  await Bun.sleep(30);
  expect(frames).toEqual([1, 2]);
  expect(queue.bytes).toBe(0);
  queue.send('c', () => frames.push(3));
  queue.close();
  await Bun.sleep(20);
  expect(frames).toEqual([1, 2]);
});

for (const fixture of FIXTURES) {
  test(`baseline exercises real transport and agent: ${fixture}`, async () => {
    const sample = await runSample({ fixture, rttMs: 0, contextBytes: 1024, sessions: 1 });
    expect(sample.errors).toEqual([]);
    expect(sample.success).toBe(true);
    expect(sample.taskMs).toHaveLength(1);
    expect(sample.nodeToGatewayBytes).toBeGreaterThan(1024);
    expect(sample.gatewayToNodeBytes).toBeGreaterThan(0);
    expect(sample.contextBytes.every((bytes) => bytes > 1024)).toBe(true);
    if (fixture !== 'chat') expect(sample.toolQueueMs.length).toBeGreaterThan(0);
  }, 30000);
}

test('agent persistence crashes cannot be reported as successful runs', async () => {
  const append = SessionStore.prototype.append;
  const mock = spyOn(SessionStore.prototype, 'append').mockImplementation(function (
    this: SessionStore,
    entry,
  ) {
    if (
      entry.type === 'message' &&
      entry.message.role === 'assistant' &&
      entry.message.timestamp !== 1
    )
      throw new Error('synthetic persistence failure');
    // Synthetic provider messages use timestamp 1; identify its final text instead.
    if (
      entry.type === 'message' &&
      entry.message.role === 'assistant' &&
      entry.message.content.some((part) => part.type === 'text' && part.text.includes(':0:0;'))
    )
      throw new Error('synthetic persistence failure');
    return append.call(this, entry);
  });
  try {
    const sample = await runSample({ fixture: 'chat', rttMs: 0, contextBytes: 1024, sessions: 1 });
    expect(sample.success).toBe(false);
    expect(sample.errors.join(';')).toContain('synthetic persistence failure');
  } finally {
    mock.mockRestore();
  }
}, 30000);

test('duplicate UI deltas cannot pass correlation checks', async () => {
  const emit = WebSocket.prototype.emit;
  const mock = spyOn(WebSocket.prototype, 'emit').mockImplementation(function (
    this: WebSocket,
    event,
    ...args
  ) {
    const result = emit.call(this, event, ...args);
    if (event === 'message') {
      const value = JSON.parse(String(args[0]));
      if (value.event?.message?.type === 'message_update') emit.call(this, event, ...args);
    }
    return result;
  });
  try {
    const sample = await runSample({ fixture: 'chat', rttMs: 0, contextBytes: 1024, sessions: 1 });
    expect(sample.success).toBe(false);
    expect(sample.errors).toContain('Duplicate or unknown delta delivery');
  } finally {
    mock.mockRestore();
  }
}, 30000);

test('100 ms RTT and concurrent large histories retain delivery and correlation', async () => {
  const sample = await runSample({
    fixture: 'chat',
    rttMs: 100,
    contextBytes: 262144,
    sessions: 4,
  });
  expect(sample.errors).toEqual([]);
  expect(sample.taskMs).toHaveLength(4);
  expect(sample.deltaToUiMs).toHaveLength(16);
  expect(sample.measuredRttMs).toBeGreaterThanOrEqual(90);
  expect(distribution(sample.deltaToUiMs).p50!).toBeGreaterThanOrEqual(90);
  expect(sample.contextBytes.every((bytes) => bytes > 262144)).toBe(true);
}, 30000);
