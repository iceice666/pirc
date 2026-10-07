import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { DisposablePair } from './ptc-m1/disposable-pair.js';
import { runOpenAIFixture } from './ptc-m1/openai-runner.js';
import { fakeResponses } from './ptc-m1/openai-fake.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import type { InitialRequest } from './ptc-m1/initial-request.js';
test.skipIf(!process.env.PTC_LINUX_NODE_BINARY)(
  'OpenAI warm same-path full-body proof and authoritative cache buckets',
  async () => {
    const pair = await DisposablePair.create();
    const fingerprints = new Set<string>();
    const proofs: Array<ReturnType<InitialRequest['snapshot']>> = [];
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const text = await req.text();
        const body = JSON.parse(text);
        expect(body.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
        const hash = createHash('sha256').update(text).digest('hex');
        const cached = fingerprints.has(hash);
        fingerprints.add(hash);
        return fakeResponses(
          { text: 'Unavailable; stopped.' },
          {
            input_tokens: 2000,
            output_tokens: 20,
            input_tokens_details: {
              cached_tokens: cached ? 1800 : 0,
              cache_write_tokens: cached ? 0 : 1800,
            },
            output_tokens_details: { reasoning_tokens: 5 },
            total_tokens: 2020,
          },
        );
      },
    });
    try {
      for (let i = 0; i < 2; i++) {
        const run = await runOpenAIFixture({
          fixture: FIXTURES.find((f) => f.id === 'permission-rejection')!,
          condition: 'warm',
          binary: process.env.PTC_LINUX_NODE_BINARY!,
          endpoint: upstream.url.origin,
          apiKey: 'synthetic',
          budget: new OpenAIBudget(),
          testLoopback: true,
          pair,
          onInitialEvidence: (value) => proofs.push(value),
        });
        expect(run.success).toBe(true);
        expect(run.allAttemptsAccounted).toBe(true);
      }
      expect(proofs[0]).not.toBeNull();
      expect(proofs[0]!.bodyHash).toBe(proofs[1]!.bodyHash);
      expect(proofs[0]!.attempt.usage?.cacheWrite).toBe(1800);
      expect(proofs[1]!.attempt.usage?.cacheRead).toBe(1800);
    } finally {
      await upstream.stop(true);
      await pair.close();
    }
  },
  60000,
);
