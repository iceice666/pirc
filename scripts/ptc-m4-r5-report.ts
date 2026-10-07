/**
 * Aggregate-only M4 round 5 report (same judgement as rounds 3 and 4): the hybrid branch arm against the concurrent `main` arm
 * (primary) and against the accepted M1 baseline (secondary), under the M4 bounds
 * (plans/ptc-m4-evaluation.md). No spend; no row content leaves the host.
 */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { OPENAI_PROTOCOL, openAICostUnits } from '../apps/gateway/test/ptc-m1/openai-contract.js';
import { APPROVED_OPENAI_001 } from '../apps/gateway/test/ptc-m1/openai-resume.js';
import {
  authorizationEnforced,
  openAIReadiness,
} from '../apps/gateway/test/ptc-m1/openai-readiness.js';
import { summarizeOpenAI } from '../apps/gateway/test/ptc-m1/openai-report.js';
import {
  M4_BOUNDS,
  evaluateM4,
  type BaselineReport,
} from '../apps/gateway/test/ptc-m1/m4-bounds.js';
import { PTC_ORACLE_MAPPING } from '../apps/gateway/test/ptc-m1/ptc-surface.js';
import { TEAM_ORACLE_REVISION } from '../apps/gateway/test/ptc-m1/team-evidence.js';
import {
  M4_BASELINE,
  M4_R5,
  M4_R5_STOPS,
  M4_ROUND2_END,
  M4_ROUND3_END,
  M4_ROUND4_END,
  m4R5Run,
} from '../apps/gateway/test/ptc-m1/m4-run.js';
import {
  ARMS,
  pairedOrder,
  validatePairedStopped,
  type Arm,
  type PairedRow,
} from '../apps/gateway/test/ptc-m1/m4-paired.js';
import { FIXTURES } from '../apps/gateway/test/ptc-m1/fixtures.js';
import type { OpenAICohortResult } from '../apps/gateway/test/ptc-m1/openai-cohort.js';

const directory = path.join(os.homedir(), 'pirc-ptc-m1-eval');
const root = path.resolve(import.meta.dir, '..');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (name: string) => readFile(path.join(directory, name), 'utf8');
const lines = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const plansBaseline = await readFile(path.join(root, 'plans/ptc-m1-openai-baseline.json'), 'utf8');
if (sha256(plansBaseline) !== M4_BASELINE.plansReport) throw new Error('Baseline report pin');
const m1 = JSON.parse(plansBaseline) as BaselineReport & { protocol: unknown };
const round2Text = await readFile(path.join(root, 'plans/ptc-m4-round2-evaluation.json'), 'utf8');
if (sha256(round2Text) !== M4_ROUND2_END.plansReport) throw new Error('Round 2 report pin');
const round2 = JSON.parse(round2Text);
const round3Text = await readFile(path.join(root, 'plans/ptc-m4-round3-partial.json'), 'utf8');
if (sha256(round3Text) !== M4_ROUND3_END.plansReport) throw new Error('Round 3 report pin');
const round3 = JSON.parse(round3Text);
const round4Text = await readFile(path.join(root, 'plans/ptc-m4-round4-evaluation.json'), 'utf8');
if (sha256(round4Text) !== M4_ROUND4_END.plansReport) throw new Error('Round 4 report pin');
const round4 = JSON.parse(round4Text);

const expected = {
  round: 5,
  provider: 'openai',
  auxiliaryReasoningMap: { off: 'low', minimal: 'low' },
  arms: M4_R5.arms,
  limitUsd: M4_R5.limitUsd,
  features: M4_R5.features,
  round4: M4_ROUND4_END,
  protocol: OPENAI_PROTOCOL,
  oracleMapping: PTC_ORACLE_MAPPING,
  teamOracleRevision: TEAM_ORACLE_REVISION,
  bounds: M4_BOUNDS,
  fixtureHash: APPROVED_OPENAI_001.fixture,
  primeOutcome: 'record',
};
const sameFields = (manifest: any) =>
  Object.entries(expected).every(
    ([key, value]) => JSON.stringify(manifest[key]) === JSON.stringify(value),
  );
