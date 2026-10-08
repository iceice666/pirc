import { describe, expect, test } from 'bun:test';
import {
  daemonMessageSchema,
  nodeMessageSchema,
  registrationSchema,
} from '../src/protocol-schema.js';
import { NODE_PROTOCOL_VERSION, type DaemonToNode, type NodeToDaemon } from '../src/protocol.js';

const ledgerKey = '0123456789abcdef';
const register = {
  type: 'register',
  protocol: NODE_PROTOCOL_VERSION,
  role: 'node',
  workspaces: [
    {
      id: 'work',
      displayName: 'Workspace',
      kind: 'directory',
      roles: [{ name: 'reviewer', source: 'workspace', overrides: 'builtin' }],
    },
  ],
} satisfies NodeToDaemon;
const mirror = {
  type: 'memory_mirror',
  ledgerKey,
  offset: 0,
  end: 10,
  lines: [{ type: 'cleared' }],
} satisfies NodeToDaemon;
const terminal = {
  type: 'terminal_open',
  streamId: 'stream',
  user: 'user',
  sessionId: 'session',
  terminalId: 'terminal',
} satisfies DaemonToNode;
const request = {
  type: 'request',
  requestId: 'request',
  data: { method: 'POST', url: '/api/sessions', user: 'user', payload: { title: 'hello' } },
} satisfies DaemonToNode;
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const nodeFrames = [
  register,
  {
    type: 'model_start',
    requestId: 'inference',
    request: {
      providerName: 'provider',
      modelId: 'model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      tools: [],
      thinking: 'off',
      sessionId: 'session',
    },
  },
  { type: 'model_cancel', requestId: 'inference' },
  { type: 'heartbeat' },
  { type: 'response', requestId: 'request', data: { status: 204 } },
  { type: 'response', requestId: 'request', data: { status: 200, body: { ok: true } } },
  { type: 'event', sessionId: 'session', event: { type: 'updated' } },
  { type: 'activity', sessions: [{ id: 'session', run: 'running', writeLease: true }] },
  { type: 'agent_request', requestId: 'request', sessionId: 'session', op: 'memory.search' },
  mirror,
  { ...mirror, reset: true, end: 0, lines: [] },
  { type: 'terminal_frame', streamId: 'stream', frame: { type: 'output', data: 'hello' } },
  { type: 'terminal_closed', streamId: 'stream', code: 1000, reason: 'done' },
] satisfies NodeToDaemon[];
const daemonFrames = [
  {
    type: 'registered',
    protocol: NODE_PROTOCOL_VERSION,
    nodeId: 'node',
    models: { providers: {} },
    mirrors: { [ledgerKey]: 10 },
  },
  { type: 'models', models: { providers: {} } },
  { type: 'memory_mirror_ack', ledgerKey, watermark: 10 },
  { type: 'registration_error', status: 403, code: 'forbidden', message: 'Not allowed' },
  { type: 'heartbeat_ack' },
  request,
  {
    ...request,
    data: { method: 'DELETE', url: '/api/sessions/chat', user: 'user' },
  },
  { ...request, data: { ...request.data, bodyBase64: 'e30=', contentType: 'application/json' } },
  { type: 'agent_response', requestId: 'request', status: 204 },
  { type: 'agent_response', requestId: 'request', status: 200, body: { result: [] } },
  terminal,
  { ...terminal, kind: 'browser' },
  { type: 'terminal_input', streamId: 'stream', message: { type: 'input', data: 'hello' } },
  { type: 'terminal_close', streamId: 'stream' },
  {
    type: 'model_delta',
    requestId: 'inference',
    delta: { type: 'text_delta', contentIndex: 0, delta: 'hi' },
  },
  { type: 'model_error', requestId: 'inference', code: 'cancelled' },
  {
    type: 'model_end',
    requestId: 'inference',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      api: 'openai-chat',
      provider: 'provider',
      model: 'model',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: 'stop',
      timestamp: 1,
    },
  },
] satisfies DaemonToNode[];

