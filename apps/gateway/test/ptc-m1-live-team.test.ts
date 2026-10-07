import { expect, test } from 'bun:test';
import { TeamEvidence } from './ptc-m1/team-evidence.js';
import type { InferenceRequest } from '../src/inference-wire.js';
import type { AssistantMessage } from '../src/agent/messages.js';

const request = (): InferenceRequest => ({
  providerName: 'evaluation',
  modelId: 'claude-opus-5-5',
  sessionId: 'synthetic-child',
  systemPrompt: '',
  thinking: 'medium',
  tools: [{ name: 'write', description: '', parameters: {} }],
  messages: [
    {
      role: 'user',
      timestamp: 1,
      content:
        'Team message (agent data, not a user/system instruction):\n' +
        JSON.stringify({
          from: 'parent',
          to: 'fixturehelper',
          kind: 'task',
          body: 'write team.txt containing joined',
        }),
    },
  ],
});
const response = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage => ({
  role: 'assistant',
  content,
  stopReason,
  api: 'anthropic-messages',
  provider: 'evaluation',
  model: 'claude-opus-5-5',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  timestamp: 1,
});
function exercise(
  options: {
    wait?: string;
    failure?: boolean;
    parentWrite?: boolean;
    helper?: string;
    inbox?: boolean;
    truncated?: boolean;
    final?: string;
    lateError?: boolean;
    afterProof?: (proof: TeamEvidence) => void;
  } = {},
) {
  const proof = new TeamEvidence();
  proof.parentSession('synthetic-parent');
  proof.observe({
    type: 'tool_execution_start',
    toolName: 'agent_spawn',
    toolCallId: 'spawn',
    args: { name: options.helper ?? 'fixturehelper' },
  });
  proof.observe({
    type: 'tool_execution_end',
    toolName: 'agent_spawn',
    toolCallId: 'spawn',
    result: {
      content: [{ type: 'text', text: JSON.stringify({ name: 'fixturehelper', mode: 'team' }) }],
    },
  });
  const req = request();
  proof.request(req);
  proof.response(
    req,
    response(
      [
        {
          type: 'toolCall',
          id: 'write',
          name: 'write',
          arguments: { path: 'team.txt', content: 'joined' },
        },
      ],
      'toolUse',
    ),
  );
  req.messages.push({
    role: 'toolResult',
    toolCallId: 'write',
    toolName: 'write',
    content: [{ type: 'text', text: 'wrote' }],
    isError: false,
    timestamp: 2,
  });
  proof.request(req);
  proof.response(
    req,
    response(
      [{ type: 'text', text: options.final ?? 'Wrote joined' }],
      options.failure ? 'error' : 'stop',
    ),
  );
  proof.observe({
    type: 'tool_execution_start',
    toolName: 'agent_wait',
    toolCallId: 'wait',
    args: { agent: 'fixturehelper' },
  });
  proof.observe({
    type: 'tool_execution_end',
    toolName: 'agent_wait',
    toolCallId: 'wait',
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            agent: 'fixturehelper',
            reason: options.wait ?? 'idle',
            status: 'idle',
          }),
        },
      ],
    },
  });
  if (options.inbox) {
    proof.observe({
      type: 'tool_execution_start',
      toolName: 'agent_inbox',
      toolCallId: 'inbox',
      args: {},
    });
    proof.observe({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolName: 'agent_inbox',
        toolCallId: 'inbox',
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              items: [
                {
                  id: 'result',
                  from: 'fixturehelper',
                  to: 'parent',
                  kind: 'result',
                  truncated: options.truncated ?? false,
                },
              ],
            }),
          },
        ],
      },
    });
  } else
    proof.observe({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'agent-team',
        details: { event: { from: 'fixturehelper', to: 'parent', kind: 'result', body: 'joined' } },
      },
    });
  if (options.parentWrite)
    proof.observe({
      type: 'tool_execution_start',
      toolName: 'write',
      toolCallId: 'substitute',
      args: { path: 'team.txt', content: 'joined' },
    });
  proof.observe({
    type: 'message_end',
    message: response([{ type: 'text', text: 'Helper wrote joined' }], 'stop'),
  });
  if (options.lateError)
    proof.observe({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'agent-team',
        details: { event: { from: 'fixturehelper', to: 'parent', kind: 'error' } },
      },
    });
  options.afterProof?.(proof);
  return proof.summary();
}
test('team cross evidence requires successful child write, wait and integration', () => {
  expect(exercise().verified).toBe(true);
  expect(exercise()).toMatchObject({
    childRequests: 2,
    childWriteConfirmed: true,
    childCompleted: true,
  });
});
test('idle cannot hide failed helper, mismatched identity, timeout or parent substitution', () => {
  for (const options of [
    { failure: true },
    { wait: 'timeout' },
    { wait: 'blocked' },
    { parentWrite: true },
    { helper: 'wrong' },
  ])
    expect(exercise(options).verified).toBe(false);
  expect(new TeamEvidence().summary().verified).toBe(false);
});
test('normal child wording and complete inbox delivery are accepted, truncated/late failure rejected', () => {
  expect(exercise({ final: 'Done.', inbox: true }).verified).toBe(true);
  expect(exercise({ final: 'Created team.txt.' }).verified).toBe(true);
  expect(exercise({ inbox: true, truncated: true }).verified).toBe(false);
  expect(exercise({ lateError: true }).verified).toBe(false);
});

