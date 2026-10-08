/**
 * M4 public-benchmark evaluation (docs/evaluations/ptc/ptc-m4-evaluation.md, "Public benchmark"): Aider
 * polyglot Python exercises. `--dev` measures a branch build on the development split (for
 * tuning; never judged); `--holdout` interleaves the pinned M1 `main` and the pinned branch on
 * the holdout split and is judged. Spend continues the same independent OpenAI budget. Key only
 * via stdin; exclusive marker per run; aggregate-only artifacts.
 */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { sourceIdentity, endpointIdentity } from '../apps/gateway/test/ptc-m1/provenance.js';
import { OPENAI_PROTOCOL } from '../apps/gateway/test/ptc-m1/openai-contract.js';
import { OpenAIBudget } from '../apps/gateway/test/ptc-m1/openai-budget.js';
import { OpenAIController } from '../apps/gateway/test/ptc-m1/openai-controller.js';
import { waitForOpenAIStage } from '../apps/gateway/test/ptc-m1/openai-stage.js';
import { PTC_ORACLE_MAPPING } from '../apps/gateway/test/ptc-m1/ptc-surface.js';
import {
  checkPolyglot,
  examplePolyglot,
  loadPolyglot,
  POLYGLOT,
} from '../apps/gateway/test/ptc-m1/polyglot.js';
import {
  APPROVED_CONTINUATIONS,
  APPROVED_REMEASURES,
} from '../apps/gateway/test/ptc-m1/openai-resume.js';
import { runExerciseMatrix } from '../apps/gateway/test/ptc-m1/m4-polyglot.js';
import type { Arm } from '../apps/gateway/test/ptc-m1/m4-paired.js';
import {
  M4_POLY,
  M4_POLY_HOLDOUT,
  M4_POLY_RUNS,
  M4_R3,
  M4_ROUND5_END,
  m4KnownFiles,
} from '../apps/gateway/test/ptc-m1/m4-run.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const { values } = parseArgs({
  options: {
    dev: { type: 'boolean' },
    holdout: { type: 'boolean' },
    dataset: { type: 'string' },
    'main-node': { type: 'string' },
    'main-chat': { type: 'string' },
    'ptc-node': { type: 'string' },
    'ptc-chat': { type: 'string' },
    output: { type: 'string' },
    'execute-openai': { type: 'boolean' },
  },
  strict: true,
});
const directory = path.join(os.homedir(), 'pirc-ptc-m1-eval');
const mode = values.dev ? 'dev' : values.holdout ? 'holdout' : undefined;
const RUN = `ptc-m4-poly-${String(M4_POLY_RUNS.length + 1).padStart(3, '0')}`;
if (
  !values['execute-openai'] ||
  !mode ||
  (values.dev && values.holdout) ||
  process.platform !== 'linux' ||
  !values.dataset ||
  !values['ptc-node'] ||
  !values['ptc-chat'] ||
  (mode === 'holdout' && (!values['main-node'] || !values['main-chat'])) ||
  !values.output ||
  path.resolve(values.output) !== path.join(directory, RUN)
)
  throw new Error('Explicit M4 public-benchmark execution settings required');
// Run-count rules (pre-declared): at most three development runs, all before any holdout run;
// one holdout run, rerun in full at most twice and only after an incomplete one.
const devRuns = M4_POLY_RUNS.filter((run) => run.mode === 'dev');
const holdoutRuns = M4_POLY_RUNS.filter((run) => run.mode === 'holdout');
if (mode === 'dev' && (devRuns.length >= 3 || holdoutRuns.length > 0))
  throw new Error('No further development run is allowed');
if (mode === 'holdout' && (holdoutRuns.length >= 3 || holdoutRuns.some((run) => run.complete)))
  throw new Error('No further holdout run is allowed');
const arms: Arm[] = mode === 'holdout' ? ['main', 'ptc'] : ['ptc'];
const binaries: Record<Arm, { node?: string; chat?: string }> = {
  main: { node: values['main-node'], chat: values['main-chat'] },
  ptc: { node: values['ptc-node'], chat: values['ptc-chat'] },
};
const actualPins = Object.fromEntries(
  await Promise.all(
    arms.map(async (arm) => [
      arm,
      {
        node: sha256(await readFile(binaries[arm].node!)),
        chat: sha256(await readFile(binaries[arm].chat!)),
      },
    ]),
  ),
) as Record<Arm, { node: string; chat: string }>;
// The holdout is judged only on the pinned builds; development runs record what they ran.
if (mode === 'holdout' && JSON.stringify(actualPins) !== JSON.stringify(M4_POLY_HOLDOUT.arms))
  throw new Error('Holdout binaries differ from the pins');
if (mode === 'dev' && actualPins.ptc.node === M4_R3.arms.main.node)
  throw new Error('A development run measures a branch build');
if (
  (await readFile('/proc/swaps', 'utf8')).trim().split('\n').length !== 1 ||
  !/^Max core file size\s+0\s/m.test(await readFile('/proc/self/limits', 'utf8'))
)
  throw new Error('No swap/core zero required');
