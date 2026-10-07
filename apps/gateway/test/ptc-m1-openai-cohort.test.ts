import { expect, test } from 'bun:test';
import { runOpenAICohorts, type OpenAICohortResult } from './ptc-m1/openai-cohort.js';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import { openAIReadiness } from './ptc-m1/openai-readiness.js';
import { newMetrics } from './ptc-m1/metrics.js';
function result(phase: 'uncached' | 'prime' | 'warm'): OpenAICohortResult {
  return {
    condition: phase === 'uncached' ? 'uncached' : 'warm',
    cacheVerified: phase !== 'prime',
    infrastructureValid: true,
    provenance: 'synthetic',
    run: {
      fixture: FIXTURES[0]!.id,
      kind: 'coding',
      condition: phase === 'uncached' ? 'uncached' : 'warm',
      infrastructureValid: true,
      budgetValid: true,
      budget: new OpenAIBudget().snapshot(),
      success: true,
      measurement: null,
      requestFinishedAt: 0,
      drain: null,
      outcome: null,
      services: null,
      authorizationProof: true,
      teamEvidence: null,
      metrics: { ...newMetrics(), requestCount: 1, modelRounds: 1 },
      reasoningTokens: 0,
      attempts: [],
      cacheVerified: phase === 'uncached',
      accounting: null,
      childrenAccounted: true,
      allAttemptsAccounted: true,
    },
  };
}
test('OpenAI matrix counts 20 measured+10 prime with no cold wait; synthetic cannot complete', async () => {
  const phases: string[] = [];
  const r = await runOpenAICohorts({
    fixtures: [FIXTURES[0]!],
    signal: new AbortController().signal,
    firstTriplet: async () => {},
    execute: async (_f, phase) => result(phase),
    record: async (row) => {
      phases.push(row.phase);
    },
  });
  expect(r.measured).toHaveLength(20);
  expect(phases.filter((p) => p === 'prime')).toHaveLength(10);
  expect(r.complete).toBe(false);
});
test('invalid lifecycle/cache and failed prime are retained then halt, no automatic retry', async () => {
  for (const fault of ['lifecycle', 'cache', 'prime']) {
    let calls = 0,
      records = 0;
    await expect(
      runOpenAICohorts({
        fixtures: [FIXTURES[0]!],
        signal: new AbortController().signal,
        firstTriplet: async () => {},
        execute: async (_f, phase) => {
          calls++;
          const r = result(phase);
          if (fault === 'lifecycle') r.infrastructureValid = false;
          if (fault === 'cache') r.cacheVerified = false;
          if (fault === 'prime' && phase === 'prime') r.run.success = false;
          return r;
        },
        record: async () => {
          records++;
        },
      }),
    ).rejects.toThrow();
    expect(records).toBe(fault === 'prime' ? 2 : 1);
    expect(calls).toBe(records);
  }
});

test('empty/full malformed evidence cannot certify protocol completion', async () => {
  const empty = await runOpenAICohorts({
    fixtures: [],
    signal: new AbortController().signal,
    firstTriplet: async () => {},
    execute: async () => result('uncached'),
    record: async () => {},
  });
  expect(empty.complete).toBe(false);
  expect(empty.missing).toContain('matrix_incomplete');
  const rows = FIXTURES.flatMap((f) =>
    ['uncached', 'warm'].flatMap((c) =>
      Array.from({ length: 10 }, () => {
        const row = result(c as 'uncached' | 'warm');
        row.run.fixture = f.id;
        row.run.kind = f.kind;
        row.provenance = 'real-openai';
        return row;
      }),
    ),
  );
  expect(openAIReadiness(rows)).toContain('measurement_missing');
  expect(openAIReadiness(rows)).toContain('accounting_incomplete');
  expect(openAIReadiness(rows)).toContain('authorization_unverified');
});
test('budget halt is not merely a valid task failure', async () => {
  let records = 0;
  await expect(
    runOpenAICohorts({
      fixtures: [FIXTURES[0]!],
      signal: new AbortController().signal,
      firstTriplet: async () => {},
      record: async () => {
        records++;
      },
      execute: async () => {
        const r = result('uncached');
        r.run.budgetValid = false;
        return r;
      },
    }),
  ).rejects.toThrow('budget');
  expect(records).toBe(1);
});

test('first triplet pauses before fourth dispatch and continues without replay', async () => {
  let calls = 0,
    gateCalls = 0,
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  const running = runOpenAICohorts({
    fixtures: [FIXTURES[0]!],
    signal: new AbortController().signal,
    execute: async (_f, phase) => {
      calls++;
      return result(phase);
    },
    record: async () => {},
    firstTriplet: async (rows) => {
      gateCalls++;
      expect(rows).toHaveLength(3);
      entered();
      await gate;
    },
  });
  await ready;
  expect(calls).toBe(3);
  await Bun.sleep(20);
  expect(calls).toBe(3);
  release();
  await running;
  expect(calls).toBe(30);
  expect(gateCalls).toBe(1);
});

