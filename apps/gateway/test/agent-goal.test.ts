import { afterEach, describe, expect, it } from 'bun:test';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});
const start = async (options?: Parameters<typeof startAgent>[0]) => {
  const agent = await startAgent(options);
  agents.push(agent);
  return agent;
};
const texts = (body: any): string[] =>
  body.messages
    .filter((m: any) => m.role === 'user')
    .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
const toolResult = (body: any, id: string): string => {
  const message = body.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === id);
  return typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content);
};
const goalWidget = (agent: AgentProcess) =>
  agent.events.findLast(
    (e) => e.type === 'extension_ui_request' && e.method === 'setWidget' && e.widgetKey === 'goal',
  )?.widgetLines;
/** Wait until the agent has made `count` model requests and is idle again. */
const idleAfter = async (agent: AgentProcess, count: number) => {
  for (let i = 0; i < 400 && agent.llm.requests.length < count; i++) await Bun.sleep(10);
  for (let i = 0; i < 400; i++) {
    const state = await agent.send({ type: 'get_state' });
    if (!state.data.isStreaming && agent.llm.requests.length >= count) {
      await Bun.sleep(50);
      const again = await agent.send({ type: 'get_state' });
      if (!again.data.isStreaming) return;
    }
    await Bun.sleep(10);
  }
  throw new Error('agent did not go idle');
};

describe('goal', () => {
  it('continues in rounds until the model marks the goal complete', async () => {
    const agent = await start();
    agent.llm.push(
      { tool: { id: 'c1', name: 'create_goal', args: { objective: 'Ship feature X' } } },
      { text: 'first slice done' },
      // Round 1: the model reads the goal and completes it.
      { tool: { id: 'g1', name: 'get_goal', args: {} } },
      {
        dynamic: (body) => {
          const id = /Goal ([0-9a-f]+) \(revision (\d+)\)/.exec(toolResult(body, 'g1'))!;
          return {
            tool: {
              id: 'u1',
              name: 'update_goal',
              args: { goal_id: id[1], revision: Number(id[2]), action: 'complete' },
            },
          };
        },
      },
      { text: 'all done' },
    );
    await agent.send({ type: 'prompt', message: 'build feature X until it ships' });
    await idleAfter(agent, 5);
    expect(agent.llm.requests).toHaveLength(5);
    const round = texts(agent.llm.requests[2]!.body).at(-1)!;
    expect(round).toContain('Goal continuation round 1');
    expect(round).toContain('Objective: Ship feature X');
    expect(toolResult(agent.llm.requests[4]!.body, 'u1')).toContain('— complete');
    expect(goalWidget(agent)![0]).toBe('GOAL · complete · 1');
    // Complete: no further rounds.
    await Bun.sleep(150);
    expect(agent.llm.requests).toHaveLength(5);
  });

  it('pauses at the round limit', async () => {
    const agent = await start();
    agent.llm.push(
      {
        tool: {
          id: 'c1',
          name: 'create_goal',
          args: { objective: 'Loop', max_goal_rounds: 2 },
        },
      },
      { text: 'start' },
      { text: 'round one' },
      { text: 'round two' },
    );
    await agent.send({ type: 'prompt', message: 'loop' });
    await idleAfter(agent, 4);
    await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.method === 'notify' &&
        /continuation rounds/.test(e.message),
    );
    expect(agent.llm.requests).toHaveLength(4);
    expect(goalWidget(agent)).toEqual([
      'GOAL · paused · 2/2',
      'Loop',
      'Used all 2 continuation rounds.',
    ]);
  });

  it('rejects human-only actions and early blocked during continuation rounds', async () => {
    const agent = await start({ config: { features: { goal: { minBlockedRounds: 3 } } } });
    // The reference the latest continuation message hands the model.
    const ref = (body: any, _id: string) => {
      const match = /\(goal ([0-9a-f]+), revision (\d+)\)/.exec(
        texts(body).findLast((text) => text.includes('Goal continuation'))!,
      )!;
      return { goal_id: match[1], revision: Number(match[2]) };
    };
    agent.llm.push(
      {
        tool: {
          id: 'c1',
          name: 'create_goal',
          args: { objective: 'Hard thing', max_goal_rounds: 1 },
        },
      },
      { text: 'started' },
      // Round 1: try to pause (human only), then block too early, then create another.
      {
        dynamic: (body) => ({
          tool: { id: 'p1', name: 'update_goal', args: { ...ref(body, 'c1'), action: 'pause' } },
        }),
      },
      {
        dynamic: (body) => ({
          tool: {
            id: 'b1',
            name: 'update_goal',
            args: { ...ref(body, 'c1'), action: 'blocked', blocked_reason: 'stuck' },
          },
        }),
      },
      { tool: { id: 'c2', name: 'create_goal', args: { objective: 'Another' } } },
      { text: 'ok' },
    );
    await agent.send({ type: 'prompt', message: 'do the hard thing' });
    await idleAfter(agent, 6);
    const last = agent.llm.requests[5]!.body;
    expect(toolResult(last, 'p1')).toContain('requires a direct request from the user');
    expect(toolResult(last, 'b1')).toContain('blocked is rejected before 3 continuation rounds');
    expect(toolResult(last, 'c2')).toContain('requires a direct request from the user');
    expect(agent.llm.requests).toHaveLength(6);
  });

  it('restores an active goal disarmed after a crash until the user resumes it', async () => {
    const first = await start();
    first.llm.push(
      {
        tool: { id: 'c1', name: 'create_goal', args: { objective: 'Survive', max_goal_rounds: 1 } },
      },
      { hang: true },
    );
    await first.send({ type: 'prompt', message: 'go' });
    while (first.llm.requests.length < 2) await Bun.sleep(5);
    first.proc.kill('SIGKILL');
    await first.proc.exited;
    agents.splice(agents.indexOf(first), 1);

    const second = await start({ sessionDir: first.sessionDir, workspace: first.workspace });
    await second.waitFor((e) => e.method === 'setWidget' && e.widgetKey === 'goal');
    expect(goalWidget(second)![0]).toBe('GOAL · active · disarmed · 0/1');
    // A normal prompt does not continue the disarmed goal, but the model sees its state.
    second.llm.push({ text: 'hello' });
    await second.send({ type: 'prompt', message: 'status?' });
    await idleAfter(second, 1);
    await Bun.sleep(150);
    expect(second.llm.requests).toHaveLength(1);
    expect(texts(second.llm.requests[0]!.body).join('\n')).toContain('Disarmed after a restart');
    second.llm.push({ text: 'round one' });
    await second.send({ type: 'prompt', message: '/goal resume' });
    await idleAfter(second, 2);
    expect(texts(second.llm.requests[1]!.body).at(-1)).toContain('Goal continuation round 1 of 1');
    first.llm.stop();
  });

  it('pauses when a run is aborted', async () => {
    const agent = await start();
    agent.llm.push(
      { tool: { id: 'c1', name: 'create_goal', args: { objective: 'Long job' } } },
      { hang: true },
    );
    await agent.send({ type: 'prompt', message: 'long job' });
    while (agent.llm.requests.length < 2) await Bun.sleep(5);
    await agent.send({ type: 'abort' });
    await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' && e.method === 'notify' && /Goal paused/.test(e.message),
    );
    expect(goalWidget(agent)![0]).toBe('GOAL · paused · 0');
    await Bun.sleep(150);
    expect(agent.llm.requests).toHaveLength(2);
  });

  it('restores a goal disarmed after a restart and continues on /goal resume', async () => {
    const first = await start();
    first.llm.push(
      {
        tool: { id: 'c1', name: 'create_goal', args: { objective: 'Persist', max_goal_rounds: 1 } },
      },
      { text: 'started' },
      { text: 'round one' },
    );
    await first.send({ type: 'prompt', message: 'go' });
    await idleAfter(first, 3);
    await first.close();
    agents.splice(agents.indexOf(first), 1);

    const second = await start({ sessionDir: first.sessionDir, workspace: first.workspace });
    // Paused at the limit; raise it and resume.
    await second.send({ type: 'prompt', message: '/goal rounds 2' });
    await second.waitFor((e) => e.method === 'notify' && /round limit set to 2/.test(e.message));
    second.llm.push({ text: 'round two' });
    await second.send({ type: 'prompt', message: '/goal resume' });
    await idleAfter(second, 1);
    const body = second.llm.requests[0]!.body;
    expect(texts(body).at(-1)).toContain('Goal continuation round 2 of 2');
    first.llm.stop();
  });

  it('leaves unfinished-todo nudges to the goal continuation', async () => {
    const agent = await start();
    agent.llm.push(
      { tool: { id: 't1', name: 'todo', args: { action: 'add', text: 'step' } } },
      {
        tool: { id: 'c1', name: 'create_goal', args: { objective: 'Todo', max_goal_rounds: 1 } },
      },
      { text: 'stopping' },
      { text: 'round one' },
      { text: 'reminded' },
    );
    await agent.send({ type: 'prompt', message: 'work' });
    await idleAfter(agent, 5);
    const bodies = agent.llm.requests.map((r) => texts(r.body).at(-1)!);
    // The first stop continues the goal (no todo reminder), the last run is reminded once.
    expect(bodies[3]).toContain('Goal continuation round 1');
    expect(bodies[4]).toContain('1 unfinished todos');
  });
});

