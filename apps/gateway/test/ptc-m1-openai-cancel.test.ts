import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { startOpenAIProvider, type OpenAIAttemptSummary } from './ptc-m1/openai-provider.js';
import { OPENAI_PROTOCOL } from './ptc-m1/openai-contract.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import { fakeResponses } from './ptc-m1/openai-fake.js';
for (const mode of ['client', 'provider'] as const)
  test(`Responses active stream cancellation by ${mode} retains one liability`, async () => {
    const root = await mkdtemp('/tmp/ptc-oac-');
    let started!: () => void, cancelled!: () => void;
    const start = new Promise<void>((r) => (started = r)),
      cancel = new Promise<void>((r) => (cancelled = r));
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(c) {
              const events = [
                { type: 'response.created', response: { model: OPENAI_PROTOCOL.model } },
                {
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: { id: 'msg_test', type: 'message', role: 'assistant', content: [] },
                },
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
                  delta: 'STREAM_STARTED',
                },
              ];
              c.enqueue(
                new TextEncoder().encode(
                  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
                ),
              );
            },
            cancel() {
              cancelled();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const budget = new OpenAIBudget();
    const attempts: OpenAIAttemptSummary[] = [];
    let provider: Awaited<ReturnType<typeof startOpenAIProvider>> | undefined;
    try {
      provider = await startOpenAIProvider({
        stateDir: root,
        condition: 'uncached',
        endpoint: upstream.url.origin,
        apiKey: 'synthetic',
        budget,
        onAttempt: (a) => attempts.push(a),
        testLoopback: true,
        // An upstream that never finishes: the relay gives up reading it after this long.
        drainMs: 200,
      });
      const transport = provider.models.inference;
      const req = request(
        {
          socketPath: transport.socketPath,
          path: '/inference',
          method: 'POST',
          headers: { authorization: `Bearer ${transport.token}` },
        },
        (res) => {
          let text = '';
          res.on('error', () => {});
          res.on('data', (chunk) => {
            text += chunk;
            if (text.includes('STREAM_STARTED')) started();
          });
        },
      );
      req.on('error', () => {});
      req.end(
        JSON.stringify({
          providerName: 'evaluation',
          modelId: OPENAI_PROTOCOL.model,
          sessionId: 'synthetic',
          systemPrompt: 'synthetic developer',
          messages: [],
          tools: [],
          thinking: 'medium',
        }),
      );
      await start;
      if (mode === 'client') {
        req.destroy();
        await provider.waitForQuiet({ quietMs: 10, timeoutMs: 1000 });
      }
      await provider.close();
      await cancel;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.usage).toBeNull();
      expect(budget.snapshot()).toMatchObject({
        halted: true,
        unknownAttempts: 1,
        reservedUsd: 4.85576,
      });
      expect(await Bun.file(transport.socketPath).exists()).toBe(false);
    } finally {
      const results = await Promise.allSettled([provider?.close(), upstream.stop(true)]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);

test('a client that goes away mid-stream leaves the rest to be read for its usage', async () => {
  const root = await mkdtemp('/tmp/ptc-oac-');
  let started!: () => void;
  const start = new Promise<void>((r) => (started = r));
  const full = await fakeResponses({ text: 'STREAM_STARTED and the rest' }).text();
  const split = full.indexOf('data: {"type":"response.output_item.done"');
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode(full.slice(0, split)));
            // The rest arrives only after the client has gone away.
            await Bun.sleep(300);
            c.enqueue(new TextEncoder().encode(full.slice(split)));
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const budget = new OpenAIBudget();
  const attempts: OpenAIAttemptSummary[] = [];
  let provider: Awaited<ReturnType<typeof startOpenAIProvider>> | undefined;
  try {
    provider = await startOpenAIProvider({
      stateDir: root,
      condition: 'uncached',
      endpoint: upstream.url.origin,
      apiKey: 'synthetic',
      budget,
      onAttempt: (a) => attempts.push(a),
      testLoopback: true,
      drainMs: 5000,
    });
    const transport = provider.models.inference;
    const req = request(
      {
        socketPath: transport.socketPath,
        path: '/inference',
        method: 'POST',
        headers: { authorization: `Bearer ${transport.token}` },
      },
      (res) => {
        let text = '';
        res.on('error', () => {});
        res.on('data', (chunk) => {
          text += chunk;
          if (text.includes('STREAM_STARTED')) started();
        });
      },
    );
    req.on('error', () => {});
    req.end(
      JSON.stringify({
        providerName: 'evaluation',
        modelId: OPENAI_PROTOCOL.model,
        sessionId: 'synthetic',
        systemPrompt: 'synthetic developer',
        messages: [],
        tools: [],
        thinking: 'medium',
      }),
    );
    await start;
    req.destroy();
    // Closing waits for the drain; the attempt ends with its real usage, not a liability.
    await provider.close();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      completion: 'complete',
      generationComplete: true,
      clientCancelled: true,
    });
    expect(attempts[0]!.usage?.totalTokens).toBe(120);
    expect(budget.snapshot()).toMatchObject({
      halted: false,
      unknownAttempts: 0,
      reservedUnits: 0,
    });
    expect(budget.snapshot().spentUnits).toBeGreaterThan(0);
  } finally {
    const results = await Promise.allSettled([provider?.close(), upstream.stop(true)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
