/**
 * Round 3 (docs/evaluations/ptc/ptc-m4-evaluation.md): the `main` and branch binaries measured in one session,
 * interleaved per fixture and index with alternating order, so provider latency drift affects
 * both arms alike. Each arm keeps the M1 cohort shape (uncached, prime, warm) and gates.
 */
import { createHash } from 'node:crypto';
import { FIXTURES, type Fixture } from './fixtures.js';
import { ATTEMPT_RESERVATION_UNITS } from './openai-budget.js';
import { OPENAI_PROTOCOL, openAICostUnits } from './openai-contract.js';
import type { OpenAICohortResult } from './openai-cohort.js';
import { openAIReadiness } from './openai-readiness.js';
import { rowAdvances, type OpenAIRecordedRow } from './openai-resume.js';

export type Arm = 'main' | 'ptc';
export const ARMS: readonly Arm[] = ['main', 'ptc'];
export type Phase = 'uncached' | 'prime' | 'warm';
export interface PairedPosition {
  arm: Arm;
  fixture: string;
  index: number;
  phase: Phase;
}
export type PairedRow = PairedPosition & { result: OpenAICohortResult };

/** Per fixture and index, both arms; `main` first on even indices, the branch first on odd. */
export function pairedOrder(fixtures: readonly Fixture[] = FIXTURES): PairedPosition[] {
  return fixtures.flatMap((fixture) =>
    Array.from({ length: OPENAI_PROTOCOL.trialsPerCondition }, (_, index) => index).flatMap(
      (index) =>
        (index % 2 === 0 ? (['main', 'ptc'] as const) : (['ptc', 'main'] as const)).flatMap((arm) =>
          (['uncached', 'prime', 'warm'] as const).map((phase) => ({
            arm,
            fixture: fixture.id,
            index,
            phase,
          })),
        ),
    ),
  );
}

/** The gates runOpenAICohorts applies to every row (prime outcome recorded, not gating). */
export function gatePairedRow(row: PairedRow, fixture: Fixture): void {
  const result = row.result;
  if (!result.infrastructureValid || !result.run.infrastructureValid)
    throw new Error('OpenAI lifecycle invalid');
  if (
    result.run.fixture !== fixture.id ||
    result.run.kind !== fixture.kind ||
    result.condition !== (row.phase === 'uncached' ? 'uncached' : 'warm')
  )
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
  if (row.phase !== 'prime' && !result.cacheVerified)
    throw new Error('OpenAI cache evidence invalid');
}

export async function runPairedCohorts(options: {
  signal: AbortSignal;
  /** Validated rows of stopped runs; never dispatched or recorded again. */
  previous?: readonly PairedRow[];
  /** First pair of triplets (both arms of the first fixture index); no dispatch until it resolves. */
  firstStage: (rows: readonly PairedRow[]) => Promise<void>;
  execute: (arm: Arm, fixture: Fixture, phase: Phase, index: number) => Promise<OpenAICohortResult>;
  record: (row: PairedRow) => Promise<void>;
}) {
  const order = pairedOrder();
  const previous = options.previous ?? [];
  if (
    previous.length &&
    (previous.length >= order.length ||
      order[previous.length]!.phase === 'warm' ||
      previous.some(
        (row, i) =>
          row.arm !== order[i]!.arm ||
          row.fixture !== order[i]!.fixture ||
          row.index !== order[i]!.index ||
          row.phase !== order[i]!.phase,
      ))
  )
    throw new Error('Invalid paired resume prefix');
  const rows: PairedRow[] = [];
  for (const [i, position] of order.entries()) {
    options.signal.throwIfAborted();
    const fixture = FIXTURES.find((f) => f.id === position.fixture)!;
    const reused = previous[i];
    const row: PairedRow = reused ?? {
      ...position,
      result: await options.execute(position.arm, fixture, position.phase, position.index),
    };
    if (!reused) await options.record(row);
    options.signal.throwIfAborted();
    gatePairedRow(row, fixture);
    rows.push(row);
    if (rows.length === 6 && previous.length === 0) {
      await options.firstStage(rows);
      options.signal.throwIfAborted();
    }
  }
  const measured = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      rows.filter((row) => row.arm === arm && row.phase !== 'prime').map((row) => row.result),
    ]),
  ) as Record<Arm, OpenAICohortResult[]>;
  const missing = Object.fromEntries(
    ARMS.map((arm) => [arm, openAIReadiness(measured[arm])]),
  ) as Record<Arm, string[]>;
  return { rows, measured, missing, complete: ARMS.every((arm) => missing[arm].length === 0) };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const lines = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

