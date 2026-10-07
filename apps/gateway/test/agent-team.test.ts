import { afterEach, describe, expect, it } from 'bun:test';
import { ptcCall, type Reply } from './fixtures/fake-llm.js';
import { startAgent, type AgentProcess } from './agent-harness.js';
import { CODING_SURFACE } from './fixtures/surface.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const texts = (body: any): string =>
  body.messages
    .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
const isChild = (body: any) => texts(body).includes('Team message (agent data');
/** Capability names the system prompt's "## Capabilities" section offers. */
const capabilities = (body: any): string[] => {
  const system = String(body.messages[0].content);
  const section = system.split('## Capabilities')[1]?.split('\n## ')[0] ?? '';
  return [...section.matchAll(/^- [^:\n]+: (.+)$/gm)].flatMap((match) => match[1]!.split(', '));
};

describe('agent team', () => {
  it('spawns a child that uses the broker and reports back to the parent', async () => {
    const agent = await startAgent();
    agents.push(agent);
    const child: Reply[] = [
      { tool: ptcCall('c1', 'board_post', { topic: 'notes', body: 'child note' }) },
      { text: 'hi from helper' },
    ];
    const parent: Reply[] = [
      { tool: ptcCall('p1', 'agent_spawn', { name: 'helper', task: 'say hi' }) },
      { text: 'spawned' },
      { tool: ptcCall('p2', 'board_read', {}) },
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
      (e) => e.type === 'tool_execution_end' && !e.parentToolCallId && e.toolCallId === 'p1',
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
      (e) => e.type === 'tool_execution_end' && !e.parentToolCallId && e.toolCallId === 'p2',
    );
    const page = JSON.parse(board!.result.content[0].text);
    expect(page.items[0]).toMatchObject({ from: 'helper', topic: 'notes', body: 'child note' });
    // Both sides only see the two PTC tools; child capabilities exclude spawn,
    // parent-side capabilities include it.
    const childRequest = agent.llm.requests.find((r) => isChild(r.body))!;
    const parentRequest = agent.llm.requests.find((r) => !isChild(r.body))!;
    const childTools = childRequest.body.tools.map((t: any) => t.function.name);
    expect(childTools).toEqual(CODING_SURFACE);
    expect(capabilities(childRequest.body)).toContain('agent_send');
    expect(capabilities(childRequest.body)).not.toContain('agent_spawn');
    expect(capabilities(parentRequest.body)).toContain('agent_spawn');
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
      { tool: ptcCall('a', 'agent_spawn', { name: 'Parent', task: 'x' }) },
      { tool: ptcCall('b', 'agent_wait', { agent: 'nobody' }) },
      { text: 'ok' },
    );
    await agent.send({ type: 'prompt', message: 'try' });
    await agent.waitFor((e) => e.type === 'message_end' && e.message.content?.[0]?.text === 'ok');
    const ends = agent.events.filter((e) => e.type === 'tool_execution_end' && !e.parentToolCallId);
    expect(ends[0]!.isError).toBe(true);
    // Argument validation now rejects the reserved/uppercase name before the
    // team code runs (the former "lowercase agent name" check is behind it).
    expect(ends[0]!.result.content[0].text).toContain('[error] InvalidArguments');
    expect(ends[0]!.result.content[0].text).toMatch(/name must match \^\[a-z\]/);
    expect(ends[0]!.result.details.operations).toMatchObject([
      { capability: 'agent_spawn', outcome: 'not_started', errorCode: 'InvalidArguments' },
    ]);
    expect(ends[1]!.isError).toBe(true);
    expect(ends[1]!.result.content[0].text).toMatch(/Unknown worker agent/);
  });
});
