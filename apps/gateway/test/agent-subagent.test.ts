import { afterEach, describe, expect, it } from 'bun:test';
import type { Reply } from './fixtures/fake-llm.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const texts = (body: any): string =>
  body.messages
    .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
const isSubagent = (body: any) => texts(body).includes('You are a one-shot subagent');
const isTeammate = (body: any) => texts(body).includes('Team message (agent data');
const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name);
const toolEnd = (agent: AgentProcess, name: string) =>
  agent.events.filter((e) => e.type === 'tool_execution_end' && e.toolName === name);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('subagent tool', () => {
  it('runs a foreground one-shot subagent and returns only its final report', async () => {
    const agent = await startAgent({
      config: {
        features: {
          sessionTitle: { enabled: false },
          agentTeam: { kinds: { explorer: { tools: ['read', 'grep', 'ls'] } } },
        },
      },
    });
    agents.push(agent);
    const child: Reply[] = [
      { tool: { id: 'c1', name: 'ls', args: {} } },
      { text: 'Found nothing interesting.' },
    ];
    const parent: Reply[] = [
      {
        tool: {
          id: 'p1',
          name: 'subagent',
          args: { task: 'look around', kind: 'explorer', name: 'scout' },
        },
      },
      { text: 'parent done' },
    ];
    agent.llm.route = (body) =>
      (isSubagent(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'delegate' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBeFalsy();
    expect(end!.result.content[0].text).toContain('Subagent scout done');
    expect(end!.result.content[0].text).toContain('Found nothing interesting.');
    // The report arrives as the tool result, not as an extra wakeup.
    expect(
      agent.events.some((e) => e.type === 'message_end' && e.message.customType === 'agent-team'),
    ).toBe(false);
    // Kind allowlist applies, and one-shot subagents get no team or spawn tools.
    const childRequest = agent.llm.requests.find((r) => isSubagent(r.body))!;
    expect(toolNames(childRequest.body).sort()).toEqual(['grep', 'ls', 'read']);
    const state = await agent.send({ type: 'get_panel_state' });
    const scout = state.data.team.agents.find((a: any) => a.name === 'scout');
    expect(scout).toMatchObject({
      mode: 'subagent',
      status: 'done',
      tools: ['read', 'grep', 'ls'],
    });
    await Bun.sleep(300);
    expect(alive(scout.pid)).toBe(false);
  }, 30_000);

  it('delivers a background subagent result once when it finishes', async () => {
    const agent = await startAgent();
    agents.push(agent);
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'subagent', args: { task: 'slow work', background: true } } },
      { text: 'started it' },
      { text: 'got the report' },
    ];
    let childCalls = 0;
    agent.llm.route = (body) => {
      if (!isSubagent(body)) return parent.shift() ?? { text: 'extra' };
      childCalls++;
      return childCalls === 1
        ? { tool: { id: 'c1', name: 'bash', args: { command: 'sleep 0.3' } } }
        : { text: 'background report' };
    };
    await agent.send({ type: 'prompt', message: 'delegate in background' });
    const [start] = await Promise.all([
      agent.waitFor((e) => e.type === 'tool_execution_end' && e.toolName === 'subagent'),
    ]);
    const started = JSON.parse(start.result.content[0].text);
    expect(started).toMatchObject({ mode: 'subagent', background: true });
    expect(started.name).toMatch(/^sub-/);
    const wake = await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.customType === 'agent-team',
      15_000,
    );
    expect(wake.message.content).toContain('subagent_result');
    expect(wake.message.content).toContain('background report');
    await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.content?.[0]?.text === 'got the report',
    );
    await Bun.sleep(300);
    const notices = agent.events.filter(
      (e) => e.type === 'message_end' && e.message.customType === 'agent-team',
    );
    expect(notices).toHaveLength(1);
  }, 30_000);

  it('reports a failed subagent as an error result', async () => {
    const agent = await startAgent();
    agents.push(agent);
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'subagent', args: { task: 'break' } } },
      { text: 'noted' },
    ];
    agent.llm.route = (body) =>
      isSubagent(body) ? { status: 400, body: 'bad request' } : (parent.shift() ?? { text: 'x' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'delegate' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBe(true);
    expect(end!.result.content[0].text).toMatch(/failed/);
  }, 30_000);
});

