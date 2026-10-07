import { expect, test } from 'bun:test';
import { initialCacheEvidence, COLD_CACHE_WAIT_MS } from './ptc-m1/cache-evidence.js';
import type { AttemptSummary } from './ptc-m1/live-provider.js';
const request: AttemptSummary = {
  schemaBytes: 1,
  contextBytes: 1,
  requestBytes: 1,
  responseBytes: 1,
  durationMs: 1,
  status: 200,
  completion: 'complete',
  evidence: 'complete',
  usage: { input: 2, output: 4, cacheRead: 0, cacheWrite: 2000 },
};
test('cold requires elapsed TTL AND provider evidence, never just a fresh process', () => {
  expect(
    initialCacheEvidence('cold', request, {
      elapsedSinceLastProviderRequestMs: 0,
      identicalPrefixPrimed: false,
    }),
  ).toBe(false);
  expect(
    initialCacheEvidence('cold', request, {
      elapsedSinceLastProviderRequestMs: COLD_CACHE_WAIT_MS,
      identicalPrefixPrimed: false,
    }),
  ).toBe(true);
  expect(
    initialCacheEvidence(
      'cold',
      { ...request, usage: { ...request.usage!, cacheRead: 1 } },
      { elapsedSinceLastProviderRequestMs: COLD_CACHE_WAIT_MS, identicalPrefixPrimed: false },
    ),
  ).toBe(false);
});
test('warm requires shared prefix priming and actual hit; missing evidence cannot pass', () => {
  const warm = { ...request, usage: { ...request.usage!, cacheRead: 2000 } };
  expect(
    initialCacheEvidence('warm', warm, {
      elapsedSinceLastProviderRequestMs: 0,
      identicalPrefixPrimed: false,
    }),
  ).toBe(false);
  expect(
    initialCacheEvidence('warm', warm, {
      elapsedSinceLastProviderRequestMs: 0,
      identicalPrefixPrimed: true,
    }),
  ).toBe(true);
  expect(
    initialCacheEvidence(
      'warm',
      { ...warm, usage: null },
      { elapsedSinceLastProviderRequestMs: 0, identicalPrefixPrimed: true },
    ),
  ).toBe(false);
});
