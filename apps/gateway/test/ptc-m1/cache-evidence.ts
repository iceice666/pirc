/** Initial main-request cache evidence, separate from evolving within-trial reuse. */
import type { AttemptSummary } from './live-provider.js';
export const COLD_CACHE_WAIT_MS = 310_000;
export function initialCacheEvidence(
  condition: 'cold' | 'warm',
  firstMain: AttemptSummary | undefined,
  setup: { elapsedSinceLastProviderRequestMs: number; identicalPrefixPrimed: boolean },
): boolean {
  if (!firstMain?.usage || firstMain.completion !== 'complete' || firstMain.evidence !== 'complete')
    return false;
  if (condition === 'cold')
    return (
      Number.isFinite(setup.elapsedSinceLastProviderRequestMs) &&
      setup.elapsedSinceLastProviderRequestMs >= COLD_CACHE_WAIT_MS &&
      firstMain.usage.cacheRead === 0 &&
      firstMain.usage.cacheWrite > 0
    );
  return setup.identicalPrefixPrimed && firstMain.usage.cacheRead > 0;
}
