/**
 * Continuation of a stopped M4 run (plans/ptc-m4-evaluation.md, round 2 amendment): validates
 * the stopped run's pinned artifacts, recomputes its spend, charges every attempt without usage
 * at its full worst-case reservation, supersedes the stopping row (charged, never measured) and
 * returns the rows to reuse and where to resume. No recorded row is dispatched again.
 */
import { createHash } from 'node:crypto';
import { ATTEMPT_RESERVATION_UNITS } from './openai-budget.js';
import { OPENAI_PROTOCOL, openAICostUnits } from './openai-contract.js';
import { M4_BOUNDS } from './m4-bounds.js';
import { PTC_ORACLE_MAPPING } from './ptc-surface.js';
import { TEAM_ORACLE_REVISION } from './team-evidence.js';
import {
  APPROVED_OPENAI_001,
  openAIOrder,
  rowAdvances,
  type OpenAIRecordedRow,
} from './openai-resume.js';

export { ATTEMPT_RESERVATION_UNITS };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const lines = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

export interface StoppedRunPin {
  name: string;
  pins: { node: string; chat: string };
  controller: string;
  trials: string;
  budget: string;
  summary: string;
  carry: { spentUnits: number; admittedAttempts: number };
}

export function validateM4Stopped(
  texts: { trials: string; budget: string; summary: string },
  pin: StoppedRunPin,
) {
  if (
    sha256(texts.trials) !== pin.trials ||
    sha256(texts.budget) !== pin.budget ||
    sha256(texts.summary) !== pin.summary
  )
    throw new Error('Stopped M4 run hash mismatch');
  const [manifest, ...rows] = lines(texts.trials) as [any, ...OpenAIRecordedRow[]];
  if (
    manifest?.kind !== 'ptc-m4' ||
    manifest.provider !== 'openai' ||
    manifest.primeOutcome !== 'record' ||
    manifest.controllerSourceHash !== pin.controller ||
    JSON.stringify(manifest.pins) !== JSON.stringify(pin.pins) ||
    JSON.stringify(manifest.carry) !== JSON.stringify(pin.carry) ||
    JSON.stringify(manifest.protocol) !== JSON.stringify(OPENAI_PROTOCOL) ||
    // Same fixtures, oracle mapping and bounds as the run that continues it.
    manifest.fixtureHash !== APPROVED_OPENAI_001.fixture ||
    manifest.oracleMapping !== PTC_ORACLE_MAPPING ||
    manifest.teamOracleRevision !== TEAM_ORACLE_REVISION ||
    JSON.stringify(manifest.bounds) !== JSON.stringify(M4_BOUNDS)
  )
    throw new Error('Stopped M4 manifest mismatch');
  const order = openAIOrder();
  if (rows.length === 0 || rows.length >= order.length)
    throw new Error('Stopped M4 run length unexpected');
  let spent = pin.carry.spentUnits,
    attempts = pin.carry.admittedAttempts,
    unknown = 0;
  rows.forEach((row, i) => {
    const wanted = order[i]!;
    if (
      row.fixture !== wanted.fixture ||
      row.index !== wanted.index ||
      row.phase !== wanted.phase ||
      row.result.run.fixture !== wanted.fixture ||
      row.result.condition !== (wanted.phase === 'uncached' ? 'uncached' : 'warm')
    )
      throw new Error('Stopped M4 sequence mismatch');
    for (const attempt of row.result.run.attempts) {
      if (attempt.usage) spent += openAICostUnits(attempt.usage);
      else if (i === rows.length - 1) unknown++;
      else throw new Error('Stopped M4 usage missing before the stop');
    }
    attempts += row.result.run.attempts.length;
    const b = row.result.run.budget;
    if (b.spentUnits !== spent || b.admittedAttempts !== attempts)
      throw new Error('Stopped M4 row budget mismatch');
    if (i < rows.length - 1 && !rowAdvances(row)) throw new Error('Stopped M4 row invalid');
  });
  const stop = rows.at(-1)!;
  if (rowAdvances(stop)) throw new Error('Stopped M4 run has no stopping row');
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
    throw new Error('Stopped M4 budget mismatch');
  const retained = rows.slice(0, -1);
  const superseded = [
    {
      fixture: stop.fixture,
      phase: stop.phase,
      index: stop.index,
      reason: unknown ? 'uncertain_usage' : 'gate',
    },
  ];
  // A trailing prime lost its warm pair with the stopped process.
  if (retained.at(-1)?.phase === 'prime') {
    const prime = retained.pop()!;
    superseded.push({
      fixture: prime.fixture,
      phase: prime.phase,
      index: prime.index,
      reason: 'pair_lost',
    });
  }
  return {
    rows: retained,
    // Uncertain attempts are charged at their full reservation: never under-counted.
    carry: { spentUnits: spent + unknown * ATTEMPT_RESERVATION_UNITS, admittedAttempts: attempts },
    chargedUncertain: { attempts: unknown, units: unknown * ATTEMPT_RESERVATION_UNITS },
    next: order[retained.length]!,
    superseded,
  };
}
