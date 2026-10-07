/** OpenAI evaluation CLI: independent marker/artifacts/budget; key only via stdin. */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  AUTHORIZATION_FIXTURES,
  validateOpenAIRemeasure,
  validateOpenAIContinuation,
  validateOpenAIResume,
  validateOpenAIResume002,
} from '../apps/gateway/test/ptc-m1/openai-resume.js';
import { OpenAIBudget } from '../apps/gateway/test/ptc-m1/openai-budget.js';
import { OpenAIController } from '../apps/gateway/test/ptc-m1/openai-controller.js';
import { waitForOpenAIStage } from '../apps/gateway/test/ptc-m1/openai-stage.js';
import { runOpenAICohorts } from '../apps/gateway/test/ptc-m1/openai-cohort.js';
import { FIXTURES } from '../apps/gateway/test/ptc-m1/fixtures.js';
import { TEAM_ORACLE_REVISION } from '../apps/gateway/test/ptc-m1/team-evidence.js';
import { BASELINE_COMMIT } from '../apps/gateway/test/ptc-m1/metrics.js';
const { values } = parseArgs({
  options: {
    node: { type: 'string' },
    chat: { type: 'string' },
    output: { type: 'string' },
    'execute-openai': { type: 'boolean' },
    'resume-openai-001': { type: 'boolean' },
    'resume-openai-002': { type: 'boolean' },
    'resume-latest': { type: 'boolean' },
    // Whole-category re-measure of the authorization fixtures with explicit enforcement evidence.
    remeasure: { type: 'string' },
  },
  strict: true,
});
if (
  !values['execute-openai'] ||
  process.platform !== 'linux' ||
  !values.node ||
  !values.chat ||
  !values.output ||
  [
    values['resume-openai-001'],
    values['resume-openai-002'],
    values['resume-latest'],
    values.remeasure,
  ].filter(Boolean).length > 1 ||
  (values.remeasure !== undefined && values.remeasure !== 'authorization')
)
  throw new Error('Explicit OpenAI execution settings required');
const pins = {
  node: '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80',
  chat: 'be2eb5fbf1908dd1ddaa74be79cdb503e7dafcf73413a0d1fb2a87618fea8aaf',
};
for (const kind of ['node', 'chat'] as const)
  if (
    createHash('sha256')
      .update(await readFile(values[kind]!))
      .digest('hex') !== pins[kind]
  )
    throw new Error('Baseline binary mismatch');
if (
  (await readFile('/proc/swaps', 'utf8')).trim().split('\n').length !== 1 ||
  !/^Max core file size\s+0\s/m.test(await readFile('/proc/self/limits', 'utf8'))
)
  throw new Error('No swap/core zero required');
