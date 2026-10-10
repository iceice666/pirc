/**
 * Records what the TS gateway's inference (GatewayInference + pi-adapter +
 * pi-ai 0.73.1, or the native openai-chat transport) does for scripted
 * OpenAI-compatible responses: the HTTP requests it sends, the deltas it
 * reports and the final assistant message. `cargo test -p pirc-providers`
 * replays the same responses against the Rust port and compares.
 *
 * Re-record (from the repository root):
 *   bun crates/pirc-providers/tests/parity/record.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { GatewayInference } from '../../../../apps/gateway/src/backends/inference.ts';
import { modelsSchema } from '../../../../apps/gateway/src/models.ts';

type Json = any;
type Response =
  | { status: number; body: string; contentType?: string }
  | { chunks: string[]; hang?: boolean };

interface Scenario {
  name: string;
  /** models.json-shaped providers (keys resolved); `{BASE}` is the server's /v1 URL. */
  models: Json;
  request: Json;
  nodeId?: string;
  /** One response per HTTP request the scenario makes. */
  responses: Response[];
  /** Call cancelAll() from inside the n-th delta callback (1-based). */
  cancelAfterDeltas?: number;
  /** Run with PI_CACHE_RETENTION=long (otherwise unset). */
  longCacheRetention?: boolean;
}

const data = (value: Json) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta: Json, finish: Json = null, extra: Json = {}) =>
  data({ ...extra, choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = (extra: Json = {}) =>
  data({
    choices: [],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 40 },
      ...extra,
    },
  });
const DONE = 'data: [DONE]\n\n';

/** The conformance fake LLM's text reply (crates/pirc-conformance/src/fake_llm.rs). */
function textReply(text: string): string[] {
  const chars = [...text];
  const half = Math.ceil(chars.length / 2);
  const out: string[] = [];
  for (const part of [chars.slice(0, half), chars.slice(half)])
    if (part.length) out.push(chunk({ content: part.join('') }));
  out.push(chunk({}, 'stop'), usage(), DONE);
  return out;
}

/** The conformance fake LLM's tool reply. */
function toolReply(id: string, name: string, args: Json): string[] {
  const text = JSON.stringify(args);
  const split = [...text].slice(0, 5).join('').length;
  return [
    chunk({
      tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: text.slice(0, split) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: text.slice(split) } }] }),
    chunk({}, 'tool_calls'),
    usage(),
    DONE,
  ];
}

const fakeModels = (provider: Json = {}, model: Json = {}) => ({
  providers: {
    fake: {
      api: 'openai-completions',
      baseUrl: '{BASE}',
      apiKey: 'test-key',
      ...provider,
      models: [
        { id: 'fake-model', reasoning: true, contextWindow: 100000, maxTokens: 1000, ...model },
      ],
    },
  },
  defaultModel: { provider: 'fake', id: 'fake-model', thinking: 'low' },
});

const readTool = {
  name: 'read',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, offset: { type: 'number' } },
    required: ['path'],
  },
};

const baseRequest = (extra: Json = {}) => ({
  providerName: 'fake',
  modelId: 'fake-model',
  systemPrompt: 'You are a test agent.',
  messages: [{ role: 'user', content: 'Say hello.', timestamp: 1 }],
  tools: [readTool],
  thinking: 'low',
  sessionId: 'session-1',
  ...extra,
});

const usage0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const assistant = (content: Json[], extra: Json = {}) => ({
  role: 'assistant',
  content,
  api: 'openai-completions',
  provider: 'fake',
  model: 'fake-model',
  usage: { input: 5, output: 6, cacheRead: 1, cacheWrite: 0, totalTokens: 12 },
  stopReason: 'stop',
  timestamp: 2,
  ...extra,
});

