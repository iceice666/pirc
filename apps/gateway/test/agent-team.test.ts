import { afterEach, describe, expect, it } from 'bun:test';
import type { Reply } from './fixtures/fake-llm.js';
import { startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const texts = (body: any): string =>
  body.messages
    .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
const isChild = (body: any) => texts(body).includes('Team message (agent data');

describe('agent team', () => {
  it('spawns a child that uses the broker and reports back to the parent', async () => {
    const agent = await startAgent();
    agents.push(agent);
    const child: Reply[] = [
      { tool: { id: 'c1', name: 'board_post', args: { topic: 'notes', body: 'child note' } } },
      { text: 'hi from helper' },
    ];
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'agent_spawn', args: { name: 'helper', task: 'say hi' } } },
      { text: 'spawned' },
      { tool: { id: 'p2', name: 'board_read', args: {} } },
      { text: 'all done' },
    ];
    agent.llm.route = (body) =>
      (isChild(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    await agent.send({ type: 'prompt', message: 'spawn a helper' });
    const done = await agent.waitFor(
      (e) =>
        e.type === 'message_end' &&
        e.message.role === 'assistant' &&
        e.message.content[0]?.text === 'all done',
      15_000,
    );
    expect(done).toBeTruthy();
    const spawnEnd = agent.events.find(
      (e) => e.type === 'tool_execution_end' && e.toolName === 'agent_spawn',
    );
    expect(spawnEnd!.isError).toBeFalsy();
    const spawned = JSON.parse(spawnEnd!.result.content[0].text);
    expect(spawned.name).toBe('helper');
    expect(spawned.model).toBe('fake/fake-model');
    const wake = agent.events.find(
      (e) =>
        e.type === 'message_end' &&
        e.message.role === 'custom' &&
        e.message.customType === 'agent-team',
    );
    expect(wake!.message.content).toContain('hi from helper');
    const board = agent.events.find(
      (e) => e.type === 'tool_execution_end' && e.toolName === 'board_read',
    );
    const page = JSON.parse(board!.result.content[0].text);
    expect(page.items[0]).toMatchObject({ from: 'helper', topic: 'notes', body: 'child note' });
    // Child tools exclude spawn; parent-side tools include it.
    const childRequest = agent.llm.requests.find((r) => isChild(r.body))!;
    const childTools = childRequest.body.tools.map((t: any) => t.function.name);
    expect(childTools).toContain('agent_send');
    expect(childTools).not.toContain('agent_spawn');
    const pid = spawned.pid as number;
    await agent.close();
    agents.splice(0);
    await Bun.sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it('rejects invalid spawns and unknown operations', async () => {
    const agent = await startAgent();
    agents.push(agent);
    agent.llm.push(
      { tool: { id: 'a', name: 'agent_spawn', args: { name: 'Parent', task: 'x' } } },
      { tool: { id: 'b', name: 'agent_wait', args: { agent: 'nobody' } } },
      { text: 'ok' },
    );
    await agent.send({ type: 'prompt', message: 'try' });
    await agent.waitFor((e) => e.type === 'message_end' && e.message.content?.[0]?.text === 'ok');
    const ends = agent.events.filter((e) => e.type === 'tool_execution_end');
    expect(ends[0]!.isError).toBe(true);
    expect(ends[0]!.result.content[0].text).toMatch(/lowercase agent name/);
    expect(ends[1]!.result.content[0].text).toMatch(/Unknown worker agent/);
  });
});
