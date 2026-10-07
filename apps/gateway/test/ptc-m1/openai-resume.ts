/** Validates an immutable aggregate prefix; no raw sessions and no discarded task failures. */
import { createHash } from 'node:crypto';
import { FIXTURES } from './fixtures.js';
import { OPENAI_PROTOCOL, openAICostUnits } from './openai-contract.js';
import type { OpenAICohortResult } from './openai-cohort.js';
export const APPROVED_OPENAI_001 = {
  trials: '81c35ecbd5cfb5ddae17d8ec5e6124ee7831c9c65f80897c22900f731f87bce5',
  budget: '7764043b75aceac62b2c2e1212f6bc353e5930690422e4e9ebe287e3ad365a08',
  summary: 'f4a0cb66f197cf257be47bb924a05518cef283d2e5459c413cce68e9a000f463',
  controller: '7bde20ffe2fe65b21d4bb99593110614d25cdd5c71f7c6602c9fce9c1255e8e6',
  fixture: '39f59e86faee6ff61d053c62d0e485e0bd2c1d355d7764d3292caa3ac491d106',
} as const;
export interface OpenAIRecordedRow {
  fixture: string;
  phase: 'uncached' | 'prime' | 'warm';
  index: number;
  result: OpenAICohortResult;
}
export function openAIOrder() {
  return FIXTURES.flatMap((f) =>
    Array.from({ length: OPENAI_PROTOCOL.trialsPerCondition }, (_, index) =>
      (['uncached', 'prime', 'warm'] as const).map((phase) => ({ fixture: f.id, index, phase })),
    ),
  ).flat();
}
export function validateOpenAIResume(
  text: string,
  expectedHash: string,
  budget: { spentUnits: number; admittedAttempts: number; reservedUnits: number; halted: boolean },
) {
  if (createHash('sha256').update(text).digest('hex') !== expectedHash)
    throw new Error('Resume source hash mismatch');
  const parsed = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (
    parsed[0]?.kind !== 'manifest' ||
    parsed[0]?.provider !== 'openai' ||
    JSON.stringify(parsed[0]?.protocol) !== JSON.stringify(OPENAI_PROTOCOL) ||
    parsed[0]?.baseline !== '16c80846da64c07114d8cd43bab68748e5474127' ||
    parsed[0]?.controllerSourceHash !== APPROVED_OPENAI_001.controller ||
    parsed[0]?.fixtureHash !== APPROVED_OPENAI_001.fixture ||
    parsed[0]?.pins?.node !== '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80' ||
    parsed[0]?.pins?.chat !== 'be2eb5fbf1908dd1ddaa74be79cdb503e7dafcf73413a0d1fb2a87618fea8aaf' ||
    parsed[0]?.endpointFingerprint !==
      'd9617135d6fdd0a2cde722d637a1dfcc3da37515708b3ea5d66ae607c8ac785e'
  )
    throw new Error('Resume manifest mismatch');
  const rows = parsed.slice(1) as OpenAIRecordedRow[],
    order = openAIOrder();
  if (rows.length !== 271 || rows.length >= order.length)
    throw new Error('Unexpected approved resume cursor');
  let spent = 0,
    attempts = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!,
      wanted = order[i]!;
    if (
      row.fixture !== wanted.fixture ||
      row.index !== wanted.index ||
      row.phase !== wanted.phase ||
      row.result.run.fixture !== wanted.fixture ||
      row.result.condition !== (wanted.phase === 'uncached' ? 'uncached' : 'warm')
    )
      throw new Error('Resume sequence mismatch');
    const r = row.result.run;
    if (
      row.result.provenance !== 'real-openai' ||
      r.kind !== FIXTURES.find((f) => f.id === row.fixture)?.kind ||
      (i < rows.length - 1 && r.childrenAccounted !== true) ||
      !row.result.infrastructureValid ||
      !r.infrastructureValid ||
      !r.budgetValid ||
      !r.allAttemptsAccounted ||
      !r.accounting?.verified ||
      r.accounting.attempts !== r.attempts.length ||
      r.metrics.requestCount !== r.attempts.length ||
      r.metrics.missingUsage !== 0
    )
      throw new Error('Resume accounting invalid');
    if (row.phase !== 'prime' && !row.result.cacheVerified) throw new Error('Resume cache invalid');
    if (row.phase === 'prime' && !r.success) throw new Error('Resume prime invalid');
    for (const a of r.attempts) {
      if (
        !a.usage ||
        !a.generationComplete ||
        !a.cacheConditionValid ||
        a.completion !== 'complete'
      )
        throw new Error('Resume usage incomplete');
      spent += openAICostUnits(a.usage);
      attempts++;
    }
    if (
      r.budget.spentUnits !== spent ||
      r.budget.admittedAttempts !== attempts ||
      r.budget.reservedUnits !== 0 ||
      r.budget.halted
    )
      throw new Error('Resume row budget mismatch');
  }
  const last = rows.at(-1)!;
  if (
    last.fixture !== 'team-wait' ||
    last.phase !== 'uncached' ||
    last.index !== 0 ||
    last.result.run.success !== false ||
    last.result.run.teamEvidence?.waited !== false ||
    last.result.run.childrenAccounted !== false ||
    last.result.run.accounting?.requests !== 17 ||
    last.result.run.accounting?.owners.parent !== 6 ||
    last.result.run.accounting?.owners.child !== 7 ||
    last.result.run.accounting?.owners.auxiliary !== 4 ||
    last.result.run.accounting?.owners.unknown !== 0 ||
    last.result.run.teamEvidence?.childWriteConfirmed !== true ||
    last.result.run.teamEvidence?.childCompleted !== true
  )
    throw new Error('Unexpected corrected task boundary');
  if (
    spent !== 53688009 ||
    attempts !== 1030 ||
    spent !== budget.spentUnits ||
    attempts !== budget.admittedAttempts ||
    budget.reservedUnits !== 0 ||
    budget.halted
  )
    throw new Error('Resume budget mismatch');
  // Derived view only: original serialized row is never overwritten. Task remains failed.
  const derived = structuredClone(rows);
  const final = derived.at(-1)!.result.run;
  final.childrenAccounted = true;
  return {
    rows: derived,
    sourceHash: expectedHash,
    correction: {
      fixture: 'team-wait',
      phase: 'uncached',
      index: 0,
      field: 'childrenAccounted',
      from: false,
      to: true,
      taskSuccess: false,
    },
    carry: { spentUnits: spent, admittedAttempts: attempts },
    next: order[rows.length]!,
  };
}