let previous: PairedRow[] = [];
let carry: { spentUnits: number; admittedAttempts: number } = { ...M4_R5.carry };
const continuations: unknown[] = [];
for (const [i, stop] of M4_R5_STOPS.entries()) {
  if (stop.name !== m4R5Run(i + 1) || JSON.stringify(stop.carry) !== JSON.stringify(carry))
    throw new Error('Round 5 stop chain mismatch');
  const step = validatePairedStopped(
    {
      trials: await read(`${stop.name}.trials.jsonl`),
      budget: await read(`${stop.name}.budget.jsonl`),
      summary: await read(`${stop.name}.summary.json`),
    },
    stop,
    previous,
    sameFields,
  );
  previous = step.rows;
  carry = step.carry;
  continuations.push({
    source: stop,
    superseded: step.superseded,
    chargedUncertain: step.chargedUncertain,
  });
}
const RUN = m4R5Run(M4_R5_STOPS.length + 1);
const texts = {
  trials: await read(`${RUN}.trials.jsonl`),
  budget: await read(`${RUN}.budget.jsonl`),
  summary: await read(`${RUN}.summary.json`),
};
const [manifest, ...own] = lines(texts.trials) as [any, ...PairedRow[]];
if (
  manifest?.kind !== 'ptc-m4-paired' ||
  !sameFields(manifest) ||
  JSON.stringify(manifest.carry) !== JSON.stringify(carry) ||
  manifest.reusedRows !== previous.length ||
  JSON.stringify(manifest.continuations) !== JSON.stringify(continuations)
)
  throw new Error('Round 5 manifest mismatch');
const rows = [...previous, ...own];
const order = pairedOrder();
if (
  rows.length !== order.length ||
  rows.some(
    (row, i) =>
      row.arm !== order[i]!.arm ||
      row.fixture !== order[i]!.fixture ||
      row.index !== order[i]!.index ||
      row.phase !== order[i]!.phase,
  )
)
  throw new Error('Round 5 matrix order or length mismatch');
const summary = JSON.parse(texts.summary);
const budgets = lines(texts.budget);
const finalBudget = budgets.at(-1);
if (
  JSON.stringify(summary.budget) !== JSON.stringify(finalBudget) ||
  finalBudget.reservedUnits !== 0 ||
  finalBudget.unknownAttempts !== 0 ||
  finalBudget.halted !== false ||
  finalBudget.limitUsd !== M4_R5.limitUsd ||
  finalBudget.spentUnits > M4_R5.limitUsd * OPENAI_PROTOCOL.unitsPerUsd ||
  budgets[0].spentUnits !== carry.spentUnits ||
  budgets[0].admittedAttempts !== carry.admittedAttempts ||
  budgets.some(
    (b, i) =>
      i > 0 &&
      (b.spentUnits < budgets[i - 1].spentUnits ||
        b.admittedAttempts < budgets[i - 1].admittedAttempts),
  )
)
  throw new Error('Round 5 budget ledger mismatch');

const measured = Object.fromEntries(
  ARMS.map((arm) => [
    arm,
    rows.filter((row) => row.arm === arm && row.phase !== 'prime').map((row) => row.result),
  ]),
) as Record<Arm, OpenAICohortResult[]>;
const authorizationOf = (results: OpenAICohortResult[]) => {
  const out: Record<string, { trials: number; enforced: number; taskSuccesses: number }> = {};
  for (const result of results) {
    const run = result.run;
    if (
      !['approval-denial', 'permission-rejection', 'chat-permission', 'schedule'].includes(
        run.fixture,
      )
    )
      continue;
    const group = (out[`${run.fixture}/${result.condition}`] ??= {
      trials: 0,
      enforced: 0,
      taskSuccesses: 0,
    });
    group.trials++;
    if (authorizationEnforced(run)) group.enforced++;
    if (run.success) group.taskSuccesses++;
  }
  return out;
};
// The final run's own rows reconcile with its ledger (spend recomputed from usage).
{
  let spent = carry.spentUnits,
    attempts = carry.admittedAttempts;
  for (const row of own) {
    for (const attempt of row.result.run.attempts) {
      if (!attempt.usage) throw new Error('Round 5 usage missing');
      spent += openAICostUnits(attempt.usage);
    }
    attempts += row.result.run.attempts.length;
    if (
      row.result.run.budget.spentUnits !== spent ||
      row.result.run.budget.admittedAttempts !== attempts
    )
      throw new Error('Round 5 row budget mismatch');
  }
  if (finalBudget.spentUnits !== spent || finalBudget.admittedAttempts !== attempts)
    throw new Error('Round 5 ledger does not match its rows');
}
const mainMissing = openAIReadiness(measured.main);
const concurrent: BaselineReport = {
  readiness: { missing: mainMissing, complete: mainMissing.length === 0 },
  measuredTrials: measured.main.length,
  authorization: authorizationOf(measured.main),
  aggregates: summarizeOpenAI(measured.main) as unknown as BaselineReport['aggregates'],
};
// Primary: against the concurrent main arm. The main arm must be ready, with every
// authorization trial enforced and every cancel-wait trial cancelled (the parity the bounds
// compare against); otherwise the round is unjudged, never failed by a weak main arm.
const mainParity =
  Object.values(concurrent.authorization).every((g) => g.enforced === g.trials) &&
  ['uncached', 'warm'].every((condition) => {
    const rows = measured.main.filter(
      (r) => r.run.fixture === 'cancel-wait' && r.condition === condition,
    );
    return rows.every((r) => r.run.success && r.run.outcome?.cancellationObserved === true);
  });
