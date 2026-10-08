/**
 * M4 OpenAI evaluation of the PTC-only binaries (docs/evaluations/ptc/ptc-m4-evaluation.md): the M1 fixtures,
 * oracles (PTC mapping), protocol and readiness function, one fresh 300-trial matrix. Spend
 * continues the same independent USD 100 OpenAI budget from the pinned M1 chain end. Key only
 * via stdin; exclusive marker; aggregate-only artifacts.
 */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { sourceIdentity, endpointIdentity } from '../apps/gateway/test/ptc-m1/provenance.js';
import { summarizeOpenAI } from '../apps/gateway/test/ptc-m1/openai-report.js';
import { OPENAI_PROTOCOL } from '../apps/gateway/test/ptc-m1/openai-contract.js';
import {
  APPROVED_CONTINUATIONS,
  APPROVED_OPENAI_001,
  APPROVED_REMEASURES,
} from '../apps/gateway/test/ptc-m1/openai-resume.js';
import { OpenAIBudget } from '../apps/gateway/test/ptc-m1/openai-budget.js';
import { OpenAIController } from '../apps/gateway/test/ptc-m1/openai-controller.js';
import { waitForOpenAIStage } from '../apps/gateway/test/ptc-m1/openai-stage.js';
import { runOpenAICohorts } from '../apps/gateway/test/ptc-m1/openai-cohort.js';
import { FIXTURES } from '../apps/gateway/test/ptc-m1/fixtures.js';
import { TEAM_ORACLE_REVISION } from '../apps/gateway/test/ptc-m1/team-evidence.js';
import { PTC_ORACLE_MAPPING } from '../apps/gateway/test/ptc-m1/ptc-surface.js';
import { M4_BOUNDS } from '../apps/gateway/test/ptc-m1/m4-bounds.js';
import {
  M4_BASELINE,
  M4_COMPLETED,
  M4_MARKER,
  M4_PINS,
  M4_RUN,
  M4_STOPPED,
} from '../apps/gateway/test/ptc-m1/m4-run.js';
import { validateM4Stopped } from '../apps/gateway/test/ptc-m1/m4-continuation.js';

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

const { values } = parseArgs({
  options: {
    node: { type: 'string' },
    chat: { type: 'string' },
    output: { type: 'string' },
    'execute-openai': { type: 'boolean' },
  },
  strict: true,
});
const directory = path.join(os.homedir(), 'pirc-ptc-m1-eval');
if (
  !values['execute-openai'] ||
  process.platform !== 'linux' ||
  !values.node ||
  !values.chat ||
  !values.output ||
  path.resolve(values.output) !== path.join(directory, M4_RUN)
)
  throw new Error('Explicit M4 OpenAI execution settings required');
for (const kind of ['node', 'chat'] as const)
  if (sha256(await readFile(values[kind]!)) !== M4_PINS[kind])
    throw new Error('PTC binary mismatch');
if (
  (await readFile('/proc/swaps', 'utf8')).trim().split('\n').length !== 1 ||
  !/^Max core file size\s+0\s/m.test(await readFile('/proc/self/limits', 'utf8'))
)
  throw new Error('No swap/core zero required');
const root = path.resolve(import.meta.dir, '..');
const fixtureHash = sha256(await readFile(path.join(root, 'apps/gateway/test/ptc-m1/fixtures.ts')));
if (fixtureHash !== APPROVED_OPENAI_001.fixture) throw new Error('Fixture mismatch with M1');

// The M1 chain is intact and nothing outside it or the M4 runs has spent from the budget.
const pinnedRuns = new Set([
  'openai-001',
  'openai-002',
  ...APPROVED_CONTINUATIONS.map((p) => p.name),
  ...APPROVED_REMEASURES.map((p) => p.name),
]);
// Run identity: a new name and marker; the stopped run's binaries, which no completed run used.
if (
  [...M4_COMPLETED, M4_STOPPED].some((run) => run.name === M4_RUN || run.marker === M4_MARKER) ||
  M4_COMPLETED.some((run) => run.pins.node === M4_PINS.node || run.pins.chat === M4_PINS.chat) ||
  JSON.stringify(M4_PINS) !== JSON.stringify(M4_STOPPED.pins)
)
  throw new Error('M4 run identity mismatch');
const allowedM4 = new Set(
  [...M4_COMPLETED, M4_STOPPED].flatMap((run) => [
    `${run.name}.trials.jsonl`,
    `${run.name}.budget.jsonl`,
    `${run.name}.summary.json`,
    `${run.name}-report.json`,
    `${run.name}.stage.pending.json`,
    `${run.name}.stage.approve.json`,
    `${run.name}.stage.accepted.json`,
    run.marker,
  ]),
);
const entries = await readdir(directory);
for (const run of [...M4_COMPLETED, M4_STOPPED])
  if (!entries.includes(run.marker)) throw new Error(`M4 marker missing: ${run.marker}`);
