import { expect, test } from 'bun:test';
import { runCohorts } from './ptc-m1/cohort.js';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { newMetrics, type Trial } from './ptc-m1/metrics.js';
import { COLD_CACHE_WAIT_MS } from './ptc-m1/cache-evidence.js';
const row = (cache: 'cold' | 'warm'): Trial => ({
  fixture: FIXTURES[0]!.id,
  kind: 'coding',
  cache,
  success: true,
  metrics: { ...newMetrics(), requestCount: 1, modelRounds: 1 },
  wallMs: 1,
  cpuMs: 1,
  cgroupMemoryPeakBytes: 1,
  provenance: 'synthetic',
  cacheVerified: true,
  childrenAccounted: true,
  allAttemptsAccounted: true,
  authorizationOracle: null,
  cancellationOracle: null,
});
test('cohort counts ten cold and warm plus charged priming, never promotes synthetic evidence', async () => {
  let now = 0;
  const phases: string[] = [];
  const sleeps: number[] = [];
  const result = await runCohorts({
    fixtures: [FIXTURES[0]!],
    signal: new AbortController().signal,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    record: async (entry) => {
      phases.push(entry.phase);
    },
    execute: async (_f, cache) => {
      now += 20;
      return { trial: row(cache), requestFinishedAt: now, infrastructureValid: true };
    },
  });
  expect(result.trials).toHaveLength(20);
  expect(phases.filter((phase) => phase === 'warmup')).toHaveLength(10);
  expect(sleeps).toEqual(Array(10).fill(COLD_CACHE_WAIT_MS));
  expect(result.missing).toContain('synthetic_usage');
});
test('missing usage halts without retry and persists invalid record; abort never dispatches', async () => {
  let now = 0,
    calls = 0,
    records = 0;
  const abort = new AbortController();
  const options = {
    fixtures: [FIXTURES[0]!],
    signal: abort.signal,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    record: async () => {
      records++;
    },
    execute: async (_f: unknown, cache: 'cold' | 'warm') => {
      calls++;
      const trial = row(cache);
      trial.metrics.missingUsage = 1;
      return { trial, requestFinishedAt: now, infrastructureValid: true };
    },
  };
  await expect(runCohorts(options)).rejects.toThrow('Incomplete usage');
  expect(calls).toBe(1);
  expect(records).toBe(1);
  abort.abort();
  await expect(runCohorts(options)).rejects.toThrow();
  expect(calls).toBe(1);
});

test('bad timing still records the charged attempt before halting', async () => {
  for (const timing of [NaN, -1, Infinity]) {
    let now = 0,
      records = 0,
      calls = 0;
    await expect(
      runCohorts({
        fixtures: [FIXTURES[0]!],
        signal: new AbortController().signal,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        record: async () => {
          records++;
        },
        execute: async (_fixture, cache) => {
          calls++;
          return { trial: row(cache), requestFinishedAt: timing, infrastructureValid: true };
        },
      }),
    ).rejects.toThrow('timing');
    expect(records).toBe(1);
    expect(calls).toBe(1);
  }
});

test('measured infrastructure failure is retained and halts instead of counting as model failure', async () => {
  let now = 0,
    records = 0,
    calls = 0;
  await expect(
    runCohorts({
      fixtures: [FIXTURES[0]!],
      signal: new AbortController().signal,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      record: async () => {
        records++;
      },
      execute: async (_f, cache) => {
        calls++;
        return { trial: row(cache), requestFinishedAt: now, infrastructureValid: false };
      },
    }),
  ).rejects.toThrow('lifecycle');
  expect(records).toBe(1);
  expect(calls).toBe(1);
});
