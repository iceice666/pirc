/** Test-only trusted sidecar. The measured agent receives only a Unix inference socket. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestLedger } from './request-ledger.js';
import { InitialRequest } from './initial-request.js';
import type { InferenceRequest } from '../../src/inference-wire.js';
import type { AssistantMessage } from '../../src/agent/messages.js';
import { ProviderActivity } from './activity.js';
import { startAdmissionProxy } from './inference-admission.js';
import { GatewayInference } from '../../src/backends/inference.js';
import { streamPi } from '../../src/backends/pi-adapter.js';
import { startNodeInference } from '../../src/node/inference.js';
import { publicModels, type ModelsConfig } from '../../src/models.js';
import { OPENAI_PROTOCOL, type OpenAIUsage } from './openai-contract.js';
import { OpenAIBudget } from './openai-budget.js';
import { OpenAIWireObserver } from './openai-wire.js';
import { openAIControlledBody, type OpenAICondition } from './openai-cache.js';
import type { AttemptSummary } from './live-provider.js';
export interface OpenAIAttemptSummary extends AttemptSummary {
  usage: OpenAIUsage | null;
  condition: OpenAICondition;
  generationComplete: boolean;
  cacheConditionValid: boolean;
  requestedReasoning: string;
  effectiveReasoning: string;
  outputCap: number;
  /**
   * The client stopped reading before the response ended (e.g. its agent exited); the relay
   * read the rest of the upstream stream for its usage (round 3 amendment). Diagnostic only.
   */
  clientCancelled?: boolean;
}

