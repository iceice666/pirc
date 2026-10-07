import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { LiveBudget, LIVE_MODEL } from './ptc-m1/live-budget.js';
import { startLiveProvider, type AttemptSummary } from './ptc-m1/live-provider.js';

test('malformed non-ending upstream is cancelled and billed as uncertain exactly once', async () => {
  const root = await mkdtemp('/tmp/ptc-e-');
  let cancelled!: () => void;
  const upstreamCancelled = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('event: message_start\ndata: {INVALID\n\n'),
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
  const summaries: AttemptSummary[] = [];
  const budget = new LiveBudget({ limitUsd: 100, priorUnits: 0 });
  let provider: Awaited<ReturnType<typeof startLiveProvider>> | undefined;
  try {
    provider = await startLiveProvider({
      stateDir: root,
      endpoint: upstream.url.origin,
      apiKey: 'synthetic',
      budget,
      onAttempt: (value) => summaries.push(value),
      testLoopback: true,
    });
    const result = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          socketPath: provider!.models.inference.socketPath,
          path: '/inference',
          method: 'POST',
          headers: { authorization: `Bearer ${provider!.models.inference.token}` },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve(text));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          providerName: 'evaluation',
          modelId: LIVE_MODEL,
          sessionId: 'synthetic',
          systemPrompt: '',
          messages: [],
          tools: [],
          thinking: 'medium',
        }),
      );
    });
    expect(result).toContain('"stopReason":"error"');
    await upstreamCancelled;
    expect(summaries).toHaveLength(1);
    expect(budget.snapshot()).toMatchObject({
      halted: true,
      unknownAttempts: 1,
      reservedUsdEquivalent: 8.32768,
    });
    expect(provider.close()).toBe(provider.close());
  } finally {
    const cleanup = await Promise.allSettled([provider?.close(), upstream.stop(true)]);
    expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

for (const mode of ['client-disconnect', 'provider-close'] as const)
  test(`streaming ${mode} drains sockets and preserves exactly one unknown liability`, async () => {
    const root = await mkdtemp('/tmp/ptc-e-');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: LIVE_MODEL, usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'STREAM_STARTED' } })}\n\n`,
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
    const summaries: AttemptSummary[] = [];
    const budget = new LiveBudget({ limitUsd: 100, priorUnits: 0 });
    let provider: Awaited<ReturnType<typeof startLiveProvider>> | undefined;
    try {
      provider = await startLiveProvider({
        stateDir: root,
        endpoint: upstream.url.origin,
        apiKey: 'synthetic',
        budget,
        onAttempt: (s) => summaries.push(s),
        testLoopback: true,
      });
      const transport = provider.models.inference;
      const req = request(
        {
          socketPath: transport.socketPath,
          method: 'POST',
          path: '/inference',
          headers: { authorization: `Bearer ${transport.token}` },
        },
        (res) => {
          res.on('error', () => undefined);
          let received = '';
          res.on('data', (chunk) => {
            received += chunk;
            if (received.includes('STREAM_STARTED')) entered();
          });
        },
      );
      req.on('error', () => undefined);
      req.end(
        JSON.stringify({
          providerName: 'evaluation',
          modelId: LIVE_MODEL,
          sessionId: 'synthetic',
          systemPrompt: '',
          messages: [],
          tools: [],
          thinking: 'medium',
        }),
      );
      await started;
      if (mode === 'client-disconnect') {
        req.destroy();
        await provider.waitForQuiet({ quietMs: 10, timeoutMs: 1000 });
      }
      await provider.close();
      await cancellation;
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.usage).toBeNull();
      expect(budget.snapshot()).toMatchObject({
        unknownAttempts: 1,
        reservedUsdEquivalent: 8.32768,
        halted: true,
      });
      expect(await Bun.file(transport.socketPath).exists()).toBe(false);
    } finally {
      const cleanup = await Promise.allSettled([provider?.close(), upstream.stop(true)]);
      expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);
