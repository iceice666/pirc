import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { LiveBudget, LIVE_MODEL } from './ptc-m1/live-budget.js';
import { startLiveProvider, WireObserver, type AttemptSummary } from './ptc-m1/live-provider.js';

const events = [
  {
    type: 'message_start',
    message: {
      model: LIVE_MODEL,
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'PRIVATE_SENTINEL' },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
];
const wire = events
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join('');

test('bounded streaming observer handles arbitrary chunk boundaries and rejects truncated frames', () => {
  const observer = new WireObserver();
  for (const byte of new TextEncoder().encode(wire)) observer.push(new Uint8Array([byte]));
  expect(observer.finish()).toEqual({ input: 10, output: 4, cacheWrite: 0, cacheRead: 20 });
  expect(JSON.stringify(observer)).not.toContain('PRIVATE_SENTINEL');
  const bad = new WireObserver();
  bad.push(new TextEncoder().encode(wire.slice(0, -2)));
  expect(bad.finish()).toBeNull();
  expect(() =>
    new WireObserver().push(new TextEncoder().encode('x'.repeat(1024 * 1024 + 1))),
  ).toThrow();
});

function infer(socketPath: string, token: string, modelId = LIVE_MODEL, sessionId = 'synthetic') {
  const body = JSON.stringify({
    providerName: 'evaluation',
    modelId,
    sessionId,
    systemPrompt: 'PRIVATE_CONTEXT',
    messages: [{ role: 'user', content: 'synthetic', timestamp: 1 }],
    tools: [],
    thinking: 'medium',
  });
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/inference',
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('Unix inference relay accounts wire usage once and keeps credentials outside public catalog', async () => {
  const root = await mkdtemp('/tmp/ptc-p-');
  let calls = 0;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      calls++;
      expect(req.headers.get('x-api-key')).toBe('synthetic-secret');
      expect(req.headers.get('x-ptc-request')).toBeNull();
      const body = (await req.json()) as any;
      expect(body.model).toBe(LIVE_MODEL);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'medium' });
      await Bun.sleep(60);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const summaries: AttemptSummary[] = [];
  const budget = new LiveBudget({ limitUsd: 100, priorUnits: 106636 });
  let provider: Awaited<ReturnType<typeof startLiveProvider>> | undefined;
  try {
    provider = await startLiveProvider({
      stateDir: root,
      endpoint: upstream.url.origin,
      apiKey: 'synthetic-secret',
      budget,
      onAttempt: (value) => summaries.push(value),
      testLoopback: true,
    });
    expect(JSON.stringify(provider.models)).not.toContain('synthetic-secret');
    expect(JSON.stringify(provider.models)).not.toContain(upstream.url.origin);
    provider.parentSession('synthetic');
    const transport = provider.models.inference;
    const started = performance.now();
    const response = infer(transport.socketPath, transport.token);
    const quiet = provider.waitForQuiet({ quietMs: 100, timeoutMs: 2000 });
    const result = await response;
    await quiet;
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    expect(result).toContain('PRIVATE_SENTINEL');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.usage).toEqual({ input: 10, output: 4, cacheWrite: 0, cacheRead: 20 });
    expect(summaries[0]!.contextBytes).toBeGreaterThan(0);
    expect(JSON.stringify(summaries)).not.toMatch(/PRIVATE|synthetic-secret/);
    expect(budget.snapshot().reservedUsdEquivalent).toBe(0);
    expect(provider.accounting()).toMatchObject({
      verified: true,
      owners: { parent: 1, child: 0, auxiliary: 0, unknown: 0 },
      attempts: 1,
    });
    await infer(transport.socketPath, transport.token, 'wrong-model');
    expect(calls).toBe(1);
  } finally {
    await Promise.allSettled([provider?.close(), upstream.stop(true)]);
    await rm(root, { recursive: true, force: true });
  }
});