describe('team kinds and results', () => {
  it('keeps coordination tools for restricted teammates and reports once per idle', async () => {
    const agent = await startAgent({
      config: {
        features: {
          sessionTitle: { enabled: false },
          agentTeam: { kinds: { reader: { tools: ['read'] } } },
        },
      },
    });
    agents.push(agent);
    const child: Reply[] = [
      { text: 'thinking out loud', tool: { id: 'c1', name: 'read', args: { path: 'nope' } } },
      { text: 'final teammate answer' },
    ];
    const parent: Reply[] = [
      {
        tool: {
          id: 'p1',
          name: 'agent_spawn',
          args: { name: 'reader', task: 'read', kind: 'reader' },
        },
      },
      { text: 'spawned' },
      { text: 'noted' },
    ];
    agent.llm.route = (body) =>
      (isTeammate(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    await agent.send({ type: 'prompt', message: 'spawn' });
    const wake = await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.customType === 'agent-team',
      15_000,
    );
    expect(wake.message.content).toContain('final teammate answer');
    await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.content?.[0]?.text === 'noted',
    );
    await Bun.sleep(200);
    expect(
      agent.events.filter((e) => e.type === 'message_end' && e.message.customType === 'agent-team'),
    ).toHaveLength(1);
    const childRequest = agent.llm.requests.find((r) => isTeammate(r.body))!;
    const names = toolNames(childRequest.body);
    expect(names).toContain('read');
    expect(names).toContain('task_update');
    expect(names).toContain('agent_send');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('subagent');
  }, 30_000);

  it('rejects invalid kind tool lists', async () => {
    const agent = await startAgent({
      config: {
        features: {
          sessionTitle: { enabled: false },
          agentTeam: { kinds: { bad: { tools: ['Not A Tool'] } } },
        },
      },
    });
    agents.push(agent);
    agent.llm.push({ tool: { id: 'a', name: 'subagent', args: { task: 'x' } } }, { text: 'ok' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'try' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBe(true);
    expect(end!.result.content[0].text).toMatch(/Invalid tool name/);
  });
});

describe('team task board', () => {
  it('enforces dependencies, claims and revisions', async () => {
    const agent = await startAgent();
    agents.push(agent);
    const call = (id: string, name: string, args: Record<string, unknown>): Reply => ({
      tool: { id, name, args },
    });
    agent.llm.push(
      call('t1', 'task_create', { subject: 'schema', description: 'design schema' }),
      call('t2', 'task_create', { subject: 'api', description: 'build api', blocked_by: ['1'] }),
      call('t3', 'task_update', { task_id: '2', action: 'claim' }),
      call('t4', 'task_update', { task_id: '1', action: 'claim' }),
      call('t5', 'task_update', { task_id: '1', action: 'complete', expected_revision: 0 }),
      call('t6', 'task_update', { task_id: '1', action: 'complete' }),
      call('t7', 'task_list', { ready: true }),
      call('t8', 'task_update', { task_id: '1', action: 'set_dependencies', blocked_by: ['2'] }),
      { text: 'board done' },
    );
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'plan' });
    await settledAfter(agent, from);
    const ends = agent.events.filter((e) => e.type === 'tool_execution_end');
    const body = (i: number) => ends[i]!.result.content[0].text as string;
    expect(JSON.parse(body(1))).toMatchObject({ id: '2', blocked: true, ready: false });
    expect(ends[2]!.isError).toBe(true);
    expect(body(2)).toMatch(/blocked/);
    expect(JSON.parse(body(3))).toMatchObject({ status: 'in_progress', owner: 'parent' });
    expect(ends[4]!.isError).toBe(true);
    expect(body(4)).toMatch(/Revision mismatch/);
    expect(JSON.parse(body(5))).toMatchObject({ status: 'completed' });
    const ready = JSON.parse(body(6)).tasks;
    expect(ready.map((t: any) => t.id)).toEqual(['2']);
    expect(ends[7]!.isError).toBe(true);
    expect(body(7)).toMatch(/cycle/);
    const state = await agent.send({ type: 'get_panel_state' });
    expect(state.data.team.tasks.map((t: any) => t.status)).toEqual(['completed', 'pending']);
  });
});