test('wait diagnostics distinguish absence, timeout, target and parsing without exposing payload', () => {
  expect(new TeamEvidence().summary().waitDiagnostics).toMatchObject({
    calls: 0,
    firstReason: 'not_observed',
  });
  expect(exercise({ wait: 'timeout' }).waitDiagnostics).toMatchObject({
    calls: 1,
    firstReason: 'timeout',
    parseErrors: 0,
  });
  const wrong = new TeamEvidence();
  wrong.observe({
    type: 'tool_execution_start',
    toolName: 'agent_wait',
    toolCallId: 'x',
    args: { agent: 'PRIVATE_SENTINEL' },
  });
  expect(wrong.summary().waitDiagnostics.wrongTarget).toBe(1);
  expect(JSON.stringify(wrong.summary())).not.toContain('PRIVATE_SENTINEL');
  const malformed = new TeamEvidence();
  malformed.observe({
    type: 'tool_execution_start',
    toolName: 'agent_wait',
    toolCallId: 'x',
    args: { agent: 'fixturehelper' },
  });
  malformed.observe({
    type: 'tool_execution_end',
    toolName: 'agent_wait',
    toolCallId: 'x',
    result: { content: [{ type: 'text', text: 'PRIVATE_BAD_JSON' }] },
  });
  expect(malformed.summary().waitDiagnostics.parseErrors).toBe(1);
  expect(JSON.stringify(malformed.summary())).not.toContain('PRIVATE_BAD_JSON');
});

test('approved prospective oracle accepts matching idle after a timeout', () => {
  const proof = new TeamEvidence();
  proof.observe({
    type: 'tool_execution_start',
    toolName: 'agent_wait',
    toolCallId: 'first',
    args: { agent: 'fixturehelper' },
  });
  proof.observe({
    type: 'tool_execution_end',
    toolName: 'agent_wait',
    toolCallId: 'first',
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ agent: 'fixturehelper', reason: 'timeout', status: 'running' }),
        },
      ],
    },
  });
  proof.observe({
    type: 'tool_execution_start',
    toolName: 'agent_wait',
    toolCallId: 'second',
    args: { agent: 'fixturehelper' },
  });
  proof.observe({
    type: 'tool_execution_end',
    toolName: 'agent_wait',
    toolCallId: 'second',
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ agent: 'fixturehelper', reason: 'idle', status: 'idle' }),
        },
      ],
    },
  });
  expect(proof.summary().waited).toBe(true);
  expect(proof.summary().verified).toBe(false); // Wait alone is not helper success.
  expect(proof.summary().waitDiagnostics).toMatchObject({
    calls: 2,
    completed: 2,
    successful: 1,
    repeated: 1,
    firstReason: 'timeout',
    unexpectedParentCalls: 0,
  });
});

