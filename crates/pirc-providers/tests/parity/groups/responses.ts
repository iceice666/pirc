/** pi-ai `openai-responses` (with `openai-responses-shared`) behind pi-adapter. */
import {
  assistant,
  baseRequest,
  data,
  DONE,
  fakeModels,
  type Json,
  richHistory,
  type Scenario,
} from '../common.ts';

/** A Responses SSE event, named as OpenAI names them. */
export const ev = (type: string, fields: Json = {}) =>
  `event: ${type}\n${data({ type, ...fields })}`;

export const created = ev('response.created', {
  response: { id: 'resp_1', status: 'in_progress' },
});
export const completed = (response: Json = {}) =>
  ev('response.completed', {
    response: {
      id: 'resp_1',
      status: 'completed',
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: { cached_tokens: 40 },
      },
      ...response,
    },
  });

export function messageEvents(text: string, item: Json = {}): string[] {
  const chars = [...text];
  const half = Math.ceil(chars.length / 2);
  const base = { type: 'message', id: 'msg_1', role: 'assistant', ...item };
  return [
    ev('response.output_item.added', {
      output_index: 0,
      item: { ...base, status: 'in_progress', content: [] },
    }),
    ev('response.content_part.added', { part: { type: 'output_text', text: '', annotations: [] } }),
    ...[chars.slice(0, half), chars.slice(half)]
      .filter((part) => part.length)
      .map((part) => ev('response.output_text.delta', { delta: part.join('') })),
    ev('response.output_item.done', {
      item: {
        ...base,
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    }),
  ];
}

export function toolEvents(callId: string, itemId: string, name: string, args: Json): string[] {
  const text = JSON.stringify(args);
  const item = { type: 'function_call', id: itemId, call_id: callId, name };
  return [
    ev('response.output_item.added', { item: { ...item, arguments: '', status: 'in_progress' } }),
    ev('response.function_call_arguments.delta', { delta: text.slice(0, 5) }),
    ev('response.function_call_arguments.delta', { delta: text.slice(5) }),
    ev('response.function_call_arguments.done', { arguments: text }),
    ev('response.output_item.done', { item: { ...item, arguments: text, status: 'completed' } }),
  ];
}

export const reasoningEvents = (summary: string[], item: Json = {}): string[] => [
  ev('response.output_item.added', {
    item: { type: 'reasoning', id: 'rs_1', summary: [], ...item },
  }),
  ...summary.flatMap((text) => [
    ev('response.reasoning_summary_part.added', { part: { type: 'summary_text', text: '' } }),
    ev('response.reasoning_summary_text.delta', { delta: text.slice(0, 3) }),
    ev('response.reasoning_summary_text.delta', { delta: text.slice(3) }),
    ev('response.reasoning_summary_part.done', { part: { type: 'summary_text', text } }),
  ]),
  ev('response.output_item.done', {
    item: {
      type: 'reasoning',
      id: 'rs_1',
      summary: summary.map((text) => ({ type: 'summary_text', text })),
      encrypted_content: 'enc',
      ...item,
    },
  }),
];

export const textReply = (text: string) => [created, ...messageEvents(text), completed()];

const models = (provider: Json = {}, model: Json = {}) =>
  fakeModels({ api: 'openai-responses', ...provider }, model);

/** A history replayed to the same model (api, provider and id match). */
export const sameModelHistory = (api: string) => [
  { role: 'user', content: 'hi', timestamp: 1 },
  assistant(
    [
      {
        type: 'thinking',
        thinking: 'thought',
        signature: JSON.stringify({
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'thought' }],
          encrypted_content: 'enc',
        }),
      },
      {
        type: 'thinking',
        thinking: '',
        signature: '{"type":"reasoning","id":"rs_2","summary":[]}',
      },
      { type: 'thinking', thinking: 'hidden', redacted: true },
      {
        type: 'text',
        text: 'Answer',
        textSignature: JSON.stringify({ v: 1, id: 'msg_a', phase: 'final_answer' }),
      },
      {
        type: 'text',
        text: 'Comment',
        textSignature: JSON.stringify({ v: 1, id: 'msg_c', phase: 'other' }),
      },
      { type: 'text', text: 'Legacy', textSignature: 'msg_legacy' },
      { type: 'text', text: 'Long', textSignature: 'm'.repeat(70) },
      { type: 'text', text: '', textSignature: '{bad json' },
      { type: 'toolCall', id: 'call_1|fc_1', name: 'read', arguments: { path: 'a', n: 1 } },
      { type: 'toolCall', id: 'call_2|rs_odd', name: 'read', arguments: {} },
    ],
    { api, stopReason: 'toolUse' },
  ),
  {
    role: 'toolResult',
    toolCallId: 'call_1|fc_1',
    toolName: 'read',
    content: [{ type: 'text', text: 'one' }],
    isError: false,
    timestamp: 3,
  },
  {
    role: 'toolResult',
    toolCallId: 'call_2|rs_odd',
    toolName: 'read',
    content: [
      { type: 'text', text: 'two' },
      { type: 'image', data: 'EEEE', mimeType: 'image/png' },
    ],
    isError: false,
    timestamp: 4,
  },
  // Same provider and API, another model: function call item ids are dropped.
  assistant(
    [
      { type: 'text', text: 'other model' },
      { type: 'toolCall', id: 'call_3|fc_3', name: 'read', arguments: {} },
      { type: 'toolCall', id: 'call_4|item 4', name: 'read', arguments: {} },
    ],
    { api, model: 'gpt-old', stopReason: 'toolUse' },
  ),
  {
    role: 'toolResult',
    toolCallId: 'call_3|fc_3',
    toolName: 'read',
    content: [{ type: 'text', text: 'three' }],
    isError: false,
    timestamp: 5,
  },
  // Another provider: item ids are hashed, plain ids sanitized.
  assistant(
    [
      { type: 'toolCall', id: 'call_5|item+5', name: 'read', arguments: {} },
      { type: 'toolCall', id: 'call+6__', name: 'read', arguments: {} },
    ],
    { api: 'openai-completions', provider: 'other', model: 'x', stopReason: 'toolUse' },
  ),
  {
    role: 'toolResult',
    toolCallId: 'call_5|item+5',
    toolName: 'read',
    content: [{ type: 'text', text: 'five' }],
    isError: false,
    timestamp: 6,
  },
  { role: 'user', content: 'next', timestamp: 9 },
];