describe('goal commands', () => {
  it('creates a goal with /goal set and starts working', async () => {
    const agent = await start({ config: { features: { goal: { defaultMaxRounds: 1 } } } });
    agent.llm.push({ tool: { id: 'g', name: 'get_goal', args: {} } }, { text: 'noted' });
    await agent.send({ type: 'prompt', message: '/goal set Write the docs' });
    await idleAfter(agent, 2);
    const first = texts(agent.llm.requests[0]!.body);
    expect(first.at(-1)).toContain('Goal continuation round 1 of 1');
    expect(toolResult(agent.llm.requests[1]!.body, 'g')).toContain('Objective: Write the docs');
    await agent.waitFor(
      (e) => e.method === 'setWidget' && e.widgetLines?.[0] === 'GOAL · paused · 1/1',
    );
    await agent.send({ type: 'prompt', message: '/goal clear' });
    const confirm = await agent.waitFor((e) => e.method === 'confirm');
    agent.raw({ type: 'extension_ui_response', id: confirm.id, confirmed: true });
    await agent.waitFor((e) => e.method === 'notify' && e.message === 'Goal cleared.');
    expect(goalWidget(agent)).toBeUndefined();
    const commands = await agent.send({ type: 'get_commands' });
    expect(commands.data.commands.map((c: any) => c.name)).toContain('goal');
  });

  it('is disabled by features.goal.enabled = false', async () => {
    const agent = await start({ config: { features: { goal: { enabled: false } } } });
    agent.llm.push({ text: 'hi' });
    await agent.send({ type: 'prompt', message: 'hello' });
    await settledAfter(agent, 0);
    const names = agent.llm.requests[0]!.body.tools.map((t: any) => t.function.name);
    expect(names).not.toContain('create_goal');
  });
});
