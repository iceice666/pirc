/** Explicit, single-fixture live preflight; never a baseline or a default test. */
import { createHash } from 'node:crypto';
import { closeSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { LiveBudget } from '../apps/gateway/test/ptc-m1/live-budget.js';
import {
  startLiveProvider,
  type AttemptSummary,
} from '../apps/gateway/test/ptc-m1/live-provider.js';
import { startMeasuredAgent } from '../apps/gateway/test/ptc-m1/live-driver.js';
import { FIXTURES } from '../apps/gateway/test/ptc-m1/fixtures.js';
import { BASELINE_COMMIT, EVALUATION_PROTOCOL } from '../apps/gateway/test/ptc-m1/metrics.js';

const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    hash: { type: 'string' },
    endpoint: { type: 'string' },
    report: { type: 'string' },
    ledger: { type: 'string' },
    'prior-units': { type: 'string' },
  },
  strict: true,
});
if (
  process.platform !== 'linux' ||
  !values.binary ||
  !values.hash ||
  !values.endpoint ||
  !values.report ||
  !values.ledger ||
  !/^\d+$/.test(values['prior-units'] ?? '')
)
  throw new Error('Explicit Linux preflight configuration required');
const binaryHash = createHash('sha256')
  .update(await readFile(values.binary))
  .digest('hex');
if (
  binaryHash !== '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80' ||
  binaryHash !== values.hash
)
  throw new Error('Baseline binary hash mismatch');
const swapLines = (await readFile('/proc/swaps', 'utf8')).trim().split('\n');
const limits = await readFile('/proc/self/limits', 'utf8');
if (swapLines.length !== 1 || !/^Max core file size\s+0\s/m.test(limits))
  throw new Error('Live credentials require no swap and zero core limit');
