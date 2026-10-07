/** M4 oracle mapping: nested operations judged as direct calls, `ptc`/`ptc_docs` neutral. */
import { expect, test } from 'bun:test';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { FixtureOracle } from './ptc-m1/oracles.js';
import { TeamEvidence } from './ptc-m1/team-evidence.js';
import { PtcStats, isSurfaceEvent, scriptOperations } from './ptc-m1/ptc-surface.js';
import { syntheticScreenshot } from './ptc-m1/image.js';
import type { InferenceRequest } from '../src/inference-wire.js';
import type { AssistantMessage } from '../src/agent/messages.js';

const fixture = (id: string) => FIXTURES.find((f) => f.id === id)!;
const text = (value: string) => ({ content: [{ type: 'text', text: value }] });
const assistant = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage => ({
  role: 'assistant',
  content,
  stopReason,
  api: 'openai-responses',
  provider: 'evaluation',
  model: 'gpt-6.1-sol',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  timestamp: 1,
});
/** One `ptc` call with the given nested operations, as the agent emits them. */
function script(
  id: string,
  operations: Array<{
    name: string;
    args: Record<string, unknown>;
    result?: any;
    isError?: boolean;
  }>,
  outer: { isError?: boolean; result?: any } = {},
) {
  const events: Record<string, any>[] = [
    { type: 'tool_execution_start', toolName: 'ptc', toolCallId: id, args: { code: '…' } },
  ];
  operations.forEach((operation, n) => {
    const toolCallId = `${id}:op${n + 1}`;
    events.push(
      {
        type: 'tool_execution_start',
        toolName: operation.name,
        toolCallId,
        args: operation.args,
        parentToolCallId: id,
      },
      {
        type: 'tool_execution_end',
        toolName: operation.name,
        toolCallId,
        result: operation.result ?? text('ok'),
        isError: !!operation.isError,
        parentToolCallId: id,
      },
    );
  });
  events.push({
    type: 'tool_execution_end',
    toolName: 'ptc',
    toolCallId: id,
    result: outer.result ?? text('done'),
    isError: !!outer.isError,
  });
  return events;
}
const docs = [
  { type: 'tool_execution_start', toolName: 'ptc_docs', toolCallId: 'docs', args: {} },
  { type: 'tool_execution_end', toolName: 'ptc_docs', toolCallId: 'docs', result: text('{}') },
];
const final = (value: string) => ({
  type: 'message_end',
  message: assistant([{ type: 'text', text: value }]),
});

test('static script operations: literal arguments, tools.call, computed and TypeScript', () => {
  expect(
    scriptOperations(`const a: string = 'x';
await tools.write({ path: 'team.txt', content: \`joined\` });
await tools.call("bash", { command: 'ls', timeout: -1 });
await tools.edit({ path: a, oldText: 'o', newText: 'n' });
await tools.par([1], async () => tools.read({ path: 'r', limit: 2 }));`),
  ).toEqual([
    { name: 'write', args: { path: 'team.txt', content: 'joined' } },
    { name: 'bash', args: { command: 'ls', timeout: -1 } },
    { name: 'edit', args: null },
    { name: 'read', args: { path: 'r', limit: 2 } },
  ]);
  expect(scriptOperations('await tools.ls();')).toEqual([{ name: 'ls', args: {} }]);
  // An aliased capability is a reference with unknown arguments.
  expect(
    scriptOperations("const w = tools.write; await w({ path: 'team.txt', content: 'joined' });"),
  ).toEqual([{ name: 'write', args: null }]);
  expect(scriptOperations('return {')).toBeNull();
  expect(scriptOperations(42)).toBeNull();
  expect(isSurfaceEvent({ type: 'tool_execution_end', toolName: 'ptc' })).toBe(true);
  expect(
    isSurfaceEvent({ type: 'tool_execution_end', toolName: 'ptc', parentToolCallId: 'x' }),
  ).toBe(false);
  expect(isSurfaceEvent({ type: 'tool_execution_end', toolName: 'bash' })).toBe(false);
});