const root = path.resolve(import.meta.dir, '..');
// The dataset checkout is the pinned commit; every used file is checked against its hash.
const fixtures = await loadPolyglot(values.dataset, mode);

// The budget continues from round 5's end through every earlier public-benchmark run.
const read = (name: string) => readFile(path.join(directory, name), 'utf8');
for (const kind of ['trials', 'budget', 'summary'] as const) {
  const file = `${M4_ROUND5_END.name}.${kind === 'summary' ? 'summary.json' : `${kind}.jsonl`}`;
  if (sha256(await read(file)) !== M4_ROUND5_END[kind]) throw new Error(`Pin mismatch: ${file}`);
}
if (sha256(await read(`${M4_ROUND5_END.name}-report.json`)) !== M4_ROUND5_END.report)
  throw new Error('Round 5 report pin mismatch');
const endOf = (budgetText: string) => {
  const last = JSON.parse(budgetText.trim().split('\n').at(-1)!);
  // An uncertain reservation left at a stop is counted as spent: never under-counted.
  return {
    spentUnits: last.spentUnits + last.reservedUnits,
    admittedAttempts: last.admittedAttempts,
  };
};
let carry: { spentUnits: number; admittedAttempts: number } = endOf(
  await read(`${M4_ROUND5_END.name}.budget.jsonl`),
);
if (JSON.stringify(carry) !== JSON.stringify(M4_ROUND5_END.carry))
  throw new Error('Round 5 end mismatch');
for (const run of M4_POLY_RUNS) {
  const texts = {
    trials: await read(`${run.name}.trials.jsonl`),
    budget: await read(`${run.name}.budget.jsonl`),
    summary: await read(`${run.name}.summary.json`),
  };
  for (const kind of ['trials', 'budget', 'summary'] as const)
    if (sha256(texts[kind]) !== run[kind]) throw new Error(`Pin mismatch: ${run.name}.${kind}`);
  const first = JSON.parse(texts.budget.trim().split('\n')[0]!);
  if (first.spentUnits !== carry.spentUnits || first.admittedAttempts !== carry.admittedAttempts)
    throw new Error(`Budget chain mismatch at ${run.name}`);
  carry = endOf(texts.budget);
}
// Nothing has spent from the budget outside the pinned runs: every M4 and OpenAI artifact is
// known, and every earlier run's marker exists.
const known = m4KnownFiles();
const pinnedOpenAI = new Set([
  'openai-001',
  'openai-002',
  'openai-team-diagnostic-001',
  ...APPROVED_CONTINUATIONS.map((p) => p.name),
  ...APPROVED_REMEASURES.map((p) => p.name),
]);
const entries = await readdir(directory);
for (const entry of entries) {
  const run = /^(openai-[\w-]+?)\.(?:trials\.jsonl|budget\.jsonl|summary\.json)$/.exec(entry)?.[1];
  if (run && !pinnedOpenAI.has(run)) throw new Error(`Unpinned OpenAI run exists: ${run}`);
  const openaiMarker = /^\.ptc-m1-openai-(?:remeasure|resume)-([\w-]+)-attempted$/.exec(entry)?.[1];
  if (openaiMarker && !['openai-005', '001', '002', 'openai-003'].includes(openaiMarker))
    throw new Error(`Unpinned OpenAI marker exists: ${entry}`);
  if (/^\.?ptc-m4-/.test(entry) && !known.allowed.has(entry))
    throw new Error(`Unpinned M4 artifact exists: ${entry}`);
}
for (const marker of known.markers)
  if (!entries.includes(marker)) throw new Error(`M4 marker missing: ${marker}`);