/** A history touching every conversion path. */
const richHistory = [
  { role: 'user', content: 'first', timestamp: 1 },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
    ],
    timestamp: 2,
  },
  assistant(
    [
      { type: 'thinking', thinking: 'pondering', signature: 'reasoning_content' },
      { type: 'text', text: 'I will read.' },
      { type: 'toolCall', id: 'call_a', name: 'read', arguments: { path: 'a.txt', offset: 2 } },
    ],
    { stopReason: 'toolUse', canonicalProvider: 'fake', responseId: 'resp-1' },
  ),
  {
    role: 'toolResult',
    toolCallId: 'call_a',
    toolName: 'read',
    content: [
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
      { type: 'image', data: 'CCCC', mimeType: 'image/png' },
    ],
    details: { bytes: 3 },
    isError: false,
    timestamp: 3,
  },
  { role: 'custom', customType: 'note', content: 'a custom note', display: true, timestamp: 4 },
  { role: 'compactionSummary', summary: 'we talked', tokensBefore: 50, timestamp: 5 },
  // Another backend's turn: thinking becomes text, the long pipe id is normalized.
  assistant(
    [
      { type: 'thinking', thinking: 'other thoughts' },
      { type: 'thinking', thinking: '   ' },
      { type: 'text', text: 'From elsewhere.' },
      {
        type: 'toolCall',
        id: 'call_x+y|' + 'z'.repeat(60),
        name: 'read',
        arguments: { path: 'b' },
        thoughtSignature: 'sig',
      },
    ],
    {
      api: 'openai-responses',
      provider: 'other',
      model: 'other-model',
      stopReason: 'toolUse',
    },
  ),
  {
    role: 'toolResult',
    toolCallId: 'call_x+y|' + 'z'.repeat(60),
    toolName: 'read',
    content: [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }],
    isError: true,
    timestamp: 6,
  },
  // Failed turns are not replayed.
  assistant([{ type: 'text', text: 'partial' }], { stopReason: 'error', errorMessage: 'x' }),
  // An orphaned call gets a synthetic result before the next user message.
  assistant([{ type: 'toolCall', id: 'call_orphan', name: 'read', arguments: {} }], {
    stopReason: 'toolUse',
  }),
  { role: 'user', content: [], timestamp: 7 },
  assistant([{ type: 'text', text: '  ' }]),
  assistant([{ type: 'thinking', thinking: 'only thinking', signature: 'reasoning' }]),
  { role: 'user', content: 'last', timestamp: 8 },
];