const root = path.resolve(import.meta.dir, '..');
const manifest = {
  provider: 'openai',
  baseline: BASELINE_COMMIT,
  pins,
  protocol: OPENAI_PROTOCOL,
  auxiliaryReasoningMap: { off: 'low', minimal: 'low' },
  controllerSourceHash: await sourceIdentity(root, [
    'apps/gateway/src',
    'apps/gateway/test/ptc-m1',
    'scripts/ptc-m1-openai.ts',
    'bun.lock',
    'package.json',
    'apps/gateway/package.json',
    'patches',
  ]),
  fixtureHash: createHash('sha256')
    .update(await readFile(path.join(root, 'apps/gateway/test/ptc-m1/fixtures.ts')))
    .digest('hex'),
  endpointFingerprint: endpointIdentity(OPENAI_PROTOCOL.endpoint),
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  kernel: os.release(),
};
let resumed: ReturnType<typeof validateOpenAIResume> | undefined;
let chained: ReturnType<typeof validateOpenAIResume002> | undefined;
let latest: ReturnType<typeof validateOpenAIContinuation>[] = [];
let remeasured: ReturnType<typeof validateOpenAIRemeasure> | undefined;
let remeasureCarry: { spentUnits: number; admittedAttempts: number } | undefined;
const remeasure = values.remeasure ? [...AUTHORIZATION_FIXTURES] : undefined;
if (
  values['resume-openai-001'] ||
  values['resume-openai-002'] ||
  values['resume-latest'] ||
  remeasure
) {
  const directory = path.join(os.homedir(), 'pirc-ptc-m1-eval');
  const texts = await Promise.all(
    ['trials.jsonl', 'budget.jsonl', 'summary.json'].map((suffix) =>
      readFile(path.join(directory, `openai-001.${suffix}`), 'utf8'),
    ),
  );
  for (const [index, expected] of [
    APPROVED_OPENAI_001.trials,
    APPROVED_OPENAI_001.budget,
    APPROVED_OPENAI_001.summary,
  ].entries())
    if (createHash('sha256').update(texts[index]!).digest('hex') !== expected)
      throw new Error('Approved continuation artifact mismatch');
  const summary = JSON.parse(texts[2]!);
  const lastBudget = JSON.parse(texts[1]!.trim().split('\n').at(-1)!);
  if (summary.complete !== false || JSON.stringify(summary.budget) !== JSON.stringify(lastBudget))
    throw new Error('Original run not safely stopped');
  resumed = validateOpenAIResume(texts[0]!, APPROVED_OPENAI_001.trials, lastBudget);
  if (path.resolve(values.output) === path.join(directory, 'openai-001'))
    throw new Error('Cannot overwrite original run');
  if (values['resume-openai-002'] || values['resume-latest'] || remeasure) {
    const read = (name: string) => readFile(path.join(directory, name), 'utf8');
    chained = validateOpenAIResume002(
      resumed,
      {
        trials: await read('openai-002.trials.jsonl'),
        budget: await read('openai-002.budget.jsonl'),
        summary: await read('openai-002.summary.json'),
      },
      {
        report: await read('openai-team-diagnostic-001.json'),
        budget: await read('openai-team-diagnostic-001.budget.jsonl'),
      },
    );
    if (
      ['openai-001', 'openai-002', 'openai-team-diagnostic-001'].some(
        (name) => path.resolve(values.output!) === path.join(directory, name),
      )
    )
      throw new Error('Cannot overwrite original run');
    if (values['resume-latest'] || remeasure) {
      let state: {
        rows: any[];
        carry: { spentUnits: number; admittedAttempts: number };
        next: any;
      } = chained;
      for (const [i, pin] of APPROVED_CONTINUATIONS.entries()) {
        if (pin.name !== `openai-${String(3 + i).padStart(3, '0')}`)
          throw new Error('Continuation pin order mismatch');
        const step = validateOpenAIContinuation(
          state,
          {
            trials: await read(`${pin.name}.trials.jsonl`),
            budget: await read(`${pin.name}.budget.jsonl`),
            summary: await read(`${pin.name}.summary.json`),
          },
          pin,
        );
        latest.push(step);
        state = step;
      }
      if (remeasure) {
        if (state.next) throw new Error('Re-measure requires the completed matrix chain');
        let current = { rows: state.rows, carry: state.carry };
        for (const pin of APPROVED_REMEASURES) {
          remeasured = validateOpenAIRemeasure(
            current,
            {
              trials: await read(`${pin.name}.trials.jsonl`),
              budget: await read(`${pin.name}.budget.jsonl`),
              summary: await read(`${pin.name}.summary.json`),
            },
            pin,
          );
          current = remeasured;
        }
        if (
          APPROVED_REMEASURES.some((pin) =>
            pin.fixtures.some((f) => remeasure.includes(f as never)),
          )
        )
          throw new Error('Fixture already re-measured');
        remeasureCarry = current.carry;
      }
      const expected = `openai-${String(3 + APPROVED_CONTINUATIONS.length + (remeasure ? APPROVED_REMEASURES.length : 0)).padStart(3, '0')}`;
      if (!latest.length || path.resolve(values.output) !== path.join(directory, expected))
        throw new Error('Latest continuation output mismatch');
    }
  }
}
// Pre-spend: resumed rows are only comparable under the same fixtures and baseline.
if (
  (resumed || chained || latest.length) &&
  (manifest.fixtureHash !== APPROVED_OPENAI_001.fixture || manifest.baseline !== BASELINE_COMMIT)
)
  throw new Error('Continuation fixture/baseline mismatch');
const tip = latest.at(-1);
if (!remeasure && tip && !tip.next)
  throw new Error('Matrix already complete; use the report script');
