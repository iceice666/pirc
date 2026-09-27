import { describe, expect, test } from 'bun:test';
import type {
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Api,
  ProviderStreamOptions,
} from '@mariozechner/pi-ai';
import { createPiStream, type PiDispatcher } from '../src/backends/pi-adapter.js';
import type { StreamRequest } from '../src/agent/providers/types.js';
import type { AssistantDelta, AssistantMessage } from '../src/agent/messages.js';

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    providerName: 'my-account',
    provider: {
      api: 'anthropic-messages',
      piProvider: 'github-copilot',
      baseUrl: 'https://configured.example',
      headers: { 'x-provider': 'yes', 'x-shared': 'provider' },
      compat: { supportsStore: false },
      models: [],
    },
    model: {
      id: 'model',
      contextWindow: 100_000,
      maxTokens: 8192,
      reasoning: true,
      input: ['text', 'image'],
      compat: {},
    },
    apiKey: 'explicit-token',
    systemPrompt: 'system',
    messages: [],
    tools: [
      {
        name: 'read',
        description: 'Read file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    thinking: 'off',
    sessionId: 'session',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function message(overrides: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-responses',
    provider: 'github-copilot',
    model: 'model',
    content: [],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 20,
      cacheWrite: 3,
      totalTokens: 38,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
    },
    stopReason: 'stop',
    timestamp: 999,
    ...overrides,
  };
}

function events(...values: AssistantMessageEvent[]): AsyncIterable<AssistantMessageEvent> {
  return (async function* () {
    yield* values;
  })();
}

function capture() {
  let captured!: { model: Model<Api>; context: Context; options: ProviderStreamOptions };
  const dispatch: PiDispatcher = (model, context, options) => {
    captured = { model, context, options };
    return events({
      type: 'done',
      reason: 'stop',
      message: message({ api: model.api, provider: model.provider }),
    });
  };
  return { stream: createPiStream(dispatch), get: () => captured };
}

