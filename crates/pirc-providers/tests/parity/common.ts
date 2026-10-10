/**
 * Scenario types and helpers shared by the parity groups (`groups/*.ts`);
 * see record.ts.
 */
export type Json = any;
export type Response =
  | { status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { chunks: string[]; hang?: boolean };

export interface Scenario {
  name: string;
  /**
   * models.json-shaped providers (keys resolved); `{BASE}` is the server's
   * /v1 URL, `{ROOT}` its origin.
   */
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

export const data = (value: Json) => `data: ${JSON.stringify(value)}\n\n`;
export const chunk = (delta: Json, finish: Json = null, extra: Json = {}) =>
  data({ ...extra, choices: [{ index: 0, delta, finish_reason: finish }] });
export const usage = (extra: Json = {}) =>
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
export const DONE = 'data: [DONE]\n\n';

/** The conformance fake LLM's text reply (crates/pirc-conformance/src/fake_llm.rs). */
export function textReply(text: string): string[] {
  const chars = [...text];
  const half = Math.ceil(chars.length / 2);
  const out: string[] = [];
  for (const part of [chars.slice(0, half), chars.slice(half)])
    if (part.length) out.push(chunk({ content: part.join('') }));
  out.push(chunk({}, 'stop'), usage(), DONE);
  return out;
}

/** The conformance fake LLM's tool reply. */
export function toolReply(id: string, name: string, args: Json): string[] {
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

export const fakeModels = (provider: Json = {}, model: Json = {}) => ({
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

export const readTool = {
  name: 'read',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, offset: { type: 'number' } },
    required: ['path'],
  },
};

export const baseRequest = (extra: Json = {}) => ({
  providerName: 'fake',
  modelId: 'fake-model',
  systemPrompt: 'You are a test agent.',
  messages: [{ role: 'user', content: 'Say hello.', timestamp: 1 }],
  tools: [readTool],
  thinking: 'low',
  sessionId: 'session-1',
  ...extra,
});

export const usage0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
export const assistant = (content: Json[], extra: Json = {}) => ({
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
export const richHistory = [
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