const carry = remeasureCarry ?? tip?.carry ?? chained?.carry ?? resumed?.carry;
const previousRows = remeasure ? undefined : (tip?.rows ?? chained?.rows ?? resumed?.rows);
// Prospective policy for the chained continuation only; see plans/ptc-m1-openai.md.
const primeOutcome = chained ? ('record' as const) : ('gate' as const);
// Fixed location and exclusive creation: never delete to restart with a zero budget.
const marker = createArtifact(
  path.join(
    os.homedir(),
    'pirc-ptc-m1-eval',
    remeasure
      ? `.ptc-m1-openai-remeasure-${path.basename(values.output)}-attempted`
      : tip
        ? `.ptc-m1-openai-resume-${tip.source.name}-attempted`
        : chained
          ? '.ptc-m1-openai-resume-002-attempted'
          : resumed
            ? '.ptc-m1-openai-resume-001-attempted'
            : '.ptc-m1-openai-attempted',
  ),
);
try {
  checkpoint(marker, {
    provider: 'openai',
    initialSpentUnits: carry?.spentUnits ?? 0,
    ...(resumed ? { originalSourceHash: resumed.sourceHash } : {}),
    ...(chained ? { sources: chained.sources } : {}),
    ...(tip ? { continuations: latest.map((s) => s.source) } : {}),
    ledger: path.resolve(`${values.output}.budget.jsonl`),
  });
} finally {
  closeSync(marker);
}
const budgetFd = createArtifact(`${values.output}.budget.jsonl`),
  resultsFd = createArtifact(`${values.output}.trials.jsonl`),
  finalFd = createArtifact(`${values.output}.summary.json`);
checkpoint(resultsFd, {
  kind: 'manifest',
  ...manifest,
  ...(remeasure
    ? {
        remeasure: {
          fixtures: remeasure,
          primeOutcome,
          carry,
          basis: latest.map((s) => s.source.name),
          reason:
            'explicit per-trial authorization enforcement evidence for the whole authorization category',
        },
      }
    : chained
      ? {
          continuation: {
            sources: chained.sources,
            correction: chained.correction,
            supersededPrime: chained.supersededPrime,
            diagnosticAttempts: chained.diagnosticAttempts,
            carry: carry,
            next: tip?.next ?? chained.next,
            ...(tip
              ? {
                  continuations: latest.map((s) => ({
                    source: s.source,
                    superseded: s.superseded,
                  })),
                }
              : {}),
            primeOutcome,
            teamOracleRevision: TEAM_ORACLE_REVISION,
          },
        }
      : resumed
        ? {
            continuation: {
              original: APPROVED_OPENAI_001,
              correction: resumed.correction,
              carry: resumed.carry,
              next: resumed.next,
            },
          }
        : {}),
});
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
  // Progress signal that stdin was fully consumed (a detached launch waits for it); no credential data.
  console.log(JSON.stringify({ status: 'credential_accepted', budget: budget.snapshot() }));
  controller = new OpenAIController({
    nodeBinary: values.node,
    chatBinary: values.chat,
    endpoint: OPENAI_PROTOCOL.endpoint,
    apiKey: key,
    budget,
    signal: cancellation.signal,
    requirePrimeSuccess: primeOutcome === 'gate',
  });
  key = '';
  result = await runOpenAICohorts({
    fixtures: remeasure ? FIXTURES.filter((f) => remeasure.includes(f.id as never)) : FIXTURES,
    ...(previousRows ? { previous: previousRows } : {}),
    primeOutcome,
    signal: cancellation.signal,
    firstTriplet: async (rows) => {
      if (remeasure) return; // Matrix already reviewed; whole-cohort re-measure needs no stage.
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
    kind: 'openai-baseline',
    manifest,
    ...(remeasure ? { remeasure: { fixtures: remeasure, carry } } : {}),
    ...(chained
      ? {
          continuation: {
            sources: chained.sources,
            correction: chained.correction,
            supersededPrime: chained.supersededPrime,
            carry,
            ...(tip
              ? {
                  continuations: latest.map((s) => ({
                    source: s.source,
                    superseded: s.superseded,
                  })),
                }
              : {}),
            primeOutcome,
            // team-wait uncached index 0 was judged under revision 1; later team rows use this one.
            teamOracleRevision: TEAM_ORACLE_REVISION,
          },
        }
      : resumed
        ? {
            continuation: {
              original: APPROVED_OPENAI_001,
              correction: resumed.correction,
              carry: resumed.carry,
            },
          }
        : {}),
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
