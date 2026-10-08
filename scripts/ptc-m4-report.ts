/**
 * Aggregate-only M4 report: the PTC run against the accepted M1 baseline and the M4 bounds
 * (docs/evaluations/ptc/ptc-m4-evaluation.md). No spend; no row content leaves the host.
 */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { authorizationEnforced } from '../apps/gateway/test/ptc-m1/openai-readiness.js';
import { openAIOrder } from '../apps/gateway/test/ptc-m1/openai-resume.js';
import {
  M4_BOUNDS,
  evaluateM4,
  type BaselineReport,
} from '../apps/gateway/test/ptc-m1/m4-bounds.js';
import { APPROVED_OPENAI_001 } from '../apps/gateway/test/ptc-m1/openai-resume.js';
import { PTC_ORACLE_MAPPING } from '../apps/gateway/test/ptc-m1/ptc-surface.js';
import { TEAM_ORACLE_REVISION } from '../apps/gateway/test/ptc-m1/team-evidence.js';
import {
  M4_BASELINE,
  M4_COMPLETED,
  M4_PINS,
  M4_RUN,
  M4_STOPPED,
} from '../apps/gateway/test/ptc-m1/m4-run.js';
import { validateM4Stopped } from '../apps/gateway/test/ptc-m1/m4-continuation.js';
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

const plansReport = await readFile(
  path.join(root, 'docs/evaluations/ptc/ptc-m1-openai-baseline.json'),
  'utf8',
);
if (sha256(plansReport) !== M4_BASELINE.plansReport) throw new Error('Baseline report pin');
// The previous M4 run's aggregate report, for an informational comparison.
const previousRun = M4_COMPLETED.at(-1)!;
const previousText = await readFile(
  path.join(root, 'docs/evaluations/ptc/ptc-m4-openai-evaluation.json'),
  'utf8',
);
if (sha256(previousText) !== previousRun.plansReport) throw new Error('Previous M4 report pin');
const previousReport = JSON.parse(previousText);
const baseline = JSON.parse(plansReport) as BaselineReport & { protocol: unknown };

const texts = {
  trials: await read(`${M4_RUN}.trials.jsonl`),
  budget: await read(`${M4_RUN}.budget.jsonl`),
  summary: await read(`${M4_RUN}.summary.json`),
};
// The stopped run's validated rows, then this continuation's rows: one matrix.
const stopped = validateM4Stopped(
  {
    trials: await read(`${M4_STOPPED.name}.trials.jsonl`),
    budget: await read(`${M4_STOPPED.name}.budget.jsonl`),
    summary: await read(`${M4_STOPPED.name}.summary.json`),
  },
  M4_STOPPED,
);
const M4_CARRY = stopped.carry;
const [manifest, ...ownRows] = lines(texts.trials);
const rows = [...stopped.rows, ...ownRows];
if (
  manifest?.kind !== 'ptc-m4' || // The run's manifest kind overrides the line's 'manifest'.
  manifest.provider !== 'openai' ||
  JSON.stringify(manifest.pins) !== JSON.stringify(M4_PINS) ||
  JSON.stringify(manifest.carry) !== JSON.stringify(M4_CARRY) ||
  manifest.oracleMapping !== PTC_ORACLE_MAPPING ||
  manifest.teamOracleRevision !== TEAM_ORACLE_REVISION ||
  manifest.fixtureHash !== APPROVED_OPENAI_001.fixture ||
  manifest.primeOutcome !== 'record' ||
  JSON.stringify(manifest.protocol) !== JSON.stringify(baseline.protocol) ||
  JSON.stringify(manifest.bounds) !== JSON.stringify(M4_BOUNDS) ||
  JSON.stringify(manifest.previousRuns) !==
    JSON.stringify(
      M4_COMPLETED.map(({ name, trials, budget, summary }) => ({ name, trials, budget, summary })),
    ) ||
  JSON.stringify(manifest.continuation) !==
    JSON.stringify({
      source: {
        name: M4_STOPPED.name,
        trials: M4_STOPPED.trials,
        budget: M4_STOPPED.budget,
        summary: M4_STOPPED.summary,
        controller: M4_STOPPED.controller,
      },
      reusedRows: stopped.rows.length,
      superseded: stopped.superseded,
      chargedUncertain: stopped.chargedUncertain,
      next: stopped.next,
    })
)
  throw new Error('M4 manifest mismatch');
