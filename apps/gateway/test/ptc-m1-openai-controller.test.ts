import { expect, test } from 'bun:test';
import { OpenAIController } from './ptc-m1/openai-controller.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { newMetrics } from './ptc-m1/metrics.js';
import type { runOpenAIFixture } from './ptc-m1/openai-runner.js';
import type { OpenAIAttemptSummary } from './ptc-m1/openai-provider.js';
for (const mode of [
  'match',
  'mismatch',
  'missing',
  'failed-prime',
  'failed-prime-recorded',
  'no-hit',
] as const)
  test(`OpenAI controller ${mode} explicit pair evidence`, async () => {
    let calls = 0;
    const roots: string[] = [];
    const budget = new OpenAIBudget();
    const run: typeof runOpenAIFixture = async (options) => {
      calls++;
      if (options.pair) {
        const lease = await options.pair.acquire();
        roots.push(lease.root);
        await lease.release();
      }
      const attempt: OpenAIAttemptSummary = {
        schemaBytes: 1,
        contextBytes: 1,
        requestBytes: 1,
        responseBytes: 1,
        durationMs: 1,
        status: 200,
        usage: {
          input: 0,
          output: 1,
          cacheRead: calls === 2 && mode !== 'no-hit' ? 1000 : 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: calls === 2 && mode !== 'no-hit' ? 1001 : 1,
        },
        completion: 'complete',
        evidence: 'complete',
        condition: 'warm',
        generationComplete: true,
        cacheConditionValid: true,
        requestedReasoning: 'medium',
        effectiveReasoning: 'medium',
        outputCap: 16384,
      };
      options.onInitialEvidence?.(
        mode === 'missing'
          ? null
          : { bodyHash: mode === 'mismatch' && calls === 2 ? 'other' : 'same', attempt },
      );
      return {
        fixture: options.fixture.id,
        kind: options.fixture.kind,
        condition: options.condition,
        infrastructureValid: true,
        budgetValid: true,
        budget: budget.snapshot(),
        success: !(mode.startsWith('failed-prime') && calls === 1),
        measurement: null,
        requestFinishedAt: 1,
        drain: null,
        outcome: null,
        services: null,
        authorizationProof: true,
        teamEvidence: null,
        metrics: newMetrics(),
        reasoningTokens: 0,
        attempts: [attempt],
        cacheVerified: false,
        accounting: null,
        childrenAccounted: true,
        allAttemptsAccounted: true,
      };
    };
    const c = new OpenAIController(
      {
        nodeBinary: '/synthetic/node',
        chatBinary: '/synthetic/chat',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'synthetic',
        budget,
        signal: new AbortController().signal,
        ...(mode === 'failed-prime-recorded' ? { requirePrimeSuccess: false } : {}),
      },
      { run },
    );
    try {
      await c.execute(FIXTURES[0]!, 'prime', 0);
      if (mode === 'failed-prime' || mode === 'missing') {
        await expect(c.execute(FIXTURES[0]!, 'warm', 0)).rejects.toThrow('prime');
        expect(calls).toBe(1);
      } else {
        const r = await c.execute(FIXTURES[0]!, 'warm', 0);
        // A recorded failed-task prime still warms; validity comes from body equality + hit.
        expect(r.cacheVerified).toBe(mode === 'match' || mode === 'failed-prime-recorded');
        expect(r.run.success).toBe(true);
        expect(roots[0]).toBe(roots[1]);
        expect(r.provenance).toBe('synthetic');
        expect(JSON.stringify(r)).not.toContain('bodyHash');
      }
    } finally {
      await c.close();
    }
  });
