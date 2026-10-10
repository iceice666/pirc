/** pi-ai `openai-completions` and the native `openai-chat` transport (M2). */
import {
  assistant,
  baseRequest,
  chunk,
  data,
  DONE,
  fakeModels,
  richHistory,
  type Scenario,
  textReply,
  toolReply,
  usage,
} from '../common.ts';

export const scenarios: Scenario[] = [
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