/** Stopped openai-002 (one failed team prime) and the bounded team diagnostic, hash-pinned. */
export const APPROVED_OPENAI_002 = {
  trials: '2d8709af1415eb79e0cf060f785357528f5f5240233de66a9b23df3890d83dbf',
  budget: '0f2af600a52f1b6a2e458c5efdfa80acdea7aec746b8db53a9d8c6f6ad564013',
  summary: 'c42ebf0cbe85a10dba6042e20606c1ea6bbc8fd22a67009d9ba772902be16c70',
  controller: '3d167e21c798baf99f846aa31cf1bec0a239dc16a4494069713d068f4691a40d',
} as const;
export const APPROVED_TEAM_DIAGNOSTIC_001 = {
  report: '1f43f88eb8add230c99489ac639c75e1ac7fd152b6920d5a6f9cc558392910de',
  budget: '437e7a7e388cf5446d336a84324b314bc94e464cd13a7b01ff90fae16c3552c9',
} as const;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const lines = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
function attemptCost(attempts: any[], strict = true) {
  let spent = 0;
  for (const a of attempts) {
    if (
      !a?.usage ||
      (strict && (!a.generationComplete || !a.cacheConditionValid || a.completion !== 'complete'))
    )
      throw new Error('Resume usage incomplete');
    spent += openAICostUnits(a.usage);
  }
  return spent;
}
/**
 * Chains a validated openai-001 prefix through openai-002 and the diagnostic budget only.
 * The failed openai-002 prime is a superseded, charged prime attempt (its pair died with that
 * process); the diagnostic is never a matrix row. Neither is dispatched or recorded again.
 */
