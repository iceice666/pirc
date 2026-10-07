/** One authorized diagnostic, never matrix continuation or historical regrading. */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { sourceIdentity } from '../apps/gateway/test/ptc-m1/provenance.js';
import { OpenAIBudget } from '../apps/gateway/test/ptc-m1/openai-budget.js';
import { OPENAI_PROTOCOL } from '../apps/gateway/test/ptc-m1/openai-contract.js';
import { TEAM_ORACLE_REVISION } from '../apps/gateway/test/ptc-m1/team-evidence.js';
import { runOpenAIFixture } from '../apps/gateway/test/ptc-m1/openai-runner.js';
import { FIXTURES } from '../apps/gateway/test/ptc-m1/fixtures.js';
const directory = path.join(os.homedir(), 'pirc-ptc-m1-eval');
const binary = path.join(directory, 'baseline/apps/gateway/dist/pirc-node');
const prefix = path.join(directory, 'openai-team-diagnostic-001');
const sourcePins = {
  trials: '2d8709af1415eb79e0cf060f785357528f5f5240233de66a9b23df3890d83dbf',
  budget: '0f2af600a52f1b6a2e458c5efdfa80acdea7aec746b8db53a9d8c6f6ad564013',
  summary: 'c42ebf0cbe85a10dba6042e20606c1ea6bbc8fd22a67009d9ba772902be16c70',
};
if (process.platform !== 'linux' || TEAM_ORACLE_REVISION !== 2)
  throw new Error('Diagnostic platform/oracle mismatch');
if (
  createHash('sha256')
    .update(await readFile(binary))
    .digest('hex') !== '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80'
)
  throw new Error('Diagnostic binary mismatch');
if (
  (await readFile('/proc/swaps', 'utf8')).trim().split('\n').length !== 1 ||
  !/^Max core file size\s+0\s/m.test(await readFile('/proc/self/limits', 'utf8'))
)
  throw new Error('No swap/core zero required');
const files = await Promise.all(
  ['trials.jsonl', 'budget.jsonl', 'summary.json'].map((suffix) =>
    readFile(path.join(directory, `openai-002.${suffix}`), 'utf8'),
  ),
);
for (const [i, hash] of Object.values(sourcePins).entries())
  if (createHash('sha256').update(files[i]!).digest('hex') !== hash)
    throw new Error('Stopped run changed');
const previous = JSON.parse(files[2]!);
const latest = JSON.parse(files[1]!.trim().split('\n').at(-1)!);
if (
  previous.complete !== false ||
  latest.spentUnits !== 54291743 ||
  latest.admittedAttempts !== 1048 ||
  latest.reservedUnits !== 0 ||
  latest.halted ||
  JSON.stringify(latest) !== JSON.stringify(previous.budget)
)
  throw new Error('Invalid diagnostic carry');
const manifest = {
  kind: 'team-diagnostic-not-baseline',
  protocol: OPENAI_PROTOCOL,
  oracleRevision: TEAM_ORACLE_REVISION,
  sourcePins,
  carry: { spentUnits: 54291743, admittedAttempts: 1048 },
  bounds: { additionalUnits: 100000000, maxAttempts: 32, timeoutMs: 180000 },
  controllerHash: await sourceIdentity(path.resolve(import.meta.dir, '..'), [
    'apps/gateway/src',
    'apps/gateway/test/ptc-m1',
    'scripts/ptc-m1-team-diagnostic.ts',
    'bun.lock',
    'package.json',
    'apps/gateway/package.json',
    'patches',
  ]),
};
const marker = createArtifact(path.join(directory, '.ptc-m1-team-diagnostic-001-attempted'));
try {
  checkpoint(marker, manifest);
} finally {
  closeSync(marker);
}
const budgetFd = createArtifact(`${prefix}.budget.jsonl`),
  reportFd = createArtifact(`${prefix}.json`);
const budget = new OpenAIBudget(
  () => checkpoint(budgetFd, budget.snapshot()),
  manifest.carry,
  manifest.bounds,
);
checkpoint(budgetFd, budget.snapshot());
const abort = new AbortController();
const reader = Bun.stdin.stream().getReader();
const stop = () => {
  abort.abort();
  void reader.cancel().catch(() => {});
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
let result: Awaited<ReturnType<typeof runOpenAIFixture>> | undefined;
let failed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  let key = '';
  while (true) {
    abort.signal.throwIfAborted();
    const chunk = await reader.read();
    abort.signal.throwIfAborted();
    if (chunk.done) break;
    key += new TextDecoder().decode(chunk.value);
    if (key.length > 4096) throw new Error('Credential limit');
  }
  reader.releaseLock();
  key = key.trim();
  if (!key || /\s/.test(key)) throw new Error('Invalid credential');
  timer = setTimeout(stop, manifest.bounds.timeoutMs);
  result = await runOpenAIFixture({
    fixture: FIXTURES.find((f) => f.id === 'team-wait')!,
    condition: 'uncached',
    binary,
    endpoint: OPENAI_PROTOCOL.endpoint,
    apiKey: key,
    budget,
    signal: abort.signal,
  });
  key = '';
} catch {
  failed = true;
} finally {
  clearTimeout(timer);
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  const report = {
    ...manifest,
    completed:
      !failed &&
      !abort.signal.aborted &&
      !!result?.infrastructureValid &&
      result.allAttemptsAccounted &&
      result.childrenAccounted &&
      result.accounting?.verified === true &&
      result.budgetValid &&
      !budget.snapshot().halted &&
      budget.snapshot().reservedUnits === 0,
    success: result?.success ?? false,
    result: result ?? null,
    budget: budget.snapshot(),
  };
  try {
    checkpoint(reportFd, report);
    console.log(
      JSON.stringify({
        kind: manifest.kind,
        completed: report.completed,
        success: report.success,
        team: result?.teamEvidence,
        budget: report.budget,
      }),
    );
  } finally {
    closeSync(reportFd);
    closeSync(budgetFd);
  }
  if (!report.completed) process.exitCode = 1;
}
