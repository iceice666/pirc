import { afterEach, describe, expect, it } from 'bun:test';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

/** What the node sets for an agent in a chat workspace. */
const CHAT = { PIRC_GATEWAY: '1', PIRC_WORKSPACE_KIND: 'chat' };
/** Coding-session tools a chat leaves out unless its config turns them back on. */
const CODING_ONLY = [
  'agent_spawn',
  'agent_list',
  'board_post',
  'task_create',
  'subagent',
  'create_goal',
  'update_goal',
  'code',
  'background_task',
  'todo',
];

/** The tools (and their schemas' size) of the first model request. */
async function firstRequest(options: Parameters<typeof startAgent>[0] = {}) {
  const agent = await startAgent(options);
  agents.push(agent);
  agent.llm.push({ text: 'Hi.' });
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
  const tools = agent.llm.requests.at(-1)!.body.tools as Array<Record<string, any>>;
  return {
    names: tools.map((tool) => String(tool.function?.name ?? tool.name)),
    chars: JSON.stringify(tools).length,
  };
}

describe('tools in chats', () => {
  it('leaves coding-session tools out of chats', async () => {
    const chat = await firstRequest({ env: CHAT });
    for (const name of CODING_ONLY) expect(chat.names).not.toContain(name);
    expect(chat.names).toEqual(
      expect.arrayContaining(['read', 'bash', 'memory_note', 'delegate', 'web_search', 'schedule']),
    );
    // A budget, so a growing tool description shows up in review.
    expect(chat.chars).toBeLessThan(20_000);
  });

  it('keeps them in coding sessions', async () => {
    const coding = await firstRequest();
    for (const name of CODING_ONLY) expect(coding.names).toContain(name);
  });

  it('brings one back when the config turns it on', async () => {
    const chat = await firstRequest({
      env: CHAT,
      config: { features: { todo: { enabled: true }, agentTeam: { enabled: true } } },
    });
    expect(chat.names).toContain('todo');
    expect(chat.names).toContain('agent_spawn');
    expect(chat.names).not.toContain('create_goal');
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

  it('keeps all three in coding sessions', async () => {
    const agent = await startAgent({ env: { PIRC_SANDBOX: 'srt' } });
    agents.push(agent);
    agent.llm.push({ text: 'Hi.' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'hello' });
    await settledAfter(agent, from);
    const system = String(agent.llm.requests.at(-1)!.body.messages[0].content);
    expect(system).toContain(
      'Your shell commands (bash, background_task, code) run in an OS sandbox',
    );
  });
});
