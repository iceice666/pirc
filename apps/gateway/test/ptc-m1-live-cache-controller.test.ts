import { expect, test } from 'bun:test';
import { CacheController } from './ptc-m1/cache-controller.js';
import { LiveBudget } from './ptc-m1/live-budget.js';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { newMetrics } from './ptc-m1/metrics.js';
import type { runFixture } from './ptc-m1/fixture-runner.js';
import type { AttemptSummary } from './ptc-m1/live-provider.js';

function setup(mode: 'normal' | 'different' | 'failed-prime' | 'missing' | 'cleanup-failure') {
  let now = 0,
    calls = 0;
  const roots: string[] = [];
  const attempt: AttemptSummary = {
    schemaBytes: 1,
    contextBytes: 1,
    requestBytes: 1,
    responseBytes: 1,
    durationMs: 1,
    status: 200,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1000 },
    completion: 'complete',
    evidence: 'complete',
  };
  const run: typeof runFixture = async (options) => {
    calls++;
    now++;
    if (options.pair) {
      const lease = await options.pair.acquire();
      roots.push(lease.root);
      await lease.release();
      if (mode === 'cleanup-failure' && calls === 3) {
        // Preserve real cleanup, then simulate a post-completion filesystem failure.
        const close = options.pair.close.bind(options.pair);
        options.pair.close = async () => {
          await close();
          throw new Error('Synthetic cleanup failure');
        };
      }
    }
    const summary = { ...attempt, usage: { ...attempt.usage!, cacheRead: calls === 3 ? 1000 : 0 } };
    options.onInitialEvidence?.(
      mode === 'missing'
        ? null
        : {
            bodyHash: mode === 'different' && calls === 3 ? 'different' : 'same',
            attempt: summary,
          },
    );
    return {
      fixture: options.fixture.id,
      kind: options.fixture.kind,
      infrastructureValid: true,
      success: !(mode === 'failed-prime' && calls === 2),
      measurement: {
        wallMs: 1,
        startupMs: 1,
        cpuMs: 1,
        cgroupMemoryPeakBytes: 1,
        resourceStartLeadMs: 0,
        resourceEndLagMs: 0,
        memoryWindow: 'unit-start-through-post-settled-sample',
        cpuWindow: 'pre-dispatch-through-post-settled-sample',
      },
      requestFinishedAt: now,
      drain: null,
      outcome: null,
      services: null,
      authorizationProof: true,
      teamEvidence: null,
      metrics: { ...newMetrics(), requestCount: 1, modelRounds: 1 },
      attempts: [summary],
      cacheVerified: false,
      accounting: null,
      childrenAccounted: true,
      allAttemptsAccounted: true,
    };
  };
  const controller = new CacheController(
    {
      nodeBinary: '/synthetic/node',
      chatBinary: '/synthetic/chat',
      endpoint: 'https://example.invalid',
      apiKey: 'synthetic',
      budget: new LiveBudget({ limitUsd: 100, priorUnits: 0 }),
    },
    { now: () => now, run },
  );
  return {
    controller,
    roots,
    advance: () => {
      now += 310000;
    },
    calls: () => calls,
  };
}
for (const mode of ['normal', 'different', 'failed-prime', 'missing'] as const)
  test(`cache controller ${mode} cannot promote unmatched evidence`, async () => {
    const s = setup(mode);
    try {
      s.advance();
      const cold = await s.controller.execute(FIXTURES[0]!, 'cold', 'measured', 0);
      expect(cold.trial.cacheVerified).toBe(mode !== 'missing');
      expect(cold.trial.provenance).toBe('synthetic');
      await s.controller.execute(FIXTURES[0]!, 'warm', 'warmup', 0);
      if (mode === 'failed-prime' || mode === 'missing') {
        await expect(s.controller.execute(FIXTURES[0]!, 'warm', 'measured', 0)).rejects.toThrow(
          'prime',
        );
        expect(s.calls()).toBe(2);
      } else {
        const warm = await s.controller.execute(FIXTURES[0]!, 'warm', 'measured', 0);
        expect(warm.trial.cacheVerified).toBe(mode === 'normal');
        expect(s.roots[0]).toBe(s.roots[1]);
        expect(JSON.stringify(warm)).not.toContain('bodyHash');
      }
    } finally {
      await s.controller.close();
    }
  });

test('warm cleanup failure returns paid aggregate and poisons next dispatch', async () => {
  const s = setup('cleanup-failure');
  try {
    s.advance();
    await s.controller.execute(FIXTURES[0]!, 'cold', 'measured', 0);
    await s.controller.execute(FIXTURES[0]!, 'warm', 'warmup', 0);
    const measured = await s.controller.execute(FIXTURES[0]!, 'warm', 'measured', 0);
    expect(measured.infrastructureValid).toBe(false);
    expect(measured.attempts).toHaveLength(1);
    expect(measured.diagnostics.cpuWindow).toBe('pre-dispatch-through-post-settled-sample');
    expect(measured.diagnostics.resourceEndLagMs).toBe(0);
    await expect(s.controller.execute(FIXTURES[0]!, 'cold', 'measured', 1)).rejects.toThrow(
      'unavailable',
    );
    expect(s.calls()).toBe(3);
  } finally {
    await s.controller.close();
  }
});