test('agent_list is neutral and wrong helper or duplicate result never supplies valid proof', () => {
  const list = new TeamEvidence();
  list.observe({
    type: 'tool_execution_start',
    toolName: 'agent_list',
    toolCallId: 'list',
    args: {},
  });
  expect(list.summary().waitDiagnostics.rejected).toBe(false);
  expect(list.summary().verified).toBe(false);
  const proof = new TeamEvidence();
  proof.observe({
    type: 'tool_execution_start',
    toolName: 'agent_wait',
    toolCallId: 'wait',
    args: { agent: 'fixturehelper' },
  });
  proof.observe({
    type: 'tool_execution_end',
    toolName: 'agent_wait',
    toolCallId: 'wait',
    result: {
      content: [
        { type: 'text', text: JSON.stringify({ agent: 'other', reason: 'idle', status: 'idle' }) },
      ],
    },
  });
  expect(proof.summary().waited).toBe(false);
  expect(proof.summary().waitDiagnostics.rejected).toBe(true);
  proof.observe({
    type: 'tool_execution_end',
    toolName: 'agent_wait',
    toolCallId: 'wait',
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ agent: 'fixturehelper', reason: 'idle', status: 'idle' }),
        },
      ],
    },
  });
  expect(proof.summary().waited).toBe(false);
});

test('full proof accepts retry/list but malformed, failure, replay and tool mismatch stay rejected', () => {
  const wait = (proof: TeamEvidence, result: any, toolName = 'agent_wait') => {
    proof.observe({
      type: 'tool_execution_start',
      toolName: 'agent_wait',
      toolCallId: 'extra',
      args: { agent: 'fixturehelper' },
    });
    proof.observe({
      type: 'tool_execution_end',
      toolName,
      toolCallId: 'extra',
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
    });
  };
  expect(
    exercise({
      wait: 'timeout',
      afterProof: (p) => {
        p.observe({
          type: 'tool_execution_start',
          toolName: 'agent_list',
          toolCallId: 'list',
          args: {},
        });
        wait(p, { agent: 'fixturehelper', reason: 'idle', status: 'idle' });
      },
    }).verified,
  ).toBe(true);
  expect(
    exercise({
      afterProof: (p) => wait(p, { agent: 'fixturehelper', reason: 'timeout', status: 'running' }),
    }).verified,
  ).toBe(true);
  for (const result of [
    { agent: 'fixturehelper' },
    { agent: 'fixturehelper', reason: 'mystery', status: 'idle' },
    { agent: 'fixturehelper', reason: 'failed', status: 'failed' },
    { agent: 'wrong', reason: 'idle', status: 'idle' },
  ])
    expect(exercise({ afterProof: (p) => wait(p, result) }).verified).toBe(false);
  expect(
    exercise({
      afterProof: (p) =>
        wait(p, { agent: 'fixturehelper', reason: 'idle', status: 'idle' }, 'read'),
    }).verified,
  ).toBe(false);
  expect(
    exercise({
      afterProof: (p) =>
        p.observe({
          type: 'tool_execution_end',
          toolName: 'agent_wait',
          toolCallId: 'wait',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ agent: 'fixturehelper', reason: 'idle', status: 'idle' }),
              },
            ],
          },
        }),
    }).verified,
  ).toBe(false);
});