test('truncated upstream usage retains liability and blocks subsequent paid requests', async () => {
  const root = await mkdtemp('/tmp/ptc-p-');
  let calls = 0;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      calls++;
      return new Response(wire.slice(0, wire.lastIndexOf('event: message_stop')), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const summaries: AttemptSummary[] = [];
  const budget = new LiveBudget({ limitUsd: 100, priorUnits: 0 });
  let provider: Awaited<ReturnType<typeof startLiveProvider>> | undefined;
  try {
    provider = await startLiveProvider({
      stateDir: root,
      endpoint: upstream.url.origin,
      apiKey: 'synthetic-secret',
      budget,
      onAttempt: (value) => summaries.push(value),
      testLoopback: true,
    });
    const { socketPath, token } = provider.models.inference;
    const result = await infer(socketPath, token);
    expect(result).toContain('"stopReason":"error"');
    expect(summaries[0]!.usage).toBeNull();
    expect(summaries[0]!.completion).toBe('invalid_evidence');
    expect(summaries[0]!.evidence).toBe('missing_stop');
    expect(budget.snapshot()).toMatchObject({ halted: true, reservedUsdEquivalent: 8.32768 });
    await infer(socketPath, token);
    expect(calls).toBe(1);
  } finally {
    await Promise.allSettled([provider?.close(), upstream.stop(true)]);
    await rm(root, { recursive: true, force: true });
  }
});

for (const observerFailure of ['none', 'attempt', 'response'] as const)
  test(`concurrent owner accounting with ${observerFailure} observer failure`, async () => {
    const root = await mkdtemp('/tmp/ptc-con-');
    let upstreamCalls = 0;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        expect(req.headers.get('x-ptc-request')).toBeNull();
        const index = ++upstreamCalls;
        await Bun.sleep(index === 1 ? 80 : index === 2 ? 40 : 10);
        return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const summaries: AttemptSummary[] = [];
    let observations = 0;
    let responses = 0;
    const budget = new LiveBudget({ limitUsd: 100, priorUnits: 0 });
    let provider: Awaited<ReturnType<typeof startLiveProvider>> | undefined;
    try {
      provider = await startLiveProvider({
        stateDir: root,
        endpoint: upstream.url.origin,
        apiKey: 'synthetic',
        budget,
        testLoopback: true,
        onAttempt(summary) {
          if (++observations === 2 && observerFailure === 'attempt')
            throw new Error('Synthetic observer failure');
          summaries.push(summary);
        },
        onResponse() {
          if (++responses === 2 && observerFailure === 'response')
            throw new Error('Synthetic response observer failure');
        },
      });
      provider.parentSession('parent');
      provider.childSession('child');
      const transport = provider.models.inference;
      await Promise.all(
        ['parent', 'child', 'child-memory'].map((session) =>
          infer(transport.socketPath, transport.token, LIVE_MODEL, session),
        ),
      );
      await provider.waitForQuiet({ quietMs: 20, timeoutMs: 1000 });
      const ledger = provider.accounting();
      expect(ledger.owners).toEqual({ parent: 1, child: 1, auxiliary: 1, unknown: 0 });
      expect(ledger.attempts).toBe(upstreamCalls);
      expect(ledger.completeAttempts).toBe(3);
      expect(ledger.pending).toBe(0);
      expect(budget.snapshot()).toMatchObject({
        admittedAttempts: 3,
        reservedUnits: 0,
        unknownAttempts: 0,
      });
      expect(ledger.verified).toBe(observerFailure === 'none');
      expect(summaries.length).toBe(observerFailure === 'attempt' ? 2 : 3);
      if (observerFailure === 'none') {
        await infer(transport.socketPath, transport.token, LIVE_MODEL, 'unknown-owner');
        await provider.waitForQuiet({ quietMs: 10, timeoutMs: 1000 });
        expect(provider.accounting().verified).toBe(false);
        expect(provider.accounting().owners.unknown).toBe(1);
      }
    } finally {
      const cleanup = await Promise.allSettled([provider?.close(), upstream.stop(true)]);
      expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 5000);