test('resume retains failed uncached sample and dispatches only prime/warm remainder', async () => {
  const old = result('uncached');
  old.run.success = false;
  const calls: string[] = [];
  const records: string[] = [];
  const r = await runOpenAICohorts({
    fixtures: [FIXTURES[0]!],
    signal: new AbortController().signal,
    previous: [{ fixture: FIXTURES[0]!.id, phase: 'uncached', index: 0, result: old }],
    firstTriplet: async () => {
      throw new Error('must not replay gate');
    },
    execute: async (_f, phase, index) => {
      calls.push(`${phase}:${index}`);
      return result(phase);
    },
    record: async (row) => {
      records.push(`${row.phase}:${row.index}`);
    },
  });
  expect(calls[0]).toBe('prime:0');
  expect(calls).not.toContain('uncached:0');
  expect(calls).toHaveLength(29);
  expect(records).toEqual(calls);
  expect(r.measured[0]!.run.success).toBe(false);
});

test('resumed failed prime is recorded once and never advances to warm or retry', async () => {
  const old = result('uncached');
  old.run.success = false;
  let calls = 0,
    records = 0;
  await expect(
    runOpenAICohorts({
      fixtures: [FIXTURES[0]!],
      signal: new AbortController().signal,
      previous: [{ fixture: FIXTURES[0]!.id, phase: 'uncached', index: 0, result: old }],
      firstTriplet: async () => {
        throw new Error('old gate');
      },
      execute: async (_f, phase) => {
        expect(phase).toBe('prime');
        calls++;
        const r = result('prime');
        r.run.success = false;
        return r;
      },
      record: async () => {
        records++;
      },
    }),
  ).rejects.toThrow('prime');
  expect(calls).toBe(1);
  expect(records).toBe(1);
});

test('record prime outcome keeps failed-task primes, still pairs warm and halts on invalid evidence', async () => {
  const records: string[] = [];
  const r = await runOpenAICohorts({
    fixtures: [FIXTURES[0]!],
    signal: new AbortController().signal,
    primeOutcome: 'record',
    previous: [],
    firstTriplet: async () => {},
    execute: async (_f, phase) => {
      const out = result(phase);
      if (phase === 'prime') out.run.success = false;
      return out;
    },
    record: async (row) => {
      records.push(`${row.phase}:${row.index}:${row.result.run.success}`);
    },
  });
  expect(r.measured).toHaveLength(20);
  expect(records.filter((x) => x.startsWith('prime:') && x.endsWith(':false'))).toHaveLength(10);
  for (const fault of ['lifecycle', 'accounting', 'generation'] as const) {
    let records = 0;
    await expect(
      runOpenAICohorts({
        fixtures: [FIXTURES[0]!],
        signal: new AbortController().signal,
        primeOutcome: 'record',
        firstTriplet: async () => {},
        execute: async (_f, phase) => {
          const out = result(phase);
          if (phase === 'prime') {
            out.run.success = false;
            if (fault === 'lifecycle') out.run.infrastructureValid = false;
            if (fault === 'accounting') out.run.allAttemptsAccounted = false;
            if (fault === 'generation') out.run.attempts = [{ generationComplete: false } as any];
          }
          return out;
        },
        record: async () => {
          records++;
        },
      }),
    ).rejects.toThrow();
    expect(records).toBe(2);
  }
  await expect(
    runOpenAICohorts({
      fixtures: [FIXTURES[0]!],
      signal: new AbortController().signal,
      primeOutcome: 'record',
      firstTriplet: async () => {},
      execute: async (_f, phase) => {
        const out = result(phase);
        if (phase === 'warm') out.cacheVerified = false;
        return out;
      },
      record: async () => {},
    }),
  ).rejects.toThrow('cache');
});

test('resume may start at an uncached position but never at a warm one', async () => {
  const ok = result('uncached');
  const prime = result('prime');
  const warm = result('warm');
  const calls: string[] = [];
  await runOpenAICohorts({
    fixtures: [FIXTURES[0]!],
    signal: new AbortController().signal,
    primeOutcome: 'record',
    previous: [
      { fixture: FIXTURES[0]!.id, phase: 'uncached', index: 0, result: ok },
      { fixture: FIXTURES[0]!.id, phase: 'prime', index: 0, result: prime },
      { fixture: FIXTURES[0]!.id, phase: 'warm', index: 0, result: warm },
    ],
    firstTriplet: async () => {
      throw new Error('no gate on resume');
    },
    execute: async (_f, phase, index) => {
      calls.push(`${phase}:${index}`);
      return result(phase);
    },
    record: async () => {},
  });
  expect(calls[0]).toBe('uncached:1');
  await expect(
    runOpenAICohorts({
      fixtures: [FIXTURES[0]!],
      signal: new AbortController().signal,
      previous: [
        { fixture: FIXTURES[0]!.id, phase: 'uncached', index: 0, result: ok },
        { fixture: FIXTURES[0]!.id, phase: 'prime', index: 0, result: prime },
      ],
      firstTriplet: async () => {},
      execute: async (_f, phase) => result(phase),
      record: async () => {},
    }),
  ).rejects.toThrow('resume prefix');
});
