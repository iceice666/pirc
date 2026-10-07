/** Explicit long-running baseline CLI. Aggregate artifacts only; key via stdin only. */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sourceIdentity, endpointIdentity } from '../apps/gateway/test/ptc-m1/provenance.js';
import os from 'node:os';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { LiveBudget } from '../apps/gateway/test/ptc-m1/live-budget.js';
import { CacheController } from '../apps/gateway/test/ptc-m1/cache-controller.js';
import { runCohorts } from '../apps/gateway/test/ptc-m1/cohort.js';
import { FIXTURES } from '../apps/gateway/test/ptc-m1/fixtures.js';
import { BASELINE_COMMIT, EVALUATION_PROTOCOL } from '../apps/gateway/test/ptc-m1/metrics.js';
const { values } = parseArgs({
  options: {
    node: { type: 'string' },
    chat: { type: 'string' },
    endpoint: { type: 'string' },
    output: { type: 'string' },
    'prior-units': { type: 'string' },
    'execute-baseline': { type: 'boolean' },
  },
  strict: true,
});
if (
  !values['execute-baseline'] ||
  process.platform !== 'linux' ||
  !values.node ||
  !values.chat ||
  !values.endpoint ||
  !values.output ||
  values['prior-units'] !== '43194951'
)
  throw new Error('Explicit baseline settings/current budget required');
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
    throw new Error('Pinned baseline mismatch');
if (
  (await readFile('/proc/swaps', 'utf8')).trim().split('\n').length !== 1 ||
  !/^Max core file size\s+0\s/m.test(await readFile('/proc/self/limits', 'utf8'))
)
  throw new Error('No swap and core zero required');
// Do not remove this marker to resume a partial run: reconcile its durable ledger first.
const marker = createArtifact(
  path.join(os.homedir(), 'pirc-ptc-m1-eval', '.ptc-m1-baseline-attempted'),
);
try {
  checkpoint(marker, {
    baseline: BASELINE_COMMIT,
    priorUnits: 43194951,
    ledger: path.resolve(`${values.output}.budget.jsonl`),
  });
} finally {
  closeSync(marker);
}
const ledgerFd = createArtifact(`${values.output}.budget.jsonl`);
const resultsFd = createArtifact(`${values.output}.trials.jsonl`);
const finalFd = createArtifact(`${values.output}.summary.json`);
const harnessRoot = new URL('../apps/gateway/test/ptc-m1/', import.meta.url);
const controllerSourceHash = await sourceIdentity(path.resolve(import.meta.dir, '..'), [
  'apps/gateway/src',
  'apps/gateway/test/ptc-m1',
  'scripts/ptc-m1-baseline.ts',
  'package.json',
  'apps/gateway/package.json',
  'bun.lock',
  'patches',
]);
const manifest = {
  baseline: BASELINE_COMMIT,
  pins,
  protocol: EVALUATION_PROTOCOL,
  fixtureHash: createHash('sha256')
    .update(await readFile(new URL('fixtures.ts', harnessRoot)))
    .digest('hex'),
  controllerSourceHash,
  endpointFingerprint: endpointIdentity(values.endpoint),
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  kernel: os.release(),
  model: 'claude-opus-5-5',
  transport: 'anthropic-messages',
  mainThinking: 'adaptive-medium',
  outputCap: 16384,
  auxiliarySettings: 'unchanged-pinned-binary',
  budgetPriorUnits: 43194951,
};
checkpoint(resultsFd, { kind: 'manifest', ...manifest });
const budget = new LiveBudget({
  limitUsd: 100,
  priorUnits: 43194951,
  checkpoint: () => checkpoint(ledgerFd, budget.snapshot()),
});
checkpoint(ledgerFd, budget.snapshot());
const abort = new AbortController();
const reader = Bun.stdin.stream().getReader();
const stop = () => {
  abort.abort();
  void reader.cancel().catch(() => undefined);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let controller: CacheController | undefined;
let result: Awaited<ReturnType<typeof runCohorts>> | undefined;
let failed = false;
try {
  let secret = '';
  while (true) {
    abort.signal.throwIfAborted();
    const chunk = await reader.read();
    abort.signal.throwIfAborted();
    if (chunk.done) break;
    secret += new TextDecoder().decode(chunk.value);
    if (secret.length > 4096) throw new Error('Credential limit');
  }
  reader.releaseLock();
  secret = secret.trim();
  if (!secret || /\s/.test(secret)) throw new Error('Invalid credential');
  controller = new CacheController({
    nodeBinary: values.node,
    chatBinary: values.chat,
    endpoint: values.endpoint,
    apiKey: secret,
    budget,
    signal: abort.signal,
  });
  secret = '';
  result = await runCohorts({
    fixtures: FIXTURES,
    signal: abort.signal,
    now: Date.now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(new Error('Baseline cancelled'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', cancel);
          resolve();
        }, ms);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }),
    record: async (entry) => {
      checkpoint(resultsFd, entry);
      console.log(
        JSON.stringify({
          fixture: entry.fixture,
          phase: entry.phase,
          index: entry.index,
          success: entry.result.trial.success,
          cache: entry.result.trial.cache,
          budget: budget.snapshot(),
        }),
      );
    },
    execute: (fixture, cache, phase, index) => controller!.execute(fixture, cache, phase, index),
  });
} catch {
  failed = true;
} finally {
  try {
    await controller?.close();
  } catch {
    failed = true;
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  const summary = {
    kind: 'baseline',
    baseline: BASELINE_COMMIT,
    pins,
    protocol: EVALUATION_PROTOCOL,
    complete:
      !failed &&
      !!result &&
      result.missing.length === 0 &&
      !budget.snapshot().halted &&
      budget.snapshot().reservedUnits === 0,
    manifest,
    measuredTrials: result?.trials.length ?? null,
    missing: result?.missing ?? ['run_incomplete'],
    budget: budget.snapshot(),
  };
  try {
    checkpoint(finalFd, summary);
    console.log(JSON.stringify(summary));
  } finally {
    closeSync(finalFd);
    closeSync(resultsFd);
    closeSync(ledgerFd);
  }
  if (!summary.complete) process.exitCode = 1;
}
