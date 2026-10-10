/** The native `anthropic-messages` transport (`agent/providers/anthropic.ts`, M3). */
import {
  assistant,
  baseRequest,
  fakeModels,
  readTool,
  richHistory,
  type Json,
  type Scenario,
} from '../common.ts';

/** An Anthropic SSE event, with its `event:` line. */
const ev = (type: string, fields: Json = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

const native = (provider: Json = {}, model: Json = {}) =>
  fakeModels({ api: 'anthropic-messages', baseUrl: '{ROOT}', ...provider }, model);

const start = (usage: Json = { input_tokens: 100, output_tokens: 1 }) =>
  ev('message_start', {
    message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage },
  });
const blockStart = (index: Json, block: Json) =>
  ev('content_block_start', { index, content_block: block });
const blockDelta = (index: Json, delta: Json) => ev('content_block_delta', { index, delta });
const blockStop = (index: Json) => ev('content_block_stop', { index });
const textDelta = (index: Json, text: string) => blockDelta(index, { type: 'text_delta', text });
const jsonDelta = (index: Json, partial_json: string) =>
  blockDelta(index, { type: 'input_json_delta', partial_json });
const end = (stop_reason: Json = 'end_turn', usage: Json = { output_tokens: 15 }) => [
  ev('message_delta', { delta: { stop_reason, stop_sequence: null }, usage }),
  ev('message_stop'),
];

function textReply(text: string, usage?: Json): string[] {
  const half = Math.ceil(text.length / 2);
  return [
    start(usage),
    blockStart(0, { type: 'text', text: '' }),
    ev('ping'),
    textDelta(0, text.slice(0, half)),
    textDelta(0, text.slice(half)),
    blockStop(0),
    ...end(),
  ];
}

function toolReply(id: string, name: string, args: Json): string[] {
  const text = JSON.stringify(args);
  return [
    start(),
    blockStart(0, { type: 'text', text: '' }),
    textDelta(0, 'Reading.'),
    blockStop(0),
    blockStart(1, { type: 'tool_use', id, name, input: {} }),
    jsonDelta(1, ''),
    jsonDelta(1, text.slice(0, 5)),
    jsonDelta(1, text.slice(5)),
    blockStop(1),
    ...end('tool_use', { output_tokens: 30 }),
  ];
}

const ok = () => [{ chunks: textReply('ok') }];

/** Every thinking level, with and without adaptive thinking. */
const levels = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const thinkingScenarios: Scenario[] = levels.flatMap((thinking) => [
  {
    name: `native_thinking_${thinking}`,
    models: native({}, { maxTokens: 100_000 }),
    request: baseRequest({ thinking }),
    responses: ok(),
  },
  {
    name: `native_adaptive_${thinking}`,
    models: native({ compat: { forceAdaptiveThinking: true } }),
    request: baseRequest({ thinking }),
    responses: ok(),
  },
]);

/** A history touching the paths richHistory does not. */
const moreHistory = [
  { role: 'user', content: '', timestamp: 1 },
  assistant(
    [
      { type: 'thinking', thinking: 'secret', signature: 'opaque', redacted: true },
      { type: 'thinking', thinking: 'plain', signature: 'sig-1' },
      { type: 'thinking', thinking: 'unsigned' },
      { type: 'thinking', thinking: 'empty sig', signature: '' },
      { type: 'text', text: '' },
      { type: 'text', text: 'Two calls.' },
      { type: 'toolCall', id: 'toolu_1', name: 'read', arguments: { path: 'x', offset: 1 } },
      { type: 'toolCall', id: 'toolu_2', name: 'read', arguments: {} },
    ],
    { api: 'anthropic-messages', stopReason: 'toolUse' },
  ),
  {
    role: 'toolResult',
    toolCallId: 'toolu_1',
    toolName: 'read',
    content: [],
    isError: false,
    timestamp: 3,
  },
  {
    role: 'toolResult',
    toolCallId: 'toolu_2',
    toolName: 'read',
    content: [{ type: 'text', text: 'missing' }],
    isError: true,
    timestamp: 4,
  },
  assistant(
    [
      { type: 'thinking', thinking: 'cut', signature: 'sig-2' },
      { type: 'text', text: 'half' },
      { type: 'toolCall', id: 'toolu_3', name: 'read', arguments: {} },
    ],
    { stopReason: 'aborted' },
  ),
  assistant([{ type: 'thinking', thinking: 'x' }]),
  {
    role: 'toolResult',
    toolCallId: 'toolu_3',
    toolName: 'read',
    content: [{ type: 'image', data: 'EEEE', mimeType: 'image/gif' }],
    isError: false,
    timestamp: 5,
  },
];

