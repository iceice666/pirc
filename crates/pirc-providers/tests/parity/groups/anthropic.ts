/** pi-ai `anthropic-messages` behind pi-adapter (M3). */
import {
  assistant,
  baseRequest,
  type Json,
  readTool,
  richHistory,
  type Scenario,
} from '../common.ts';

/** One Anthropic SSE event (`event:` plus a typed `data:` payload). */
const ev = (type: string, payload: Json = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const messageStart = (usage: Json = {}, id = 'msg_1') =>
  ev('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-real',
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 5,
        ...usage,
      },
    },
  });
const blockStart = (index: number, block: Json) =>
  ev('content_block_start', { index, content_block: block });
const blockDelta = (index: number, delta: Json) => ev('content_block_delta', { index, delta });
const blockStop = (index: number) => ev('content_block_stop', { index });
const messageDelta = (stopReason: Json, usage: Json = { output_tokens: 12 }) =>
  ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage });
const messageStop = ev('message_stop');
const ping = ev('ping');

const textBlock = (index: number, ...parts: string[]) => [
  blockStart(index, { type: 'text', text: '' }),
  ...parts.map((text) => blockDelta(index, { type: 'text_delta', text })),
  blockStop(index),
];
const toolBlock = (index: number, id: string, name: string, ...parts: string[]) => [
  blockStart(index, { type: 'tool_use', id, name, input: {} }),
  ...parts.map((json) => blockDelta(index, { type: 'input_json_delta', partial_json: json })),
  blockStop(index),
];

function textReply(text: string, stopReason = 'end_turn'): string[] {
  const half = Math.ceil(text.length / 2);
  return [
    messageStart(),
    ping,
    ...textBlock(0, text.slice(0, half), text.slice(half)),
    messageDelta(stopReason),
    messageStop,
  ];
}

const toolReply = (id: string, name: string, args: Json) => {
  const json = JSON.stringify(args);
  return [
    messageStart(),
    ...toolBlock(0, id, name, '', json.slice(0, 5), json.slice(5)),
    messageDelta('tool_use'),
    messageStop,
  ];
};

/** A managed Anthropic account (piProvider) on the fake server. */
const models = (provider: Json = {}, model: Json = {}) => ({
  providers: {
    fake: {
      api: 'anthropic-messages',
      piProvider: 'anthropic',
      baseUrl: '{ROOT}',
      apiKey: 'sk-ant-api03-test',
      ...provider,
      models: [
        {
          id: 'claude-sonnet-4-5',
          reasoning: true,
          contextWindow: 200000,
          maxTokens: 32000,
          ...model,
        },
      ],
    },
  },
  defaultModel: { provider: 'fake', id: 'claude-sonnet-4-5', thinking: 'low' },
});
const request = (extra: Json = {}) => baseRequest({ modelId: 'claude-sonnet-4-5', ...extra });
const OAUTH_KEY = 'sk-ant-oat01-subscription';

const bashTool = {
  name: 'bash',
  description: 'Run a command',
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
};
const customTool = {
  name: 'my_tool',
  description: 'Custom',
  parameters: { type: 'object', required: null },
};

/** This model's own turns: signed and redacted thinking are replayed. */
const ownTurn = (content: Json[], extra: Json = {}) =>
  assistant(content, {
    api: 'anthropic-messages',
    model: 'claude-sonnet-4-5',
    stopReason: 'toolUse',
    ...extra,
  });
