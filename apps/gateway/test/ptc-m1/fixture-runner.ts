/** One fixture orchestration; not a cohort scheduler and cannot certify cache readiness. */
import { mkdtemp, rm } from 'node:fs/promises';
import type { Fixture } from './fixtures.js';
import { LiveBudget } from './live-budget.js';
import { startLiveProvider, type AttemptSummary } from './live-provider.js';
import { startMeasuredAgent } from './live-driver.js';
import { startFixtureDaemon } from './daemon-fixture.js';
import { FixtureServices } from './fixture-services.js';
import { FixtureOracle } from './oracles.js';
import { TeamEvidence } from './team-evidence.js';
import type { DisposablePair } from './disposable-pair.js';
import type { InitialRequest } from './initial-request.js';
import { newMetrics, collectRequestSizes } from './metrics.js';

export async function runFixture(options: {
  fixture: Fixture;
  binary: string;
  endpoint: string;
  apiKey: string;
  budget: LiveBudget;
  testLoopback?: boolean;
  signal?: AbortSignal;
  pair?: DisposablePair;
  /** Cache fingerprint consumed in memory only; never part of the returned report. */
  onInitialEvidence?: (evidence: ReturnType<InitialRequest['snapshot']>) => void;
}) {
  options.signal?.throwIfAborted();
  const root = await mkdtemp('/tmp/ptc-fixture-');
  const attempts: AttemptSummary[] = [];
  const metrics = newMetrics();
  const oracle = new FixtureOracle(options.fixture);
  const team = options.fixture.id === 'team-wait' ? new TeamEvidence() : undefined;
  let daemon: Awaited<ReturnType<typeof startFixtureDaemon>> | undefined;
  let provider: Awaited<ReturnType<typeof startLiveProvider>> | undefined;
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
    provider = await startLiveProvider({
      stateDir: root,
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
      onFatal: fatal,
      onEvent({ value }, reply) {
        team?.observe(value);
        if (value.type === 'message_end' && value.message?.role === 'assistant')
          metrics.modelRounds++;
        if (value.type === 'auto_retry_start') metrics.transportRetries++;
        if (value.type === 'tool_execution_end' && value.isError) metrics.toolErrors++;
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
    infrastructureValid: !failed,
    success:
      !failed &&
      !!outcome?.success &&
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
    attempts,
    // Deliberate fail-closed placeholders until cohort controls and stronger proofs exist.
    cacheVerified: false,
    accounting,
    childrenAccounted: reconciled && (!team || team.summary().verified),
    allAttemptsAccounted: reconciled && metrics.missingUsage === 0 && attempts.length > 0,
  };
}