// Maintainer authorized ONE retry, conservatively charging the entire prior unknown
// reservation. Fixed exclusive marker prevents rerun with fresh report paths.
const priorUnits = Number(values['prior-units']);
if (priorUnits !== 42354176) throw new Error('Full prior occupancy must carry forward');
const attemptMarker = createArtifact(
  path.join(path.dirname(values.binary), '.ptc-preflight-002-attempted'),
);
try {
  checkpoint(attemptMarker, { attempt: 2, priorUnits });
} finally {
  closeSync(attemptMarker);
}
// Exclusive artifacts prevent accidental overwrite/resume. Append+fsync before admission;
// an interrupted final record/reservation MUST stop human reconciliation, never reset to zero.
const ledger = createArtifact(values.ledger);
const report = createArtifact(values.report);
const root = await mkdtemp('/tmp/ptc-live-');
const attempts: AttemptSummary[] = [];
const budget = new LiveBudget({
  limitUsd: 100,
  priorUnits,
  checkpoint: () => {
    checkpoint(ledger, budget.snapshot());
  },
});
checkpoint(ledger, budget.snapshot());
let provider: Awaited<ReturnType<typeof startLiveProvider>> | undefined;
let agent: Awaited<ReturnType<typeof startMeasuredAgent>> | undefined;
let measured: Awaited<ReturnType<NonNullable<typeof agent>['prompt']>> | null = null;
let drain: { waitMs: number; observedChanges: number } | null = null;
const cancellation = new AbortController();
let failure = false;
let answer = false;
let bashCalls = 0;
let bashResults = 0;
let mainRounds = 0;
let aborted = false;
const credentialReader = Bun.stdin.stream().getReader();
const ensureActive = () => {
  if (aborted) throw new Error('Preflight cancelled');
};
const stop = () => {
  aborted = true;
  cancellation.abort();
  void credentialReader.cancel().catch(() => undefined);
  void agent?.close().catch(() => undefined);
  void provider?.close().catch(() => undefined);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  // stdin contains ONLY the credential, EOF terminated, capped. Never environment or argv.
  let secret = '';
  while (true) {
    ensureActive();
    const { done, value } = await credentialReader.read();
    ensureActive();
    if (done) break;
    secret += new TextDecoder().decode(value);
    if (secret.length > 4096) throw new Error('Credential input limit');
  }
  credentialReader.releaseLock();
  ensureActive();
  secret = secret.trim();
  if (!secret || /\s/.test(secret)) throw new Error('Credential input invalid');
  provider = await startLiveProvider({
    stateDir: root,
    endpoint: values.endpoint,
    apiKey: secret,
    budget,
    onAttempt: (value) => attempts.push(value),
  });
  secret = '';
  ensureActive();
  agent = await startMeasuredAgent({
    binary: values.binary,
    fixture: FIXTURES.find((f) => f.id === 'single-bash')!,
    models: provider.models,
    providerStateDir: root,
    onFatal: () => {
      stop();
    },
    onEvent({ value }, reply) {
      ensureActive();
      if (value.type === 'gateway_request') {
        reply({
          type: 'gateway_response',
          id: value.id,
          ok: false,
          error: {
            status: 403,
            code: 'fixture_unavailable',
            message: 'Unavailable in synthetic preflight',
          },
        });
      }
      if (
        value.type === 'sandbox_request' ||
        value.type === 'browser_request' ||
        (value.type === 'extension_ui_request' &&
          ['confirm', 'select', 'input', 'editor'].includes(value.method))
      )
        throw new Error('Unexpected preflight interaction');
      if (value.type === 'tool_execution_start' && value.toolName !== 'bash')
        throw new Error('Unexpected preflight tool');
      if (value.type === 'tool_execution_start' && value.toolName === 'bash') {
        bashCalls++;
        if (value.args?.command !== 'printf PTC_BASH_OK')
          throw new Error('Unexpected preflight command');
      }
      if (
        value.type === 'tool_execution_end' &&
        value.toolName === 'bash' &&
        !value.isError &&
        JSON.stringify(value.result).includes('PTC_BASH_OK')
      )
        bashResults++;
      if (value.type === 'message_end' && value.message?.role === 'assistant') {
        mainRounds++;
        answer =
          value.message.stopReason === 'stop' &&
          Array.isArray(value.message.content) &&
          value.message.content.some(
            (part: any) => part.type === 'text' && part.text.includes('PTC_BASH_OK'),
          );
      }
    },
  });
  ensureActive();
  measured = await agent.prompt();
  // Observation only; keep the original settled wall metric. The authorized retry
  // is one-shot: its exclusive marker is consumed and must not be reset.
  drain = await provider.waitForQuiet({
    quietMs: 1000,
    timeoutMs: 60000,
    signal: cancellation.signal,
  });
} catch {
  failure = true;
} finally {
  try {
    await agent?.close();
  } catch {
    failure = true;
  }
  try {
    await provider?.close();
  } catch {
    failure = true;
  }
  await rm(root, { recursive: true, force: true }).catch(() => {
    failure = true;
  });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  const result = {
    kind: 'preflight-not-baseline',
    fixture: 'single-bash',
    baseline: BASELINE_COMMIT,
    binaryHash,
    protocol: EVALUATION_PROTOCOL.version,
    fixtureHash: createHash('sha256')
      .update(readFileSync(new URL('../apps/gateway/test/ptc-m1/fixtures.ts', import.meta.url)))
      .digest('hex'),
    success:
      !failure &&
      !aborted &&
      !!measured &&
      answer &&
      bashCalls === 1 &&
      bashResults === 1 &&
      attempts.length > 0 &&
      attempts.every((a) => a.usage !== null) &&
      !budget.snapshot().halted &&
      budget.snapshot().reservedUnits === 0,
    measured,
    drain,
    mainRounds,
    bashCalls,
    bashResults,
    attempts,
    budget: budget.snapshot(),
  };
  checkpoint(report, result);
  closeSync(report);
  closeSync(ledger);
  console.log(
    JSON.stringify({
      kind: result.kind,
      success: result.success,
      attempts: attempts.length,
      budget: result.budget,
    }),
  );
  if (!result.success) process.exitCode = 1;
}