export function validateOpenAIResume002(
  base: ReturnType<typeof validateOpenAIResume>,
  openai002: { trials: string; budget: string; summary: string },
  diagnostic: { report: string; budget: string },
  pins: {
    openai002: { trials: string; budget: string; summary: string; controller: string };
    diagnostic: { report: string; budget: string };
  } = { openai002: APPROVED_OPENAI_002, diagnostic: APPROVED_TEAM_DIAGNOSTIC_001 },
) {
  if (
    sha256(openai002.trials) !== pins.openai002.trials ||
    sha256(openai002.budget) !== pins.openai002.budget ||
    sha256(openai002.summary) !== pins.openai002.summary ||
    sha256(diagnostic.report) !== pins.diagnostic.report ||
    sha256(diagnostic.budget) !== pins.diagnostic.budget
  )
    throw new Error('Resume source hash mismatch');
  if (
    base.rows.length !== 271 ||
    base.carry.spentUnits !== 53688009 ||
    base.carry.admittedAttempts !== 1030 ||
    JSON.stringify(base.next) !== JSON.stringify({ fixture: 'team-wait', index: 0, phase: 'prime' })
  )
    throw new Error('Resume base mismatch');
  const [manifest, ...rows] = lines(openai002.trials);
  if (
    manifest?.kind !== 'manifest' ||
    manifest.provider !== 'openai' ||
    JSON.stringify(manifest.protocol) !== JSON.stringify(OPENAI_PROTOCOL) ||
    manifest.baseline !== '16c80846da64c07114d8cd43bab68748e5474127' ||
    manifest.controllerSourceHash !== pins.openai002.controller ||
    manifest.fixtureHash !== APPROVED_OPENAI_001.fixture ||
    manifest.pins?.node !== '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80' ||
    manifest.pins?.chat !== 'be2eb5fbf1908dd1ddaa74be79cdb503e7dafcf73413a0d1fb2a87618fea8aaf' ||
    manifest.endpointFingerprint !==
      'd9617135d6fdd0a2cde722d637a1dfcc3da37515708b3ea5d66ae607c8ac785e' ||
    JSON.stringify(manifest.continuation?.original) !== JSON.stringify(APPROVED_OPENAI_001) ||
    JSON.stringify(manifest.continuation?.carry) !== JSON.stringify(base.carry) ||
    JSON.stringify(manifest.continuation?.next) !== JSON.stringify(base.next)
  )
    throw new Error('Resume manifest mismatch');
  const prime = rows[0];
  const run = prime?.result?.run;
  if (
    rows.length !== 1 ||
    prime.fixture !== 'team-wait' ||
    prime.phase !== 'prime' ||
    prime.index !== 0 ||
    prime.result.condition !== 'warm' ||
    prime.result.provenance !== 'real-openai' ||
    !prime.result.infrastructureValid ||
    run?.fixture !== 'team-wait' ||
    run.kind !== 'coding' ||
    run.success !== false ||
    !run.infrastructureValid ||
    !run.budgetValid ||
    !run.allAttemptsAccounted ||
    !run.childrenAccounted ||
    !run.accounting?.verified ||
    run.accounting.owners?.unknown !== 0 ||
    run.accounting.attempts !== run.attempts.length ||
    run.metrics.requestCount !== run.attempts.length ||
    run.metrics.missingUsage !== 0
  )
    throw new Error('Resume superseded prime invalid');
  const afterPrime = {
    spentUnits: base.carry.spentUnits + attemptCost(run.attempts),
    admittedAttempts: base.carry.admittedAttempts + run.attempts.length,
  };
  const ledger002 = lines(openai002.budget);
  const budget002 = ledger002.at(-1);
  if (
    ledger002[0]?.spentUnits !== base.carry.spentUnits ||
    ledger002[0]?.admittedAttempts !== base.carry.admittedAttempts
  )
    throw new Error('Resume openai-002 budget mismatch');
  const summary002 = JSON.parse(openai002.summary);
  if (
    run.budget.spentUnits !== afterPrime.spentUnits ||
    run.budget.admittedAttempts !== afterPrime.admittedAttempts ||
    run.budget.reservedUnits !== 0 ||
    run.budget.halted ||
    summary002.complete !== false ||
    JSON.stringify(summary002.budget) !== JSON.stringify(budget002) ||
    budget002.spentUnits !== afterPrime.spentUnits ||
    budget002.admittedAttempts !== afterPrime.admittedAttempts ||
    budget002.reservedUnits !== 0 ||
    budget002.unknownAttempts !== 0 ||
    budget002.halted
  )
    throw new Error('Resume openai-002 budget mismatch');
  const report = JSON.parse(diagnostic.report);
  const diagnosticBudget = lines(diagnostic.budget);
  const attempts = report.result?.attempts;
  if (
    report.kind !== 'team-diagnostic-not-baseline' ||
    report.oracleRevision !== 2 ||
    report.completed !== true ||
    JSON.stringify(report.sourcePins) !==
      JSON.stringify({
        trials: pins.openai002.trials,
        budget: pins.openai002.budget,
        summary: pins.openai002.summary,
      }) ||
    JSON.stringify(report.carry) !== JSON.stringify(afterPrime) ||
    !Array.isArray(attempts) ||
    report.result.accounting?.verified !== true ||
    report.result.accounting.attempts !== attempts.length ||
    report.result.metrics?.missingUsage !== 0
  )
    throw new Error('Resume diagnostic invalid');
  const carry = {
    spentUnits: afterPrime.spentUnits + attemptCost(attempts),
    admittedAttempts: afterPrime.admittedAttempts + attempts.length,
  };
  const final = diagnosticBudget.at(-1);
  if (
    diagnosticBudget[0]?.spentUnits !== afterPrime.spentUnits ||
    diagnosticBudget[0]?.admittedAttempts !== afterPrime.admittedAttempts ||
    JSON.stringify(final) !== JSON.stringify(report.budget) ||
    final.spentUnits !== carry.spentUnits ||
    final.admittedAttempts !== carry.admittedAttempts ||
    final.reservedUnits !== 0 ||
    final.unknownAttempts !== 0 ||
    final.halted
  )
    throw new Error('Resume diagnostic budget mismatch');
  return {
    rows: base.rows,
    carry,
    next: base.next,
    sources: {
      openai001: APPROVED_OPENAI_001,
      openai002: pins.openai002,
      diagnostic: pins.diagnostic,
    },
    correction: base.correction,
    supersededPrime: {
      fixture: 'team-wait',
      phase: 'prime',
      index: 0,
      taskSuccess: false,
      attempts: run.attempts.length,
    },
    diagnosticAttempts: attempts.length,
  };
}

