import { afterEach, describe, expect, it } from 'bun:test';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';
import type { Reply } from './fixtures/fake-llm.js';

const agents: AgentProcess[] = [];
const gates: Array<{ release(): void; stop(): void }> = [];
afterEach(async () => {
  for (const gate of gates) gate.release();
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  for (const gate of gates.splice(0)) gate.stop();
});

const texts = (body: any): string =>
  body.messages.map((m: any) => JSON.stringify(m.content)).join('\n');
const isChild = (body: any) =>
  texts(body).includes('Team message (agent data') ||
  texts(body).includes('You are a one-shot subagent');
const parents = (agent: AgentProcess) => agent.llm.requests.filter((r) => !isChild(r.body));
const notices = (agent: AgentProcess) =>
  agent.events.filter((e) => e.type === 'message_end' && e.message.customType === 'agent-team');
const waiting = (agent: AgentProcess, from = 0) =>
  agent.waitFor(
    (e) =>
      agent.events.indexOf(e) >= from &&
      e.type === 'extension_ui_request' &&
      e.method === 'setStatus' &&
      e.statusKey === 'completion-wait' &&
      !!e.statusText,
  );
const start = async () => {
  const agent = await startAgent({
    // The test runner may itself be a delegated agent; this process is the parent.
    env: { PIRC_TEAM_AGENT: '', PIRC_TEAM_MODE: '', PIRC_TEAM_PARENT_PID: '' },
  });
  agents.push(agent);
  return agent;
};

