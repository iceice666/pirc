/**
 * M4 round 3 (docs/evaluations/ptc/ptc-m4-evaluation.md): the pinned M1 `main` binaries and the hybrid branch
 * binaries measured interleaved in one session, with the M1 fixtures, oracles (PTC mapping),
 * protocol and readiness function. Spend continues the same independent USD 100 OpenAI budget
 * from the end of round 2. Key only via stdin; exclusive marker; aggregate-only artifacts.
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
import { TEAM_ORACLE_REVISION } from '../apps/gateway/test/ptc-m1/team-evidence.js';
import { PTC_ORACLE_MAPPING } from '../apps/gateway/test/ptc-m1/ptc-surface.js';
import { M4_BOUNDS } from '../apps/gateway/test/ptc-m1/m4-bounds.js';
import {
  M4_BASELINE,
  M4_COMPLETED,
  M4_PINNED_FILES,
  M4_STOPPED,
  M4_R3,
  M4_R3_STOPS,
  M4_ROUND2_END,
  m4R3Marker,
  m4R3Run,
} from '../apps/gateway/test/ptc-m1/m4-run.js';
import {
  ARMS,
  runPairedCohorts,
  validatePairedStopped,
  type Arm,
  type PairedRow,
} from '../apps/gateway/test/ptc-m1/m4-paired.js';

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const { values } = parseArgs({
  options: {
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
// At most six continuations without a new decision (round 3 amendment 2026-10-06; was two).
if (M4_R3_STOPS.length > 6) throw new Error('Round 3 continuations exhausted');
const runNumber = M4_R3_STOPS.length + 1;
const RUN = m4R3Run(runNumber);
const binaries = {
  main: { node: values['main-node'], chat: values['main-chat'] },
  ptc: { node: values['ptc-node'], chat: values['ptc-chat'] },
};
if (
  !values['execute-openai'] ||
  process.platform !== 'linux' ||
  ARMS.some((arm) => !binaries[arm].node || !binaries[arm].chat) ||
  !values.output ||
  path.resolve(values.output) !== path.join(directory, RUN)
)
  throw new Error('Explicit M4 round 3 execution settings required');
for (const arm of ARMS)
  for (const kind of ['node', 'chat'] as const)
    if (sha256(await readFile(binaries[arm][kind]!)) !== M4_R3.arms[arm][kind])
      throw new Error(`${arm} binary mismatch`);
// The branch arm is a new build: neither main nor an earlier round's binaries.
if (
  [M4_R3.arms.main, ...M4_COMPLETED.map((run) => run.pins), M4_STOPPED.pins].some(
    (pins) => pins.node === M4_R3.arms.ptc.node || pins.chat === M4_R3.arms.ptc.chat,
  )
)
  throw new Error('Branch arm repeats earlier binaries');
if (
  (await readFile('/proc/swaps', 'utf8')).trim().split('\n').length !== 1 ||
  !/^Max core file size\s+0\s/m.test(await readFile('/proc/self/limits', 'utf8'))
)
  throw new Error('No swap/core zero required');
const root = path.resolve(import.meta.dir, '..');
const fixtureHash = sha256(await readFile(path.join(root, 'apps/gateway/test/ptc-m1/fixtures.ts')));
if (fixtureHash !== APPROVED_OPENAI_001.fixture) throw new Error('Fixture mismatch with M1');
const plansReport = await readFile(
  path.join(root, 'docs/evaluations/ptc/ptc-m1-openai-baseline.json'),
  'utf8',
);
if (
  sha256(plansReport) !== M4_BASELINE.plansReport ||
  JSON.stringify(OPENAI_PROTOCOL) !== JSON.stringify(JSON.parse(plansReport).protocol)
)
  throw new Error('Protocol differs from the M1 baseline');

// Nothing outside the pinned runs has spent from the budget.
const pinnedOpenAI = new Set([
  'openai-001',
  'openai-002',
  'openai-team-diagnostic-001',
  ...APPROVED_CONTINUATIONS.map((p) => p.name),
  ...APPROVED_REMEASURES.map((p) => p.name),
]);
const stopFiles = M4_R3_STOPS.flatMap((stop, i) => [
  `${stop.name}.trials.jsonl`,
  `${stop.name}.budget.jsonl`,
  `${stop.name}.summary.json`,
  `${stop.name}.stage.pending.json`,
  `${stop.name}.stage.approve.json`,
  `${stop.name}.stage.accepted.json`,
  m4R3Marker(i + 1),
]);
const allowed = new Set([...M4_PINNED_FILES, ...stopFiles]);
const entries = await readdir(directory);
for (const entry of entries) {
  const run = /^(openai-[\w-]+?)\.(?:trials\.jsonl|budget\.jsonl|summary\.json)$/.exec(entry)?.[1];
  if (run && !pinnedOpenAI.has(run)) throw new Error(`Unpinned OpenAI run exists: ${run}`);
  const marker = /^\.ptc-m1-openai-(?:remeasure|resume)-([\w-]+)-attempted$/.exec(entry)?.[1];
  if (marker && !['openai-005', '001', '002', 'openai-003'].includes(marker))
    throw new Error(`Unpinned OpenAI marker exists: ${entry}`);
  if (/^\.?ptc-m4-/.test(entry) && !allowed.has(entry))
    throw new Error(`Unpinned M4 artifact exists: ${entry}`);
}
for (const file of [M4_ROUND2_END.marker, ...M4_R3_STOPS.map((_, i) => m4R3Marker(i + 1))])
  if (!entries.includes(file)) throw new Error(`M4 marker missing: ${file}`);
const read = (name: string) => readFile(path.join(directory, name), 'utf8');
// Round 2 ended where this budget continues.
for (const kind of ['trials', 'budget', 'summary'] as const) {
  const file = `${M4_ROUND2_END.name}.${kind === 'summary' ? 'summary.json' : `${kind}.jsonl`}`;
  if (sha256(await read(file)) !== M4_ROUND2_END[kind]) throw new Error(`Pin mismatch: ${file}`);
}
if (sha256(await read(`${M4_ROUND2_END.name}-report.json`)) !== M4_ROUND2_END.report)
  throw new Error('Round 2 report pin mismatch');
const round2Budget = JSON.parse(
  (await read(`${M4_ROUND2_END.name}.budget.jsonl`)).trim().split('\n').at(-1)!,
);
if (
  round2Budget.spentUnits !== M4_R3.carry.spentUnits ||
  round2Budget.admittedAttempts !== M4_R3.carry.admittedAttempts ||
  round2Budget.reservedUnits !== 0 ||
  round2Budget.unknownAttempts !== 0 ||
  round2Budget.halted !== false
)
  throw new Error('Round 2 budget carry mismatch');

// The M1 chain's last budget and report are intact where they were produced.
const lastM1 = APPROVED_REMEASURES.at(-1)!;
if (
  lastM1.name !== M4_BASELINE.lastRun ||
  sha256(await read(`${lastM1.name}.budget.jsonl`)) !== lastM1.budget ||
  sha256(await read(`openai-baseline-report-${lastM1.name}.json`)) !== M4_BASELINE.report
)
  throw new Error('M1 chain pin mismatch');

const manifestFields = {
  provider: 'openai',
  auxiliaryReasoningMap: { off: 'low', minimal: 'low' },
  arms: M4_R3.arms,
  protocol: OPENAI_PROTOCOL,
  oracleMapping: PTC_ORACLE_MAPPING,
  teamOracleRevision: TEAM_ORACLE_REVISION,
  bounds: M4_BOUNDS,
  fixtureHash,
  primeOutcome: 'record',
};
const sameFields = (manifest: any) =>
  Object.entries(manifestFields).every(
    ([key, value]) => JSON.stringify(manifest[key]) === JSON.stringify(value),
  );
// Stopped runs: their rows are reused, their uncertain attempts charged in full.
let previous: PairedRow[] = [];
let carry: { spentUnits: number; admittedAttempts: number } = { ...M4_R3.carry };
const continuations: unknown[] = [];
for (const [i, stop] of M4_R3_STOPS.entries()) {
  if (stop.name !== m4R3Run(i + 1) || JSON.stringify(stop.carry) !== JSON.stringify(carry))
    throw new Error('Round 3 stop chain mismatch');
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

const manifest = {
  kind: 'ptc-m4-paired',
  ...manifestFields,
  baseline: M4_BASELINE,
  round2: M4_ROUND2_END,
  carry,
  reusedRows: previous.length,
  continuations,
  controllerSourceHash: await sourceIdentity(root, [
    'apps/gateway/src',
    'apps/gateway/test/ptc-m1',
    'scripts/ptc-m4-paired.ts',
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
const marker = createArtifact(path.join(directory, m4R3Marker(runNumber)));
try {
  checkpoint(marker, {
    provider: 'openai',
    kind: 'ptc-m4-paired',
    initialSpentUnits: carry.spentUnits,
    ledger: path.resolve(`${values.output}.budget.jsonl`),
  });
} finally {
  closeSync(marker);
}
const budgetFd = createArtifact(`${values.output}.budget.jsonl`),
  resultsFd = createArtifact(`${values.output}.trials.jsonl`),
  finalFd = createArtifact(`${values.output}.summary.json`);
checkpoint(resultsFd, manifest);
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
const controllers: Partial<Record<Arm, OpenAIController>> = {};
let result: Awaited<ReturnType<typeof runPairedCohorts>> | undefined;
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
  for (const arm of ARMS)
    controllers[arm] = new OpenAIController({
      nodeBinary: binaries[arm].node!,
      chatBinary: binaries[arm].chat!,
      endpoint: OPENAI_PROTOCOL.endpoint,
      apiKey: key,
      budget,
      signal: cancellation.signal,
      requirePrimeSuccess: false,
    });
  key = '';
  result = await runPairedCohorts({
    signal: cancellation.signal,
    previous,
    firstStage: async (rows) => {
      try {
        await waitForOpenAIStage({
          prefix: `${values.output}.stage`,
          signal: cancellation.signal,
          evidence: { rows, budget: budget.snapshot() },
          onReady: () =>
            console.log(
              JSON.stringify({ status: 'waiting_first_stage_review', budget: budget.snapshot() }),
            ),
        });
      } catch (error) {
        failureCodes.add(cancellation.signal.aborted ? 'stage_cancelled' : 'stage_not_approved');
        throw error;
      }
    },
    execute: (arm, fixture, phase, index) => controllers[arm]!.execute(fixture, phase, index),
    record: async (row) => {
      checkpoint(resultsFd, row);
      console.log(
        JSON.stringify({
          arm: row.arm,
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
  for (const arm of ARMS)
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
    kind: 'ptc-m4-paired',
    run: RUN,
    complete:
      !failed &&
      result?.complete === true &&
      !budget.snapshot().halted &&
      budget.snapshot().reservedUnits === 0,
    measuredTrials: result
      ? Object.fromEntries(ARMS.map((arm) => [arm, result!.measured[arm].length]))
      : null,
    aggregates: result
      ? Object.fromEntries(ARMS.map((arm) => [arm, summarizeOpenAI(result!.measured[arm])]))
      : null,
    missing: result
      ? Object.fromEntries(
          ARMS.map((arm) => [arm, [...new Set([...result!.missing[arm], ...failureCodes])].sort()]),
        )
      : { all: [...new Set(['run_incomplete', ...failureCodes])].sort() },
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