export interface PairedStopPin {
  name: string;
  trials: string;
  budget: string;
  summary: string;
  controller: string;
  /** The budget at the start of the stopped run. */
  carry: { spentUnits: number; admittedAttempts: number };
}

/**
 * A stopped round 3 run, continued under the round 2 amendment rule (pre-declared for round 3):
 * recorded rows before the stop are reused, attempts without usage on the stopping row are
 * charged at their full reservation, the stopping row is superseded and repeated, and a
 * trailing prime (its warm pair died with the process) is superseded too.
 */
export function validatePairedStopped(
  texts: { trials: string; budget: string; summary: string },
  pin: PairedStopPin,
  previous: readonly PairedRow[],
  check: (manifest: any) => boolean,
) {
  if (
    sha256(texts.trials) !== pin.trials ||
    sha256(texts.budget) !== pin.budget ||
    sha256(texts.summary) !== pin.summary
  )
    throw new Error('Stopped paired run hash mismatch');
  const [manifest, ...rows] = lines(texts.trials) as [any, ...PairedRow[]];
  if (
    manifest?.kind !== 'ptc-m4-paired' ||
    manifest.controllerSourceHash !== pin.controller ||
    JSON.stringify(manifest.carry) !== JSON.stringify(pin.carry) ||
    manifest.reusedRows !== previous.length ||
    !check(manifest)
  )
    throw new Error('Stopped paired manifest mismatch');
  const order = pairedOrder();
  if (rows.length === 0 || previous.length + rows.length > order.length)
    throw new Error('Stopped paired run length unexpected');
  let spent = pin.carry.spentUnits,
    attempts = pin.carry.admittedAttempts,
    unknown = 0;
  rows.forEach((row, i) => {
    const wanted = order[previous.length + i]!;
    if (
      row.arm !== wanted.arm ||
      row.fixture !== wanted.fixture ||
      row.index !== wanted.index ||
      row.phase !== wanted.phase ||
      row.result.run.fixture !== wanted.fixture
    )
      throw new Error('Stopped paired sequence mismatch');
    for (const attempt of row.result.run.attempts) {
      if (attempt.usage) spent += openAICostUnits(attempt.usage);
      else if (i === rows.length - 1) unknown++;
      else throw new Error('Stopped paired usage missing before the stop');
    }
    attempts += row.result.run.attempts.length;
    const b = row.result.run.budget;
    if (b.spentUnits !== spent || b.admittedAttempts !== attempts)
      throw new Error('Stopped paired row budget mismatch');
    if (i < rows.length - 1 && !rowAdvances(row as unknown as OpenAIRecordedRow))
      throw new Error('Stopped paired row invalid');
  });
  const stop = rows.at(-1)!;
  if (rowAdvances(stop as unknown as OpenAIRecordedRow))
    throw new Error('Stopped paired run has no stopping row');
  const ledger = lines(texts.budget);
  const final = ledger.at(-1);
  const summary = JSON.parse(texts.summary);
  if (
    ledger[0]?.spentUnits !== pin.carry.spentUnits ||
    ledger[0]?.admittedAttempts !== pin.carry.admittedAttempts ||
    summary.complete !== false ||
    JSON.stringify(summary.budget) !== JSON.stringify(final) ||
    final.spentUnits !== spent ||
    final.admittedAttempts !== attempts ||
    final.unknownAttempts !== unknown ||
    final.reservedUnits !== unknown * ATTEMPT_RESERVATION_UNITS
  )
    throw new Error('Stopped paired budget mismatch');
  const retained = rows.slice(0, -1);
  const superseded = [
    {
      arm: stop.arm,
      fixture: stop.fixture,
      phase: stop.phase,
      index: stop.index,
      reason: unknown ? 'uncertain_usage' : 'gate',
    },
  ];
  if (retained.at(-1)?.phase === 'prime') {
    const prime = retained.pop()!;
    superseded.push({
      arm: prime.arm,
      fixture: prime.fixture,
      phase: prime.phase,
      index: prime.index,
      reason: 'pair_lost',
    });
  }
  return {
    rows: [...previous, ...retained],
    carry: { spentUnits: spent + unknown * ATTEMPT_RESERVATION_UNITS, admittedAttempts: attempts },
    chargedUncertain: { attempts: unknown, units: unknown * ATTEMPT_RESERVATION_UNITS },
    superseded,
  };
}