// The child really runs a tool, but cannot finish until the test releases it.
// HTTP request arrival and completion-wait events establish ordering: no sleeps.
function gate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      entered.resolve();
      await released.promise;
      return new Response('released');
    },
  });
  const release = () => released.resolve();
  gates.push({ release, stop: () => server.stop(true) });
  const script = `await fetch('http://127.0.0.1:${server.port}').then(r => r.text())`;
  return {
    entered: entered.promise,
    release,
    reply: {
      tool: {
        id: 'child-gate',
        name: 'bash',
        args: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` },
      },
    } satisfies Reply,
  };
}

function route(agent: AgentProcess, parent: Reply[], child: Reply[]) {
  agent.llm.route = (body) =>
    (isChild(body) ? child.shift() : parent.shift()) ?? { text: 'unexpected extra turn' };
}
const spawn: Reply = {
  tool: { id: 'spawn', name: 'agent_spawn', args: { name: 'helper', task: 'complete gated work' } },
};
const assertSingleRun = (agent: AgentProcess) => {
  expect(agent.events.filter((e) => e.type === 'agent_start')).toHaveLength(1);
  expect(agent.events.filter((e) => e.type === 'agent_end')).toHaveLength(1);
  expect(agent.events.filter((e) => e.type === 'agent_settled')).toHaveLength(1);
};

describe('team completion barrier', () => {
  it('waits for a delayed background result without settling or polling the model', async () => {
    const agent = await start();
    const child = gate();
    route(
      agent,
      [
        { tool: { id: 'spawn', name: 'subagent', args: { task: 'gated work', background: true } } },
        { text: 'interim final' },
        { text: 'integrated background report' },
      ],
      [child.reply, { text: 'gated background report' }],
    );
    await agent.send({ type: 'prompt', message: 'delegate work' });
    const spawned = await agent.waitFor(
      (e) => e.type === 'tool_execution_end' && ['agent_spawn', 'subagent'].includes(e.toolName),
    );
    expect(spawned.result.content, 'spawn must succeed').toBeDefined();
    expect(spawned.isError, JSON.stringify(spawned.result)).toBeFalsy();
    await Promise.all([child.entered, waiting(agent)]);
    // Round-trip commands while blocked also prove the RPC loop remains responsive.
    for (let i = 0; i < 3; i++) {
      const state = await agent.send({ type: 'get_state' });
      expect(state.data.isStreaming).toBe(true);
      expect(parents(agent)).toHaveLength(2);
      expect(agent.events.some((e) => e.type === 'agent_end' || e.type === 'agent_settled')).toBe(
        false,
      );
    }
    child.release();
    await settledAfter(agent, 0);
    expect(parents(agent)).toHaveLength(3);
    expect(texts(parents(agent)[2]!.body)).toContain('gated background report');
    expect(notices(agent)).toHaveLength(1);
    assertSingleRun(agent);
  }, 30_000);

  it('accepts steering while waiting, then settles with a persistent idle teammate', async () => {
    const agent = await start();
    const child = gate();
    route(
      agent,
      [spawn, { text: 'interim' }, { text: 'steering accepted' }, { text: 'integrated' }],
      [child.reply, { text: 'persistent worker report' }],
    );
    await agent.send({ type: 'prompt', message: 'start helper' });
    const spawned = await agent.waitFor(
      (e) => e.type === 'tool_execution_end' && ['agent_spawn', 'subagent'].includes(e.toolName),
    );
    expect(spawned.result.content, 'spawn must succeed').toBeDefined();
    expect(spawned.isError, JSON.stringify(spawned.result)).toBeFalsy();
    await Promise.all([child.entered, waiting(agent)]);
    const from = agent.events.length;
    expect((await agent.send({ type: 'steer', message: 'include the audit detail' })).success).toBe(
      true,
    );
    await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.content?.[0]?.text === 'steering accepted',
    );
    await waiting(agent, from);
    expect(parents(agent)).toHaveLength(3);
    expect(texts(parents(agent)[2]!.body)).toContain('include the audit detail');
    expect(agent.events.some((e) => e.type === 'agent_settled')).toBe(false);
    child.release();
    await settledAfter(agent, 0);
    expect(parents(agent)).toHaveLength(4);
    const panel = await agent.send({ type: 'get_panel_state' });
    expect(panel.data.team.agents.find((a: any) => a.name === 'helper')).toMatchObject({
      mode: 'team',
      status: 'idle',
    });
    assertSingleRun(agent);
  }, 30_000);

  it('holds late results after abort until the next user prompt', async () => {
    const agent = await start();
    const child = gate();
    route(
      agent,
      [spawn, { text: 'interim' }, { text: 'resumed' }, { text: 'integrated late report' }],
      [child.reply, { text: 'late worker report' }],
    );
    await agent.send({ type: 'prompt', message: 'start helper' });
    const spawned = await agent.waitFor(
      (e) => e.type === 'tool_execution_end' && ['agent_spawn', 'subagent'].includes(e.toolName),
    );
    expect(spawned.result.content, 'spawn must succeed').toBeDefined();
    expect(spawned.isError, JSON.stringify(spawned.result)).toBeFalsy();
    await Promise.all([child.entered, waiting(agent)]);
    expect((await agent.send({ type: 'abort' })).success).toBe(true);
    await settledAfter(agent, 0);
    child.release();
    // Team status is emitted after the broker records/delivers the result.
    await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.statusKey === 'agent-team' &&
        e.statusText?.includes('helper:idle'),
    );
    await agent.send({ type: 'get_state' });
    expect(parents(agent)).toHaveLength(2);
    expect(notices(agent)).toHaveLength(0);
    assertSingleRun(agent);
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'now integrate the pending report' });
    await settledAfter(agent, from);
    expect(notices(agent)).toHaveLength(1);
    expect(notices(agent)[0]!.message.content).toContain('late worker report');
    expect(
      parents(agent)
        .slice(2)
        .some((r) => texts(r.body).includes('late worker report')),
    ).toBe(true);
    expect(agent.events.filter((e) => e.type === 'agent_start')).toHaveLength(2);
    expect(agent.events.filter((e) => e.type === 'agent_settled')).toHaveLength(2);
  }, 30_000);

  it('wakes the waiting parent to answer a teammate question in the same run', async () => {
    const agent = await start();
    const child = gate();
    let parentCalls = 0;
    let answered = false;
    const childReplies: Reply[] = [
      child.reply,
      {
        tool: {
          id: 'question',
          name: 'agent_ask',
          args: { to: 'parent', question: 'Which format?' },
        },
      },
      { text: 'waiting for format' },
    ];
    agent.llm.route = (body) => {
      if (isChild(body)) return childReplies.shift() ?? { text: 'finished in approved format' };
      parentCalls++;
      if (parentCalls === 1) return spawn;
      if (parentCalls === 2) return { text: 'interim' };
      const question = notices(agent)
        .map((e) => e.message.details?.event)
        .find((e) => e?.kind === 'question');
      if (question && !answered) {
        answered = true;
        return {
          tool: {
            id: 'answer',
            name: 'agent_reply',
            args: { question_id: question.id, answer: 'Use JSON' },
          },
        };
      }
      return { text: 'integrated teammate progress' };
    };
    await agent.send({ type: 'prompt', message: 'delegate and answer questions' });
    const spawned = await agent.waitFor(
      (e) => e.type === 'tool_execution_end' && ['agent_spawn', 'subagent'].includes(e.toolName),
    );
    expect(spawned.result.content, 'spawn must succeed').toBeDefined();
    expect(spawned.isError, JSON.stringify(spawned.result)).toBeFalsy();
    await Promise.all([child.entered, waiting(agent)]);
    child.release();
    await settledAfter(agent, 0);
    expect(answered).toBe(true);
    const reply = agent.events.find(
      (e) => e.type === 'tool_execution_end' && e.toolName === 'agent_reply',
    );
    expect(reply).toBeDefined();
    expect(reply!.isError).toBeFalsy();
    expect(
      agent.llm.requests
        .filter((r) => isChild(r.body))
        .some((r) => texts(r.body).includes('Use JSON')),
    ).toBe(true);
    expect(
      notices(agent).some((e) => e.message.content.includes('finished in approved format')),
    ).toBe(true);
    assertSingleRun(agent);
  }, 30_000);
});