describe('gateway Pi adapter', () => {
  test.each([
    'anthropic-messages',
    'openai-completions',
    'openai-responses',
    'openai-codex-responses',
  ] as const)('dispatches %s with explicit options and toolChoice none', async (api) => {
    const mock = capture();
    const req = request();
    req.model.api = api;
    req.maxTokens = 512;
    req.toolChoice = 'none';
    await mock.stream(req, () => {});
    const { model, context, options } = mock.get();
    expect(model.api).toBe(api);
    expect(model.provider).toBe('github-copilot');
    expect(model.cost).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(context.tools).toEqual(req.tools);
    expect(options).toMatchObject({
      apiKey: 'explicit-token',
      signal: req.signal,
      transport: 'sse',
      maxTokens: 512,
      maxRetries: 0,
      sessionId: 'session',
    });
    const body = (await options.onPayload!({}, model)) as Record<string, unknown>;
    expect(body.tool_choice).toEqual(api === 'anthropic-messages' ? { type: 'none' } : 'none');
    if (api === 'anthropic-messages') expect(options.thinkingEnabled).toBe(false);
    else
      expect(options.reasoningEffort).toBe(api === 'openai-codex-responses' ? 'none' : undefined);
    // The Codex subscription backend is not the public Responses API: no invented output cap.
    expect(body.max_output_tokens).toBeUndefined();
  });

  test('model overrides, canonical identity, headers/compat and legacy API mapping', async () => {
    const mock = capture();
    const req = request();
    req.model.api = 'openai-chat';
    req.model.baseUrl = 'https://model.example';
    req.model.canonicalProvider = 'openai';
    req.model.compat = { supportsStore: true };
    req.model.headers = { 'x-shared': 'model' };
    await mock.stream(req, () => {});
    expect(mock.get().model).toMatchObject({
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://model.example',
      headers: { 'x-provider': 'yes', 'x-shared': 'model' },
      compat: { supportsStore: true },
    });
    delete req.model.api;
    delete req.model.canonicalProvider;
    delete req.provider.piProvider;
    req.provider.api = 'openai-chat';
    await mock.stream(req, () => {});
    expect(mock.get().model).toMatchObject({ api: 'openai-completions', provider: 'my-account' });
  });

  test('history round-trips replay metadata, roles, images and non-overlapping usage', async () => {
    const source = message({
      responseId: 'response',
      responseModel: 'actual',
      content: [
        { type: 'text', text: 'hello', textSignature: '{"v":1,"id":"msg","phase":"commentary"}' },
        { type: 'thinking', thinking: '', thinkingSignature: 'encrypted', redacted: true },
        {
          type: 'toolCall',
          id: 'call|item',
          name: 'read',
          arguments: { path: 'x' },
          thoughtSignature: 'opaque',
        },
      ],
    });
    const first = createPiStream(() => events({ type: 'done', reason: 'stop', message: source }));
    const result = await first(request(), () => {});
    expect(result).toMatchObject({
      provider: 'my-account',
      canonicalProvider: 'github-copilot',
      responseId: 'response',
      responseModel: 'actual',
      usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, totalTokens: 38 },
    });
    expect(result.usage).not.toHaveProperty('cost');
    expect(result).not.toHaveProperty('completedAt');
    expect(result.content[1]).toMatchObject({ signature: 'encrypted', redacted: true });
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' };
    const mock = capture();
    const persisted = JSON.parse(JSON.stringify(result)) as AssistantMessage;
    await mock.stream(
      request({
        messages: [
          {
            role: 'custom',
            customType: 'notice',
            content: 'hidden but sent',
            display: false,
            timestamp: 1,
          },
          { role: 'compactionSummary', summary: 'summary text', tokensBefore: 400, timestamp: 2 },
          { role: 'user', content: [image], timestamp: 3 },
          persisted,
          {
            role: 'toolResult',
            toolCallId: 'call|item',
            toolName: 'read',
            content: [image, { type: 'text', text: 'result' }],
            isError: true,
            timestamp: 4,
          },
        ],
      }),
      () => {},
    );
    const history = mock.get().context.messages;
    expect(history[0]).toMatchObject({ role: 'user', content: 'hidden but sent' });
    expect(history[1]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('summary text'),
    });
    expect(history[2]).toMatchObject({ content: [image] });
    expect(history[3]).toMatchObject({
      provider: 'github-copilot',
      api: source.api,
      content: source.content,
      responseId: 'response',
      responseModel: 'actual',
    });
    expect(history[4]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call|item',
      isError: true,
    });
    expect(persisted).toEqual(result);
  });

  test('cross-provider history retains canonical identity; old same-backend history is inferred', async () => {
    const mock = capture();
    const base: AssistantMessage = {
      ...message(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      provider: 'my-account',
      api: 'openai-chat',
    };
    await mock.stream(
      request({
        messages: [
          base,
          { ...base, provider: 'another', canonicalProvider: 'anthropic' },
          { ...base, provider: 'old-other' },
        ],
      }),
      () => {},
    );
    expect(
      mock
        .get()
        .context.messages.map((value) =>
          value.role === 'assistant' ? [value.provider, value.api] : [],
        ),
    ).toEqual([
      ['github-copilot', 'openai-completions'],
      ['anthropic', 'openai-completions'],
      ['old-other', 'openai-completions'],
    ]);
  });

  test('maps all deltas, enriches tool start, and retains independent partial snapshots', async () => {
    const call = {
      type: 'toolCall' as const,
      id: 'call',
      name: 'read',
      arguments: { path: 'file' },
    };
    const partial = message({
      content: [
        { type: 'text', text: 'text' },
        { type: 'thinking', thinking: 'think', thinkingSignature: 'sig' },
        call,
      ],
    });
    const deltas: AssistantDelta[] = [];
    const snapshots: AssistantMessage[] = [];
    const stream = createPiStream(() =>
      events(
        { type: 'start', partial },
        { type: 'text_start', contentIndex: 0, partial },
        { type: 'text_delta', contentIndex: 0, delta: 'text', partial },
        { type: 'text_end', contentIndex: 0, content: 'text', partial },
        { type: 'thinking_start', contentIndex: 1, partial },
        { type: 'thinking_delta', contentIndex: 1, delta: 'think', partial },
        { type: 'thinking_end', contentIndex: 1, content: 'think', partial },
        { type: 'toolcall_start', contentIndex: 2, partial },
        { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"file"}', partial },
        { type: 'toolcall_end', contentIndex: 2, toolCall: call, partial },
        { type: 'done', reason: 'toolUse', message: { ...partial, stopReason: 'toolUse' } },
      ),
    );
    const result = await stream(request(), (delta, snapshot) => {
      deltas.push(delta);
      snapshots.push(snapshot);
    });
    expect(deltas).toHaveLength(9);
    expect(deltas[6]).toEqual({
      type: 'toolcall_start',
      contentIndex: 2,
      id: 'call',
      toolName: 'read',
    });
    expect(deltas[8]).toEqual({ type: 'toolcall_end', contentIndex: 2, toolCall: call });
    expect(result.stopReason).toBe('toolUse');
    expect(snapshots[0]!.usage.totalTokens).toBe(38);
    call.arguments.path = 'changed';
    expect(snapshots[0]!.content[2]).toMatchObject({ arguments: { path: 'file' } });
    expect(result.content[2]).toMatchObject({ arguments: { path: 'file' } });
  });

  test.each(['stop', 'length', 'toolUse'] as const)('preserves %s termination', async (reason) => {
    const stream = createPiStream(() =>
      events({ type: 'done', reason, message: message({ stopReason: reason }) }),
    );
    expect((await stream(request(), () => {})).stopReason).toBe(reason);
  });

  test('thinking mapping and maxTokens do not silently inflate the caller cap', async () => {
    const mock = capture();
    const req = request({ thinking: 'xhigh', maxTokens: 2048 });
    req.model.thinkingLevelMap = { xhigh: 'max', low: null };
    await mock.stream(req, () => {});
    expect(mock.get().options).toMatchObject({
      thinkingEnabled: true,
      effort: 'max',
      maxTokens: 2048,
      thinkingBudgetTokens: 2047,
    });
    req.model.api = 'openai-responses';
    req.thinking = 'low';
    await mock.stream(req, () => {});
    expect(mock.get().options.reasoningEffort).toBe('medium');
  });

  test('missing explicit token never invokes SDK/environment lookup', async () => {
    let calls = 0;
    const stream = createPiStream(() => {
      calls++;
      throw new Error('should not run');
    });
    for (const apiKey of [undefined, '', '   ']) {
      expect(await stream(request({ apiKey }), () => {})).toMatchObject({
        stopReason: 'error',
        errorMessage: 'Model credentials are unavailable.',
      });
    }
    expect(calls).toBe(0);
  });

  test('keyless user endpoints get an explicit placeholder, never an environment lookup', async () => {
    let key: string | undefined;
    const stream = createPiStream(async (_model, _context, options) => {
      key = options.apiKey;
      return events({ type: 'done', reason: 'stop', message: message() });
    });
    const provider = { ...request().provider };
    delete provider.piProvider;
    const result = await stream(request({ provider, apiKey: undefined }), () => {});
    expect(result.stopReason).toBe('stop');
    expect(key).toBe('pirc-no-api-key');
  });

  test('classifies overflow and usage limits without echoing upstream text', async () => {
    const failing = (text: string, status?: number, api: Api = 'openai-responses') =>
      createPiStream(async (model, _context, options) => {
        if (status) await options.onResponse!({ status, headers: {} }, model);
        return events({
          type: 'error',
          reason: 'error',
          error: message({ api, stopReason: 'error', errorMessage: text }),
        });
      })(request(), () => {});
    expect((await failing('prompt is too long: secret-body')).errorMessage).toBe(
      'Model context window exceeded.',
    );
    expect((await failing('anything', 413)).errorMessage).toBe('Model context window exceeded.');
    const limited = await failing(
      'The usage limit has been reached secret',
      undefined,
      'openai-codex-responses',
    );
    expect(limited.errorMessage).not.toContain('secret');
  });

  test('provider errors and thrown exceptions never disclose raw text or diagnostics', async () => {
    const sensitive = 'explicit-token secret provider response';
    const partial = message({ content: [{ type: 'text', text: 'already streamed' }] });
    const stream = createPiStream(async (model, _context, options) => {
      await options.onResponse!({ status: 401, headers: { authorization: sensitive } }, model);
      return events({
        type: 'error',
        reason: 'error',
        error: { ...partial, stopReason: 'error', errorMessage: sensitive },
      });
    });
    const result = await stream(request(), () => {});
    expect(result).toMatchObject({
      stopReason: 'error',
      errorMessage: 'Model provider request failed (HTTP 401).',
      content: partial.content,
    });
    expect(JSON.stringify(result)).not.toContain(sensitive);
    const thrown = await createPiStream(() => {
      throw new Error(sensitive);
    })(request(), () => {});
    expect(thrown.errorMessage).toBe('Model provider request failed.');
    const truncated = await createPiStream(() => events({ type: 'start', partial }))(
      request(),
      () => {},
    );
    expect(truncated.stopReason).toBe('error');
  });

  test('aborts before dispatch and during streaming; Pi aborted errors stay aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const first = await createPiStream(() => {
      called = true;
      throw new Error('no');
    })(request({ signal: controller.signal }), () => {});
    expect(first.stopReason).toBe('aborted');
    expect(called).toBe(false);
    const active = new AbortController();
    const during = createPiStream(async function* () {
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'x',
        partial: message({ content: [{ type: 'text', text: 'x' }] }),
      };
      active.abort();
      yield { type: 'done', reason: 'stop', message: message() };
    });
    const result = await during(request({ signal: active.signal }), () => {});
    expect(result).toMatchObject({ stopReason: 'aborted', content: [{ type: 'text', text: 'x' }] });
    expect(result).not.toHaveProperty('errorMessage');
    const providerAbort = await createPiStream(() =>
      events({
        type: 'error',
        reason: 'aborted',
        error: message({ stopReason: 'aborted', errorMessage: 'sensitive' }),
      }),
    )(request(), () => {});
    expect(providerAbort.stopReason).toBe('aborted');
    expect(providerAbort).not.toHaveProperty('errorMessage');
  });
});