/**
 * Stopped chained continuations in order, each hash-pinned after aggregate inspection.
 * Appending an entry is the only way to resume past a new stop; markers are never reset.
 */
export const APPROVED_CONTINUATIONS = [
  {
    name: 'openai-003',
    trials: '9f859b696ba532ad5713593c9d7029cab9a18bfb901f91ab645cf47371706494',
    budget: 'ec982b2b3dd79030cf94e31d4d441e19bff8bf2b64f9bb3e32a2b57b6123d8b6',
    summary: '1d0cfe5f4d14c1f6fdfc8c68d0610b7c3cc55ddfb5e197b2ccc14a6b3dc9af26',
    controller: 'e09c91c5670f815c562b5d1cc71ee8e55457b4a472ba887159768c17014f2a98',
  },
  {
    name: 'openai-004',
    trials: '5fa1e397cc717c70da373fe0c426bb9169c77df992866e7b5989780ae0fc26da',
    budget: '21c1744899ab953f352cee793a1ef774a25ed84a99c3757a235f6d9a8cb39ba0',
    summary: 'feb2658d0893dc682a14be9ca4bf1b4321b56afc0d9339fcb2964feb78104649',
    controller: '92e069378e7f1a3194d7abc9273b443fbeb366f875c7784e4cb75d6154769913',
  },
] as const;
export interface ContinuationState {
  rows: OpenAIRecordedRow[];
  carry: { spentUnits: number; admittedAttempts: number };
  next: { fixture: string; index: number; phase: 'uncached' | 'prime' | 'warm' };
}
/** Gates a recorded record-mode row exactly as runOpenAICohorts would before advancing. */
export function rowAdvances(row: OpenAIRecordedRow): boolean {
  const r = row.result.run;
  return (
    row.result.provenance === 'real-openai' &&
    r.kind === FIXTURES.find((f) => f.id === row.fixture)?.kind &&
    row.result.infrastructureValid &&
    r.infrastructureValid &&
    r.budgetValid &&
    !r.budget.halted &&
    r.budget.reservedUnits === 0 &&
    r.allAttemptsAccounted &&
    r.childrenAccounted &&
    r.accounting?.verified === true &&
    r.accounting.attempts === r.attempts.length &&
    r.metrics.requestCount === r.attempts.length &&
    r.metrics.missingUsage === 0 &&
    r.attempts.every(
      (a) =>
        a.usage && a.generationComplete && a.cacheConditionValid && a.completion === 'complete',
    ) &&
    (row.phase === 'prime' || row.result.cacheVerified)
  );
}
/**
 * Validates one stopped continuation against the prior state. Every row's charged usage is
 * recomputed. Only the final row may fail a gate; it becomes a superseded invalid attempt
 * (charged, never measured) and is repeated. A trailing prime is superseded too, because its
 * warm pair died with that process.
 */