for (const entry of entries) {
  const run = /^(openai-[\w-]+?)\.(?:trials\.jsonl|budget\.jsonl|summary\.json)$/.exec(entry)?.[1];
  if (run && !pinnedRuns.has(run) && run !== 'openai-team-diagnostic-001')
    throw new Error(`Unpinned OpenAI run exists: ${run}`);
  const pinnedMarker = /^\.ptc-m1-openai-(?:remeasure|resume)-([\w-]+)-attempted$/.exec(entry)?.[1];
  if (pinnedMarker && !['openai-005', '001', '002', 'openai-003'].includes(pinnedMarker))
    throw new Error(`Unpinned OpenAI marker exists: ${entry}`);
  // Only the pinned M4 runs' own files may exist.
  if (/^\.?ptc-m4-/.test(entry) && !allowedM4.has(entry))
    throw new Error(`Unpinned M4 artifact exists: ${entry}`);
}
// The completed M4 runs are intact, and the budget continues from the last one.
for (const run of M4_COMPLETED)
  for (const kind of ['trials', 'budget', 'summary'] as const) {
    const file = `${run.name}.${kind === 'summary' ? 'summary.json' : `${kind}.jsonl`}`;
    if (sha256(await readFile(path.join(directory, file), 'utf8')) !== run[kind])
      throw new Error(`M4 artifact pin mismatch: ${file}`);
  }
const previous = M4_COMPLETED.at(-1)!;
if (
  sha256(await readFile(path.join(directory, `${previous.name}-report.json`), 'utf8')) !==
  previous.report
)
  throw new Error('Previous M4 report pin mismatch');