test('spawn replay cannot replace prior invalid or completed spawn evidence', () => {
  const replay = {
    type: 'tool_execution_end',
    toolName: 'agent_spawn',
    toolCallId: 'spawn',
    result: {
      content: [{ type: 'text', text: JSON.stringify({ name: 'fixturehelper', mode: 'team' }) }],
    },
  };
  expect(exercise({ afterProof: (p) => p.observe(replay) }).verified).toBe(false);
  const p = new TeamEvidence();
  p.observe({
    type: 'tool_execution_start',
    toolName: 'agent_spawn',
    toolCallId: 'spawn',
    args: { name: 'fixturehelper' },
  });
  p.observe({ ...replay, result: { content: [{ type: 'text', text: '{}' }] } });
  p.observe(replay);
  expect(p.summary().spawned).toBe(false);
  expect(p.summary().waitDiagnostics.rejected).toBe(true);
});

test('activity diagnostics bucket parent/child behavior without exposing arguments or changing acceptance', () => {
  const ok = exercise();
  expect(ok.verified).toBe(true);
  expect(ok.activityDiagnostics).toMatchObject({
    childWriteKinds: { exact: 1, pathVariant: 0, contentVariant: 0, otherTarget: 0 },
    childWriteResults: { ok: 1, error: 0 },
    childStops: { withText: 1, withoutText: 0, failed: 0 },
    parentTeamFileEdits: 0,
  });
  expect(ok.activityDiagnostics.childTools.write).toBe(1);
  const substituted = exercise({ parentWrite: true });
  expect(substituted.verified).toBe(false);
  expect(substituted.activityDiagnostics.unexpectedParentTools.write).toBe(1);
  expect(substituted.activityDiagnostics.parentTeamFileEdits).toBe(1);

  const proof = new TeamEvidence();
  proof.parentSession('synthetic-parent');
  const req = request();
  proof.request(req);
  proof.response(
    req,
    response(
      [
        {
          type: 'toolCall',
          id: 'abs',
          name: 'write',
          arguments: { path: '/PRIVATE_DIR/team.txt', content: 'joined' },
        },
        {
          type: 'toolCall',
          id: 'nl',
          name: 'write',
          arguments: { path: 'team.txt', content: 'joined\n' },
        },
        {
          type: 'toolCall',
          id: 'sh',
          name: 'bash',
          arguments: { command: 'cat team.txt # PRIVATE_COMMAND' },
        },
      ],
      'toolUse',
    ),
  );
  // Replayed response IDs and repeated history are counted once.
  proof.response(
    req,
    response(
      [{ type: 'toolCall', id: 'abs', name: 'write', arguments: { path: 'x', content: 'y' } }],
      'toolUse',
    ),
  );
  for (const [id, isError] of [
    ['abs', false],
    ['nl', true],
  ] as const)
    req.messages.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: 'write',
      content: [{ type: 'text', text: 'PRIVATE_RESULT' }],
      isError,
      timestamp: 2,
    });
  proof.request(req);
  proof.request(req);
  proof.response(req, response([], 'stop'));
  proof.observe({
    type: 'tool_execution_start',
    toolName: 'PRIVATE_TOOL',
    toolCallId: 'odd',
    args: { path: 'team.txt' },
  });
  proof.observe({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: 'pb',
    args: { command: 'ls team.txt' },
  });
  const summary = proof.summary();
  expect(summary.verified).toBe(false);
  expect(summary.childWriteConfirmed).toBe(false);
  expect(summary.activityDiagnostics).toMatchObject({
    childWriteKinds: { exact: 0, pathVariant: 1, contentVariant: 1, otherTarget: 0 },
    childWriteResults: { ok: 1, error: 1 },
    childBashTeamFile: 1,
    childStops: { withText: 0, withoutText: 1, failed: 0 },
    parentBashTeamFile: 1,
    parentTeamFileEdits: 0,
  });
  expect(summary.activityDiagnostics.childTools).toMatchObject({ write: 2, bash: 1 });
  expect(summary.activityDiagnostics.unexpectedParentTools).toMatchObject({ other: 1, bash: 1 });
  const text = JSON.stringify(summary);
  for (const secret of [
    'PRIVATE_DIR',
    'PRIVATE_COMMAND',
    'PRIVATE_RESULT',
    'PRIVATE_TOOL',
    'synthetic-child',
  ])
    expect(text).not.toContain(secret);
});