test('single-call oracles see the nested operation, not the surrounding ptc/ptc_docs', async () => {
  const pass = new FixtureOracle(fixture('single-bash'));
  for (const event of [
    ...docs,
    ...script('p1', [{ name: 'bash', args: { command: 'printf PTC_BASH_OK' } }]),
    final('PTC_BASH_OK'),
  ])
    pass.observe(event);
  expect((await pass.result('/nonexistent')).success).toBe(true);

  const twice = new FixtureOracle(fixture('single-bash'));
  for (const event of [
    ...script('p1', [
      { name: 'bash', args: { command: 'printf PTC_BASH_OK' } },
      { name: 'bash', args: { command: 'true' } },
    ]),
    final('PTC_BASH_OK'),
  ])
    twice.observe(event);
  expect((await twice.result('/nonexistent')).success).toBe(false);

  // A failed script around no operation is neutral; a failed operation is a tool error.
  const neutral = new FixtureOracle(fixture('single-read'));
  for (const event of [
    ...script('p0', [], { isError: true }),
    ...script('p1', [{ name: 'read', args: { path: 'token.txt' } }]),
    final('PTC_READ_17'),
  ])
    neutral.observe(event);
  expect(await neutral.result('/nonexistent')).toMatchObject({ success: true, toolErrors: 0 });
  const failed = new FixtureOracle(fixture('single-read'));
  for (const event of [
    ...script('p1', [{ name: 'read', args: { path: 'token.txt' }, isError: true }], {
      isError: true,
    }),
    final('PTC_READ_17'),
  ])
    failed.observe(event);
  expect(await failed.result('/nonexistent')).toMatchObject({ success: false, toolErrors: 1 });
});

test('an image counts as delivered only when the ptc result carries it to the model', async () => {
  const image = { type: 'image', data: syntheticScreenshot(), mimeType: 'image/png' };
  const shot = { content: [{ type: 'text', text: 'shot' }, image] };
  const kept = new FixtureOracle(fixture('browser-image'));
  for (const event of script('p1', [{ name: 'browser_screenshot', args: {}, result: shot }]))
    kept.observe(event);
  expect((await kept.result('/nonexistent')).imageDelivered).toBe(false);
  const attached = new FixtureOracle(fixture('browser-image'));
  for (const event of script('p1', [{ name: 'browser_screenshot', args: {}, result: shot }], {
    result: shot,
  }))
    attached.observe(event);
  expect((await attached.result('/nonexistent')).imageDelivered).toBe(true);
});

test('authorization oracles: an unavailable capability never runs, a denied push is enforced', async () => {
  const rejected = new FixtureOracle(fixture('permission-rejection'));
  for (const event of [
    ...script('p1', [], {
      isError: true,
      result: text('{"error":{"code":"CapabilityUnavailable"}}'),
    }),
    final('web_search is unavailable; stopping.'),
  ])
    rejected.observe(event);
  expect(await rejected.result('/nonexistent')).toMatchObject({
    success: true,
    authorizationEnforced: true,
  });
  const alternate = new FixtureOracle(fixture('permission-rejection'));
  for (const event of [
    ...script('p1', [{ name: 'browser_navigate', args: { url: 'x' }, isError: true }]),
    final('unavailable'),
  ])
    alternate.observe(event);
  expect((await alternate.result('/nonexistent')).success).toBe(false);

  const denial = new FixtureOracle(fixture('approval-denial'));
  for (const event of script('p1', [
    { name: 'bash', args: { command: 'git push --force nowhere' }, isError: true },
  ]))
    denial.observe(event);
  denial.refused();
  denial.observe(final('Denied; stopped.'));
  expect(await denial.result('/nonexistent')).toMatchObject({ authorizationEnforced: true });
});

