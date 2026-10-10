/**
 * pi-ai `openai-codex-responses` over SSE behind pi-adapter. Failed
 * responses are retried inside pi-ai (1 s, 2 s, 4 s), so few scenarios
 * fail over HTTP.
 */
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
import {
  completed,
  created,
  ev,
  messageEvents,
  reasoningEvents,
  sameModelHistory,
  textReply,
  toolEvents,
} from './responses.ts';

/** An access token whose payload `atob` decodes (standard alphabet). */
const jwt = (payload: Json) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=+$/, '')}.sig`;
const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } });

const models = (provider: Json = {}, model: Json = {}) =>
  fakeModels({ api: 'openai-codex-responses', apiKey: token, ...provider }, model);

export const scenarios: Scenario[] = [
  // First, so pi-ai's lazy `node:os` import has settled before a request.
  {
    name: 'codex_bad_token',
    models: models({ apiKey: 'not-a-jwt' }),
    request: baseRequest(),
    responses: [],
  },
  {
    name: 'codex_text',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: textReply('Hello from the fake model.') }],
  },
  {
    name: 'codex_token_without_account',
    models: models({ apiKey: jwt({ 'https://api.openai.com/auth': {} }) }),
    request: baseRequest(),
    responses: [],
  },
  {
    name: 'codex_token_base64url',
    models: models({ apiKey: 'a.-_-_.c' }),
    request: baseRequest(),
    responses: [],
  },
  {
    name: 'codex_numeric_account',
    models: models({
      apiKey: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 12345 } }),
    }),
    request: baseRequest({ maxTokens: 64 }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_tool',
    models: models(),
    request: baseRequest({ toolChoice: 'none' }),
    responses: [
      {
        chunks: [
          created,
          ...reasoningEvents(['Thinking it over']),
          ...toolEvents('call_1', 'fc_1', 'read', { path: 'a.txt' }),
          completed(),
        ],
      },
    ],
  },
  {
    name: 'codex_history',
    models: models({ piProvider: 'openai-codex' }, { input: ['text', 'image'] }),
    request: baseRequest({
      systemPrompt: '',
      toolChoice: 'auto',
      messages: [...richHistory, ...sameModelHistory('openai-codex-responses')],
    }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'codex_history_text_only',
    models: models(),
    request: baseRequest({ messages: richHistory, tools: [] }),
    responses: [{ chunks: textReply('ok') }],
  },
  {
    name: 'codex_thinking_off',
    models: models(),
    request: baseRequest({ thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_thinking_off_mapped',
    models: models({}, { thinkingLevelMap: { off: 'minimal' } }),
    request: baseRequest({ thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_thinking_off_null',
    models: models({}, { thinkingLevelMap: { off: null } }),
    request: baseRequest({ thinking: 'off' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_thinking_xhigh',
    models: models({}, { thinkingLevelMap: { xhigh: 'max', medium: null } }),
    request: baseRequest({ thinking: 'xhigh' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_thinking_skips_null',
    models: models({}, { thinkingLevelMap: { medium: null, high: 'hi' } }),
    request: baseRequest({ thinking: 'medium' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_not_reasoning',
    models: models({}, { reasoning: false }),
    request: baseRequest({ thinking: 'high' }),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_url_codex',
    models: models({ baseUrl: '{ROOT}/backend-api/codex//' }),
    request: baseRequest(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_url_full',
    models: models({}, { baseUrl: '{ROOT}/x/codex/responses' }),
    request: baseRequest(),
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_headers',
    models: models(
      {
        headers: { 'x-provider': 'p', 'OpenAI-Beta': 'mine', originator: 'me' },
        opencodeGo: true,
      },
      { headers: { 'x-model': 'm' }, canonicalProvider: 'canon' },
    ),
    nodeId: 'node-7',
    request: baseRequest(),
    longCacheRetention: true,
    responses: [{ chunks: textReply('hi') }],
  },
  {
    name: 'codex_missing_managed_key',
    models: models({ piProvider: 'openai-codex', apiKey: undefined }),
    request: baseRequest(),
    responses: [],
  },
  {
    name: 'codex_keyless',
    models: models({ apiKey: undefined }),
    request: baseRequest(),
    responses: [],
  },
  {
    name: 'codex_retry_then_ok',
    models: models(),
    request: baseRequest(),
    responses: [
      { status: 500, body: 'boom' },
      { status: 429, body: '{"error":{"message":"slow down"}}', contentType: 'application/json' },
      { chunks: textReply('finally') },
    ],
  },
  {
    name: 'codex_http_400_overflow',
    models: models(),
    request: baseRequest(),
    responses: Array.from({ length: 4 }, () => ({
      status: 400,
      body: JSON.stringify({ error: { message: 'Your input exceeds the context window.' } }),
      contentType: 'application/json',
    })),
  },
  {
    name: 'codex_usage_limit',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        status: 400,
        body: JSON.stringify({
          error: { code: 'usage_limit_reached', plan_type: 'PLUS', resets_at: 1 },
        }),
        contentType: 'application/json',
      },
    ],
  },
  {
    name: 'codex_stream_usage_limit',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          created,
          ...messageEvents('Hello').slice(0, 3),
          ev('error', { code: 'usage_limit_reached', message: 'The usage limit has been reached' }),
        ],
      },
    ],
  },
  {
    name: 'codex_stream_error_bare',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, data({ type: 'error', detail: 'quota' })] }],
  },
  {
    name: 'codex_response_failed',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          created,
          ev('response.failed', { response: { error: { message: 'prompt is too long' } } }),
        ],
      },
    ],
  },
  {
    name: 'codex_response_failed_bare',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, ev('response.failed', {})] }],
  },
  {
    name: 'codex_done_incomplete',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          created,
          ...messageEvents('cut'),
          ev('response.done', {
            response: { id: 'resp_9', status: 'incomplete', usage: { input_tokens: 3 } },
          }),
          // Nothing after the terminal event is read.
          ...messageEvents('ignored'),
          data({ type: 'error', message: 'ignored' }),
        ],
      },
    ],
  },
  {
    name: 'codex_status_failed',
    models: models(),
    request: baseRequest(),
    responses: [
      { chunks: [created, ...messageEvents('partial'), completed({ status: 'failed' })] },
    ],
  },
  {
    name: 'codex_status_unknown',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          created,
          ...toolEvents('c', 'fc', 'read', {}),
          ev('response.incomplete', { response: { status: 'weird' } }),
        ],
      },
    ],
  },
  {
    name: 'codex_events_without_type',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          'data: 5\n\n',
          'data: {"type":7}\n\n',
          ': comment\nevent: x\n\n',
          'data: [DONE]\n\n',
          ...textReply('hi'),
        ],
      },
    ],
  },
  {
    name: 'codex_null_event',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, 'data: null\n\n'] }],
  },
  {
    name: 'codex_multiline_data',
    models: models(),
    request: baseRequest(),
    responses: [
      {
        chunks: [
          'data: {"type":"response.created",\ndata:  "response":{"id":"r_ml"}}\n\n',
          ...messageEvents('ok'),
          completed(),
        ],
      },
    ],
  },
  {
    name: 'codex_crlf',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: textReply('hi').map((chunk) => chunk.replaceAll('\n', '\r\n')) }],
  },
  {
    name: 'codex_truncated',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, ...messageEvents('Hello there').slice(0, 3), 'data: {"ty'] }],
  },
  {
    name: 'codex_bad_json',
    models: models(),
    request: baseRequest(),
    responses: [{ chunks: [created, ...messageEvents('a').slice(0, 2), 'data: {not json\n\n'] }],
  },
  {
    name: 'codex_cancel',
    models: models(),
    request: baseRequest(),
    cancelAfterDeltas: 2,
    responses: [{ chunks: [created, ...messageEvents('Hello there').slice(0, 4)], hang: true }],
  },
  {
    name: 'codex_cancel_tool',
    models: models(),
    request: baseRequest(),
    cancelAfterDeltas: 2,
    responses: [
      {
        chunks: [created, ...toolEvents('c', 'fc', 'read', { path: 'a' }).slice(0, 3)],
        hang: true,
      },
    ],
  },
  {
    name: 'codex_after_done',
    models: models(),
    request: baseRequest({
      messages: [
        assistant([{ type: 'text', text: 'prior' }], { api: 'openai-codex-responses' }),
        { role: 'user', content: 'go', timestamp: 3 },
      ],
    }),
    responses: [{ chunks: [...textReply('hi'), DONE] }],
  },
];
