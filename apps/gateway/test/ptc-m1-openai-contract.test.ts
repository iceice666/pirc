import { expect, test } from 'bun:test';
import {
  parseOpenAIUsage,
  openAICostUnits,
  OpenAIStreamEvidence,
  OPENAI_PROTOCOL,
} from './ptc-m1/openai-contract.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
const raw = {
  input_tokens: 1000,
  output_tokens: 200,
  input_tokens_details: { cached_tokens: 300, cache_write_tokens: 400 },
  output_tokens_details: { reasoning_tokens: 150 },
  total_tokens: 1200,
};
test('OpenAI buckets exclude cached/write from ordinary input and reasoning is a subset', () => {
  const usage = parseOpenAIUsage(raw)!;
  expect(usage).toEqual({
    input: 300,
    cacheRead: 300,
    cacheWrite: 400,
    output: 200,
    reasoning: 150,
    totalTokens: 1200,
  });
  expect(openAICostUnits(usage)).toBe(36300);
  for (const value of [
    { ...raw, total_tokens: 1201 },
    { ...raw, input_tokens: 1 },
    { ...raw, output_tokens_details: { reasoning_tokens: 201 } },
    { ...raw, input_tokens_details: { cached_tokens: 300 } },
  ])
    expect(parseOpenAIUsage(value)).toBeNull();
});
test('long context threshold reprices complete request, not just excess tokens', () => {
  const usage = {
    input: 272000,
    cacheRead: 0,
    cacheWrite: 0,
    output: 100,
    reasoning: 90,
    totalTokens: 272100,
  };
  expect(openAICostUnits(usage)).toBe(5450000);
  expect(openAICostUnits({ ...usage, input: 272001, totalTokens: 272101 })).toBe(10895040);
});
test('stream evidence requires created+terminal matching model/status/tier and complete usage', () => {
  const evidence = new OpenAIStreamEvidence();
  evidence.observe({ type: 'response.created', response: { model: OPENAI_PROTOCOL.model } });
  expect(evidence.usage()).toBeNull();
  evidence.observe({
    type: 'response.completed',
    response: {
      model: OPENAI_PROTOCOL.model,
      status: 'completed',
      service_tier: 'default',
      usage: raw,
      output: 'PRIVATE_SENTINEL',
    },
  });
  expect(evidence.success()).toBe(true);
  expect(JSON.stringify(evidence)).not.toContain('PRIVATE_SENTINEL');
  const bad = new OpenAIStreamEvidence();
  bad.observe({
    type: 'response.completed',
    response: {
      model: OPENAI_PROTOCOL.model,
      status: 'completed',
      service_tier: 'priority',
      usage: raw,
    },
  });
  expect(bad.usage()).toBeNull();
});
test('OpenAI budget starts at zero and reserves independently with missing-usage halt', () => {
  const budget = new OpenAIBudget();
  expect(budget.snapshot().spentUsd).toBe(0);
  const id = budget.reserve();
  expect(budget.snapshot().reservedUsd).toBe(4.85576);
  budget.settle(id, parseOpenAIUsage(raw)!);
  expect(budget.snapshot().spentUsd).toBe(0.00363);
  const next = budget.reserve();
  budget.uncertain(next);
  budget.uncertain(next);
  expect(budget.snapshot().unknownAttempts).toBe(1);
  expect(() => budget.reserve()).toThrow('halted');
});
test('checkpoint failure blocks admission without losing reservation', () => {
  const budget = new OpenAIBudget(() => {
    throw new Error('disk');
  });
  expect(() => budget.reserve()).toThrow('checkpoint');
  expect(budget.snapshot()).toMatchObject({ halted: true, reservedUsd: 4.85576 });
});

test('incomplete generation can settle known usage without being task success', () => {
  const evidence = new OpenAIStreamEvidence();
  evidence.observe({ type: 'response.created', response: { model: OPENAI_PROTOCOL.model } });
  evidence.observe({
    type: 'response.incomplete',
    response: {
      model: OPENAI_PROTOCOL.model,
      status: 'incomplete',
      service_tier: 'default',
      usage: raw,
    },
  });
  expect(evidence.usage()).not.toBeNull();
  expect(evidence.success()).toBe(false);
  evidence.observe({
    type: 'response.completed',
    response: {
      model: OPENAI_PROTOCOL.model,
      status: 'completed',
      service_tier: 'default',
      usage: raw,
    },
  });
  expect(evidence.usage()).toBeNull();
});