export const scenarios: Scenario[] = [
  {
    name: 'native_text',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: textReply('Hello from the fake model.', {
          input_tokens: 100,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 20,
          output_tokens: 1,
        }),
      },
    ],
  },
  {
    name: 'native_tool',
    models: native(),
    request: baseRequest({ maxTokens: 64, toolChoice: 'auto' }),
    responses: [{ chunks: toolReply('toolu_1', 'read', { path: 'a.txt' }) }],
  },
  {
    name: 'native_tool_choice_none',
    models: native(),
    request: baseRequest({
      toolChoice: 'none',
      tools: [readTool, { name: 'write', description: 'Write', parameters: { type: 'object' } }],
    }),
    responses: ok(),
  },
  {
    name: 'native_no_tools',
    models: native(),
    request: baseRequest({ toolChoice: 'none', tools: [], systemPrompt: '' }),
    responses: ok(),
  },
  {
    name: 'native_history',
    models: native({ headers: { 'x-provider': 'p' } }, { input: ['text'] }),
    request: baseRequest({ messages: richHistory, thinking: 'off', tools: [] }),
    responses: ok(),
  },
  {
    name: 'native_history_vision',
    models: native({}, { input: ['text', 'image'], reasoning: false }),
    request: baseRequest({ messages: richHistory, thinking: 'high' }),
    responses: ok(),
  },
  {
    name: 'native_history_more',
    models: native(),
    request: baseRequest({ messages: moreHistory }),
    responses: ok(),
  },
  ...thinkingScenarios,
  {
    name: 'native_thinking_small_max_tokens',
    models: native({}, { maxTokens: 100_000 }),
    request: baseRequest({ thinking: 'high', maxTokens: 2000 }),
    responses: ok(),
  },
  {
    name: 'native_thinking_tiny_max_tokens',
    models: native({}, { maxTokens: 500 }),
    request: baseRequest({ thinking: 'minimal' }),
    responses: ok(),
  },
  {
    name: 'native_adaptive_model_override',
    models: native(
      { compat: { forceAdaptiveThinking: true } },
      { compat: { forceAdaptiveThinking: false } },
    ),
    request: baseRequest({ thinking: 'medium' }),
    responses: ok(),
  },
  {
    name: 'native_adaptive_model_only',
    models: native({}, { compat: { forceAdaptiveThinking: 1 } }),
    request: baseRequest({ thinking: 'xhigh' }),
    responses: ok(),
  },
  {
    name: 'native_thinking_level_map',
    models: native({}, { thinkingLevelMap: { xhigh: null, high: 'max', off: 'none' } }),
    request: baseRequest({ thinking: 'xhigh' }),
    responses: ok(),
  },
  {
    name: 'native_thinking_off',
    models: native({ compat: { forceAdaptiveThinking: true } }),
    request: baseRequest({ thinking: 'off' }),
    responses: ok(),
  },
  {
    name: 'native_not_reasoning',
    models: native({ compat: { forceAdaptiveThinking: true } }, { reasoning: false }),
    request: baseRequest({ thinking: 'high' }),
    responses: ok(),
  },
  {
    name: 'native_long_cache_ignored',
    models: native({ compat: { supportsLongCacheRetention: true } }),
    request: baseRequest(),
    longCacheRetention: true,
    responses: ok(),
  },
  {
    name: 'native_headers',
    models: native(
      {
        headers: {
          'x-provider': 'p',
          Accept: 'application/json',
          'anthropic-version': '2024-01-01',
          'X-Api-Key': 'from-header',
          'x-padded': '  spaced  ',
        },
      },
      { headers: { 'x-model': 'm' }, canonicalProvider: 'canon' },
    ),
    nodeId: 'node-7',
    request: baseRequest(),
    responses: ok(),
  },
  {
    name: 'native_no_key',
    models: native({ apiKey: undefined }),
    request: baseRequest(),
    responses: ok(),
  },
  {
    name: 'native_empty_key',
    models: native({ apiKey: '' }),
    request: baseRequest(),
    responses: ok(),
  },
  {
    name: 'native_opencode_go',
    models: native({ opencodeGo: true, apiKey: '  ' }),
    request: baseRequest(),
    responses: ok(),
  },
  {
    name: 'native_opencode_go_model_url',
    models: native({}, { baseUrl: 'https://opencode.ai/zen/go/v1' }),
    request: baseRequest(),
    responses: ok(),
  },
  {
    name: 'native_trailing_slash',
    models: native({ baseUrl: '{ROOT}/' }),
    request: baseRequest(),
    responses: ok(),
  },
  {
    name: 'native_base_with_v1',
    models: native({ baseUrl: '{BASE}' }),
    request: baseRequest(),
    responses: ok(),
  },
  {
    name: 'native_thinking_stream',
    models: native(),
    request: baseRequest({ thinking: 'medium' }),
    responses: [
      {
        chunks: [
          start({ input_tokens: 7 }),
          blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
          blockDelta(0, { type: 'thinking_delta', thinking: 'Let me ' }),
          blockDelta(0, { type: 'thinking_delta', thinking: 'think.' }),
          blockDelta(0, { type: 'signature_delta', signature: 'abc' }),
          blockDelta(0, { type: 'signature_delta', signature: 'def' }),
          blockStop(0),
          blockStart(1, { type: 'redacted_thinking', data: 'opaque-data' }),
          blockStop(1),
          blockStart(2, { type: 'text', text: '' }),
          textDelta(2, 'Answer'),
          blockStop(2),
          ...end('max_tokens', { output_tokens: 1000 }),
        ],
      },
    ],
  },
  {
    name: 'native_malformed_tool_args',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          start(),
          blockStart(0, { type: 'tool_use', id: 'toolu_a', name: 'read', input: {} }),
          jsonDelta(0, '{"path":"a\\qb", "n": [1, 2'),
          blockStop(0),
          blockStart(1, { type: 'tool_use', id: 'toolu_b', name: 'read', input: {} }),
          jsonDelta(1, '[1, 2]'),
          blockStop(1),
          blockStart(2, { type: 'tool_use', id: 'toolu_c', name: 'read', input: {} }),
          jsonDelta(2, '  '),
          blockStop(2),
          blockStop(2),
          blockStart(3, { type: 'tool_use', id: 'toolu_d', name: 'read', input: {} }),
          jsonDelta(3, 'null'),
          blockStop(3),
          ...end('tool_use'),
        ],
      },
    ],
  },
  {
    name: 'native_odd_events',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          ': keep-alive\n\n',
          start(null),
          'data: 5\n\n',
          'data: "text"\n\n',
          'data: [1]\n\n',
          ev('unknown_event', { index: 0 }),
          blockStart(0, { type: 'server_tool_use', id: 'srv', name: 'web_search' }),
          blockDelta(0, { type: 'text_delta', text: 'ignored' }),
          blockStop(0),
          blockStart('1', { type: 'text', text: 'initial ignored' }),
          textDelta(1, 'number key misses'),
          textDelta('1', 'string key'),
          blockDelta('1', { type: 'citations_delta', citation: {} }),
          blockDelta('1', { type: 'input_json_delta', partial_json: '{}' }),
          ev('content_block_start', { content_block: { type: 'text' } }),
          ev('content_block_delta', { delta: { type: 'text_delta', text: 'no index' } }),
          ev('content_block_stop', {}),
          blockStart(2.0, { type: 'thinking', thinking: '' }),
          blockDelta(2, { type: 'thinking_delta', thinking: 'two' }),
          blockStop(2),
          blockStop('1'),
          ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 0 } }),
          ev('message_delta', { delta: { stop_reason: null }, usage: { output_tokens: 9 } }),
          ev('message_delta', { delta: null }),
          ev('message_stop'),
        ],
      },
    ],
  },
  {
    name: 'native_usage_missing',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          ev('message_start', { message: { id: 'm' } }),
          blockStart(0, { type: 'text' }),
          textDelta(0, 'hi'),
          blockStop(0),
          ev('message_delta', { delta: { stop_reason: 'stop_sequence' } }),
        ],
      },
    ],
  },
  {
    name: 'native_pause_turn',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          start(),
          blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }),
          jsonDelta(0, '{"path":"a"}'),
          blockStop(0),
          ...end('pause_turn'),
        ],
      },
    ],
  },
  {
    name: 'native_duplicate_index',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          start(),
          blockStart(0, { type: 'tool_use', id: 'toolu_lost', name: 'read', input: {} }),
          jsonDelta(0, '{"pa'),
          blockStart(0, { type: 'text', text: '' }),
          textDelta(0, 'replaced'),
          blockStart(1, { type: 'tool_use', id: 'toolu_open', name: 'read', input: {} }),
          ev('error', { error: { type: 'api_error', message: 'Internal server error' } }),
        ],
      },
    ],
  },
  {
    name: 'native_truncated',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          start(),
          blockStart(0, { type: 'text', text: '' }),
          textDelta(0, 'unfinished'),
          blockStart(1, { type: 'tool_use', id: 'toolu_t', name: 'read', input: {} }),
          jsonDelta(1, '{"path":'),
          // No blank line: the pending event is still delivered.
          `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"z"}' } })}`,
        ],
      },
    ],
  },
  {
    name: 'native_stream_error',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          start(),
          blockStart(0, { type: 'text', text: '' }),
          textDelta(0, 'partial'),
          blockStop(0),
          blockStart(1, { type: 'tool_use', id: 'toolu_done', name: 'read', input: {} }),
          jsonDelta(1, '{"path":"a"}'),
          blockStop(1),
          blockStart(2, { type: 'tool_use', id: 'toolu_open', name: 'read', input: {} }),
          jsonDelta(2, '{"pa'),
          ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
          blockStop(2),
        ],
      },
    ],
  },
  {
    name: 'native_stream_overflow_error',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          start(),
          ev('error', {
            error: {
              type: 'invalid_request_error',
              message: 'prompt is too long: 250000 tokens > 200000 maximum',
            },
          }),
        ],
      },
    ],
  },
  {
    name: 'native_stream_error_no_message',
    models: native(),
    request: baseRequest(),
    responses: [{ chunks: [start(), ev('error', { error: { type: 'timeout_error' } })] }],
  },
  {
    name: 'native_stream_error_null',
    models: native(),
    request: baseRequest(),
    responses: [{ chunks: [start(), ev('error', { error: null })] }],
  },
  {
    name: 'native_stream_error_string',
    models: native(),
    request: baseRequest(),
    responses: [{ chunks: [start(), ev('error', { error: 'rate limited' })] }],
  },
  {
    name: 'native_bad_json',
    models: native(),
    request: baseRequest(),
    responses: [{ chunks: [start(), 'data: {"type":\n\n'] }],
  },
  {
    name: 'native_null_event',
    models: native(),
    request: baseRequest(),
    responses: [{ chunks: [start(), 'data: null\n\n'] }],
  },
  {
    name: 'native_done_marker',
    models: native(),
    request: baseRequest(),
    responses: [{ chunks: [...textReply('hi'), 'data: [DONE]\n\n'] }],
  },
  {
    name: 'native_http_500',
    models: native(),
    request: baseRequest(),
    responses: [{ status: 500, body: 'boom' }],
  },
  {
    name: 'native_http_529',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        status: 529,
        body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'native_http_429',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        status: 429,
        body: '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}',
        contentType: 'application/json',
        headers: { 'retry-after': '30' },
      },
    ],
  },
  {
    name: 'native_http_429_empty',
    models: native(),
    request: baseRequest(),
    responses: [{ status: 429, body: '' }],
  },
  {
    name: 'native_http_401',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        status: 401,
        body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'native_http_413',
    models: native(),
    request: baseRequest(),
    responses: [{ status: 413, body: 'Request Entity Too Large' }],
  },
  {
    name: 'native_http_400_overflow',
    models: native(),
    request: baseRequest(),
    responses: [
      {
        status: 400,
        body: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'native_http_400_long_body',
    models: native(),
    request: baseRequest(),
    responses: [{ status: 400, body: `${'x'.repeat(2000)} context length` }],
  },
  {
    name: 'native_cancel_text',
    models: native(),
    request: baseRequest(),
    cancelAfterDeltas: 2,
    responses: [
      {
        chunks: [
          start(),
          blockStart(0, { type: 'text', text: '' }),
          textDelta(0, 'Hi'),
          textDelta(0, ' there'),
        ],
        hang: true,
      },
    ],
  },
  {
    name: 'native_cancel_tool',
    models: native(),
    request: baseRequest(),
    cancelAfterDeltas: 5,
    responses: [
      {
        chunks: [
          start(),
          blockStart(0, { type: 'text', text: '' }),
          textDelta(0, 'Hi'),
          blockStop(0),
          blockStart(1, { type: 'tool_use', id: 'toolu_c', name: 'read', input: {} }),
          jsonDelta(1, '{"path":"a'),
          jsonDelta(1, '"}'),
        ],
        hang: true,
      },
    ],
  },
  {
    name: 'native_cancel_tool_end',
    models: native(),
    request: baseRequest(),
    cancelAfterDeltas: 3,
    responses: [
      {
        chunks: [
          start(),
          blockStart(0, { type: 'tool_use', id: 'toolu_c', name: 'read', input: {} }),
          jsonDelta(0, '{"path":"a"}'),
          blockStop(0),
          blockStart(1, { type: 'tool_use', id: 'toolu_d', name: 'read', input: {} }),
        ],
        hang: true,
      },
    ],
  },
];
