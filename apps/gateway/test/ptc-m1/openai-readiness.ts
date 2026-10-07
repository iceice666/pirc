/** OpenAI-specific acceptance; subset/fake tests cannot certify the approved full matrix. */
import { FIXTURES } from './fixtures.js';
import { newMetrics } from './metrics.js';
import { OPENAI_PROTOCOL } from './openai-contract.js';
import type { OpenAICohortResult } from './openai-cohort.js';
/**
 * Per-trial authorization enforcement, NOT task compliance: wording or denied alternate-channel
 * attempts stay task failures and are compared as success rates in M4. This is a recorded
 * post-data protocol amendment (plans/ptc-m1-openai.md), not a restoration: the earlier Opus
 * controller also filled `authorizationOracle` from task success. M4 must judge baseline and
 * PTC rows with this same function, and PTC rows must carry explicit evidence.
 * Explicit oracle evidence is used when recorded; rows recorded before it existed use a
 * conservative derivation from stored aggregates that never upgrades unverifiable rows.
 */
export function authorizationEnforced(run: OpenAICohortResult['run']): boolean {
  if (!run.authorizationProof) return false;
  const explicit = (run.outcome as { authorizationEnforced?: boolean | null } | null)
    ?.authorizationEnforced;
  if (typeof explicit === 'boolean') return explicit;
  if (!run.outcome) return false; // No oracle result: unverifiable.
  // Every task oracle includes its enforcement condition.
  if (run.success && run.outcome.success) return true;
  const noToolExecuted = run.metrics.modelRounds === 1; // A tool call forces a second round.
  switch (run.fixture) {
    case 'permission-rejection': {
      // Disabled web_search can only execute through gateway web.search; none was requested.
      const unexpected = (run.services as { unexpected?: { gateway: number } } | null)?.unexpected;
      return noToolExecuted || unexpected?.gateway === 0;
    }
    case 'chat-permission':
      return noToolExecuted;
    case 'schedule':
      return noToolExecuted || run.outcome?.schedulePending === true;
    default:
      return false;
  }
}
export function openAIReadiness(rows: readonly OpenAICohortResult[]): string[] {
  const missing = new Set<string>();
  const nonnegative = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  for (const fixture of FIXTURES)
    for (const condition of OPENAI_PROTOCOL.conditions)
      if (
        rows.filter(
          (row) =>
            row.run.fixture === fixture.id &&
            row.run.kind === fixture.kind &&
            row.condition === condition,
        ).length !== OPENAI_PROTOCOL.trialsPerCondition
      )
        missing.add('matrix_incomplete');
  for (const row of rows) {
    const run = row.run;
    if (!FIXTURES.some((f) => f.id === run.fixture && f.kind === run.kind))
      missing.add('unknown_fixture');
    if (row.provenance !== 'real-openai') missing.add('synthetic_usage');
    if (!row.infrastructureValid || !run.infrastructureValid) missing.add('lifecycle_invalid');
    if (!run.budgetValid || run.budget.halted || run.budget.reservedUnits !== 0)
      missing.add('budget_invalid');
    if (!row.cacheVerified) missing.add('cache_unverified');
    if (
      !run.allAttemptsAccounted ||
      !run.childrenAccounted ||
      !run.accounting?.verified ||
      run.accounting.attempts !== run.attempts.length ||
      run.metrics.requestCount !== run.attempts.length
    )
      missing.add('accounting_incomplete');
    if (
      Object.keys(newMetrics()).some(
        (key) =>
          !Number.isSafeInteger(run.metrics[key as keyof typeof run.metrics]) ||
          run.metrics[key as keyof typeof run.metrics] < 0,
      ) ||
      run.metrics.missingUsage !== 0 ||
      run.metrics.requestCount <= 0 ||
      run.metrics.modelRounds <= 0 ||
      run.metrics.totalTokens !==
        run.metrics.input + run.metrics.output + run.metrics.cacheRead + run.metrics.cacheWrite ||
      !Number.isSafeInteger(run.reasoningTokens) ||
      run.reasoningTokens < 0 ||
      run.reasoningTokens > run.metrics.output
    )
      missing.add('metrics_invalid');
    const m = run.measurement;
    if (
      !m ||
      !nonnegative(m.cpuMs) ||
      !nonnegative(m.cgroupMemoryPeakBytes) ||
      m.cgroupMemoryPeakBytes <= 0 ||
      !nonnegative(m.wallMs) ||
      m.wallMs <= 0 ||
      !nonnegative(m.startupMs) ||
      !nonnegative(m.resourceStartLeadMs) ||
      !nonnegative(m.resourceEndLagMs)
    )
      missing.add('measurement_missing');
    if (
      run.attempts.length === 0 ||
      run.attempts.some(
        (a) =>
          !a.usage ||
          a.completion !== 'complete' ||
          !a.cacheConditionValid ||
          !a.generationComplete,
      )
    )
      missing.add('usage_missing');
    if (
      ['approval-denial', 'permission-rejection', 'chat-permission', 'schedule'].includes(
        run.fixture,
      ) &&
      !authorizationEnforced(run)
    )
      missing.add('authorization_unverified');
    if (run.fixture === 'cancel-wait' && (!run.outcome?.cancellationObserved || !run.success))
      missing.add('cancellation_unverified');
  }
  return [...missing].sort();
}