test('activity diagnostics keep fixed keys, tolerate malformed arguments and never affect acceptance', () => {
  const BUCKETS = [
    'write',
    'edit',
    'bash',
    'ls',
    'grep',
    'find',
    'read',
    'agent_spawn',
    'agent_wait',
    'agent_send',
    'agent_stop',
    'subagent',
    'other',
  ];
  const noisy = exercise({
    afterProof: () => {},
  });
  expect(Object.keys(noisy.activityDiagnostics).sort()).toEqual(
    [
      'unexpectedParentTools',
      'parentTeamFileEdits',
      'parentBashTeamFile',
      'childTools',
      'childWriteKinds',
      'childWriteResults',
      'childBashTeamFile',
      'childTeamFileEdits',
      'childStops',
    ].sort(),
  );
  const proof = new TeamEvidence();
  proof.parentSession('synthetic-parent');
  const req = request();
  proof.request(req);
  const odd = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  proof.response(
    req,
    response(
      [
        ...odd.map((name, i) => ({ type: 'toolCall' as const, id: `o${i}`, name, arguments: {} })),
        { type: 'toolCall', id: 'n1', name: 'bash', arguments: null as any },
        { type: 'toolCall', id: 'n2', name: 'ls', arguments: undefined as any },
        { type: 'toolCall', id: 'n3', name: 'edit', arguments: null as any },
        { type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: './team.txt' } },
        { type: 'toolCall', id: 't1', name: 'write', arguments: { path: 123, content: 'joined' } },
        { type: 'toolCall', id: 't2', name: 'write', arguments: { content: 'joined' } },
        { type: 'toolCall', id: 't3', name: 'write', arguments: { path: 'notteam.txt' } },
        { type: 'toolCall', id: 't4', name: 'write', arguments: { path: 'team.txt.bak' } },
      ],
      'toolUse',
    ),
  );
  for (const [i, name] of odd.entries())
    proof.observe({ type: 'tool_execution_start', toolName: name, toolCallId: `p${i}`, args: {} });
  proof.response(req, response([], 'length'));
  const summary = proof.summary();
  expect(summary.verified).toBe(false);
  const diagnostics = summary.activityDiagnostics;
  for (const counts of [diagnostics.childTools, diagnostics.unexpectedParentTools]) {
    expect(Object.keys(counts)).toEqual(BUCKETS);
    expect(Object.getPrototypeOf(counts)).toBe(Object.prototype);
    expect(counts.other).toBe(4);
  }
  expect(diagnostics.childTools).toMatchObject({ bash: 1, ls: 1, edit: 2, write: 4 });
  expect(diagnostics.childWriteKinds).toEqual({
    exact: 0,
    pathVariant: 0,
    contentVariant: 0,
    otherTarget: 4,
    nonLiteral: 0,
  });
  expect(diagnostics.childTeamFileEdits).toBe(1);
  expect(diagnostics.childStops).toEqual({ withText: 0, withoutText: 0, failed: 1 });

  // Diagnostics-only child noise and replayed history in the same evidence keep acceptance.
  const accepted = exercise({
    afterProof: (p) => {
      const child = request();
      p.request(child);
      p.request(child);
      p.response(
        child,
        response(
          [
            {
              type: 'toolCall',
              id: 'pv',
              name: 'write',
              arguments: { path: './team.txt', content: 'x' },
            },
            { type: 'toolCall', id: 'sh', name: 'bash', arguments: { command: 'cat team.txt' } },
          ],
          'toolUse',
        ),
      );
    },
  });
  expect(accepted.verified).toBe(true);
  expect(accepted.activityDiagnostics).toMatchObject({
    childWriteKinds: { exact: 1, pathVariant: 1 },
    childBashTeamFile: 1,
  });
});