const judgeable = concurrent.readiness.complete && mainParity;
const primary = judgeable ? evaluateM4(concurrent, measured.ptc) : null;
const secondary = evaluateM4(m1, measured.ptc);

const mean = (values: number[]) =>
  values.length ? values.reduce((s, n) => s + n, 0) / values.length : null;
const sumCounts = (items: Array<Record<string, number> | undefined>) => {
  const out: Record<string, number> = {};
  for (const item of items)
    for (const [key, value] of Object.entries(item ?? {}))
      if (Number.isSafeInteger(value) && value) out[key] = (out[key] ?? 0) + value;
  return out;
};
/**
 * Diagnostic only: wall time split into the summed duration of full-cap model requests (parent
 * and any team child, possibly overlapping) and the remainder, which can therefore be negative.
 */
const surface = ARMS.flatMap((arm) =>
  FIXTURES.flatMap((f) =>
    ['uncached', 'warm'].map((condition) => {
      const cohort = measured[arm].filter(
        (r) => r.run.fixture === f.id && r.condition === condition,
      );
      const modelMs = (r: OpenAICohortResult) =>
        r.run.attempts
          .filter((a) => a.outputCap === OPENAI_PROTOCOL.maxOutputTokens)
          .reduce((s, a) => s + a.durationMs, 0);
      return {
        arm,
        fixture: f.id,
        condition,
        meanWallMs: mean(cohort.map((r) => r.run.measurement?.wallMs ?? NaN)),
        meanMainModelMs: mean(cohort.map(modelMs)),
        meanOtherMs: mean(cohort.map((r) => (r.run.measurement?.wallMs ?? NaN) - modelMs(r))),
        meanPtcCalls: mean(cohort.map((r) => r.run.ptc?.ptcCalls ?? 0)),
        meanDocsCalls: mean(cohort.map((r) => r.run.metrics.docsCalls)),
        directCallsByCapability: sumCounts(cohort.map((r) => r.run.ptc?.directCallsByCapability)),
        operationsByCapability: sumCounts(cohort.map((r) => r.run.ptc?.operationsByCapability)),
        interactionRequests: sumCounts(cohort.map((r) => r.run.services?.requests)),
        scriptErrors: cohort.reduce((s, r) => s + (r.run.ptc?.scriptErrors ?? 0), 0),
      };
    }),
  ),
);
const report = {
  kind: 'ptc-m4-round5-evaluation',
  run: {
    name: RUN,
    trials: sha256(texts.trials),
    budget: sha256(texts.budget),
    summary: sha256(texts.summary),
    controller: manifest.controllerSourceHash,
    arms: M4_R5.arms,
    runComplete: summary.complete,
    runMissing: summary.missing,
  },
  continuations,
  measuredTrials: { main: measured.main.length, ptc: measured.ptc.length },
  primes: rows.length - measured.main.length - measured.ptc.length,
  readiness: { main: concurrent.readiness, ptc: secondary.readiness },
  // The round passes only against the concurrent main arm, with a clean run.
  pass:
    !!primary?.pass &&
    summary.complete === true &&
    Object.values(summary.missing ?? {}).every((m: any) => m.length === 0),
  primary: primary
    ? { against: 'concurrent-main', pass: primary.pass, verdicts: primary.verdicts }
    : {
        against: 'concurrent-main',
        pass: false,
        unjudged: concurrent.readiness.complete
          ? 'main arm lacks authorization/cancellation parity'
          : 'main arm not ready',
      },
  secondary: { against: 'm1-baseline', pass: secondary.pass, verdicts: secondary.verdicts },
  authorization: { main: concurrent.authorization, ptc: authorizationOf(measured.ptc) },
  aggregates: {
    main: concurrent.aggregates,
    ptc: secondary.aggregates,
    m1: m1.aggregates,
    round2: round2.aggregates,
    // Round 3 is partial: per-fixture both-arm groups where measured.
    round3: round3.fixtures,
    round4: { main: round4.aggregates.main, ptc: round4.aggregates.ptc },
  },
  surface,
  budget: {
    limitUsd: M4_R5.limitUsd,
    carry: M4_R5.carry,
    final: { spentUnits: finalBudget.spentUnits, admittedAttempts: finalBudget.admittedAttempts },
    roundSpentUnits: finalBudget.spentUnits - M4_R5.carry.spentUnits,
    roundAttempts: finalBudget.admittedAttempts - M4_R5.carry.admittedAttempts,
  },
};
const fd = createArtifact(path.join(directory, `${RUN}-report.json`));
try {
  checkpoint(fd, report);
} finally {
  closeSync(fd);
}
console.log(JSON.stringify(report));