const replayHistory = [
  { role: 'user', content: 'start', timestamp: 1 },
  ownTurn([
    { type: 'thinking', thinking: 'signed thought', signature: 'sig-1' },
    {
      type: 'thinking',
      thinking: '[Reasoning redacted]',
      signature: 'opaque-data',
      redacted: true,
    },
    { type: 'thinking', thinking: 'unsigned thought', signature: '' },
    { type: 'thinking', thinking: 'blank signature', signature: '   ' },
    { type: 'thinking', thinking: '  ', signature: 'sig-empty-text' },
    { type: 'thinking', thinking: 'no signature' },
    { type: 'thinking', thinking: 'redacted without data', redacted: true },
    { type: 'text', text: 'Reading two files.', textSignature: 'ts' },
    { type: 'text', text: '   ' },
    { type: 'toolCall', id: 'toolu_01|keep', name: 'read', arguments: { path: 'a' } },
    { type: 'toolCall', id: 'toolu_02', name: 'bash', arguments: { command: 'ls' } },
  ]),
  {
    role: 'toolResult',
    toolCallId: 'toolu_01|keep',
    toolName: 'read',
    content: [
      { type: 'text', text: 'alpha' },
      { type: 'text', text: 'beta' },
    ],
    isError: false,
    timestamp: 3,
  },
  {
    role: 'toolResult',
    toolCallId: 'toolu_02',
    toolName: 'bash',
    content: [{ type: 'image', data: 'EEEE', mimeType: 'image/png' }],
    isError: true,
    timestamp: 4,
  },
  ownTurn([{ type: 'text', text: 'Done.' }], { stopReason: 'stop' }),
  // Another canonical provider of the same model id is a different model.
  ownTurn([{ type: 'thinking', thinking: 'elsewhere', signature: 'sig-x' }], {
    canonicalProvider: 'other',
    stopReason: 'stop',
  }),
  ownTurn([{ type: 'toolCall', id: 'toolu_03', name: 'read', arguments: {} }]),
  {
    role: 'toolResult',
    toolCallId: 'toolu_03',
    toolName: 'read',
    content: [],
    isError: false,
    timestamp: 5,
  },
  { role: 'user', content: '   ', timestamp: 5 },
  { role: 'user', content: [{ type: 'text', text: '\n' }], timestamp: 5 },
  {
    role: 'user',
    content: [
      { type: 'text', text: ' ' },
      { type: 'text', text: 'final' },
    ],
    timestamp: 6,
  },
];

const anthropicError = (type: string, message: string) =>
  JSON.stringify({ type: 'error', error: { type, message } });