test('missing reasoning cannot refund liability and over-cap usage is charged then halted', () => {
  const invalid = new OpenAIBudget();
  const id = invalid.reserve();
  expect(() =>
    invalid.settle(id, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 } as any),
  ).toThrow();
  expect(invalid.snapshot()).toMatchObject({ halted: true, reservedUsd: 4.85576 });
  for (const usage of [
    { input: 1, cacheRead: 0, cacheWrite: 0, output: 20000, reasoning: 0, totalTokens: 20001 },
    { input: 922001, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, totalTokens: 922002 },
  ]) {
    const budget = new OpenAIBudget();
    const reservation = budget.reserve();
    expect(() => budget.settle(reservation, usage)).toThrow('bounds');
    expect(budget.snapshot().spentUsd).toBeGreaterThan(0);
    expect(budget.snapshot().halted).toBe(true);
  }
});

test('approved continuation carries spend and attempt count without a fresh budget', () => {
  const b = new OpenAIBudget(undefined, { spentUnits: 53688009, admittedAttempts: 1030 });
  expect(b.snapshot()).toMatchObject({ spentUsd: 5.3688009, admittedAttempts: 1030 });
  b.reserve();
  expect(b.snapshot().admittedAttempts).toBe(1031);
  expect(() => new OpenAIBudget(undefined, { spentUnits: -1, admittedAttempts: 0 })).toThrow();
});

test('diagnostic admission bounds include outstanding liability and limit request count', () => {
  const carry = { spentUnits: 54291743, admittedAttempts: 1048 };
  const budget = new OpenAIBudget(undefined, carry, { additionalUnits: 100000000, maxAttempts: 3 });
  const a = budget.reserve(),
    b = budget.reserve();
  expect(() => budget.reserve()).toThrow('exhausted');
  const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, totalTokens: 0 };
  budget.settle(a, zero);
  budget.settle(b, zero);
  const c = budget.reserve();
  budget.settle(c, zero);
  expect(() => budget.reserve()).toThrow('exhausted');
  expect(budget.snapshot().admittedAttempts).toBe(1051);
  expect(budget.snapshot().spentUsd).toBe(5.4291743);
});

test('local denial reasons checkpoint and never count as a dispatched attempt', () => {
  let checkpoints = 0;
  const budget = new OpenAIBudget(
    () => {
      checkpoints++;
    },
    undefined,
    { additionalUnits: 100000000, maxAttempts: 2 },
  );
  budget.reserve();
  budget.reserve();
  expect(() => budget.reserve()).toThrow('attempt_limit');
  expect(budget.snapshot()).toMatchObject({
    admittedAttempts: 2,
    localDenials: { attempt_limit: 1 },
  });
  expect(checkpoints).toBe(3);
  const pressure = new OpenAIBudget(undefined, undefined, {
    additionalUnits: 100000000,
    maxAttempts: 32,
  });
  pressure.reserve();
  pressure.reserve();
  expect(() => pressure.reserve()).toThrow('outstanding_pressure');
  expect(pressure.snapshot().localDenials.outstanding_pressure).toBe(1);
  const exhausted = new OpenAIBudget(undefined, { spentUnits: 990000000, admittedAttempts: 0 });
  expect(() => exhausted.reserve()).toThrow('spend_limit');
  expect(exhausted.snapshot().admittedAttempts).toBe(0);
  for (const bounds of [
    { additionalUnits: -1, maxAttempts: 1 },
    { additionalUnits: 1, maxAttempts: Infinity },
    { additionalUnits: Number.MAX_SAFE_INTEGER, maxAttempts: 1 },
  ])
    expect(
      () => new OpenAIBudget(undefined, { spentUnits: 1, admittedAttempts: 0 }, bounds),
    ).toThrow();
});

test('a raised budget limit is recorded, bounded and still fails closed', () => {
  const budget = new OpenAIBudget(
    undefined,
    { spentUnits: 1_100_000_000, admittedAttempts: 1 },
    undefined,
    150,
  );
  expect(budget.snapshot().limitUsd).toBe(150);
  expect(() => new OpenAIBudget(undefined, undefined, undefined, 99)).toThrow('limit');
  expect(() => new OpenAIBudget(undefined, undefined, undefined, 150.5)).toThrow('limit');
  expect(() => new OpenAIBudget(undefined, undefined, undefined, 1001)).toThrow('limit');
  // The default carry check still applies at the protocol limit.
  expect(
    () => new OpenAIBudget(undefined, { spentUnits: 1_100_000_000, admittedAttempts: 1 }),
  ).toThrow('carry');
  // Near the raised limit, a reservation that would cross it is refused.
  const near = new OpenAIBudget(
    undefined,
    { spentUnits: 1_499_000_000, admittedAttempts: 1 },
    undefined,
    150,
  );
  expect(() => near.reserve()).toThrow('spend_limit');
});
