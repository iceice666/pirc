/**
 * The public-benchmark matrix (plans/ptc-m4-evaluation.md, "Public benchmark"): uncached trials
 * only (cache conditions are not under test here). The holdout run interleaves the arms per
 * exercise and trial, alternating which goes first; a development run measures the branch only.
 */
import type { OpenAICohortResult } from './openai-cohort.js';
import { openAIReadiness } from './openai-readiness.js';
import type { ExerciseFixture } from './polyglot.js';
import type { Arm } from './m4-paired.js';

export interface ExercisePosition {
  arm: Arm;
  fixture: string;
  trial: number;
}
export type ExerciseRow = ExercisePosition & { result: OpenAICohortResult };

export function exerciseOrder(
  fixtures: readonly ExerciseFixture[],
  arms: readonly Arm[],
  trials: number,
): ExercisePosition[] {
  return Array.from({ length: trials }, (_, trial) => trial).flatMap((trial) =>
    fixtures.flatMap((fixture, i) => {
      const order = (trial + i) % 2 === 0 ? arms : [...arms].reverse();
      return order.map((arm) => ({ arm, fixture: fixture.id, trial }));
    }),
  );
}

/** The per-row gates of the paired runner, for uncached rows. */
export function gateExerciseRow(row: ExerciseRow, fixture: ExerciseFixture): void {
  const result = row.result;
  if (!result.infrastructureValid || !result.run.infrastructureValid)
    throw new Error('OpenAI lifecycle invalid');
  if (result.run.fixture !== fixture.id || result.condition !== 'uncached')
    throw new Error('OpenAI cohort mismatch');
  if (
    !result.run.allAttemptsAccounted ||
    !result.run.childrenAccounted ||
    result.run.metrics.missingUsage !== 0
  )
    throw new Error('OpenAI accounting incomplete');
  if (!result.run.budgetValid || result.run.budget.halted || result.run.budget.reservedUnits !== 0)
    throw new Error('OpenAI budget invalid');
  if (result.run.attempts.some((a) => !a.generationComplete))
    throw new Error('OpenAI generation incomplete');
  if (!result.cacheVerified) throw new Error('OpenAI cache evidence invalid');
}

/** M1's per-row readiness (its matrix and fixture checks do not apply), plus completeness. */
export function exerciseReadiness(
  rows: readonly ExerciseRow[],
  order: readonly ExercisePosition[],
): string[] {
  const missing = new Set(
    openAIReadiness(rows.map((row) => row.result)).filter(
      (code) => code !== 'matrix_incomplete' && code !== 'unknown_fixture',
    ),
  );
  if (
    rows.length !== order.length ||
    rows.some(
      (row, i) =>
        row.arm !== order[i]!.arm ||
        row.fixture !== order[i]!.fixture ||
        row.trial !== order[i]!.trial,
    )
  )
    missing.add('matrix_incomplete');
  return [...missing].sort();
}

export async function runExerciseMatrix(options: {
  fixtures: readonly ExerciseFixture[];
  arms: readonly Arm[];
  trials: number;
  signal: AbortSignal;
  execute: (arm: Arm, fixture: ExerciseFixture, trial: number) => Promise<OpenAICohortResult>;
  record: (row: ExerciseRow) => Promise<void>;
  /** After the first exercise's rows (every arm); no dispatch until it resolves. */
  firstStage?: (rows: readonly ExerciseRow[]) => Promise<void>;
}) {
  const order = exerciseOrder(options.fixtures, options.arms, options.trials);
  const rows: ExerciseRow[] = [];
  for (const position of order) {
    options.signal.throwIfAborted();
    const fixture = options.fixtures.find((f) => f.id === position.fixture)!;
    const row: ExerciseRow = {
      ...position,
      result: await options.execute(position.arm, fixture, position.trial),
    };
    await options.record(row);
    options.signal.throwIfAborted();
    gateExerciseRow(row, fixture);
    rows.push(row);
    if (rows.length === options.arms.length && options.firstStage) {
      await options.firstStage(rows);
      options.signal.throwIfAborted();
    }
  }
  const missing = exerciseReadiness(rows, order);
  return { rows, missing, complete: missing.length === 0 };
}