// Preflight, before any spend: the checking sandbox runs, every example solution passes its
// pinned tests and every stub fails them.
for (const fixture of fixtures) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'ptc-poly-preflight-'));
  try {
    for (const [file, text] of Object.entries(fixture.files))
      await writeFile(path.join(scratch, file), text);
    if ((await checkPolyglot(scratch, fixture)).passed)
      throw new Error(`Stub passes: ${fixture.exercise.name}`);
    await writeFile(
      path.join(scratch, fixture.exercise.solution[0]!),
      await examplePolyglot(values.dataset, fixture),
    );
    if (!(await checkPolyglot(scratch, fixture)).passed)
      throw new Error(`Example fails: ${fixture.exercise.name}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const pythonVersion = Bun.spawnSync(['/usr/bin/python3', '--version']).stdout.toString().trim();
const manifest = {
  kind: 'ptc-m4-polyglot',
  pythonVersion,
  mode,
  provider: 'openai',
  protocol: OPENAI_PROTOCOL,
  auxiliaryReasoningMap: { off: 'low', minimal: 'low' },
  oracleMapping: PTC_ORACLE_MAPPING,
  dataset: { ...POLYGLOT, exercises: fixtures.map((f) => f.exercise.name) },
  arms: actualPins,
  trials: mode === 'holdout' ? M4_POLY_HOLDOUT.trials : 1,
  limitUsd: M4_POLY.limitUsd,
  features: M4_POLY.features,
  trialDeadlineMs: M4_POLY.trialDeadlineMs,
  round5: M4_ROUND5_END,
  previousRuns: M4_POLY_RUNS,
  carry,
  controllerSourceHash: await sourceIdentity(root, [
    'apps/gateway/src',
    'apps/gateway/test/ptc-m1',
    'scripts/ptc-m4-polyglot.ts',
    'bun.lock',
    'package.json',
    'apps/gateway/package.json',
    'patches',
  ]),
  endpointFingerprint: endpointIdentity(OPENAI_PROTOCOL.endpoint),
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  kernel: os.release(),
};
const marker = createArtifact(path.join(directory, `.${RUN}-attempted`));
try {
  checkpoint(marker, { kind: 'ptc-m4-polyglot', mode, initialSpentUnits: carry.spentUnits });
} finally {
  closeSync(marker);
}
const budgetFd = createArtifact(`${values.output}.budget.jsonl`),
  resultsFd = createArtifact(`${values.output}.trials.jsonl`),
  finalFd = createArtifact(`${values.output}.summary.json`);
checkpoint(resultsFd, manifest);
const budget = new OpenAIBudget(
  () => checkpoint(budgetFd, budget.snapshot()),
  carry,
  undefined,
  M4_POLY.limitUsd,
);
checkpoint(budgetFd, budget.snapshot());
const cancellation = new AbortController();
const reader = Bun.stdin.stream().getReader();
const stop = () => {
  cancellation.abort();
  void reader.cancel().catch(() => {});
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const controllers: Partial<Record<Arm, OpenAIController>> = {};
let result: Awaited<ReturnType<typeof runExerciseMatrix>> | undefined;
let failed = false;
const failureCodes = new Set<string>();
try {
  let key = '';
  while (true) {
    cancellation.signal.throwIfAborted();
    const chunk = await reader.read();
    cancellation.signal.throwIfAborted();
    if (chunk.done) break;
    key += new TextDecoder().decode(chunk.value);
    if (key.length > 4096) throw new Error('Credential limit');
  }
  reader.releaseLock();
  key = key.trim();
  if (!key || /\s/.test(key)) throw new Error('Invalid credential');
  console.log(JSON.stringify({ status: 'credential_accepted', budget: budget.snapshot() }));
  for (const arm of arms)
    controllers[arm] = new OpenAIController({
      nodeBinary: binaries[arm].node!,
      chatBinary: binaries[arm].chat!,
      endpoint: OPENAI_PROTOCOL.endpoint,
      apiKey: key,
      budget,
      signal: cancellation.signal,
      requirePrimeSuccess: false,
      features: M4_POLY.features,
      trialDeadlineMs: M4_POLY.trialDeadlineMs,
    });
  key = '';
  result = await runExerciseMatrix({
    fixtures,
    arms,
    trials: manifest.trials,
    signal: cancellation.signal,
    execute: (arm, fixture, trial) => controllers[arm]!.execute(fixture, 'uncached', trial),
    ...(mode === 'holdout'
      ? {
          firstStage: async (rows) => {
            try {
              await waitForOpenAIStage({
                prefix: `${values.output}.stage`,
                signal: cancellation.signal,
                evidence: { rows, budget: budget.snapshot() },
                onReady: () =>
                  console.log(
                    JSON.stringify({
                      status: 'waiting_first_stage_review',
                      budget: budget.snapshot(),
                    }),
                  ),
              });
            } catch (error) {
              failureCodes.add(
                cancellation.signal.aborted ? 'stage_cancelled' : 'stage_not_approved',
              );
              throw error;
            }
          },
        }
      : {}),
    record: async (row) => {
      checkpoint(resultsFd, row);
      console.log(
        JSON.stringify({
          arm: row.arm,
          fixture: row.fixture,
          trial: row.trial,
          success: row.result.run.success,
          budget: budget.snapshot(),
        }),
      );
    },
  });
} catch {
  failed = true;
  failureCodes.add(cancellation.signal.aborted ? 'cancelled' : 'run_incomplete');
} finally {
  for (const arm of arms)
    try {
      await controllers[arm]?.close();
    } catch {
      failed = true;
      failureCodes.add('cleanup_failed');
    }
  if (budget.snapshot().halted || budget.snapshot().reservedUnits !== 0)
    failureCodes.add('budget_invalid');
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  const summary = {
    kind: 'ptc-m4-polyglot',
    run: RUN,
    mode,
    complete:
      !failed &&
      result?.complete === true &&
      !budget.snapshot().halted &&
      budget.snapshot().reservedUnits === 0,
    rows: result?.rows.length ?? null,
    missing: [...new Set([...(result?.missing ?? ['run_incomplete']), ...failureCodes])].sort(),
    budget: budget.snapshot(),
  };
  try {
    checkpoint(finalFd, summary);
    console.log(JSON.stringify(summary));
  } finally {
    closeSync(finalFd);
    closeSync(resultsFd);
    closeSync(budgetFd);
  }
  if (!summary.complete) process.exitCode = 1;
}
