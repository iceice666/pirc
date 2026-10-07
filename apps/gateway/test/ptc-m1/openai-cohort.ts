/** OpenAI-only matrix contract; old Opus cold cohort remains immutable. */
import { OPENAI_PROTOCOL } from './openai-contract.js';
import type { OpenAICondition } from './openai-cache.js';
import type { runOpenAIFixture } from './openai-runner.js';
import { FIXTURES, type Fixture } from './fixtures.js';
import { openAIReadiness } from './openai-readiness.js';
import type { OpenAIRecordedRow } from './openai-resume.js';
export type OpenAIRun = Awaited<ReturnType<typeof runOpenAIFixture>>;
export interface OpenAICohortResult {
  run: OpenAIRun;
  condition: OpenAICondition;
  cacheVerified: boolean;
  infrastructureValid: boolean;
  provenance: 'real-openai' | 'synthetic';
  cacheDiagnostics?: {
    firstRequestObserved: boolean;
    identicalPrimedBody: boolean;
    initialComplete: boolean;
    initialCacheRead: number | null;
  };
}
export async function runOpenAICohorts(options: {
  fixtures: readonly Fixture[];
  signal: AbortSignal;
  /** Validated aggregate prefix only; no completed row is dispatched or recorded again. */
  previous?: readonly OpenAIRecordedRow[];
  /**
   * `gate` (default, historical) halts on a prime whose task failed. `record` keeps the charged
   * prime row and still requires infrastructure/accounting/generation validity; warm validity
   * stays decided by identical initial bodies plus actual cache hits, never prime task success.
   */
  primeOutcome?: 'gate' | 'record';
  /** Required first-pair observation gate; no further dispatch until it resolves. */
  firstTriplet: (rows: readonly OpenAICohortResult[]) => Promise<void>;
  execute: (
    fixture: Fixture,
    phase: 'uncached' | 'prime' | 'warm',
    index: number,
  ) => Promise<OpenAICohortResult>;
  record: (row: {
    fixture: string;
    phase: 'uncached' | 'prime' | 'warm';
    index: number;
    result: OpenAICohortResult;
  }) => Promise<void>;
}) {
  if (
    new Set(options.fixtures.map((f) => f.id)).size !== options.fixtures.length ||
    options.fixtures.some(
      (f) => !FIXTURES.some((known) => known.id === f.id && known.kind === f.kind),
    )
  )
    throw new Error('Invalid fixture selection');
  const previous = options.previous ?? [];
  const order = options.fixtures
    .flatMap((f) =>
      Array.from({ length: OPENAI_PROTOCOL.trialsPerCondition }, (_, index) =>
        (['uncached', 'prime', 'warm'] as const).map((phase) => ({ fixture: f.id, index, phase })),
      ),
    )
    .flat();
  if (
    previous.length &&
    (previous.length >= order.length ||
      order[previous.length]?.phase === 'warm' ||
      previous.some(
        (row, i) =>
          row.fixture !== order[i]?.fixture ||
          row.index !== order[i]?.index ||
          row.phase !== order[i]?.phase,
      ))
  )
    throw new Error('Invalid resume prefix');
  const measured: OpenAICohortResult[] = [];
  let cursor = 0;
  const execute = async (fixture: Fixture, phase: 'uncached' | 'prime' | 'warm', index: number) => {
    options.signal.throwIfAborted();
    const reused = previous[cursor++];
    const result = reused?.result ?? (await options.execute(fixture, phase, index));
    if (!reused) await options.record({ fixture: fixture.id, phase, index, result });
    options.signal.throwIfAborted();
    if (!result.infrastructureValid || !result.run.infrastructureValid)
      throw new Error('OpenAI lifecycle invalid');
    if (
      result.run.fixture !== fixture.id ||
      result.run.kind !== fixture.kind ||
      result.condition !== (phase === 'uncached' ? 'uncached' : 'warm')
    )
      throw new Error('OpenAI cohort mismatch');
    if (
      !result.run.allAttemptsAccounted ||
      !result.run.childrenAccounted ||
      result.run.metrics.missingUsage !== 0
    )
      throw new Error('OpenAI accounting incomplete');
    if (
      !result.run.budgetValid ||
      result.run.budget.halted ||
      result.run.budget.reservedUnits !== 0
    )
      throw new Error('OpenAI budget invalid');
    if (result.run.attempts.some((a) => !a.generationComplete))
      throw new Error('OpenAI generation incomplete');
    if (phase === 'prime' && !result.run.success && options.primeOutcome !== 'record')
      throw new Error('OpenAI prime failed');
    if (phase !== 'prime' && !result.cacheVerified)
      throw new Error('OpenAI cache evidence invalid');
    return result;
  };
  for (const fixture of options.fixtures)
    for (let index = 0; index < OPENAI_PROTOCOL.trialsPerCondition; index++) {
      const uncached = await execute(fixture, 'uncached', index);
      measured.push(uncached);
      const prime = await execute(fixture, 'prime', index);
      const warm = await execute(fixture, 'warm', index);
      measured.push(warm);
      if (measured.length === 2 && previous.length === 0) {
        await options.firstTriplet([uncached, prime, warm]);
        options.signal.throwIfAborted();
      }
    }
  const missing = openAIReadiness(measured);
  return { measured, missing, complete: missing.length === 0 };
}