const order = openAIOrder();
if (
  rows.length !== order.length ||
  rows.some(
    (row, i) =>
      row.fixture !== order[i]!.fixture ||
      row.index !== order[i]!.index ||
      row.phase !== order[i]!.phase,
  )
)
  throw new Error('M4 matrix order or length mismatch');
const summary = JSON.parse(texts.summary);
const budgets = lines(texts.budget);
const finalBudget = budgets.at(-1);
if (
  JSON.stringify(summary.budget) !== JSON.stringify(finalBudget) ||
  finalBudget.reservedUnits !== 0 ||
  finalBudget.unknownAttempts !== 0 ||
  finalBudget.halted !== false ||
  budgets[0].spentUnits !== M4_CARRY.spentUnits ||
  budgets[0].admittedAttempts !== M4_CARRY.admittedAttempts ||
  budgets.some(
    (b, i) =>
      i > 0 &&
      (b.spentUnits < budgets[i - 1].spentUnits ||
        b.admittedAttempts < budgets[i - 1].admittedAttempts),
  )
)
  throw new Error('M4 budget ledger mismatch');
const measured: OpenAICohortResult[] = rows
  .filter((row) => row.phase !== 'prime')
  .map((row) => row.result);
const evaluation = evaluateM4(baseline, measured);

const authorization: Record<string, Record<string, number>> = {};
for (const result of measured) {
  const run = result.run;
  if (
    !['approval-denial', 'permission-rejection', 'chat-permission', 'schedule'].includes(
      run.fixture,
    )
  )
    continue;
  const group = (authorization[`${run.fixture}/${result.condition}`] ??= {
    trials: 0,
    enforced: 0,
    taskSuccesses: 0,
    explicitEvidence: 0,
  });
  group.trials!++;
  if (authorizationEnforced(run)) group.enforced!++;
  if (run.success) group.taskSuccesses!++;
  if (typeof run.outcome?.authorizationEnforced === 'boolean') group.explicitEvidence!++;
}
const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! : null;
const perCall = measured.flatMap((r) => r.run.ptc?.operationsPerCall ?? []).sort((a, b) => a - b);
const mean = (values: number[]) =>
  values.length ? values.reduce((s, n) => s + n, 0) / values.length : null;
