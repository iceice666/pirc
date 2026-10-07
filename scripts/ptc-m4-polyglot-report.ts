/**
 * Aggregate-only report of one pinned public-benchmark run (plans/ptc-m4-evaluation.md,
 * "Public benchmark"): per arm, tests-pass rate, mean tokens, model rounds and wall time, per
 * exercise passes, and how the branch reached its capabilities. No spend; no row content.
 */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { M4_POLY_HOLDOUT, M4_POLY_RUNS } from '../apps/gateway/test/ptc-m1/m4-run.js';
import { POLYGLOT_NAMES, polyglotSplit } from '../apps/gateway/test/ptc-m1/polyglot.js';
import { exerciseReadiness, exerciseOrder } from '../apps/gateway/test/ptc-m1/m4-polyglot.js';
import type { ExerciseRow } from '../apps/gateway/test/ptc-m1/m4-polyglot.js';
import type { Arm } from '../apps/gateway/test/ptc-m1/m4-paired.js';

const { values } = parseArgs({ options: { run: { type: 'string' } }, strict: true });
const pin = M4_POLY_RUNS.find((run) => run.name === values.run);
if (!pin) throw new Error('Report only a pinned public-benchmark run');
const directory = path.join(os.homedir(), 'pirc-ptc-m1-eval');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (name: string) => readFile(path.join(directory, name), 'utf8');
const texts = {
  trials: await read(`${pin.name}.trials.jsonl`),
  budget: await read(`${pin.name}.budget.jsonl`),
  summary: await read(`${pin.name}.summary.json`),
};
for (const kind of ['trials', 'budget', 'summary'] as const)
  if (sha256(texts[kind]) !== pin[kind]) throw new Error(`Pin mismatch: ${kind}`);
const [manifest, ...rows] = texts.trials
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line)) as [any, ...ExerciseRow[]];
const arms: Arm[] = Object.keys(manifest.arms) as Arm[];
const names: string[] = manifest.dataset.exercises;
if (
  manifest.kind !== 'ptc-m4-polyglot' ||
  manifest.mode !== pin.mode ||
  JSON.stringify(names) !==
    JSON.stringify(POLYGLOT_NAMES.filter((name) => polyglotSplit(name) === pin.mode)) ||
  manifest.trials !== (pin.mode === 'holdout' ? M4_POLY_HOLDOUT.trials : 1) ||
  JSON.stringify(arms) !== JSON.stringify(pin.mode === 'holdout' ? ['main', 'ptc'] : ['ptc']) ||
  (pin.mode === 'holdout' && JSON.stringify(manifest.arms) !== JSON.stringify(M4_POLY_HOLDOUT.arms))
)
  throw new Error('Public-benchmark manifest mismatch');
const order = exerciseOrder(
  names.map((name) => ({ id: `poly-${name}` }) as never),
  arms,
  manifest.trials,
);
const missing = exerciseReadiness(rows, order);
const summary = JSON.parse(texts.summary);
const budgets = texts.budget
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const mean = (values: number[]) =>
  values.length ? values.reduce((s, n) => s + n, 0) / values.length : null;
const sumCounts = (items: Array<Record<string, number> | undefined>) => {
  const out: Record<string, number> = {};
  for (const item of items)
    for (const [key, value] of Object.entries(item ?? {}))
      if (Number.isSafeInteger(value) && value) out[key] = (out[key] ?? 0) + value;
  return out;
};
const byArm = Object.fromEntries(
  arms.map((arm) => {
    const mine = rows.filter((row) => row.arm === arm).map((row) => row.result.run);
    return [
      arm,
      {
        trials: mine.length,
        // Bound 2 judges the tests-pass count; `succeeded` also needs a clean final stop.
        testsPassed: mine.filter((run) => run.outcome?.filesMatch === true).length,
        succeeded: mine.filter((run) => run.success).length,
        deadlineExceeded: mine.filter(
          (run) => (run.measurement as { deadlineExceeded?: boolean } | null)?.deadlineExceeded,
        ).length,
        missingMeasurement: mine.filter((run) => !run.measurement).length,
        suspiciousSolutions: mine.filter(
          (run) => (run.outcome as { suspicious?: boolean } | null)?.suspicious,
        ).length,
        meanTokens: mean(mine.map((run) => run.metrics.totalTokens)),
        meanModelRounds: mean(mine.map((run) => run.metrics.modelRounds)),
        meanRequests: mean(mine.map((run) => run.metrics.requestCount)),
        meanWallMs: mean(mine.map((run) => run.measurement?.wallMs ?? NaN)),
        meanPtcCalls: mean(mine.map((run) => run.ptc?.ptcCalls ?? 0)),
        meanDocsCalls: mean(mine.map((run) => run.metrics.docsCalls)),
        directCallsByCapability: sumCounts(mine.map((run) => run.ptc?.directCallsByCapability)),
        operationsByCapability: sumCounts(mine.map((run) => run.ptc?.operationsByCapability)),
        perExercise: Object.fromEntries(
          names.map((name) => {
            const cohort = mine.filter((run) => run.fixture === `poly-${name}`);
            return [
              name,
              {
                trials: cohort.length,
                testsPassed: cohort.filter((run) => run.outcome?.filesMatch === true).length,
                meanTokens: mean(cohort.map((run) => run.metrics.totalTokens)),
                meanModelRounds: mean(cohort.map((run) => run.metrics.modelRounds)),
              },
            ];
          }),
        ),
      },
    ];
  }),
);
// The pre-declared bounds, for a holdout run whose readiness is complete.
const bounds =
  pin.mode === 'holdout' && missing.length === 0
    ? (() => {
        const m = byArm.main!,
          p = byArm.ptc!;
        const checks = [
          {
            bound: 'tests-pass count',
            main: m.testsPassed,
            ptc: p.testsPassed,
            pass: p.testsPassed >= m.testsPassed,
          },
          {
            bound: 'mean tokens',
            main: m.meanTokens,
            ptc: p.meanTokens,
            pass: p.meanTokens! <= m.meanTokens!,
          },
          {
            bound: 'mean model rounds',
            main: m.meanModelRounds,
            ptc: p.meanModelRounds,
            pass: p.meanModelRounds! < m.meanModelRounds!,
          },
        ];
        return { checks, pass: checks.every((c) => c.pass) && summary.complete === true };
      })()
    : null;
const report = {
  kind: 'ptc-m4-polyglot-report',
  run: {
    ...pin,
    mode: manifest.mode,
    arms: manifest.arms,
    controller: manifest.controllerSourceHash,
  },
  dataset: manifest.dataset,
  readiness: { missing, complete: missing.length === 0 },
  runComplete: summary.complete,
  runMissing: summary.missing,
  byArm,
  bounds,
  budget: {
    start: { spentUnits: budgets[0].spentUnits, admittedAttempts: budgets[0].admittedAttempts },
    final: {
      spentUnits: budgets.at(-1).spentUnits,
      reservedUnits: budgets.at(-1).reservedUnits,
      admittedAttempts: budgets.at(-1).admittedAttempts,
    },
  },
};
const fd = createArtifact(path.join(directory, `${pin.name}-report.json`));
try {
  checkpoint(fd, report);
} finally {
  closeSync(fd);
}
console.log(JSON.stringify(report));