export function validateOpenAIContinuation(
  prev: ContinuationState,
  texts: { trials: string; budget: string; summary: string },
  pin: { name: string; trials: string; budget: string; summary: string; controller: string },
) {
  if (
    sha256(texts.trials) !== pin.trials ||
    sha256(texts.budget) !== pin.budget ||
    sha256(texts.summary) !== pin.summary
  )
    throw new Error('Resume source hash mismatch');
  const order = openAIOrder();
  const [manifest, ...rows] = lines(texts.trials) as [any, ...OpenAIRecordedRow[]];
  if (
    manifest?.kind !== 'manifest' ||
    manifest.provider !== 'openai' ||
    JSON.stringify(manifest.protocol) !== JSON.stringify(OPENAI_PROTOCOL) ||
    manifest.baseline !== '16c80846da64c07114d8cd43bab68748e5474127' ||
    manifest.controllerSourceHash !== pin.controller ||
    manifest.fixtureHash !== APPROVED_OPENAI_001.fixture ||
    manifest.pins?.node !== '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80' ||
    manifest.pins?.chat !== 'be2eb5fbf1908dd1ddaa74be79cdb503e7dafcf73413a0d1fb2a87618fea8aaf' ||
    manifest.endpointFingerprint !==
      'd9617135d6fdd0a2cde722d637a1dfcc3da37515708b3ea5d66ae607c8ac785e' ||
    manifest.continuation?.primeOutcome !== 'record' ||
    JSON.stringify(manifest.continuation?.carry) !== JSON.stringify(prev.carry) ||
    JSON.stringify(manifest.continuation?.next) !== JSON.stringify(prev.next) ||
    JSON.stringify(order[prev.rows.length]) !== JSON.stringify(prev.next)
  )
    throw new Error('Resume manifest mismatch');
  if (rows.length === 0 || prev.rows.length + rows.length > order.length)
    throw new Error('Unexpected continuation length');
  let spent = prev.carry.spentUnits,
    attempts = prev.carry.admittedAttempts;
  rows.forEach((row, i) => {
    const wanted = order[prev.rows.length + i]!;
    if (
      row.fixture !== wanted.fixture ||
      row.index !== wanted.index ||
      row.phase !== wanted.phase ||
      row.result.run.fixture !== wanted.fixture ||
      row.result.condition !== (wanted.phase === 'uncached' ? 'uncached' : 'warm')
    )
      throw new Error('Resume sequence mismatch');
    // Charged usage is authoritative even when the stopping row failed a validity gate.
    spent += attemptCost(row.result.run.attempts, false);
    attempts += row.result.run.attempts.length;
    const b = row.result.run.budget;
    if (b.spentUnits !== spent || b.admittedAttempts !== attempts)
      throw new Error('Resume row budget mismatch');
    if (i < rows.length - 1 && !rowAdvances(row)) throw new Error('Resume row invalid before stop');
  });
  const ledger = lines(texts.budget);
  const summary = JSON.parse(texts.summary);
  const final = ledger.at(-1);
  if (
    ledger[0]?.spentUnits !== prev.carry.spentUnits ||
    ledger[0]?.admittedAttempts !== prev.carry.admittedAttempts ||
    summary.complete !== false ||
    JSON.stringify(summary.budget) !== JSON.stringify(final) ||
    final.spentUnits !== spent ||
    final.admittedAttempts !== attempts ||
    final.reservedUnits !== 0 ||
    final.unknownAttempts !== 0 ||
    final.halted
  )
    throw new Error('Resume continuation budget mismatch');
  const retained = [...rows];
  const superseded: Array<{ fixture: string; phase: string; index: number; reason: string }> = [];
  if (!rowAdvances(retained.at(-1)!)) {
    const stop = retained.pop()!;
    superseded.push({
      fixture: stop.fixture,
      phase: stop.phase,
      index: stop.index,
      reason: 'gate',
    });
  }
  if (retained.at(-1)?.phase === 'prime') {
    const prime = retained.pop()!;
    superseded.push({
      fixture: prime.fixture,
      phase: 'prime',
      index: prime.index,
      reason: 'pair_lost',
    });
  }
  const all = [...prev.rows, ...retained];
  return {
    rows: all,
    carry: { spentUnits: spent, admittedAttempts: attempts },
    next: order[all.length]!,
    superseded,
    source: pin,
  };
}