const scenarios: Scenario[] = [
  {
    name: 'pi_text',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ chunks: textReply('Hello from the fake model.') }],
  },
  {
    name: 'pi_tool',
    models: fakeModels(),
    request: baseRequest({ toolChoice: 'auto', maxTokens: 500 }),
    responses: [{ chunks: toolReply('call_1', 'read', { path: 'a.txt' }) }],
  },
  {
    name: 'pi_history',
    models: fakeModels(),
    request: baseRequest({ messages: richHistory, tools: [] }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'pi_history_compat',
    models: fakeModels(
      {
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: 'max_tokens',
          requiresToolResultName: true,
          requiresAssistantAfterToolResult: true,
          requiresThinkingAsText: true,
          supportsStore: false,
          supportsStrictMode: false,
          supportsUsageInStreaming: false,
        },
      },
      { input: ['text', 'image'], compat: { requiresReasoningContentOnAssistantMessages: true } },
    ),
    request: baseRequest({ messages: richHistory, toolChoice: 'none' }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'pi_thinking',
    models: fakeModels({}, { thinkingLevelMap: { minimal: null, xhigh: 'max' } }),
    request: baseRequest({ thinking: 'minimal' }),
    responses: [
      {
        chunks: [
          chunk({ role: 'assistant', content: '' }, null, {
            id: 'chatcmpl-1',
            model: 'real-model',
          }),
          chunk({ reasoning_content: 'Let me ' }, null, { id: 'chatcmpl-1' }),
          chunk({ reasoning_content: 'think.', reasoning: 'dup' }, null, { id: 'chatcmpl-2' }),
          chunk({ content: 'Answer' }),
          chunk({ reasoning: ' more' }),
          chunk({
            tool_calls: [{ index: 0, id: 'call_t', function: { name: 'read', arguments: '{"pa' } }],
          }),
          chunk({
            tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }],
            reasoning_details: [
              { type: 'reasoning.encrypted', id: 'call_t', data: 'enc', format: 'f' },
            ],
          }),
          chunk({}, 'tool_calls'),
          data({
            choices: [],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 7,
              total_tokens: 57,
              prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
            },
          }),
          DONE,
        ],
      },
    ],
  },
  {
    name: 'pi_thinking_xhigh',
    models: fakeModels({}, { thinkingLevelMap: { xhigh: 'max' } }),
    request: baseRequest({ thinking: 'xhigh' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_thinking_off',
    models: fakeModels({}, { thinkingLevelMap: { off: 'none' } }),
    request: baseRequest({ thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_not_reasoning',
    models: fakeModels({}, { reasoning: false }),
    request: baseRequest({ thinking: 'high', systemPrompt: '' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_deepseek',
    models: fakeModels({ compat: { thinkingFormat: 'deepseek' } }),
    request: baseRequest({ thinking: 'medium' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_openrouter_off',
    models: fakeModels({ piProvider: 'openrouter' }, { id: 'anthropic/claude' }),
    request: baseRequest({ modelId: 'anthropic/claude', thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_qwen_template',
    models: fakeModels({ compat: { thinkingFormat: 'qwen-chat-template' } }),
    request: baseRequest({ thinking: 'high' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_zai',
    models: fakeModels({ compat: { thinkingFormat: 'zai', zaiToolStream: true } }),
    request: baseRequest({ thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_headers_affinity',
    models: fakeModels(
      {
        headers: { 'x-provider': 'p', authorization: 'Bearer override' },
        compat: { sendSessionAffinityHeaders: true, supportsLongCacheRetention: true },
      },
      { headers: { 'x-model': 'm' }, canonicalProvider: 'canon' },
    ),
    nodeId: 'node-7',
    request: baseRequest(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_long_cache',
    models: fakeModels({ compat: { cacheControlFormat: 'anthropic' } }),
    request: baseRequest({ messages: richHistory }),
    longCacheRetention: true,
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_long_cache_unsupported',
    models: fakeModels({ compat: { supportsLongCacheRetention: false } }),
    request: baseRequest(),
    longCacheRetention: true,
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_opencode_go',
    models: fakeModels({ opencodeGo: true, apiKey: '  ' }),
    request: baseRequest(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'pi_missing_managed_key',
    models: fakeModels({ piProvider: 'openai', apiKey: undefined }),
    request: baseRequest(),
    responses: [],
  },
  {
    name: 'pi_http_500',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ status: 500, body: 'boom' }],
  },
  {
    name: 'pi_http_429',
    models: fakeModels(),
    request: baseRequest(),
    responses: [
      {
        status: 429,
        body: '{"error":{"message":"Rate limit exceeded","type":"rate_limit"}}',
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'pi_http_429_empty',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ status: 429, body: '' }],
  },
  {
    name: 'pi_http_400_overflow',
    models: fakeModels(),
    request: baseRequest(),
    responses: [
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "This model's maximum context length is 128000 tokens." },
        }),
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'pi_http_413',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ status: 413, body: 'Request Entity Too Large' }],
  },
  {
    name: 'pi_stream_error',
    models: fakeModels(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          chunk({ content: 'Hel' }),
          data({ error: { message: 'Provider overloaded, try later' } }),
          DONE,
        ],
      },
    ],
  },
  {
    name: 'pi_stream_overflow_error',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ chunks: [data({ error: { message: 'prompt is too long' } })] }],
  },
  {
    name: 'pi_content_filter',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ chunks: [chunk({ content: 'bad' }), chunk({}, 'content_filter'), DONE] }],
  },
  {
    name: 'pi_length',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ chunks: [chunk({ content: 'cut' }, 'length'), DONE] }],
  },
  {
    name: 'pi_truncated',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ chunks: [chunk({ content: 'Hello' }), chunk({ content: ' there' })] }],
  },
  {
    name: 'pi_bad_json',
    models: fakeModels(),
    request: baseRequest(),
    responses: [{ chunks: [chunk({ content: 'a' }), 'data: {not json\n\n'] }],
  },
  {
    name: 'pi_malformed_tool_args',
    models: fakeModels(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'c0',
                function: { name: 'read', arguments: '{"path":"a\\qb", "n": [1, 2' },
              },
              { index: 1, id: 'c1', function: { name: 'read', arguments: '' } },
            ],
          }),
          chunk({ tool_calls: [{ index: 1, function: { arguments: '[1]' } }] }),
          chunk({ tool_calls: [{ id: 'c2', function: { name: 'write', arguments: '{"a":tru' } }] }),
          chunk({}, 'tool_calls'),
          DONE,
        ],
      },
    ],
  },
  {
    name: 'pi_cancel',
    models: fakeModels(),
    request: baseRequest(),
    cancelAfterDeltas: 2,
    responses: [
      { chunks: [chunk({ content: 'Hello' }), chunk({ content: ' there' })], hang: true },
    ],
  },
  {
    name: 'pi_cancel_tool',
    models: fakeModels(),
    request: baseRequest(),
    cancelAfterDeltas: 3,
    responses: [
      {
        chunks: [
          chunk({ content: 'Hi' }),
          chunk({
            tool_calls: [
              { index: 0, id: 'c', function: { name: 'read', arguments: '{"path":"a' } },
            ],
          }),
        ],
        hang: true,
      },
    ],
  },
  {
    name: 'unknown_model',
    models: fakeModels(),
    request: baseRequest({ modelId: 'missing' }),
    responses: [],
  },
  {
    name: 'unknown_provider',
    models: fakeModels(),
    request: baseRequest({ providerName: 'nope' }),
    responses: [],
  },
  {
    name: 'chat_text',
    models: fakeModels({ api: 'openai-chat' }),
    request: baseRequest({ toolChoice: 'none' }),
    responses: [{ chunks: textReply('Hello from the fake model.') }],
  },
  {
    name: 'chat_tool',
    models: fakeModels({ api: 'openai-chat', compat: { supportsDeveloperRole: true } }),
    request: baseRequest({ maxTokens: 64 }),
    responses: [{ chunks: toolReply('call_1', 'read', { path: 'a.txt' }) }],
  },
  {
    name: 'chat_history',
    models: fakeModels({
      api: 'openai-chat',
      headers: { 'x-provider': 'p' },
      compat: { sendSessionAffinityHeaders: true, supportsLongCacheRetention: true },
    }),
    request: baseRequest({ messages: richHistory, thinking: 'off', tools: [] }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'chat_thinking',
    models: fakeModels({ api: 'openai-chat', apiKey: undefined }, { reasoning: false }),
    request: baseRequest({ thinking: 'high' }),
    responses: [
      {
        chunks: [
          chunk({ reasoning_content: 'hmm' }),
          chunk({ content: 'A' }),
          chunk({ reasoning: 'again' }),
          chunk({ content: 'B' }),
          chunk(
            {
              tool_calls: [
                { index: 1, id: 'c1', function: { name: 'read', arguments: '{"path":' } },
              ],
            },
            null,
          ),
          chunk({ tool_calls: [{ index: 1, function: { arguments: '"x"}' } }] }),
          chunk({
            tool_calls: [{ index: 2, id: 'c2', function: { name: 'w', arguments: 'nope' } }],
          }),
          chunk({}, 'stop'),
          data({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
          DONE,
        ],
      },
    ],
  },
  {
    name: 'chat_http_500',
    models: fakeModels({ api: 'openai-chat' }),
    request: baseRequest(),
    responses: [{ status: 500, body: 'boom' }],
  },
  {
    name: 'chat_http_400_overflow',
    models: fakeModels({ api: 'openai-chat' }),
    request: baseRequest(),
    responses: [{ status: 400, body: 'context_length_exceeded' }],
  },
  {
    name: 'chat_stream_error',
    models: fakeModels({ api: 'openai-chat' }),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          chunk({ content: 'x' }),
          chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'n', arguments: '{}' } }] }),
          data({ error: { message: 'Rate limit reached' } }),
        ],
      },
    ],
  },
  {
    name: 'chat_length',
    models: fakeModels({ api: 'openai-chat' }),
    request: baseRequest(),
    responses: [{ chunks: [chunk({ content: 'cut' }, 'length'), DONE] }],
  },
  {
    name: 'chat_cancel',
    models: fakeModels({ api: 'openai-chat' }),
    request: baseRequest(),
    cancelAfterDeltas: 4,
    responses: [
      {
        chunks: [
          chunk({ content: 'Hi' }),
          chunk({
            tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{' } }],
          }),
        ],
        hang: true,
      },
    ],
  },
  {
    name: 'pi_via_model_api',
    models: fakeModels({ api: 'openai-chat' }, { api: 'openai-chat', canonicalProvider: 'openai' }),
    request: baseRequest({
      messages: [
        assistant([{ type: 'toolCall', id: 'x'.repeat(50), name: 'read', arguments: {} }], {
          stopReason: 'toolUse',
          api: 'openai-chat',
          provider: 'elsewhere',
        }),
      ],
    }),
    responses: [{ chunks: textReply('ok') }],
  },
];