const previousBudget = JSON.parse(
  (await readFile(path.join(directory, `${previous.name}.budget.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .at(-1)!,
);
if (
  previousBudget.spentUnits !== M4_STOPPED.carry.spentUnits ||
  previousBudget.admittedAttempts !== M4_STOPPED.carry.admittedAttempts ||
  previousBudget.reservedUnits !== 0 ||
  previousBudget.unknownAttempts !== 0 ||
  previousBudget.halted !== false
)
  throw new Error('Previous M4 budget carry mismatch');
const last = APPROVED_REMEASURES.at(-1)!;
if (last.name !== M4_BASELINE.lastRun || APPROVED_REMEASURES.length !== 1)
  throw new Error('Baseline chain pin mismatch');
const lastBudget = await readFile(path.join(directory, `${last.name}.budget.jsonl`), 'utf8');
if (sha256(lastBudget) !== last.budget) throw new Error('Baseline budget pin mismatch');
const report = await readFile(
  path.join(directory, `openai-baseline-report-${last.name}.json`),
  'utf8',
);
const plansReport = await readFile(
  path.join(root, 'docs/evaluations/ptc/ptc-m1-openai-baseline.json'),
  'utf8',
);
if (sha256(report) !== M4_BASELINE.report || sha256(plansReport) !== M4_BASELINE.plansReport)
  throw new Error('Baseline report pin mismatch');
// Same protocol as the baseline (model, tier, reasoning, caps, budget limit, conditions).
if (JSON.stringify(OPENAI_PROTOCOL) !== JSON.stringify(JSON.parse(plansReport).protocol))
  throw new Error('Protocol differs from the M1 baseline');
const final = JSON.parse(lastBudget.trim().split('\n').at(-1)!);
const reported = JSON.parse(report).budget;
if (
  final.spentUnits !== M4_BASELINE.carry.spentUnits ||
  final.admittedAttempts !== M4_BASELINE.carry.admittedAttempts ||
  final.reservedUnits !== 0 ||
  final.unknownAttempts !== 0 ||
  final.halted !== false ||
  JSON.stringify(reported) !== JSON.stringify(M4_BASELINE.carry)
)
  throw new Error('Baseline budget carry mismatch');
// The stopped run: its rows are reused, never dispatched again; its uncertain attempt is charged
// at the full reservation; the stopping row is superseded and repeated.
const read = (name: string) => readFile(path.join(directory, name), 'utf8');
const stopped = validateM4Stopped(
  {
    trials: await read(`${M4_STOPPED.name}.trials.jsonl`),
    budget: await read(`${M4_STOPPED.name}.budget.jsonl`),
    summary: await read(`${M4_STOPPED.name}.summary.json`),
  },
  M4_STOPPED,
);
const carry = { ...stopped.carry };
const primeOutcome = 'record' as const;

const manifest = {
  provider: 'openai',
  kind: 'ptc-m4',
  baseline: { ...M4_BASELINE, fixture: APPROVED_OPENAI_001.fixture },
  pins: M4_PINS,
  protocol: OPENAI_PROTOCOL,
  auxiliaryReasoningMap: { off: 'low', minimal: 'low' },
  oracleMapping: PTC_ORACLE_MAPPING,
  teamOracleRevision: TEAM_ORACLE_REVISION,
  bounds: M4_BOUNDS,
  primeOutcome,
  carry,
  previousRuns: M4_COMPLETED.map(({ name, trials, budget, summary }) => ({
    name,
    trials,
    budget,
    summary,
  })),
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
    next: stopped.next,
  },
  controllerSourceHash: await sourceIdentity(root, [
    'apps/gateway/src',
    'apps/gateway/test/ptc-m1',
    'scripts/ptc-m4-openai.ts',
    'bun.lock',
    'package.json',
    'apps/gateway/package.json',
    'patches',
  ]),
  fixtureHash,
  endpointFingerprint: endpointIdentity(OPENAI_PROTOCOL.endpoint),
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  kernel: os.release(),
};
// Fixed location and exclusive creation: never delete to restart.
const marker = createArtifact(path.join(directory, M4_MARKER));
try {
  checkpoint(marker, {
    provider: 'openai',
    kind: 'ptc-m4',
    initialSpentUnits: carry.spentUnits,
    ledger: path.resolve(`${values.output}.budget.jsonl`),
  });
} finally {
  closeSync(marker);
}
const budgetFd = createArtifact(`${values.output}.budget.jsonl`),
  resultsFd = createArtifact(`${values.output}.trials.jsonl`),
  finalFd = createArtifact(`${values.output}.summary.json`);
checkpoint(resultsFd, { kind: 'manifest', ...manifest });
const budget = new OpenAIBudget(() => checkpoint(budgetFd, budget.snapshot()), carry);
checkpoint(budgetFd, budget.snapshot());
const cancellation = new AbortController();
const reader = Bun.stdin.stream().getReader();
const stop = () => {
  cancellation.abort();
  void reader.cancel().catch(() => {});
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let controller: OpenAIController | undefined;
let result: Awaited<ReturnType<typeof runOpenAICohorts>> | undefined;
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
  controller = new OpenAIController({
    nodeBinary: values.node,
    chatBinary: values.chat,
    endpoint: OPENAI_PROTOCOL.endpoint,
    apiKey: key,
    budget,
    signal: cancellation.signal,
    requirePrimeSuccess: false,
  });
  key = '';
  result = await runOpenAICohorts({
    fixtures: FIXTURES,
    previous: stopped.rows,
    primeOutcome,
    signal: cancellation.signal,
    firstTriplet: async (rows) => {
      try {
        await waitForOpenAIStage({
          prefix: `${values.output}.stage`,
          signal: cancellation.signal,
          evidence: { rows, budget: budget.snapshot() },
          onReady: () =>
            console.log(
              JSON.stringify({ status: 'waiting_first_triplet_review', budget: budget.snapshot() }),
            ),
        });
      } catch (error) {
        failureCodes.add(cancellation.signal.aborted ? 'stage_cancelled' : 'stage_not_approved');
        throw error;
      }
    },
    execute: (f, p, i) => controller!.execute(f, p, i),
    record: async (row) => {
      checkpoint(resultsFd, row);
      console.log(
        JSON.stringify({
          fixture: row.fixture,
          phase: row.phase,
          index: row.index,
          success: row.result.run.success,
          cacheVerified: row.result.cacheVerified,
          budget: budget.snapshot(),
        }),
      );
    },
  });
} catch {
  failed = true;
  failureCodes.add(cancellation.signal.aborted ? 'cancelled' : 'run_incomplete');
} finally {
  try {
    await controller?.close();
  } catch {
    failed = true;
    failureCodes.add('cleanup_failed');
  }
  if (budget.snapshot().halted || budget.snapshot().reservedUnits !== 0)
    failureCodes.add('budget_invalid');
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  const summary = {
    kind: 'ptc-m4-openai',
    manifest,
    complete:
      !failed &&
      result?.complete === true &&
      !budget.snapshot().halted &&
      budget.snapshot().reservedUnits === 0,
    measuredTrials: result?.measured.length ?? null,
    aggregates: result ? summarizeOpenAI(result.measured) : null,
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