export const scenarios: Scenario[] = [
  {
    name: 'text',
    models: models(),
    request: request(),
    responses: [{ chunks: textReply('Hello from the fake model.') }],
  },
  {
    name: 'tool',
    models: models(),
    request: request({ toolChoice: 'auto', maxTokens: 500 }),
    responses: [{ chunks: toolReply('toolu_1', 'read', { path: 'a.txt' }) }],
  },
  {
    name: 'tool_choice_none',
    models: models(),
    request: request({ toolChoice: 'none', thinking: 'off' }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'model_api_route',
    models: models(
      { api: 'openai-chat', piProvider: undefined, apiKey: undefined },
      { api: 'anthropic-messages' },
    ),
    request: request({ systemPrompt: '' }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'thinking_stream',
    models: models(),
    request: request({ thinking: 'medium' }),
    responses: [
      {
        chunks: [
          messageStart({}, 'msg_think'),
          blockStart(0, { type: 'thinking', thinking: '' }),
          blockDelta(0, { type: 'thinking_delta', thinking: 'Let me ' }),
          blockDelta(0, { type: 'thinking_delta', thinking: 'think.' }),
          blockDelta(0, { type: 'signature_delta', signature: 'EqQB' }),
          blockDelta(0, { type: 'signature_delta', signature: 'more' }),
          blockStop(0),
          blockStart(1, { type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' }),
          blockStop(1),
          ...textBlock(2, 'Answer'),
          ...toolBlock(3, 'toolu_t', 'read', '{"pa', 'th":"x"}'),
          messageDelta('tool_use', {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: 0,
          }),
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'thinking_minimal_unavailable',
    models: models({}, { thinkingLevelMap: { minimal: null, xhigh: 'max' } }),
    request: request({ thinking: 'minimal' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'thinking_high_unavailable',
    models: models({}, { thinkingLevelMap: { high: null } }),
    request: request({ thinking: 'high' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'thinking_high_capped',
    models: models(),
    request: request({ thinking: 'high', maxTokens: 10000 }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'thinking_xhigh_unmapped',
    models: models(),
    request: request({ thinking: 'xhigh' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'thinking_small_max_tokens',
    models: models(),
    request: request({ thinking: 'high', maxTokens: 1024 }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'thinking_max_tokens_1025',
    models: models(),
    request: request({ thinking: 'minimal', maxTokens: 1025 }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'thinking_off',
    models: models(),
    request: request({ thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'not_reasoning',
    models: models({}, { reasoning: false }),
    request: request({ thinking: 'high', systemPrompt: '' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'adaptive_xhigh',
    models: models(
      {},
      { id: 'claude-opus-4-6', thinkingLevelMap: { xhigh: 'max' }, input: ['text', 'image'] },
    ),
    request: request({ modelId: 'claude-opus-4-6', thinking: 'xhigh' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'adaptive_minimal',
    models: models({}, { id: 'claude-sonnet-4.6' }),
    request: request({ modelId: 'claude-sonnet-4.6', thinking: 'minimal' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'adaptive_mapped_level',
    models: models({}, { id: 'claude-opus-4-7', thinkingLevelMap: { medium: 'custom' } }),
    request: request({ modelId: 'claude-opus-4-7', thinking: 'medium' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'adaptive_xhigh_unmapped',
    models: models({}, { id: 'claude-opus-4.7-20260101' }),
    request: request({ modelId: 'claude-opus-4.7-20260101', thinking: 'xhigh' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'adaptive_small_max_tokens',
    models: models({}, { id: 'claude-opus-4-6' }),
    request: request({ modelId: 'claude-opus-4-6', thinking: 'low', maxTokens: 800 }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'adaptive_off',
    models: models({}, { id: 'claude-opus-4-6' }),
    request: request({ modelId: 'claude-opus-4-6', thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'history_text_only',
    models: models(),
    request: request({ messages: richHistory, tools: [] }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'history_vision',
    models: models({}, { input: ['text', 'image'] }),
    request: request({ messages: richHistory, toolChoice: 'none' }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'history_replay',
    models: models({}, { input: ['text', 'image'] }),
    request: request({ messages: replayHistory, tools: [readTool, bashTool] }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'history_replay_cross_model',
    models: models({}, { id: 'claude-opus-4-6' }),
    request: request({ modelId: 'claude-opus-4-6', messages: replayHistory, tools: [] }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'oauth',
    models: models({ apiKey: OAUTH_KEY }),
    request: request({
      messages: replayHistory,
      tools: [readTool, bashTool, customTool],
      toolChoice: 'auto',
    }),
    responses: [
      {
        chunks: [
          messageStart(),
          ...toolBlock(0, 'toolu_r', 'Read', '{"path":"x"}'),
          ...toolBlock(1, 'toolu_b', 'BASH', '{}'),
          ...toolBlock(2, 'toolu_g', 'Grep', '{}'),
          ...toolBlock(3, 'toolu_m', 'my_tool', '{}'),
          messageDelta('tool_use'),
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'oauth_no_system_no_tools',
    models: models({ apiKey: OAUTH_KEY }, { id: 'claude-opus-4-6' }),
    request: request({ modelId: 'claude-opus-4-6', systemPrompt: '', tools: [] }),
    longCacheRetention: true,
    responses: [
      {
        chunks: [
          messageStart(),
          ...toolBlock(0, 'toolu_r', 'Read', '{"path":"x"}'),
          messageDelta('tool_use'),
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'oauth_headers_override',
    models: models(
      {
        apiKey: ` ${OAUTH_KEY} `,
        headers: { 'anthropic-beta': 'custom-beta', 'User-Agent': 'mine' },
      },
      { compat: { supportsEagerToolInputStreaming: false } },
    ),
    request: request(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'fine_grained_tool_streaming',
    models: models({ compat: { supportsEagerToolInputStreaming: false } }),
    request: request(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'fine_grained_without_tools',
    models: models(
      { compat: { supportsEagerToolInputStreaming: false } },
      { id: 'claude-opus-4-6' },
    ),
    request: request({ modelId: 'claude-opus-4-6', tools: [] }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'eager_streaming_null',
    models: models({ compat: { supportsEagerToolInputStreaming: null } }),
    request: request(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'long_cache',
    models: models(),
    request: request({ messages: replayHistory }),
    longCacheRetention: true,
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'long_cache_unsupported',
    models: models({}, { compat: { supportsLongCacheRetention: false } }),
    request: request(),
    longCacheRetention: true,
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'long_cache_tool_result_last',
    models: models(),
    request: request({
      messages: [
        { role: 'user', content: 'go', timestamp: 1 },
        ownTurn([{ type: 'toolCall', id: 'toolu_9', name: 'read', arguments: {} }]),
      ],
    }),
    longCacheRetention: true,
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'cache_last_image',
    models: models({}, { input: ['text', 'image'] }),
    request: request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', data: 'FFFF', mimeType: 'image/webp' },
          ],
          timestamp: 1,
        },
      ],
    }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'cache_last_assistant',
    models: models(),
    request: request({
      messages: [
        { role: 'user', content: 'go', timestamp: 1 },
        ownTurn([{ type: 'text', text: 'prefill' }], { stopReason: 'stop' }),
      ],
    }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'copilot',
    models: models(
      {
        piProvider: 'github-copilot',
        apiKey: 'copilot-token',
        headers: { 'User-Agent': 'GitHubCopilotChat/0.35.0', 'Editor-Version': 'vscode/1.107.0' },
      },
      { id: 'claude-sonnet-4.5', compat: { supportsEagerToolInputStreaming: false } },
    ),
    request: request({ modelId: 'claude-sonnet-4.5', messages: richHistory }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'copilot_user_turn',
    models: models(
      { piProvider: 'github-copilot', apiKey: 'copilot-token' },
      { id: 'claude-opus-4.6', headers: { 'X-Initiator': 'model-header' } },
    ),
    request: request({ modelId: 'claude-opus-4.6' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'copilot_canonical',
    models: models(
      { piProvider: undefined, api: 'openai-chat', apiKey: OAUTH_KEY },
      { api: 'anthropic-messages', canonicalProvider: 'github-copilot' },
    ),
    request: request({
      messages: [
        { role: 'user', content: 'go', timestamp: 1 },
        ownTurn([{ type: 'text', text: 'prefill' }], { stopReason: 'stop' }),
      ],
    }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'cloudflare_gateway',
    models: models(
      {
        piProvider: 'cloudflare-ai-gateway',
        baseUrl: '{ROOT}/cf/anthropic',
        apiKey: 'cf-key',
        headers: { 'x-extra': '1' },
      },
      {},
    ),
    request: request(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'cloudflare_missing_env',
    models: models({
      piProvider: 'cloudflare-ai-gateway',
      baseUrl: '{ROOT}/v1/{PIRC_PARITY_UNSET_ACCOUNT}/anthropic',
      apiKey: 'cf-key',
    }),
    request: request(),
    responses: [],
  },
  {
    name: 'headers',
    models: models(
      {
        headers: { 'x-provider': 'p', 'X-Api-Key': 'override', accept: 'text/plain' },
      },
      { headers: { 'x-model': 'm', 'x-provider': 'model' }, canonicalProvider: 'canon' },
    ),
    nodeId: 'node-7',
    request: request(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'base_url_slash',
    models: models({ baseUrl: '{ROOT}/proxy/' }),
    request: request(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'opencode_go',
    models: models(
      { opencodeGo: true, apiKey: '  ', piProvider: undefined },
      { api: 'anthropic-messages' },
    ),
    request: request(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'missing_managed_key',
    models: models({ apiKey: undefined }),
    request: request(),
    responses: [],
  },
  {
    name: 'connection_refused',
    models: models({ baseUrl: 'http://127.0.0.1:1' }),
    request: request(),
    responses: [],
  },
  {
    name: 'null_event',
    models: models(),
    request: request(),
    responses: [{ chunks: [messageStart(), 'event: content_block_start\ndata: null\n\n'] }],
  },
  {
    name: 'http_500',
    models: models(),
    request: request(),
    responses: [{ status: 500, body: 'boom' }],
  },
  {
    name: 'http_529_overloaded',
    models: models(),
    request: request(),
    responses: [
      {
        status: 529,
        body: anthropicError('overloaded_error', 'Overloaded'),
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'http_429',
    models: models(),
    request: request(),
    responses: [
      {
        status: 429,
        body: anthropicError('rate_limit_error', 'Number of requests has exceeded your limit'),
        contentType: 'application/json',
        headers: { 'retry-after': '1' },
      },
    ],
  },
  {
    name: 'http_429_empty',
    models: models(),
    request: request(),
    responses: [{ status: 429, body: '' }],
  },
  {
    name: 'http_400_overflow',
    models: models(),
    request: request(),
    responses: [
      {
        status: 400,
        body: anthropicError(
          'invalid_request_error',
          'prompt is too long: 210000 tokens > 200000 maximum',
        ),
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'http_400_top_level_message',
    models: models(),
    request: request(),
    responses: [{ status: 400, body: '{"message":"usage limit hit"}' }],
  },
  {
    name: 'http_401_null',
    models: models(),
    request: request(),
    responses: [{ status: 401, body: 'null' }],
  },
  {
    name: 'http_413',
    models: models(),
    request: request(),
    responses: [{ status: 413, body: 'Request Entity Too Large' }],
  },
  {
    name: 'stream_error_event',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          blockStart(0, { type: 'text', text: '' }),
          blockDelta(0, { type: 'text_delta', text: 'Hel' }),
          `event: error\ndata: ${anthropicError('overloaded_error', 'Overloaded')}\n\n`,
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'stream_rate_limit_event',
    models: models(),
    request: request(),
    responses: [
      { chunks: [`event: error\ndata: ${anthropicError('rate_limit_error', 'slow down')}\n\n`] },
    ],
  },
  {
    name: 'stream_overflow_event',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          `event: error\ndata: ${anthropicError('invalid_request_error', 'prompt is too long')}\n\n`,
        ],
      },
    ],
  },
  {
    name: 'stop_max_tokens',
    models: models(),
    request: request(),
    responses: [{ chunks: textReply('cut', 'max_tokens') }],
  },
  {
    name: 'stop_refusal',
    models: models(),
    request: request(),
    responses: [{ chunks: textReply('no', 'refusal') }],
  },
  {
    name: 'stop_sensitive',
    models: models(),
    request: request(),
    responses: [{ chunks: textReply('no', 'sensitive') }],
  },
  {
    name: 'stop_pause_turn',
    models: models(),
    request: request(),
    responses: [{ chunks: textReply('wait', 'pause_turn') }],
  },
  {
    name: 'stop_sequence',
    models: models(),
    request: request(),
    responses: [{ chunks: textReply('seq', 'stop_sequence') }],
  },
  {
    name: 'stop_unknown',
    models: models(),
    request: request(),
    responses: [{ chunks: textReply('odd', 'model_context_window_exceeded') }],
  },
  {
    name: 'truncated',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          blockStart(0, { type: 'text', text: '' }),
          blockDelta(0, { type: 'text_delta', text: 'Hello' }),
        ],
      },
    ],
  },
  {
    name: 'truncated_tool',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          blockStart(0, { type: 'tool_use', id: 'toolu_x', name: 'read', input: { seed: 1 } }),
          blockStart(1, { type: 'tool_use', id: 'toolu_y', name: 'read', input: { seed: 2 } }),
          blockDelta(1, { type: 'input_json_delta', partial_json: '{"path":"a' }),
        ],
      },
    ],
  },
  {
    name: 'no_message_start',
    models: models(),
    request: request(),
    responses: [{ chunks: [...textBlock(0, 'orphan'), messageDelta('end_turn')] }],
  },
  {
    name: 'not_sse',
    models: models(),
    request: request(),
    responses: [{ status: 200, body: '{"id":"msg"}', contentType: 'application/json' }],
  },
  {
    name: 'trailing_event_without_blank_line',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          ...textBlock(0, 'end'),
          messageDelta('end_turn'),
          'event: message_stop\ndata: {"type":"message_stop"}',
        ],
      },
    ],
  },
  {
    name: 'sse_line_endings',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart().replaceAll('\n', '\r\n'),
          ': comment\revent: content_block_start\rdata: {"type":"content_block_start",',
          '"index":0,"content_block":{"type":"text","text":""}}\r\r',
          'event:content_block_delta\ndata:{"type":"content_block_delta","index":0,\ndata: "delta":{"type":"text_delta","text":"multi"}}\n\n',
          // A CR at the end of a chunk ends the line; the next chunk's LF is a blank line.
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\r',
          '\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"no event"}}\n\n',
          'event: ping\ndata: not json\n\n',
          'event: content_block_stop\nid: 7\nretry: 1\ndata: {"type":"content_block_stop","index":0}\n\n',
          messageDelta('end_turn'),
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'unicode',
    models: models(),
    request: request({
      systemPrompt: 'Système \u2028 ✓',
      messages: [{ role: 'user', content: 'héllo \u{1F600}', timestamp: 1 }],
    }),
    responses: [{ chunks: textReply('café \u{1F600} \u2028 done') }],
  },
  {
    name: 'sse_split_crlf_event',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          ...textBlock(0, 'a'),
          'event: message_delta\r',
          '\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n',
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'bad_json',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          ...textBlock(0, 'a'),
          'event: content_block_delta\ndata: {not json\n\n',
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'repaired_json',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          blockStart(0, { type: 'text', text: '' }),
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tab\there \\q"}}\n\n',
          blockStop(0),
          messageDelta('end_turn'),
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'malformed_tool_args',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          ...toolBlock(0, 'toolu_0', 'read', '{"path":"a\\qb", "n": [1, 2'),
          ...toolBlock(1, 'toolu_1', 'read', '[1]'),
          ...toolBlock(2, 'toolu_2', 'write', '{"a":tru'),
          blockStart(3, { type: 'tool_use', id: 'toolu_3', name: 'read', input: { kept: true } }),
          blockStop(3),
          messageDelta('tool_use'),
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'unknown_blocks_and_indexes',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart({ input_tokens: 0, cache_read_input_tokens: null }),
          blockStart(0, { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} }),
          blockDelta(0, { type: 'input_json_delta', partial_json: '{}' }),
          blockStop(0),
          ...textBlock(1, 'visible'),
          blockDelta(1, { type: 'text_delta', text: ' late' }),
          // A stopped block lost its index, so an event without one finds it.
          ev('content_block_delta', { delta: { type: 'text_delta', text: ' no index' } }),
          blockDelta(9, { type: 'text_delta', text: 'lost' }),
          blockDelta(1, { type: 'citations_delta', citation: {} }),
          blockStart(2, { type: 'thinking', thinking: '' }),
          blockDelta(2, { type: 'text_delta', text: 'mismatch' }),
          blockDelta(2, { type: 'signature_delta', signature: 'sig' }),
          blockStop(2),
          blockStop(2),
          messageDelta(null, { output_tokens: 3, input_tokens: 7 }),
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'message_delta_without_usage',
    models: models(),
    request: request(),
    responses: [
      {
        chunks: [
          messageStart(),
          ...textBlock(0, 'x'),
          ev('message_delta', { delta: { stop_reason: 'end_turn' } }),
          messageStop,
        ],
      },
    ],
  },
  {
    name: 'cancel',
    models: models(),
    request: request(),
    cancelAfterDeltas: 2,
    responses: [
      {
        chunks: [
          messageStart(),
          blockStart(0, { type: 'text', text: '' }),
          blockDelta(0, { type: 'text_delta', text: 'Hello' }),
          blockDelta(0, { type: 'text_delta', text: ' there' }),
        ],
        hang: true,
      },
    ],
  },
  {
    name: 'cancel_tool',
    models: models(),
    request: request(),
    cancelAfterDeltas: 5,
    responses: [
      {
        chunks: [
          messageStart(),
          ...textBlock(0, 'Hi'),
          blockStart(1, { type: 'tool_use', id: 'toolu_c', name: 'read', input: {} }),
          blockDelta(1, { type: 'input_json_delta', partial_json: '{"path":"a' }),
          blockDelta(1, { type: 'input_json_delta', partial_json: '"}' }),
        ],
        hang: true,
      },
    ],
  },
];