export const scenarios: Scenario[] = [
  {
    name: 'resp_text',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: textReply('Hello from the fake model.') }],
  },
  {
    name: 'resp_tool',
    models: models(),
    request: baseRequest({ toolChoice: 'auto', maxTokens: 500 }),
    responses: [
      {
        chunks: [
          created,
          ...toolEvents('call_1', 'fc_1', 'read', { path: 'a.txt' }),
          completed(),
          DONE,
        ],
      },
    ],
  },
  {
    name: 'resp_tool_args',
    models: models(),
    request: baseRequest({ toolChoice: 'none' }),
    responses: [
      {
        chunks: [
          created,
          // Malformed streamed arguments; done extends them.
          ev('response.output_item.added', {
            item: {
              type: 'function_call',
              id: 'fc_a',
              call_id: 'c_a',
              name: 'read',
              arguments: '{"pa',
            },
          }),
          ev('response.function_call_arguments.delta', { delta: 'th":"a\\qb", "n": [1, 2' }),
          ev('response.function_call_arguments.done', {
            arguments: '{"path":"a\\qb", "n": [1, 2]}',
          }),
          ev('response.output_item.done', {
            item: {
              type: 'function_call',
              id: 'fc_a',
              call_id: 'c_a',
              name: 'read',
              arguments: 'x',
            },
          }),
          // done replaces arguments that are not a continuation.
          ev('response.output_item.added', {
            item: { type: 'function_call', id: 'fc_b', call_id: 'c_b', name: 'write' },
          }),
          ev('response.function_call_arguments.delta', { delta: '{"a":tru' }),
          ev('response.function_call_arguments.done', { arguments: '[1]' }),
          ev('response.output_item.done', {
            item: { type: 'function_call', id: 'fc_b', call_id: 'c_b', name: 'write' },
          }),
          // A call that was never added: reported, but not part of the message.
          ev('response.output_item.done', {
            item: {
              type: 'function_call',
              id: 'fc_c',
              call_id: 'c_c',
              name: 'ls',
              arguments: '{"d":1}',
            },
          }),
          // No streamed arguments: the item's own.
          ev('response.output_item.added', {
            item: { type: 'function_call', id: 'fc_d', call_id: 'c_d', name: 'ls' },
          }),
          ev('response.output_item.done', {
            item: {
              type: 'function_call',
              id: 'fc_d',
              call_id: 'c_d',
              name: 'ls',
              arguments: '{"x":',
            },
          }),
          completed({ usage: { input_tokens: 5, output_tokens: 2 } }),
        ],
      },
    ],
  },
  {
    name: 'resp_reasoning',
    models: models({}, { thinkingLevelMap: { minimal: null, low: 'lo' } }),
    request: baseRequest({ thinking: 'minimal' }),
    responses: [
      {
        chunks: [
          created,
          ...reasoningEvents(['First part', 'Second part']),
          // Raw reasoning text, then an item whose summary is empty.
          ev('response.output_item.added', { item: { type: 'reasoning', id: 'rs_2' } }),
          ev('response.reasoning_summary_text.delta', { delta: 'ignored: no part' }),
          ev('response.reasoning_text.delta', { delta: 'raw ' }),
          ev('response.reasoning_text.delta', { delta: 'thinking' }),
          ev('response.output_item.done', {
            item: {
              type: 'reasoning',
              id: 'rs_2',
              summary: [],
              content: [{ type: 'reasoning_text', text: 'raw thinking' }],
            },
          }),
          ev('response.output_item.added', { item: { type: 'reasoning', id: 'rs_3' } }),
          ev('response.reasoning_text.delta', { delta: 'kept' }),
          ev('response.output_item.done', { item: { type: 'reasoning', id: 'rs_3' } }),
          // A commentary message with a refusal part and an ignored part type.
          ev('response.output_item.added', {
            item: {
              type: 'message',
              id: 'msg_2',
              role: 'assistant',
              content: [],
              phase: 'commentary',
            },
          }),
          ev('response.output_text.delta', { delta: 'dropped: no part yet' }),
          ev('response.content_part.added', { part: { type: 'reasoning_text', text: '' } }),
          ev('response.output_text.delta', { delta: 'dropped: still no part' }),
          ev('response.content_part.added', { part: { type: 'output_text', text: '' } }),
          ev('response.output_text.delta', { delta: 'Hi. ' }),
          ev('response.refusal.delta', { delta: 'dropped: wrong part' }),
          ev('response.content_part.added', { part: { type: 'refusal', refusal: '' } }),
          ev('response.refusal.delta', { delta: 'No.' }),
          ev('response.output_item.done', {
            item: {
              type: 'message',
              id: 'msg_2',
              role: 'assistant',
              phase: 'commentary',
              content: [
                { type: 'output_text', text: 'Hi. ' },
                { type: 'refusal', refusal: 'No.' },
              ],
            },
          }),
          // An unknown item type changes nothing.
          ev('response.output_item.added', { item: { type: 'web_search_call', id: 'ws_1' } }),
          ev('response.output_text.delta', { delta: 'dropped: block closed' }),
          ev('response.output_item.done', { item: { type: 'web_search_call', id: 'ws_1' } }),
          completed({ id: 'resp_2', usage: { input_tokens: 7, output_tokens: 3 } }),
        ],
      },
    ],
  },
  {
    name: 'resp_history',
    models: models(),
    request: baseRequest({ messages: richHistory, tools: [], thinking: 'off' }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'resp_history_openai',
    models: models({ piProvider: 'openai' }, { input: ['text', 'image'] }),
    request: baseRequest({ messages: [...richHistory, ...sameModelHistory('openai-responses')] }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'resp_history_fake',
    models: models({}, { input: ['text', 'image'] }),
    request: baseRequest({
      messages: sameModelHistory('openai-responses'),
      tools: [],
      toolChoice: 'auto',
    }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'resp_bad_signature',
    models: models(),
    request: baseRequest({
      messages: [
        assistant([{ type: 'thinking', thinking: 'x', signature: 'reasoning_content' }], {
          api: 'openai-responses',
        }),
        { role: 'user', content: 'again', timestamp: 3 },
      ],
    }),
    responses: [],
  },
  {
    name: 'resp_thinking_xhigh',
    models: models({}, { thinkingLevelMap: { xhigh: 'max' } }),
    request: baseRequest({ thinking: 'xhigh' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_thinking_xhigh_unmapped',
    models: models(),
    request: baseRequest({ thinking: 'xhigh' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_thinking_off_mapped',
    models: models({}, { thinkingLevelMap: { off: 'minimal' } }),
    request: baseRequest({ thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_thinking_off_null',
    models: models({}, { thinkingLevelMap: { off: null } }),
    request: baseRequest({ thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_not_reasoning',
    models: models({}, { reasoning: false }),
    request: baseRequest({ thinking: 'high' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_no_system_prompt',
    models: models(),
    request: baseRequest({ systemPrompt: '', maxTokens: 0 }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_copilot',
    models: models({ piProvider: 'github-copilot' }),
    request: baseRequest({
      thinking: 'off',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
          timestamp: 1,
        },
        assistant([{ type: 'text', text: 'seen' }]),
      ],
    }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_copilot_user',
    models: models({ piProvider: 'github-copilot' }),
    request: baseRequest(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_headers',
    models: models(
      {
        headers: { 'x-provider': 'p', authorization: 'Bearer override', session_id: 'mine' },
        compat: { sendSessionIdHeader: false },
      },
      { headers: { 'x-model': 'm' }, canonicalProvider: 'canon' },
    ),
    nodeId: 'node-7',
    request: baseRequest(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_session_header',
    models: models({ headers: { Session_Id: 'mine' } }, { compat: { sendSessionIdHeader: null } }),
    request: baseRequest(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_long_cache',
    models: models(),
    request: baseRequest(),
    longCacheRetention: true,
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_long_cache_unsupported',
    models: models({ compat: { supportsLongCacheRetention: false } }),
    request: baseRequest(),
    longCacheRetention: true,
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_opencode_go',
    models: models({ opencodeGo: true, apiKey: '  ' }),
    request: baseRequest(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'resp_missing_managed_key',
    models: models({ piProvider: 'openai', apiKey: undefined }),
    request: baseRequest(),
    responses: [],
  },
  {
    name: 'resp_cloudflare_unset',
    models: models({
      piProvider: 'cloudflare-ai-gateway',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/{PIRC_PARITY_UNSET_VAR}/g/openai',
    }),
    request: baseRequest(),
    responses: [],
  },
  {
    name: 'resp_http_500',
    models: models(),
    request: baseRequest(),
    responses: [{ status: 500, body: 'boom' }],
  },
  {
    name: 'resp_http_429',
    models: models(),
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
    name: 'resp_http_400_overflow',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        status: 400,
        body: JSON.stringify({
          error: { message: 'Your input exceeds the context window of this model.' },
        }),
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'resp_http_413',
    models: models(),
    request: baseRequest(),
    responses: [{ status: 413, body: 'Request Entity Too Large' }],
  },
  {
    name: 'resp_stream_error',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          created,
          ...messageEvents('Hello').slice(0, 3),
          ev('error', { code: 'rate_limit_exceeded', message: 'Rate limit reached' }),
          completed(),
        ],
      },
    ],
  },
  {
    name: 'resp_stream_error_undefined',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, ev('error', {})] }],
  },
  {
    name: 'resp_stream_api_error',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, data({ error: { message: 'prompt is too long' } })] }],
  },
  {
    name: 'resp_failed',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          created,
          ev('response.failed', {
            response: {
              status: 'failed',
              error: { code: 'context_length_exceeded', message: 'Too many tokens.' },
            },
          }),
        ],
      },
    ],
  },
  {
    name: 'resp_failed_incomplete',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          created,
          ev('response.failed', { response: { incomplete_details: { reason: 'quota' } } }),
        ],
      },
    ],
  },
  {
    name: 'resp_failed_unknown',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, ev('response.failed', { response: {} })] }],
  },
  {
    name: 'resp_incomplete',
    models: models(),
    request: baseRequest(),
    responses: [
      { chunks: [created, ...messageEvents('cut'), completed({ status: 'incomplete' })] },
    ],
  },
  {
    name: 'resp_status_failed',
    models: models(),
    request: baseRequest(),
    responses: [
      { chunks: [created, ...messageEvents('partial'), completed({ status: 'cancelled' })] },
    ],
  },
  {
    name: 'resp_status_unknown',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, ...messageEvents('x'), completed({ status: 'weird' })] }],
  },
  {
    name: 'resp_status_queued_tool',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          created,
          ...toolEvents('c', 'fc', 'read', {}),
          completed({ status: 'queued', usage: null, id: '' }),
          // Events after completion still count; [DONE] ends the stream.
          ...messageEvents('late'),
          DONE,
          ...messageEvents('ignored'),
        ],
      },
    ],
  },
  {
    name: 'resp_thread_event',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          'event: thread.message.delta\ndata: {"type":"response.output_item.added","item":{"type":"message"}}\n\n',
          ...textReply('hi'),
        ],
      },
    ],
  },
  {
    name: 'resp_null_event',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, 'data: 5\n\n', 'data: null\n\n', completed()] }],
  },
  {
    name: 'resp_created_without_response',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [ev('response.created')] }],
  },
  {
    name: 'resp_truncated',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, ...messageEvents('Hello there').slice(0, 3)] }],
  },
  {
    name: 'resp_bad_json',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, ...messageEvents('a').slice(0, 2), 'data: {not json\n\n'] }],
  },
  {
    name: 'resp_cancel',
    models: models(),
    request: baseRequest(),
    cancelAfterDeltas: 2,
    responses: [{ chunks: [created, ...messageEvents('Hello there').slice(0, 4)], hang: true }],
  },
  {
    name: 'resp_cancel_tool',
    models: models(),
    request: baseRequest(),
    cancelAfterDeltas: 6,
    responses: [
      {
        chunks: [
          created,
          ...messageEvents('Hi'),
          ...toolEvents('c', 'fc', 'read', { path: 'a' }).slice(0, 2),
        ],
        hang: true,
      },
    ],
  },
];