// ---------------------------------------------------------------------------

let current: Scenario | undefined;
let recorded: Json[] = [];
let responseIndex = 0;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = await req.text();
    recorded.push({ method: req.method, path: url.pathname, headers, body: JSON.parse(text) });
    const response = current!.responses[responseIndex++];
    if (!response) return new Response('no scripted response', { status: 599 });
    if ('status' in response)
      return new Response(response.body, {
        status: response.status,
        headers: response.contentType ? { 'content-type': response.contentType } : {},
      });
    const { chunks, hang } = response;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const part of chunks) {
          await Bun.sleep(5);
          controller.enqueue(encoder.encode(part));
        }
        if (!hang) {
          controller.close();
          return;
        }
        await new Promise<void>((resolve) =>
          req.signal.aborted ? resolve() : req.signal.addEventListener('abort', () => resolve()),
        );
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});
const base = `http://127.0.0.1:${server.port}/v1`;

const substitute = (value: Json): Json =>
  JSON.parse(JSON.stringify(value).replaceAll('{BASE}', base));
const unsubstitute = (value: Json): Json =>
  JSON.parse(JSON.stringify(value).replaceAll(base, '{BASE}'));

const results: Json[] = [];
for (const scenario of scenarios) {
  current = scenario;
  recorded = [];
  responseIndex = 0;
  if (scenario.longCacheRetention) process.env.PI_CACHE_RETENTION = 'long';
  else delete process.env.PI_CACHE_RETENTION;
  const models = modelsSchema.parse(substitute(scenario.models));
  const inference = new GatewayInference({
    async resolve(providerName, modelId) {
      const provider = Object.hasOwn(models.providers, providerName)
        ? models.providers[providerName]
        : undefined;
      const model = provider?.models.find((entry) => entry.id === modelId);
      if (!provider || !model) throw new Error('Backend or authorization session not found');
      return {
        provider: structuredClone(provider),
        model: structuredClone(model),
        apiKey: provider.apiKey,
      };
    },
  });
  const deltas: Json[] = [];
  const message = await inference.run(
    scenario.request,
    new AbortController().signal,
    (delta) => {
      deltas.push(structuredClone(delta));
      if (deltas.length === scenario.cancelAfterDeltas) inference.cancelAll();
    },
    scenario.nodeId ?? 'node-1',
  );
  results.push({
    ...unsubstitute(scenario),
    expected: {
      requests: unsubstitute(recorded),
      deltas,
      message: { ...message, timestamp: 0 },
    },
  });
}
server.stop(true);

const out = path.join(import.meta.dir, 'fixtures.json');
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${results.length} scenarios to ${out}`);
