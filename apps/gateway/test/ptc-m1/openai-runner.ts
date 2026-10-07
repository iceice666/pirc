/** One fixture orchestration; not a cohort scheduler and cannot certify cache readiness. */
import { mkdtemp, rm } from 'node:fs/promises';
import type { Fixture } from './fixtures.js';
import { OpenAIBudget } from './openai-budget.js';
import type { OpenAICondition } from './openai-cache.js';
import { startOpenAIProvider, type OpenAIAttemptSummary } from './openai-provider.js';
import { startMeasuredAgent } from './live-driver.js';
import { startFixtureDaemon } from './daemon-fixture.js';
import { FixtureServices } from './fixture-services.js';
import { FixtureOracle } from './oracles.js';
import { TeamEvidence } from './team-evidence.js';
import type { DisposablePair } from './disposable-pair.js';
import type { InitialRequest } from './initial-request.js';
import { newMetrics, collectRequestSizes } from './metrics.js';
import { PtcStats } from './ptc-surface.js';

export async function runOpenAIFixture(options: {
  fixture: Fixture;
  condition: OpenAICondition;
  binary: string;
  endpoint: string;
  apiKey: string;
  budget: OpenAIBudget;
  testLoopback?: boolean;
  signal?: AbortSignal;
  pair?: DisposablePair;
  /** Feature settings for the measured agent's disposable config. */
  features?: Record<string, unknown>;
  trialDeadlineMs?: number;
  /** Cache fingerprint consumed in memory only; never part of the returned report. */
  onInitialEvidence?: (evidence: ReturnType<InitialRequest['snapshot']>) => void;
}) {
  options.signal?.throwIfAborted();
  const root = await mkdtemp('/tmp/ptc-fixture-');
  const attempts: OpenAIAttemptSummary[] = [];
  const metrics = newMetrics();
  let reasoningTokens = 0;
  const oracle = new FixtureOracle(options.fixture);
  const team = options.fixture.id === 'team-wait' ? new TeamEvidence() : undefined;
  const ptc = new PtcStats();
  let daemon: Awaited<ReturnType<typeof startFixtureDaemon>> | undefined;
  let provider: Awaited<ReturnType<typeof startOpenAIProvider>> | undefined;
  let agent: Awaited<ReturnType<typeof startMeasuredAgent>> | undefined;
  let services: FixtureServices | undefined;
  let failed = false;
  let authorizationProof = false;
  let measurement: Awaited<ReturnType<NonNullable<typeof agent>['prompt']>> | null = null;
  let outcome: Awaited<ReturnType<FixtureOracle['result']>> | null = null;
  let drain: { waitMs: number; observedChanges: number } | null = null;
  const fatal = () => {
    failed = true;
    void provider?.close().catch(() => undefined);
    void agent?.close().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', fatal, { once: true });
  try {
    options.signal?.throwIfAborted();
    daemon = await startFixtureDaemon(options.fixture.kind, root);
    authorizationProof = await daemon.authorizationProof();
    if (!authorizationProof) throw new Error('Fixture authorization preflight failed');
    options.signal?.throwIfAborted();
    provider = await startOpenAIProvider({
      stateDir: root,
      condition: options.condition,
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      budget: options.budget,
      ...(options.testLoopback ? { testLoopback: true } : {}),
      onRequest: (request) => {
        const child = team?.request(request);
        if (child) provider?.childSession(child);
      },
      onResponse: (request, response) => team?.response(request, response),
      onAttempt(summary) {
        attempts.push(summary);
        collectRequestSizes(metrics, summary.schemaBytes, summary.contextBytes);
        if (!summary.usage) metrics.missingUsage++;
        else {
          const { input, output, cacheRead, cacheWrite } = summary.usage;
          reasoningTokens += summary.usage.reasoning;
          metrics.input += input;
          metrics.output += output;
          metrics.cacheRead += cacheRead;
          metrics.cacheWrite += cacheWrite;
          metrics.totalTokens += input + output + cacheRead + cacheWrite;
        }
      },
    });
    services = new FixtureServices(
      options.fixture,
      oracle,
      daemon,
      async () => {
        if (!agent) throw new Error('Abort before agent startup');
        return agent.send({ type: 'abort' });
      },
      fatal,
    );
    options.signal?.throwIfAborted();
    agent = await startMeasuredAgent({
      binary: options.binary,
      fixture: options.fixture,
      models: provider.models,
      providerStateDir: root,
      ...(options.pair ? { pair: options.pair } : {}),
      ...(options.features ? { features: options.features } : {}),
      ...(options.trialDeadlineMs ? { trialDeadlineMs: options.trialDeadlineMs } : {}),
      onFatal: fatal,
      onEvent({ value }, reply) {
        team?.observe(value);
        if (value.type === 'message_end' && value.message?.role === 'assistant')
          metrics.modelRounds++;
        if (value.type === 'auto_retry_start') metrics.transportRetries++;
        if (value.type === 'tool_execution_end' && value.isError) metrics.toolErrors++;
        if (value.type === 'tool_execution_end' && value.toolName === 'ptc_docs') {
          metrics.docsCalls++;
          metrics.docsBytes += Buffer.byteLength(JSON.stringify(value.result ?? null));
        }
        ptc.observe(value);
        services!.handle(value, reply);
      },
    });
    team?.parentSession(agent.sessionId);
    provider.parentSession(agent.sessionId);
    provider.armInitial(agent.sessionId, options.fixture.prompt);
    options.signal?.throwIfAborted();
    measurement = await agent.prompt();
    await services.drain();
    drain = await provider.waitForQuiet({
      quietMs: 1000,
      timeoutMs: 60000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.fixture.id === 'schedule') oracle.scheduleEnforcement(daemon.scheduleEnforcement());
    outcome = await oracle.result(agent.workspace, team?.summary().verified ?? false);
  } catch {
    failed = true;
  } finally {
    // Keep provider alive through agent shutdown: shutdown can itself issue billable work.
    try {
      await agent?.close();
    } catch {
      failed = true;
    }
    try {
      await services?.close();
    } catch {
      failed = true;
    }
    try {
      await provider?.close();
    } catch {
      failed = true;
    }
    try {
      await daemon?.close();
    } catch {
      failed = true;
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  options.signal?.removeEventListener('abort', fatal);
  try {
    options.onInitialEvidence?.(provider?.initialEvidence() ?? null);
  } catch {
    failed = true;
  }
  const accounting = provider?.accounting() ?? null;
  const reconciled =
    !!accounting?.verified &&
    accounting.attempts === attempts.length &&
    attempts.length === metrics.requestCount &&
    metrics.missingUsage === 0;
  return {
    fixture: options.fixture.id,
    kind: options.fixture.kind,
    condition: options.condition,
    infrastructureValid: !failed,
    budgetValid: !options.budget.snapshot().halted && options.budget.snapshot().reservedUnits === 0,
    budget: options.budget.snapshot(),
    success:
      !failed &&
      !!outcome?.success &&
      // A trial stopped at its deadline is a failed attempt (public-benchmark exercises).
      !(measurement as { deadlineExceeded?: boolean } | null)?.deadlineExceeded &&
      (!team || team.summary().verified) &&
      reconciled &&
      !!services?.summary().serviceValid &&
      metrics.missingUsage === 0 &&
      attempts.length > 0 &&
      !options.budget.snapshot().halted &&
      options.budget.snapshot().reservedUnits === 0,
    measurement,
    requestFinishedAt: provider?.lastRequestFinishedAt() ?? Date.now(),
    drain,
    outcome,
    services: services?.summary() ?? null,
    authorizationProof,
    teamEvidence: team?.summary() ?? null,
    metrics,
    // Fixed counts of the PTC surface (all zero for a direct-call binary; absent in M1 rows).
    ...({ ptc: ptc.summary() } as { ptc?: ReturnType<PtcStats['summary']> }),
    reasoningTokens,
    attempts,
    // Deliberate fail-closed placeholders until cohort controls and stronger proofs exist.
    cacheVerified:
      options.condition === 'uncached' &&
      attempts.length > 0 &&
      attempts.every(
        (a) => a.usage !== null && a.usage.cacheRead === 0 && a.usage.cacheWrite === 0,
      ),
    accounting,
    // Usage/ownership completeness is independent of helper task or wait success.
    childrenAccounted: reconciled,
    allAttemptsAccounted: reconciled && metrics.missingUsage === 0 && attempts.length > 0,
  };
}