const sumCounts = (items: Array<Record<string, number> | undefined>) => {
  const out: Record<string, number> = {};
  for (const item of items)
    for (const [key, value] of Object.entries(item ?? {}))
      if (Number.isSafeInteger(value)) out[key] = (out[key] ?? 0) + value;
  return out;
};
const surface = FIXTURES.flatMap((f) =>
  ['uncached', 'warm'].map((condition) => {
    const cohort = measured.filter((r) => r.run.fixture === f.id && r.condition === condition);
    return {
      fixture: f.id,
      condition,
      meanPtcCalls: mean(cohort.map((r) => r.run.ptc?.ptcCalls ?? NaN)),
      meanDocsCalls: mean(cohort.map((r) => r.run.metrics.docsCalls)),
      meanDocsBytes: mean(cohort.map((r) => r.run.metrics.docsBytes)),
      meanOperations: mean(cohort.map((r) => r.run.ptc?.operations ?? NaN)),
      scriptErrors: cohort.reduce((s, r) => s + (r.run.ptc?.scriptErrors ?? 0), 0),
      operationErrors: cohort.reduce((s, r) => s + (r.run.ptc?.operationErrors ?? 0), 0),
      notStartedOperations: cohort.reduce((s, r) => s + (r.run.ptc?.notStartedOperations ?? 0), 0),
      // All surfaces: a failed operation and the failed script around it both count.
      meanAllSurfaceToolErrors: mean(cohort.map((r) => r.run.metrics.toolErrors)),
      meanSchemaBytes: mean(
        cohort.map((r) => r.run.metrics.schemaBytes / r.run.metrics.requestCount),
      ),
      meanCpuMs: mean(cohort.map((r) => r.run.measurement?.cpuMs ?? NaN)),
      meanMemoryPeakBytes: mean(cohort.map((r) => r.run.measurement?.cgroupMemoryPeakBytes ?? NaN)),
      meanStartupMs: mean(cohort.map((r) => r.run.measurement?.startupMs ?? NaN)),
      // Content-free diagnostics summed over the cohort (fixed keys, counts only).
      operationsByCapability: sumCounts(cohort.map((r) => r.run.ptc?.operationsByCapability)),
      interactionRequests: sumCounts(cohort.map((r) => r.run.services?.requests)),
    };
  }),
);
const report = {
  kind: 'ptc-m4-openai-evaluation',
  run: {
    name: M4_RUN,
    trials: sha256(texts.trials),
    budget: sha256(texts.budget),
    summary: sha256(texts.summary),
    controller: manifest.controllerSourceHash,
    pins: M4_PINS,
    oracleMapping: manifest.oracleMapping,
    teamOracleRevision: manifest.teamOracleRevision,
    runComplete: summary.complete,
    runMissing: summary.missing,
  },
  baseline: { report: M4_BASELINE.report, plansReport: M4_BASELINE.plansReport },
  continuation: {
    source: {
      name: M4_STOPPED.name,
      trials: M4_STOPPED.trials,
      budget: M4_STOPPED.budget,
      summary: M4_STOPPED.summary,
      controller: M4_STOPPED.controller,
    },
    reusedRows: stopped.rows.length,
    superseded: stopped.superseded,
    chargedUncertain: stopped.chargedUncertain,
  },
  measuredTrials: measured.length,
  primes: rows.length - measured.length,
  readiness: evaluation.readiness,
  // Bounds and a run that completed cleanly (no cleanup, budget or lifecycle failure).
  pass: evaluation.pass && summary.complete === true && summary.missing?.length === 0,
  boundsPass: evaluation.pass,
  verdicts: evaluation.verdicts,
  authorization,
  aggregates: evaluation.aggregates,
  surface,
  operationsPerCall: {
    scripts: perCall.length,
    p50: quantile(perCall, 0.5),
    p90: quantile(perCall, 0.9),
    p99: quantile(perCall, 0.99),
    max: perCall.at(-1) ?? null,
  },
  // Informational only: the bounds are judged against the M1 baseline.
  previous: {
    name: previousRun.name,
    pass: previousReport.pass,
    readiness: previousReport.readiness,
    aggregates: previousReport.aggregates,
    authorization: previousReport.authorization,
  },
  budget: {
    carry: M4_CARRY,
    final: { spentUnits: finalBudget.spentUnits, admittedAttempts: finalBudget.admittedAttempts },
    m4SpentUnits: finalBudget.spentUnits - M4_CARRY.spentUnits,
    m4Attempts: finalBudget.admittedAttempts - M4_CARRY.admittedAttempts,
    // The whole round: the stopped run (with its uncertain attempt charged) and this one.
    roundSpentUnits: finalBudget.spentUnits - M4_STOPPED.carry.spentUnits,
    roundAttempts: finalBudget.admittedAttempts - M4_STOPPED.carry.admittedAttempts,
  },
};
const fd = createArtifact(path.join(directory, `${M4_RUN}-report.json`));
try {
  checkpoint(fd, report);
} finally {
  closeSync(fd);
}
console.log(JSON.stringify(report));
