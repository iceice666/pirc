import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { startOpenAIProvider, type OpenAIAttemptSummary } from './ptc-m1/openai-provider.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import { OPENAI_PROTOCOL } from './ptc-m1/openai-contract.js';
import { OpenAIWireObserver } from './ptc-m1/openai-wire.js';
import { fakeResponses } from './ptc-m1/openai-fake.js';
function wire(mode: 'normal' | 'truncated' | 'incomplete' = 'normal') {
  const response = {
    id: 'resp_synthetic',
    model: OPENAI_PROTOCOL.model,
    status: 'in_progress',
    service_tier: 'default',
  };
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', content: [] };
  const events: any[] = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item },
    {
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: 'SYNTHETIC_OK',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        ...item,
        status: 'completed',
        content: [{ type: 'output_text', text: 'SYNTHETIC_OK', annotations: [] }],
      },
    },
  ];
  if (mode !== 'truncated')
    events.push({
      type: mode === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response: {
        ...response,
        status: mode === 'incomplete' ? 'incomplete' : 'completed',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 10 },
          total_tokens: 120,
        },
      },
    });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}
function infer(socketPath: string, token: string, thinking = 'medium') {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/inference',
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(text));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(
      JSON.stringify({
        providerName: 'evaluation',
        modelId: OPENAI_PROTOCOL.model,
        sessionId: 'synthetic',
        systemPrompt: 'Exact developer text',
        messages: [{ role: 'user', content: 'fixture', timestamp: 1 }],
        tools: [],
        thinking,
      }),
    );
  });
}
test('Responses wire requires terminal usage even with DONE and accepts byte-split events', () => {
  const observer = new OpenAIWireObserver();
  for (const byte of new TextEncoder().encode(wire())) observer.push(new Uint8Array([byte]));
  expect(observer.finish()?.reasoning).toBe(10);
  expect(observer.success()).toBe(true);
  const broken = new OpenAIWireObserver();
  broken.push(new TextEncoder().encode(wire('truncated')));
  expect(broken.finish()).toBeNull();
});
for (const mode of ['normal', 'truncated', 'incomplete'] as const)
  test(`OpenAI relay uses unchanged Pi adapter and fail-closed ${mode} evidence`, async () => {
    const root = await mkdtemp('/tmp/ptc-oa-');
    let calls = 0;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        calls++;
        expect(new URL(req.url).pathname).toBe('/responses');
        expect(req.headers.get('authorization')).toBe('Bearer synthetic-key');
        expect(req.headers.get('x-ptc-request')).toBeNull();
        const body = (await req.json()) as any;
        expect(body.service_tier).toBe('default');
        expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
        expect(body.reasoning.effort).toBe('medium');
        expect(body.max_output_tokens).toBe(16384);
        return new Response(wire(mode), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const budget = new OpenAIBudget();
    const summaries: OpenAIAttemptSummary[] = [];
    let provider: Awaited<ReturnType<typeof startOpenAIProvider>> | undefined;
    try {
      provider = await startOpenAIProvider({
        stateDir: root,
        condition: 'uncached',
        endpoint: upstream.url.origin,
        apiKey: 'synthetic-key',
        budget,
        onAttempt: (s) => summaries.push(s),
        testLoopback: true,
      });
      provider.parentSession('synthetic');
      expect(JSON.stringify(provider.models)).not.toContain('synthetic-key');
      const transport = provider.models.inference;
      const result = await infer(transport.socketPath, transport.token);
      await provider.waitForQuiet({ quietMs: 10, timeoutMs: 1000 });
      expect(calls).toBe(1);
      expect(summaries).toHaveLength(1);
      if (mode === 'normal') {
        expect(result).toContain('SYNTHETIC_OK');
        expect(result).toContain('"stopReason":"stop"');
        expect(summaries[0]!.usage?.totalTokens).toBe(120);
        expect(provider.accounting().verified).toBe(true);
        expect(budget.snapshot().spentUsd).toBe(0.0004);
      } else {
        expect(result).toContain('"stopReason":"error"');
        expect(summaries[0]!.generationComplete).toBe(false);
        if (mode === 'truncated')
          expect(budget.snapshot()).toMatchObject({
            halted: true,
            unknownAttempts: 1,
            reservedUsd: 4.85576,
          });
        else expect(budget.snapshot().reservedUsd).toBe(0);
      }
    } finally {
      const cleanup = await Promise.allSettled([provider?.close(), upstream.stop(true)]);
      expect(cleanup.every((r) => r.status === 'fulfilled')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);

for (const condition of ['uncached', 'warm'] as const)
  test(`OpenAI raw cache-write evidence is authoritative in ${condition}`, async () => {
    const root = await mkdtemp('/tmp/ptc-oa-');
    const summaries: OpenAIAttemptSummary[] = [];
    const budget = new OpenAIBudget();
    let calls = 0;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        calls++;
        const body = (await req.json()) as any;
        expect(body.reasoning.effort).toBe('low');
        return fakeResponses(
          { text: 'Done' },
          {
            input_tokens: 1000,
            output_tokens: 200,
            input_tokens_details: { cached_tokens: 300, cache_write_tokens: 400 },
            output_tokens_details: { reasoning_tokens: 150 },
            total_tokens: 1200,
          },
        );
      },
    });
    let provider: Awaited<ReturnType<typeof startOpenAIProvider>> | undefined;
    try {
      provider = await startOpenAIProvider({
        stateDir: root,
        condition,
        endpoint: upstream.url.origin,
        apiKey: 'synthetic',
        budget,
        onAttempt: (s) => summaries.push(s),
        testLoopback: true,
      });
      provider.parentSession('synthetic');
      const transport = provider.models.inference;
      const result = await infer(transport.socketPath, transport.token, 'off');
      await provider.waitForQuiet({ quietMs: 10, timeoutMs: 1000 });
      expect(summaries[0]).toMatchObject({
        requestedReasoning: 'off',
        effectiveReasoning: 'low',
        usage: { input: 300, cacheWrite: 400, cacheRead: 300, output: 200 },
      });
      expect(budget.snapshot().spentUsd).toBe(0.00363);
      if (condition === 'uncached') {
        expect(result).toContain('"stopReason":"error"');
        expect(budget.snapshot().halted).toBe(true);
        expect(provider.accounting().verified).toBe(false);
        await infer(transport.socketPath, transport.token);
        expect(calls).toBe(1);
      } else {
        const end = result
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .find((event) => event.type === 'model_end');
        expect(end.message.usage).toMatchObject({ input: 700, cacheWrite: 0, cacheRead: 300 });
        expect(budget.snapshot().halted).toBe(false);
      }
    } finally {
      const cleanup = await Promise.allSettled([provider?.close(), upstream.stop(true)]);
      expect(cleanup.every((r) => r.status === 'fulfilled')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);
