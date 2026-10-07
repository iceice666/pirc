import { expect, test } from 'bun:test';
import {
  AnthropicEvidence,
  LiveBudget,
  LIVE_MODEL,
  anthropicUsage,
  usageUnits,
} from './ptc-m1/live-budget.js';

const usage = { input: 2, output: 17, cacheWrite: 2516, cacheRead: 0 };
const start = () => ({
  type: 'message_start',
  message: {
    model: LIVE_MODEL,
    content: 'PRIVATE_SENTINEL',
    usage: {
      input_tokens: 2,
      output_tokens: 0,
      cache_creation_input_tokens: 2516,
      cache_read_input_tokens: 0,
    },
  },
});
const delta = {
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 17 },
};

test('budget uses conservative integer prices and carries preflight spend forward', () => {
  expect(usageUnits(usage)).toBe(102380);
  const budget = new LiveBudget({ limitUsd: 100, priorUnits: 106636 });
  const id = budget.reserve();
  expect(budget.snapshot().reservedUsdEquivalent).toBe(8.32768);
  budget.settle(id, usage);
  expect(budget.snapshot()).toMatchObject({
    spentUsdEquivalent: 0.0418032,
    reservedUsdEquivalent: 0,
    halted: false,
  });
  expect(() => budget.settle(id, usage)).toThrow('Unknown');
});

test('concurrent admissions cannot spend outstanding reservations', () => {
  const budget = new LiveBudget({ limitUsd: 10, priorUnits: 0 });
  const id = budget.reserve();
  expect(() => budget.reserve()).toThrow('exhausted');
  budget.settle(id, usage);
  expect(() => budget.reserve()).not.toThrow();
});

test('unknown billing halts and retains full liability, never refunded as zero', () => {
  const budget = new LiveBudget({ limitUsd: 100, priorUnits: 0 });
  const id = budget.reserve();
  budget.uncertain(id);
  budget.uncertain(id);
  expect(budget.snapshot()).toMatchObject({
    admittedAttempts: 1,
    reservedUsdEquivalent: 8.32768,
    unknownAttempts: 1,
    halted: true,
  });
  expect(() => budget.reserve()).toThrow('blocked');
});

test('invalid usage and reservation overflow fail closed', () => {
  for (const value of [NaN, Infinity, -1, 0.5, undefined]) {
    const budget = new LiveBudget({ limitUsd: 100, priorUnits: 0 });
    expect(() => budget.reserve(value as number, -1)).toThrow();
    const id = budget.reserve();
    expect(() => budget.settle(id, { ...usage, input: value as number })).toThrow();
    expect(budget.snapshot().halted).toBe(true);
    expect(budget.snapshot().reservedUsdEquivalent).toBeGreaterThan(0);
  }
  const budget = new LiveBudget({ limitUsd: 100, priorUnits: 0 });
  const id = budget.reserve(1, 1);
  expect(() => budget.settle(id, usage)).toThrow('exceeded');
  expect(budget.snapshot().halted).toBe(true);
});

test('checkpoint precedes admission and failure halts with liability retained', () => {
  let calls = 0;
  const budget = new LiveBudget({
    limitUsd: 100,
    priorUnits: 106636,
    checkpoint: () => {
      calls++;
      throw new Error('disk failure');
    },
  });
  expect(() => budget.reserve()).toThrow('checkpoint');
  expect(calls).toBe(1);
  expect(budget.snapshot()).toMatchObject({
    halted: true,
    spentUnits: 106636,
    reservedUnits: 41638400,
  });
  expect(() => budget.reserve()).toThrow('blocked');
});

test('raw missing fields are not normalized to zero', () => {
  expect(anthropicUsage({ input_tokens: 1, output_tokens: 1 })).toBeNull();
  expect(anthropicUsage(null)).toBeNull();
  expect(anthropicUsage(start().message.usage)).toEqual({ ...usage, output: 0 });
});

test('complete wire evidence retains only numeric usage, never content', () => {
  const evidence = new AnthropicEvidence();
  evidence.observe(start());
  evidence.observe({ type: 'content_block_delta', delta: { text: 'PRIVATE_SENTINEL' } });
  evidence.observe(delta);
  evidence.observe({ type: 'message_stop' });
  expect(evidence.result()).toEqual(usage);
  expect(JSON.stringify(evidence)).not.toContain('PRIVATE_SENTINEL');
});

test('final cumulative input/cache fields replace start evidence and must be valid', () => {
  const evidence = new AnthropicEvidence();
  evidence.observe(start());
  evidence.observe({
    ...delta,
    usage: {
      output_tokens: 17,
      input_tokens: 100,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 20,
    },
  });
  evidence.observe({ type: 'message_stop' });
  expect(evidence.result()).toEqual({ input: 100, output: 17, cacheWrite: 5000, cacheRead: 20 });
  for (const invalid of [
    { input_tokens: -1 },
    { cache_creation_input_tokens: 0.5 },
    { cache_read_input_tokens: 'unknown' },
    { cache_creation_input_tokens: 1 },
  ]) {
    const bad = new AnthropicEvidence();
    bad.observe(start());
    bad.observe({ ...delta, usage: { ...delta.usage, ...invalid } });
    bad.observe({ type: 'message_stop' });
    expect(bad.result()).toBeNull();
  }
});

test('truncated, mismatched, errored, decreasing or reordered streams cannot pass', () => {
  const mismatched = start();
  mismatched.message.model = 'other-model';
  const missing = start();
  delete (missing.message.usage as Record<string, unknown>).cache_read_input_tokens;
  for (const events of [
    [start()],
    [start(), delta],
    [start(), { type: 'message_stop' }],
    [mismatched, delta, { type: 'message_stop' }],
    [missing, delta, { type: 'message_stop' }],
    [delta, start(), { type: 'message_stop' }],
    [start(), start(), delta, { type: 'message_stop' }],
    [start(), delta, { type: 'error' }, { type: 'message_stop' }],
    [start(), delta, { ...delta, usage: { output_tokens: 1 } }, { type: 'message_stop' }],
    [start(), delta, { type: 'message_stop' }, delta],
  ]) {
    const evidence = new AnthropicEvidence();
    events.forEach((event) => evidence.observe(event));
    expect(evidence.result()).toBeNull();
  }
});