describe('node link wire envelopes', () => {
  test.each(nodeFrames)('node → daemon roundtrip: $type', (frame) => {
    const schema = frame.type === 'register' ? registrationSchema : nodeMessageSchema;
    expect(schema.parse(json(frame))).toEqual(frame);
  });

  test.each(daemonFrames)('daemon → node roundtrip: $type', (frame) => {
    expect(daemonMessageSchema.parse(json(frame))).toEqual(frame);
  });

  test('missing protocol remains parseable for the dedicated mismatch response', () => {
    const { protocol: _, ...legacy } = register;
    expect(registrationSchema.parse(legacy)).toEqual(legacy);
    expect(
      registrationSchema.parse({ ...register, protocol: NODE_PROTOCOL_VERSION - 1 }).protocol,
    ).toBe(NODE_PROTOCOL_VERSION - 1);
    expect(registrationSchema.safeParse({ ...register, protocol: '8' }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...register, protocol: 1.5 }).success).toBe(false);
    expect(nodeMessageSchema.safeParse(register).success).toBe(false);
  });

  test('model defaults remain applied; optional terminal kind/body remain absent', () => {
    expect(daemonMessageSchema.parse({ type: 'models', models: {} })).toEqual({
      type: 'models',
      models: { providers: {} },
    });
    expect(daemonMessageSchema.parse(terminal)).not.toHaveProperty('kind');
    expect(
      nodeMessageSchema.parse({ type: 'response', requestId: '', data: { status: 204 } }),
    ).toEqual({ type: 'response', requestId: '', data: { status: 204 } });
    expect(
      daemonMessageSchema.parse({ type: 'agent_response', requestId: 'r', status: 204 }),
    ).not.toHaveProperty('body');
  });

  test('opaque lines, agent operations and terminal payloads stay handler-validated', () => {
    const opaque = { ...mirror, lines: [null, 'bad line', { type: 'future', value: true }] };
    expect(nodeMessageSchema.parse(opaque)).toEqual(opaque);
    for (const op of ['', 'NOT VALID!', 'x'.repeat(1000)]) {
      const frame = {
        type: 'agent_request',
        requestId: 'r',
        sessionId: 's',
        op,
      } satisfies NodeToDaemon;
      expect(nodeMessageSchema.parse(frame)).toEqual(frame);
    }
    // z.unknown() historically accepts absence too; don't tighten the receiving envelope.
    expect(nodeMessageSchema.parse({ type: 'terminal_frame', streamId: '' })).toEqual({
      type: 'terminal_frame',
      streamId: '',
    });
    expect(daemonMessageSchema.parse({ type: 'terminal_input', streamId: '' })).toEqual({
      type: 'terminal_input',
      streamId: '',
    });
  });

  test('unknown envelope keys are stripped rather than rejected', () => {
    expect(nodeMessageSchema.parse({ type: 'heartbeat', future: true })).toEqual({
      type: 'heartbeat',
    });
    expect(daemonMessageSchema.parse({ type: 'heartbeat_ack', future: true })).toEqual({
      type: 'heartbeat_ack',
    });
  });

  test.each([null, [], {}, { type: 'unknown' }, { type: 1 }].map((frame) => ({ frame })))(
    'rejects malformed envelopes: %j',
    ({ frame }) => {
      expect(registrationSchema.safeParse(frame).success).toBe(false);
      expect(nodeMessageSchema.safeParse(frame).success).toBe(false);
      expect(daemonMessageSchema.safeParse(frame).success).toBe(false);
    },
  );

  test.each([
    { ...register, role: 'other' },
    { ...register, workspaces: Array(101).fill(register.workspaces[0]) },
    ...[
      { id: '../work' },
      { displayName: '' },
      { displayName: 'x'.repeat(201) },
      { kind: 'remote' },
      { roles: [{ name: 'Uppercase' }] },
      { roles: [{ name: 'ok', description: 'x'.repeat(501) }] },
      { roles: [{ name: 'ok', models: Array(21).fill('model') }] },
      { roles: [{ name: 'ok', tools: Array(65).fill('tool') }] },
      { roles: Array(51).fill({ name: 'ok' }) },
    ].map((change) => ({ ...register, workspaces: [{ ...register.workspaces[0], ...change }] })),
  ])('rejects invalid registration constraints: %#', (frame) => {
    expect(registrationSchema.safeParse(frame).success).toBe(false);
  });

  test.each([
    { type: 'model_cancel', requestId: '' },
    { type: 'model_cancel', requestId: 'x'.repeat(101) },
    { type: 'response', requestId: 'r', data: { status: 200.5 } },
    { type: 'event', sessionId: 's', event: [] },
    { type: 'activity', sessions: [{ id: 's', run: 'finished' }] },
    { type: 'activity', sessions: Array(10001).fill({ id: 's' }) },
    { ...mirror, ledgerKey: 'ABCDEF0123456789' },
    { ...mirror, offset: -1 },
    { ...mirror, end: 1.5 },
    { ...mirror, lines: Array(10001).fill(null) },
    { type: 'agent_request', requestId: 'r', sessionId: 's', op: 'x'.repeat(1001) },
    { type: 'agent_request', requestId: '', sessionId: 's', op: 'memory.search' },
    { type: 'terminal_closed', streamId: 's', code: 1.5, reason: '' },
  ])('rejects invalid node constraints: %#', (frame) => {
    expect(nodeMessageSchema.safeParse(frame).success).toBe(false);
  });

  test.each([
    { ...request, requestId: '' },
    { ...request, data: { ...request.data, method: 'TRACE' } },
    { ...request, data: { ...request.data, url: '/private' } },
    { ...request, data: { ...request.data, url: '/api/' + 'x'.repeat(8192) } },
    { ...request, data: { ...request.data, contentType: 'x'.repeat(201) } },
    { ...request, data: { ...request.data, user: '' } },
    { ...terminal, kind: 'other' },
    { ...terminal, streamId: '' },
    { type: 'memory_mirror_ack', ledgerKey, watermark: -1 },
    {
      type: 'registered',
      protocol: NODE_PROTOCOL_VERSION,
      nodeId: 'node',
      models: {},
      mirrors: { [ledgerKey]: 1.5 },
    },
    { type: 'agent_response', requestId: 'r', status: 200.5 },
    { type: 'model_error', requestId: 'r', code: 'unknown' },
    {
      type: 'model_delta',
      requestId: 'r',
      delta: { type: 'text_delta', contentIndex: -1, delta: '' },
    },
  ] as unknown[])('rejects invalid daemon constraints: %#', (frame) => {
    expect(daemonMessageSchema.safeParse(frame).success).toBe(false);
  });
});

// Compile-time regressions: permissive input schemas must not weaken outgoing guarantees.
function outboundTypeChecks() {
  // @ts-expect-error Outgoing registration must advertise a protocol.
  const missingProtocol: NodeToDaemon = { type: 'register', role: 'node', workspaces: [] };
  // @ts-expect-error Incoming mirror lines may be opaque, outgoing lines must be semantic ledger entries.
  const badLine: NodeToDaemon = { ...mirror, lines: ['opaque'] };
  // @ts-expect-error Outgoing terminal frames retain the required opaque payload field.
  const missingFrame: NodeToDaemon = { type: 'terminal_frame', streamId: 's' };
  // @ts-expect-error Outgoing terminal input retains the required opaque payload field.
  const missingMessage: DaemonToNode = { type: 'terminal_input', streamId: 's' };
  return [missingProtocol, badLine, missingFrame, missingMessage];
}
void outboundTypeChecks;
