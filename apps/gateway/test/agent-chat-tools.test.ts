import { afterEach, describe, expect, it } from 'bun:test';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';
import { ptcCall, type Reply } from './fixtures/fake-llm.js';
import { CODING_SURFACE, GATEWAY_SURFACE } from './fixtures/surface.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

/** What the node sets for an agent in a chat workspace. */
const CHAT = { PIRC_GATEWAY: '1', PIRC_WORKSPACE_KIND: 'chat' };
/** Coding-session capabilities a chat leaves out unless its config turns them back on. */
const CODING_ONLY = [
  'agent_spawn',
  'agent_list',
  'board_post',
  'task_create',
  'subagent',
  'create_goal',
  'update_goal',
  'background_task',
  'todo',
];

/**
 * The provider tools (and their schemas' size) of the last model request, and
 * the capabilities its system prompt offers in "## Capabilities".
 */
async function firstRequest(
  options: Parameters<typeof startAgent>[0] = {},
  replies: Reply[] = [{ text: 'Hi.' }],
) {
  const agent = await startAgent(options);
  agents.push(agent);
  agent.llm.push(...replies);
  const from = agent.events.length;
  await agent.send({ type: 'prompt', message: 'hello' });
  if (options.env?.PIRC_WORKSPACE_KIND === 'chat') {
    const request = await agent.waitFor(
      (event) => event.type === 'gateway_request' && event.op === 'assistant.context',
    );
    agent.raw({
      type: 'gateway_response',
      id: request.id,
      ok: true,
      result: { enabled: true, user: [], notes: [] },
    });
  }
  await settledAfter(agent, from);
  const body = agent.llm.requests.at(-1)!.body;
  const tools = body.tools as Array<Record<string, any>>;
  const system = String(body.messages[0].content);
  const section = system.split('## Capabilities')[1] ?? '';
  return {
    agent,
    names: tools.map((tool) => String(tool.function?.name ?? tool.name)),
    chars: JSON.stringify(tools).length,
    offered: [...section.matchAll(/^- [\w-]+: (.+)$/gm)].flatMap((match) => match[1]!.split(', ')),
  };
}

const resultOf = (agent: AgentProcess, id: string) =>
  agent.events.find(
    (event) =>
      event.type === 'tool_execution_end' && !event.parentToolCallId && event.toolCallId === id,
  )!;

describe('tools in chats', () => {
  it('leaves coding-session tools out of chats', async () => {
    const chat = await firstRequest({ env: CHAT }, [
      { tool: ptcCall('t1', 'todo', { action: 'list' }) },
      { text: 'Hi.' },
    ]);
    // A chat gets the two PTC tools too; everything else is a capability.
    expect(chat.names).toEqual(GATEWAY_SURFACE);
    for (const name of CODING_ONLY) expect(chat.offered).not.toContain(name);
    expect(chat.offered).not.toContain('code');
    expect(chat.offered).toEqual(
      expect.arrayContaining(['read', 'bash', 'memory_note', 'delegate', 'web_search', 'schedule']),
    );
    // A left-out capability cannot be reached from a script either.
    const todo = resultOf(chat.agent, 't1');
    expect(todo.isError).toBe(true);
    expect(todo.result.content[0].text).toContain('Not available in this session: todo');
    // A budget, so a growing tool description shows up in review.
    expect(chat.chars).toBeLessThan(20_000);
  });

  it('keeps them in coding sessions', async () => {
    const coding = await firstRequest();
    expect(coding.names).toEqual(CODING_SURFACE);
    for (const name of CODING_ONLY) expect(coding.offered).toContain(name);
  });

  it('brings one back when the config turns it on', async () => {
    const chat = await firstRequest({
      env: CHAT,
      config: { features: { todo: { enabled: true }, agentTeam: { enabled: true } } },
    });
    expect(chat.offered).toContain('todo');
    expect(chat.offered).toContain('agent_spawn');
    expect(chat.offered).not.toContain('create_goal');
  });
});

describe('the sandbox section in chats', () => {
  it('names only the shell tools the agent has', async () => {
    const env = { ...CHAT, PIRC_SANDBOX: 'srt' };
    const agent = await startAgent({ env });
    agents.push(agent);
    agent.llm.push({ text: 'Hi.' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'hello' });
    const request = await agent.waitFor(
      (event) => event.type === 'gateway_request' && event.op === 'assistant.context',
    );
    agent.raw({
      type: 'gateway_response',
      id: request.id,
      ok: true,
      result: { enabled: true, user: [], notes: [] },
    });
    await settledAfter(agent, from);
    const system = String(agent.llm.requests.at(-1)!.body.messages[0].content);
    expect(system).toContain('Your shell commands (bash) run in an OS sandbox');
  });

  it('keeps both in coding sessions', async () => {
    const agent = await startAgent({ env: { PIRC_SANDBOX: 'srt' } });
    agents.push(agent);
    agent.llm.push({ text: 'Hi.' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'hello' });
    await settledAfter(agent, from);
    const system = String(agent.llm.requests.at(-1)!.body.messages[0].content);
    // The code tool is gone; ptc scripts cannot run shell commands themselves.
    expect(system).toContain('Your shell commands (bash, background_task) run in an OS sandbox');
  });
});