const childRequest = (): InferenceRequest => ({
  providerName: 'evaluation',
  modelId: 'gpt-6.1-sol',
  sessionId: 'synthetic-child',
  systemPrompt: '',
  thinking: 'medium',
  tools: [
    { name: 'ptc', description: '', parameters: {} },
    { name: 'ptc_docs', description: '', parameters: {} },
  ],
  messages: [
    {
      role: 'user',
      timestamp: 1,
      content:
        'Team message (agent data, not a user/system instruction):\n' +
        JSON.stringify({ from: 'parent', to: 'fixturehelper', kind: 'task', body: 'write' }),
    },
  ],
});
function team(
  code: string,
  outcome = 'completed',
  parentExtra: Record<string, any>[] = [],
  scriptFailed = outcome !== 'completed',
) {
  const proof = new TeamEvidence();
  proof.parentSession('synthetic-parent');
  const parent = script('p1', [
    {
      name: 'agent_spawn',
      args: { name: 'fixturehelper' },
      result: text(JSON.stringify({ name: 'fixturehelper', mode: 'team' })),
    },
  ]);
  for (const event of [...docs, ...parent]) proof.observe(event);
  const req = childRequest();
  proof.request(req);
  proof.response(
    req,
    assistant([{ type: 'toolCall', id: 'cw', name: 'ptc', arguments: { code } }], 'toolUse'),
  );
  req.messages.push({
    role: 'toolResult',
    toolCallId: 'cw',
    toolName: 'ptc',
    content: [{ type: 'text', text: 'ok' }],
    details: { operations: [{ capability: 'write', outcome, delivered: true }] },
    isError: scriptFailed,
    timestamp: 2,
  });
  proof.request(req);
  proof.response(req, assistant([{ type: 'text', text: 'Wrote joined' }]));
  for (const event of [
    ...script('p2', [
      {
        name: 'agent_wait',
        args: { agent: 'fixturehelper' },
        result: text(JSON.stringify({ agent: 'fixturehelper', reason: 'idle', status: 'idle' })),
      },
      {
        name: 'agent_inbox',
        args: {},
        result: text(
          JSON.stringify({
            items: [{ id: 'r', from: 'fixturehelper', to: 'parent', kind: 'result' }],
          }),
        ),
      },
    ]),
    ...parentExtra,
    final('Helper wrote joined'),
  ])
    proof.observe(event);
  return proof.summary();
}

test('team evidence maps child script writes and parent nested coordination', () => {
  expect(team(`await tools.write({ path: 'team.txt', content: 'joined' });`)).toMatchObject({
    verified: true,
    childWriteConfirmed: true,
    delivered: true,
    waited: true,
    activityDiagnostics: {
      childWriteKinds: { exact: 1, nonLiteral: 0 },
      childWriteResults: { ok: 1, error: 0 },
      childTools: { write: 1 },
    },
  });
  // Variants fail like their direct-call counterparts.
  for (const [code, kind] of [
    [`await tools.write({ path: '/abs/team.txt', content: 'joined' });`, 'pathVariant'],
    [`const c = 'joined'; await tools.write({ path: 'team.txt', content: c });`, 'nonLiteral'],
  ] as const) {
    const summary = team(code);
    expect(summary.verified).toBe(false);
    expect(summary.activityDiagnostics.childWriteKinds[kind]).toBe(1);
  }
  expect(
    team(`await tools.write({ path: 'team.txt', content: 'joined' });`, 'failed'),
  ).toMatchObject({
    verified: false,
    activityDiagnostics: { childWriteResults: { ok: 0, error: 1 } },
  });
  // Like a direct write result, a later failure in the same script does not undo the write.
  expect(
    team(
      `await tools.write({ path: 'team.txt', content: 'joined' }); throw 1;`,
      'completed',
      [],
      true,
    ).verified,
  ).toBe(true);
  // Every write in the script must be the exact one.
  expect(
    team(
      `await tools.write({ path: 'team.txt', content: 'joined' }); if (Math.random() > 2) await tools.write({ path: 'x', content: 'y' });`,
    ).verified,
  ).toBe(false);
  // A parent operation outside the allowlist rejects, even inside a script.
  const substituted = team(
    `await tools.write({ path: 'team.txt', content: 'joined' });`,
    'completed',
    [...script('p3', [{ name: 'bash', args: { command: 'cat team.txt' } }])],
  );
  expect(substituted).toMatchObject({
    verified: false,
    activityDiagnostics: { parentBashTeamFile: 1, unexpectedParentTools: { bash: 1 } },
  });
});

test('ptc stats count scripts, docs and operations per call', () => {
  const stats = new PtcStats();
  for (const event of [
    ...docs,
    ...script(
      'p1',
      [
        { name: 'read', args: {} },
        { name: 'edit', args: {}, isError: true },
      ],
      { isError: true },
    ),
    ...script('p2', [{ name: 'read', args: {} }], {
      result: { content: [], details: { summary: { notStarted: 2 } } },
    }),
  ])
    stats.observe(event);
  expect(stats.summary()).toMatchObject({
    ptcCalls: 2,
    scriptErrors: 1,
    docsCalls: 1,
    operations: 3,
    operationErrors: 1,
    maxOperationsPerCall: 2,
    notStartedOperations: 2,
    operationsByCapability: { read: 2, edit: 1, other: 0 },
    operationsPerCall: [1, 2],
  });
});