/** Full-size admission is intentionally conservative, including multimodal tokenization. */
export async function startOpenAIProvider(options: {
  stateDir: string;
  condition: OpenAICondition;
  endpoint: string;
  apiKey: string;
  budget: OpenAIBudget;
  onAttempt: (summary: OpenAIAttemptSummary) => void;
  /** Live in-memory observations only; callbacks must reduce data, never persist it. */
  onRequest?: (request: InferenceRequest) => void;
  onResponse?: (request: InferenceRequest, response: AssistantMessage) => void;
  /** Offline tests only; a production caller must leave this false. */
  testLoopback?: boolean;
  /**
   * How long the relay keeps reading an upstream response after the client went away, for its
   * usage, before giving up (then the attempt stays uncertain, as before). Round 3 amendment.
   */
  drainMs?: number;
}) {
  const drainMs = options.drainMs ?? 60_000;
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== 'https:' &&
      !(options.testLoopback && endpoint.hostname === '127.0.0.1' && endpoint.protocol === 'http:'))
  )
    throw new Error('Invalid evaluation endpoint');
  if (!options.testLoopback && endpoint.href.replace(/\/$/, '') !== OPENAI_PROTOCOL.endpoint)
    throw new Error('Only direct OpenAI Platform permitted');
  const target = `${endpoint.href.replace(/\/$/, '')}/responses`;
  const relayToken = randomBytes(32).toString('hex');
  const activity = new ProviderActivity();
  const ledger = new RequestLedger();
  const initial = new InitialRequest();
  let lastRequestFinishedAt = Date.now();
  const requestContext = new AsyncLocalStorage<string>();
  const correlations = new Map<string, string>();
  const requestedReasoning = new Map<string, string>();
  const active = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  /** Attempts whose client went away, still being read for usage. */
  const draining = new Set<Promise<void>>();
  let closed = false;
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(request) {
      const actual = Buffer.from(request.headers.get('authorization') ?? '');
      const expected = Buffer.from(`Bearer ${relayToken}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        return new Response(null, { status: 403 });
      if (closed || request.method !== 'POST' || new URL(request.url).pathname !== '/v1/responses')
        return new Response(null, { status: 404 });
      const origin = correlations.get(request.headers.get('x-ptc-request') ?? '');
      if (!origin) return new Response(null, { status: 403 });
      const finishActivity = activity.begin();
      let streaming = false;
      try {
        let body: string;
        let parsed: Record<string, any>;
        try {
          body = await request.text();
          parsed = openAIControlledBody(JSON.parse(body), options.condition);
          body = JSON.stringify(parsed);
        } catch {
          return new Response(null, { status: 400 });
        }
        let reservation: number;
        try {
          reservation = options.budget.reserve();
        } catch {
          ledger.deny(origin);
          return new Response(null, { status: 429 });
        }
        const started = performance.now();
        const summary: OpenAIAttemptSummary = {
          schemaBytes: Buffer.byteLength(JSON.stringify(parsed.tools ?? [])),
          contextBytes: Buffer.byteLength(
            JSON.stringify({ instructions: parsed.instructions ?? null, input: parsed.input }),
          ),
          requestBytes: Buffer.byteLength(body),
          responseBytes: 0,
          durationMs: 0,
          status: null,
          usage: null,
          completion: 'pending',
          evidence: 'not_observed',
          condition: options.condition,
          generationComplete: false,
          cacheConditionValid: false,
          requestedReasoning: requestedReasoning.get(origin) ?? 'unknown',
          effectiveReasoning: parsed.reasoning?.effort ?? 'unknown',
          outputCap: parsed.max_output_tokens,
        };
        const abort = new AbortController();
        active.add(abort);
        // A client that goes away no longer cancels the upstream request: the relay keeps
        // reading it (bounded by drainMs) so its usage is known (round 3 amendment).
        let reader:
          | {
              read(): Promise<{ done: boolean; value?: Uint8Array }>;
              cancel(): Promise<void>;
            }
          | undefined;
        let observer: OpenAIWireObserver | undefined;
        let clientGone = false;
        let drainStarted = false;
        let pullRead: Promise<unknown> | null = null;
        let upstreamDone = false;
        const onAbort = () => startDrain();
        request.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => abort.abort(), 10 * 60_000);
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        pending.add(done);
        let finished = false;
        const complete = (usage: OpenAIUsage | null, bytes: number) => {
          if (finished) return;
          finished = true;
          summary.usage = usage;
          summary.responseBytes = bytes;
          summary.durationMs = performance.now() - started;
          try {
            if (usage) {
              options.budget.settle(reservation, usage);
              summary.cacheConditionValid =
                options.condition !== 'uncached' ||
                (usage.cacheRead === 0 && usage.cacheWrite === 0);
              if (!summary.cacheConditionValid) {
                ledger.invalidate();
                options.budget.halt();
              }
            } else options.budget.uncertain(reservation);
          } finally {
            clearTimeout(timer);
            request.signal.removeEventListener('abort', onAbort);
            active.delete(abort);
            pending.delete(done);
            finish();
            finishActivity();
            lastRequestFinishedAt = Date.now();
            initial.complete(origin, summary);
            ledger.attempt(origin, usage !== null && summary.completion === 'complete');
            try {
              options.onAttempt(summary);
            } catch {
              ledger.invalidate();
              throw new Error('Evaluation attempt observer failed');
            }
          }
        };
        /** Final usage from a fully read upstream stream. */
        const finalize = () => {
          const usage = observer!.finish();
          summary.evidence = observer!.status();
          summary.completion = usage ? 'complete' : 'invalid_evidence';
          summary.generationComplete = observer!.success();
          complete(usage, observer!.responseBytes);
          return usage;
        };
        const drain = async () => {
          try {
            await pullRead?.catch(() => undefined);
            while (!upstreamDone) {
              const next = await reader!.read();
              if (next.done) upstreamDone = true;
              else observer!.push(next.value!);
            }
            summary.clientCancelled = true;
            finalize();
          } catch {
            if (summary.completion === 'pending') summary.completion = 'cancelled';
            summary.evidence = observer!.status();
            abort.abort();
            await reader!.cancel().catch(() => undefined);
            complete(null, observer!.responseBytes);
          }
        };
        let drainDone: Promise<void> | undefined;
        function startDrain() {
          clientGone = true;
          if (drainStarted || finished) return;
          drainStarted = true;
          const deadline = setTimeout(() => abort.abort(), drainMs);
          const run = (async () => {
            // Before the response arrives, the fetch below starts the drain itself.
            if (reader) await drain();
            else await done;
          })().finally(() => clearTimeout(deadline));
          drainDone = run;
          draining.add(run);
          void run.catch(() => undefined).finally(() => draining.delete(run));
        }
        if (request.signal.aborted) startDrain();
        try {
          initial.dispatch(origin, body);
          const response = await fetch(target, {
            method: 'POST',
            redirect: 'error',
            signal: abort.signal,
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              authorization: `Bearer ${options.apiKey}`,
            },
            body,
          });
          summary.status = response.status;
          if (
            !response.ok ||
            !response.body ||
            !response.headers.get('content-type')?.includes('text/event-stream')
          ) {
            await response.body?.cancel();
            summary.completion = 'http_error';
            complete(null, 0);
            return new Response(null, { status: 502 });
          }
          reader = response.body.getReader();
          observer = new OpenAIWireObserver();
          if (clientGone) {
            // The client left while the request was in flight: read it for usage only.
            await drain();
            return new Response(null, { status: 499 });
          }
          const upstream = reader!;
          const wire = observer;
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const read = upstream.read();
                pullRead = read;
                const next = await read;
                pullRead = null;
                if (drainStarted) {
                  // The client went away mid-read: the drain owns the rest of the stream.
                  if (next.done) upstreamDone = true;
                  else wire.push(next.value!);
                  controller.error(new Error('Client went away'));
                  return;
                }
                if (next.done) {
                  upstreamDone = true;
                  const usage = finalize();
                  if (!usage || !summary.generationComplete || !summary.cacheConditionValid)
                    throw new Error('Incomplete Responses evidence');
                  controller.close();
                } else {
                  wire.push(next.value!);
                  controller.enqueue(next.value!);
                }
              } catch {
                pullRead = null;
                if (drainStarted) return;
                if (summary.completion === 'pending')
                  summary.completion = abort.signal.aborted ? 'cancelled' : 'transport_error';
                summary.evidence = wire.status();
                abort.abort();
                await upstream.cancel().catch(() => undefined);
                complete(null, wire.responseBytes);
                controller.error(new Error('Evaluation provider stream failed'));
              }
            },
            async cancel() {
              startDrain();
              await drainDone;
            },
          });
          streaming = true;
          return new Response(stream, {
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
          });
        } catch {
          if (summary.completion === 'pending')
            summary.completion = abort.signal.aborted ? 'cancelled' : 'transport_error';
          complete(null, observer?.responseBytes ?? 0);
          return new Response(null, { status: 502 });
        }
      } finally {
        if (!streaming) finishActivity();
      }
    },
    error() {
      return new Response(null, { status: 500 });
    },
  });
  const privateModels: ModelsConfig = {
    providers: {
      evaluation: {
        api: 'openai-responses',
        baseUrl: `${relay.url.origin}/v1`,
        apiKey: relayToken,
        headers: {},
        compat: { sendSessionIdHeader: false, supportsLongCacheRetention: false },
        models: [
          {
            id: OPENAI_PROTOCOL.model,
            contextWindow: OPENAI_PROTOCOL.maxInputTokens,
            maxTokens: OPENAI_PROTOCOL.maxOutputTokens,
            reasoning: true,
            input: ['text', 'image'],
            compat: {},
            thinkingLevelMap: {
              off: 'low',
              minimal: 'low',
              low: 'low',
              medium: 'medium',
              high: 'high',
              xhigh: 'xhigh',
            },
          },
        ],
      },
    },
    defaultModel: { provider: 'evaluation', id: OPENAI_PROTOCOL.model, thinking: 'medium' },
  };
  const catalog = publicModels(privateModels);
  const gateway = new GatewayInference(
    {
      async resolve(providerName, modelId) {
        if (closed || providerName !== 'evaluation' || modelId !== OPENAI_PROTOCOL.model)
          throw new Error('Evaluation model unavailable');
        const provider = privateModels.providers.evaluation!;
        return { provider, model: provider.models[0]!, apiKey: relayToken };
      },
    },
    async (request, onDelta) => {
      // Abort while GatewayInference still has its signal bridge installed. The native
      // adapter can return early on a malformed event without consuming/cancelling EOF.
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      const requestId = requestContext.getStore();
      if (!requestId) throw new Error('Missing evaluation request identity');
      const correlation = randomBytes(24).toString('hex');
      correlations.set(correlation, requestId);
      try {
        return await streamPi(
          {
            ...request,
            provider: {
              ...request.provider,
              headers: { ...request.provider.headers, 'x-ptc-request': correlation },
            },
            signal: controller.signal,
          },
          onDelta,
        );
      } finally {
        correlations.delete(correlation);
        controller.abort();
        request.signal.removeEventListener('abort', abort);
      }
    },
  );
  const requests = new Map<string, AbortController>();
  const runs = new Set<Promise<void>>();
  let inference: Awaited<ReturnType<typeof startNodeInference>>;
  try {
    inference = await startNodeInference({
      stateDir: options.stateDir,
      getModels: () => catalog,
      send(message) {
        if (message.type === 'model_cancel') {
          requests.get(message.requestId)?.abort();
          return true;
        }
        if (closed) return false;
        ledger.start(message.requestId, message.request.sessionId);
        requestedReasoning.set(message.requestId, message.request.thinking);
        initial.request(message.requestId, message.request);
        try {
          options.onRequest?.(message.request);
        } catch {
          ledger.invalidate();
          return false;
        }
        const finishActivity = activity.begin();
        const abort = new AbortController();
        requests.set(message.requestId, abort);
        const run = requestContext
          .run(message.requestId, () =>
            gateway.run(
              message.request,
              abort.signal,
              (delta) => inference.receive(message.requestId, { type: 'model_delta', delta }),
              'evaluation',
            ),
          )
          .then((result) => {
            try {
              options.onResponse?.(message.request, result);
            } catch {
              ledger.invalidate();
              throw new Error('Evaluation response observer failed');
            }
            inference.receive(message.requestId, { type: 'model_end', message: result });
          })
          .catch(() => {
            inference.receive(message.requestId, { type: 'model_error', code: 'inference_failed' });
          })
          .finally(() => {
            abort.abort();
            requests.delete(message.requestId);
            ledger.end(message.requestId);
            runs.delete(run);
            finishActivity();
          });
        runs.add(run);
        return true;
      },
    });
  } catch {
    await relay.stop(true);
    throw new Error('Evaluation inference unavailable');
  }
  let admission: Awaited<ReturnType<typeof startAdmissionProxy>>;
  try {
    admission = await startAdmissionProxy(options.stateDir, inference.config, activity);
  } catch {
    await Promise.allSettled([inference.close(), relay.stop(true)]);
    throw new Error('Evaluation admission unavailable');
  }
  let closing: Promise<void> | undefined;
  return {
    models: { ...catalog, inference: admission.config },
    parentSession: (id: string) => ledger.parentSession(id),
    childSession: (id: string) => ledger.childSession(id),
    accounting: () => ledger.summary(),
    armInitial: (parent: string, prompt: string) => initial.arm(parent, prompt),
    initialEvidence: () => initial.snapshot(),
    lastRequestFinishedAt: () => lastRequestFinishedAt,
    waitForQuiet: (options: Parameters<ProviderActivity['waitForQuiet']>[0]) =>
      activity.waitForQuiet(options),
    close() {
      closing ??= (async () => {
        closed = true;
        // Attempts still in flight belong to a client that is gone or going (the agent closed
        // first): let them be read for usage, bounded by drainMs, before aborting anything.
        if (pending.size || draining.size) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.allSettled([...pending, ...draining]),
            new Promise((resolve) => (timer = setTimeout(resolve, drainMs))),
          ]);
          clearTimeout(timer);
        }
        activity.close();
        gateway.cancelAll();
        for (const abort of active) abort.abort();
        const results = await Promise.allSettled([
          admission.close(),
          inference.close(),
          relay.stop(true),
        ]);
        await Promise.allSettled([...runs, ...pending]);
        if (results.some((result) => result.status === 'rejected'))
          throw new Error('Evaluation provider cleanup failed');
      })();
      return closing;
    },
  };
}
