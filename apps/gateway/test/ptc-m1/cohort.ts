/** Cohort orchestration, injected execution so offline tests cannot accidentally contact a model. */
import { EVALUATION_PROTOCOL, baselineReadiness, type Trial } from './metrics.js';
import type { Fixture } from './fixtures.js';
import { COLD_CACHE_WAIT_MS } from './cache-evidence.js';

export interface CohortResult {
  /** Warm-up/invalid usage is still charged and retained by the shared provider ledger. */
  trial: Trial;
  requestFinishedAt: number;
  infrastructureValid: boolean;
}
export async function runCohorts(options: {
  fixtures: readonly Fixture[];
  signal: AbortSignal;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Persist each result immediately; never accept raw requests/content here. */
  record: (entry: {
    fixture: string;
    phase: 'warmup' | 'measured';
    index: number;
    result: CohortResult;
  }) => Promise<void>;
  execute: (
    fixture: Fixture,
    cache: 'cold' | 'warm',
    phase: 'warmup' | 'measured',
    index: number,
  ) => Promise<CohortResult>;
}) {
  const trials: Trial[] = [];
  // First cold request also waits for potential prior endpoint cache activity.
  let lastRequest = options.now();
  const execute = async (
    fixture: Fixture,
    cache: 'cold' | 'warm',
    phase: 'warmup' | 'measured',
    index: number,
  ) => {
    options.signal.throwIfAborted();
    const result = await options.execute(fixture, cache, phase, index);
    await options.record({ fixture: fixture.id, phase, index, result });
    if (result.infrastructureValid !== true) throw new Error('Invalid lifecycle halts cohort');
    if (
      !Number.isFinite(result.requestFinishedAt) ||
      result.requestFinishedAt < lastRequest ||
      result.requestFinishedAt > options.now()
    )
      throw new Error('Invalid provider timing evidence');
    lastRequest = result.requestFinishedAt;
    options.signal.throwIfAborted();
    if (
      result.trial.fixture !== fixture.id ||
      result.trial.kind !== fixture.kind ||
      result.trial.cache !== cache
    )
      throw new Error('Mismatched cohort result');
    if (result.trial.metrics.missingUsage || !result.trial.allAttemptsAccounted)
      throw new Error('Incomplete usage halts cohort');
    return result.trial;
  };
  for (const fixture of options.fixtures) {
    for (let index = 0; index < EVALUATION_PROTOCOL.trialsPerCacheCondition; index++) {
      const wait = Math.max(0, lastRequest + COLD_CACHE_WAIT_MS - options.now());
      if (wait) await options.sleep(wait, options.signal);
      options.signal.throwIfAborted();
      if (options.now() < lastRequest + COLD_CACHE_WAIT_MS)
        throw new Error('Cold TTL wait incomplete');
      const cold = await execute(fixture, 'cold', 'measured', index);
      if (!cold.cacheVerified) throw new Error('Cold cache evidence missing');
      trials.push(cold);
      const prime = await execute(fixture, 'warm', 'warmup', index);
      if (!prime.success) throw new Error('Warm priming did not complete successfully');
      const warm = await execute(fixture, 'warm', 'measured', index);
      if (!warm.cacheVerified) throw new Error('Warm cache evidence missing');
      trials.push(warm);
    }
  }
  return { trials, missing: baselineReadiness(trials, options.fixtures) };
}