/**
 * Whole-fixture re-measurements, applied after the matrix chain. A cohort is replaced in full
 * (every index, both conditions, its primes), decided before new results exist; the replaced
 * rows stay reported as superseded. Never a success-only retry of selected trials.
 */
export const AUTHORIZATION_FIXTURES = [
  'approval-denial',
  'permission-rejection',
  'chat-permission',
  'schedule',
] as const;
export const APPROVED_REMEASURES: ReadonlyArray<{
  name: string;
  fixtures: readonly string[];
  reason: string;
  trials: string;
  budget: string;
  summary: string;
  controller: string;
}> = [
  {
    name: 'openai-005',
    fixtures: AUTHORIZATION_FIXTURES,
    reason:
      'explicit per-trial authorization enforcement evidence for the whole authorization category',
    trials: 'eb2cae258d2d108d2a9fb998d264b6699de8672290edc52d61725b728c9826a3',
    budget: '3d51640302bb8780571df02dbc75f83bc331e6b8fb932b435342a454deabf101',
    summary: 'f6787277f221bf6d3da65c968ddc3a5f6cabaa2f74bd62b863f8f5809a9c0c55',
    controller: '81342b559eb279b8c41b0b7f2baacee2b1d7d06ff18dbfcdeebad62c42d0386e',
  },
];
export function validateOpenAIRemeasure(
  prev: { rows: OpenAIRecordedRow[]; carry: { spentUnits: number; admittedAttempts: number } },
  texts: { trials: string; budget: string; summary: string },
  pin: {
    name: string;
    fixtures: readonly string[];
    trials: string;
    budget: string;
    summary: string;
    controller: string;
  },
) {
  if (
    sha256(texts.trials) !== pin.trials ||
    sha256(texts.budget) !== pin.budget ||
    sha256(texts.summary) !== pin.summary
  )
    throw new Error('Resume source hash mismatch');
  const order = openAIOrder();
  if (prev.rows.length !== order.length) throw new Error('Re-measure requires a complete matrix');
  const selected = new Set(pin.fixtures);
  const wanted = order.filter((o) => selected.has(o.fixture));
  const [manifest, ...rows] = lines(texts.trials) as [any, ...OpenAIRecordedRow[]];
  if (
    // Only the pre-declared whole authorization category may be re-measured.
    JSON.stringify(pin.fixtures) !== JSON.stringify(AUTHORIZATION_FIXTURES) ||
    selected.size !== pin.fixtures.length ||
    pin.fixtures.some((f) => !FIXTURES.some((known) => known.id === f)) ||
    wanted.length !== selected.size * 3 * OPENAI_PROTOCOL.trialsPerCondition ||
    manifest?.kind !== 'manifest' ||
    manifest.provider !== 'openai' ||
    JSON.stringify(manifest.protocol) !== JSON.stringify(OPENAI_PROTOCOL) ||
    manifest.baseline !== '16c80846da64c07114d8cd43bab68748e5474127' ||
    manifest.controllerSourceHash !== pin.controller ||
    manifest.fixtureHash !== APPROVED_OPENAI_001.fixture ||
    manifest.pins?.node !== '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80' ||
    manifest.pins?.chat !== 'be2eb5fbf1908dd1ddaa74be79cdb503e7dafcf73413a0d1fb2a87618fea8aaf' ||
    manifest.endpointFingerprint !==
      'd9617135d6fdd0a2cde722d637a1dfcc3da37515708b3ea5d66ae607c8ac785e' ||
    JSON.stringify(manifest.remeasure?.fixtures) !== JSON.stringify(pin.fixtures) ||
    manifest.remeasure?.primeOutcome !== 'record' ||
    JSON.stringify(manifest.remeasure?.carry) !== JSON.stringify(prev.carry) ||
    rows.length !== wanted.length
  )
    throw new Error('Re-measure manifest mismatch');
  let spent = prev.carry.spentUnits,
    attempts = prev.carry.admittedAttempts;
  rows.forEach((row, i) => {
    const w = wanted[i]!;
    if (
      row.fixture !== w.fixture ||
      row.index !== w.index ||
      row.phase !== w.phase ||
      row.result.run.fixture !== w.fixture ||
      row.result.condition !== (w.phase === 'uncached' ? 'uncached' : 'warm')
    )
      throw new Error('Re-measure sequence mismatch');
    spent += attemptCost(row.result.run.attempts, false);
    attempts += row.result.run.attempts.length;
    const b = row.result.run.budget;
    if (b.spentUnits !== spent || b.admittedAttempts !== attempts)
      throw new Error('Re-measure row budget mismatch');
    if (!rowAdvances(row)) throw new Error('Re-measure row invalid');
    if (
      (AUTHORIZATION_FIXTURES as readonly string[]).includes(row.fixture) &&
      typeof (row.result.run.outcome as { authorizationEnforced?: unknown } | null)
        ?.authorizationEnforced !== 'boolean'
    )
      throw new Error('Re-measure authorization evidence missing');
  });
  const ledger = lines(texts.budget);
  const summary = JSON.parse(texts.summary);
  const final = ledger.at(-1);
  if (
    ledger[0]?.spentUnits !== prev.carry.spentUnits ||
    ledger[0]?.admittedAttempts !== prev.carry.admittedAttempts ||
    JSON.stringify(summary.budget) !== JSON.stringify(final) ||
    final.spentUnits !== spent ||
    final.admittedAttempts !== attempts ||
    final.reservedUnits !== 0 ||
    final.unknownAttempts !== 0 ||
    final.halted
  )
    throw new Error('Re-measure budget mismatch');
  let next = 0;
  const replaced = prev.rows.map((row) => (selected.has(row.fixture) ? rows[next++]! : row));
  return {
    rows: replaced,
    carry: { spentUnits: spent, admittedAttempts: attempts },
    supersededRows: prev.rows.filter((row) => selected.has(row.fixture)),
    source: pin,
  };
}
