import { expect, test } from 'bun:test';
import {
  baselineReadiness,
  collectEvent,
  collectRequestSizes,
  newMetrics,
  type Trial,
} from './ptc-m1/metrics.js';
import { FIXTURES } from './ptc-m1/fixtures.js';

test('complete protocol matrix rejects malformed numeric evidence', () => {
  const trials: Trial[] = FIXTURES.flatMap((fixture) =>
    (['cold', 'warm'] as const).flatMap((cache) =>
      Array.from({ length: 10 }, () => ({
        fixture: fixture.id,
        kind: fixture.kind,
        cache,
        success: true,
        metrics: {
          ...newMetrics(),
          modelRounds: 1,
          requestCount: 1,
          input: 1,
          output: 1,
          totalTokens: 2,
        },
        wallMs: 1,
        cpuMs: 0,
        cgroupMemoryPeakBytes: 1,
        provenance: 'real-opus-5.5' as const,
        cacheVerified: true,
        childrenAccounted: true,
        allAttemptsAccounted: true,
        authorizationOracle: true,
        cancellationOracle: true,
      })),
    ),
  );
  expect(baselineReadiness(trials, FIXTURES)).toEqual([]);
  for (const value of [NaN, Infinity, -1, undefined]) {
    const malformed = structuredClone(trials);
    malformed[0]!.cpuMs = value as number;
    malformed[0]!.cgroupMemoryPeakBytes = value as number;
    malformed[0]!.metrics.totalTokens = value as number;
    expect(baselineReadiness(malformed, FIXTURES)).toContain('resources_missing');
    expect(baselineReadiness(malformed, FIXTURES)).toContain('usage_missing');
  }
  trials[0]!.metrics.requestCount = 1.5;
  expect(baselineReadiness(trials, FIXTURES)).toContain('usage_missing');
  trials[0]!.cache = 'invalid' as 'cold';
  expect(baselineReadiness(trials, FIXTURES)).toContain('cache_unverified');
});

test('aggregate metrics retain no event content and include failed assistant attempts', () => {
  const metrics = newMetrics();
  collectEvent(metrics, { type: 'auto_retry_start' });
  collectEvent(metrics, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: 'PRIVATE_SENTINEL',
      stopReason: 'error',
      usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19 },
    },
  });
  collectEvent(metrics, { type: 'message_end', message: { role: 'assistant' } });
  collectRequestSizes(metrics, 500, 1000);
  expect(metrics.totalTokens).toBe(19);
  expect(metrics.transportRetries).toBe(1);
  expect(metrics.modelRounds).toBe(2);
  expect(metrics.missingUsage).toBe(1);
  expect(JSON.stringify(metrics)).not.toContain('PRIVATE_SENTINEL');
  expect(() => collectRequestSizes(metrics, NaN, 1)).toThrow();
});

test('empty, synthetic and incomplete baselines cannot pass acceptance', () => {
  expect(baselineReadiness([], FIXTURES)).toContain('trial_matrix_incomplete');
  const trial: Trial = {
    fixture: 'single-bash',
    kind: 'coding',
    cache: 'cold',
    success: true,
    metrics: newMetrics(),
    wallMs: 1,
    cpuMs: null,
    cgroupMemoryPeakBytes: null,
    provenance: 'synthetic',
    cacheVerified: false,
    childrenAccounted: false,
    allAttemptsAccounted: false,
    authorizationOracle: null,
    cancellationOracle: null,
  };
  expect(baselineReadiness([trial], FIXTURES)).toEqual([
    'cache_unverified',
    'resources_missing',
    'synthetic_usage',
    'trial_matrix_incomplete',
    'usage_missing',
    'usage_scope_incomplete',
  ]);
});
