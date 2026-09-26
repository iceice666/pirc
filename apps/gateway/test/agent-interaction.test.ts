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
const userTexts = (body: any) =>
  body.messages
    .filter((m: any) => m.role === 'user')
    .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

describe('queueing and abort', () => {
  it('delivers steer after the current tool and skips remaining calls', async () => {
    const agent = await start();
    agent.llm.push(
      { tool: { id: 's1', name: 'bash', args: { command: 'sleep 0.4; echo slept' } } },
      { text: 'adjusted' },
    );
    await agent.send({ type: 'prompt', message: 'long task' });
    await agent.waitFor((e) => e.type === 'tool_execution_start');
    const steer = await agent.send({ type: 'steer', message: 'actually do X' });
    expect(steer.success).toBe(true);
    const queued = await agent.waitFor((e) => e.type === 'queue_update' && e.steering.length === 1);
    expect(queued.steering).toEqual(['actually do X']);
    await settledAfter(agent, 0);
    const second = agent.llm.requests[1]!.body;
    expect(userTexts(second)).toEqual(['long task', 'actually do X']);
    expect(second.messages.at(-1).content).toBe('actually do X');
  });

  it('runs follow-ups only after the agent would otherwise stop', async () => {
    const agent = await start();
    agent.llm.push(
      { tool: { id: 'f1', name: 'bash', args: { command: 'sleep 0.3' } } },
      { text: 'first done' },
      { text: 'second done' },
    );
    await agent.send({ type: 'prompt', message: 'one' });
    await agent.waitFor((e) => e.type === 'tool_execution_start');
    await agent.send({ type: 'follow_up', message: 'two' });
    await settledAfter(agent, 0);
    expect(agent.llm.requests).toHaveLength(3);
    expect(userTexts(agent.llm.requests[1]!.body)).toEqual(['one']);
    expect(userTexts(agent.llm.requests[2]!.body)).toEqual(['one', 'two']);
    // A single run: exactly one agent_start/agent_end pair.
    expect(agent.events.filter((e) => e.type === 'agent_end')).toHaveLength(1);
  });

  it('aborts a hanging provider stream and clears queued messages', async () => {
    const agent = await start();
    agent.llm.push({ hang: true });
    await agent.send({ type: 'prompt', message: 'hang' });
    await agent.waitFor((e) => e.type === 'message_start' && e.message.role === 'assistant');
    // message_start precedes the HTTP request; abort only once the server holds it.
    while (agent.llm.requests.length < 1) await Bun.sleep(5);
    await agent.send({ type: 'follow_up', message: 'queued' });
    const cleared = await agent.send({ type: 'clear_queue' });
    expect(cleared.data.followUp).toEqual(['queued']);
    const aborted = await agent.send({ type: 'abort' });
    expect(aborted.success).toBe(true);
    await settledAfter(agent, 0);
    const end = agent.events.findLast(
      (e) => e.type === 'message_end' && e.message.role === 'assistant',
    );
    expect(end!.message.stopReason).toBe('aborted');
    const state = await agent.send({ type: 'get_state' });
    expect(state.data.isStreaming).toBe(false);
    // The session is still usable after an abort.
    agent.llm.push({ text: 'back' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'again' });
    await settledAfter(agent, from);
    const last = agent.llm.requests.at(-1)!.body;
    expect(userTexts(last)).toEqual(['hang', 'again']);
  }, 20_000);

  it('kills a running bash process group on abort', async () => {
    const agent = await start();
    agent.llm.push({
      tool: { id: 'k', name: 'bash', args: { command: 'sleep 30 & sleep 30; echo never' } },
    });
    await agent.send({ type: 'prompt', message: 'sleep' });
    await agent.waitFor((e) => e.type === 'tool_execution_start');
    const started = Date.now();
    await agent.send({ type: 'abort' });
    await settledAfter(agent, 0);
    expect(Date.now() - started).toBeLessThan(3000);
    const end = agent.events.find((e) => e.type === 'tool_execution_end');
    expect(end!.result.content[0].text).toContain('[aborted]');
  });
});

describe('ask_user_question', () => {
  it('asks through extension_ui_request and returns structured answers', async () => {
    const agent = await start();
    agent.llm.push(
      {
        tool: {
          id: 'q1',
          name: 'ask_user_question',
          args: {
            questions: [
              {
                question: 'Which DB?',
                header: 'DB',
                options: [{ label: 'sqlite', description: 'embedded' }, { label: 'postgres' }],
              },
              { question: 'Anything else?' },
            ],
          },
        },
      },
      { text: 'thanks' },
    );
    await agent.send({ type: 'prompt', message: 'ask me' });
    const select = await agent.waitFor(
      (e) => e.type === 'extension_ui_request' && e.method === 'select',
    );
    expect(select.title).toBe('DB: Which DB?');
    expect(select.options).toEqual(['sqlite', 'postgres', 'Other (type your own answer)']);
    expect(select.optionDescriptions[0]).toBe('embedded');
    agent.raw({ type: 'extension_ui_response', id: select.id, value: 'postgres' });
    const input = await agent.waitFor(
      (e) => e.type === 'extension_ui_request' && e.method === 'input',
    );
    agent.raw({ type: 'extension_ui_response', id: input.id, value: '  no  ' });
    await settledAfter(agent, 0);
    const end = agent.events.find((e) => e.type === 'tool_execution_end');
    expect(end!.result.details).toEqual({
      status: 'answered',
      answers: [
        { question: 'Which DB?', selected: ['postgres'] },
        { question: 'Anything else?', selected: [], customText: 'no' },
      ],
    });
  });

  it('supports multi-select with custom text and cancels on abort', async () => {
    const agent = await start();
    agent.llm.push(
      {
        tool: {
          id: 'q2',
          name: 'ask_user_question',
          args: {
            questions: [
              { question: 'Pick', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
            ],
          },
        },
      },
      { text: 'ok' },
      {
        tool: {
          id: 'q3',
          name: 'ask_user_question',
          args: { questions: [{ question: 'Wait?' }] },
        },
      },
    );
    await agent.send({ type: 'prompt', message: 'multi' });
    const select = await agent.waitFor(
      (e) => e.type === 'extension_ui_request' && e.method === 'select',
    );
    expect(select.multiple).toBe(true);
    agent.raw({
      type: 'extension_ui_response',
      id: select.id,
      value: 'a, Other (type your own answer)',
      values: ['a', 'Other (type your own answer)'],
    });
    const input = await agent.waitFor(
      (e) => e.type === 'extension_ui_request' && e.method === 'input',
    );
    agent.raw({ type: 'extension_ui_response', id: input.id, value: 'c' });
    await settledAfter(agent, 0);
    const first = agent.events.find((e) => e.type === 'tool_execution_end');
    expect(first!.result.details.answers[0]).toEqual({
      question: 'Pick',
      selected: ['a'],
      customText: 'c',
    });

    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'ask again' });
    const pending = await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.method === 'input' &&
        agent.events.indexOf(e) >= from,
    );
    await agent.send({ type: 'abort' });
    const cancel = await agent.waitFor(
      (e) => e.type === 'extension_ui_request' && e.method === 'cancel',
    );
    expect(cancel.targetId).toBe(pending.id);
    await settledAfter(agent, from);
    const second = agent.events.findLast((e) => e.type === 'tool_execution_end');
    expect(second!.result.details.status).toBe('cancelled');
  });

  it('is unavailable in headless agents', async () => {
    const agent = await start({ args: ['--headless'] });
    agent.llm.push(
      { tool: { id: 'q4', name: 'ask_user_question', args: { questions: [{ question: 'x' }] } } },
      { text: 'ok' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    const end = agent.events.find((e) => e.type === 'tool_execution_end');
    expect(end!.result.details.status).toBe('unavailable');
    expect(
      agent.events.some((e) => e.type === 'extension_ui_request' && e.method === 'input'),
    ).toBe(false);
  });
});

describe('todo', () => {
  it('tracks tasks, shows a widget and reminds once about unfinished work', async () => {
    const agent = await start();
    agent.llm.push(
      {
        tool: {
          id: 't1',
          name: 'todo',
          args: {
            action: 'add',
            items: [{ text: 'write code' }, { text: 'test it', blockedBy: [1] }],
          },
        },
      },
      { tool: { id: 't2', name: 'todo', args: { action: 'update', id: 1, status: 'completed' } } },
      { text: 'stopping early' },
      { text: 'still stopping' },
    );
    await agent.send({ type: 'prompt', message: 'plan' });
    await agent.waitFor((e) => e.type === 'agent_end');
    await settledAfter(agent, 0);
    const widget = agent.events.findLast(
      (e) => e.type === 'extension_ui_request' && e.method === 'setWidget',
    );
    expect(widget!.widgetLines).toEqual(['TODO · 1/2', '✓ write code', '☐ test it']);
    // Reminder follow-up triggered exactly one extra request, then stopped.
    expect(agent.llm.requests).toHaveLength(4);
    const reminder = agent.llm.requests[3]!.body.messages.at(-1).content;
    expect(reminder).toContain('1 unfinished todos');
    expect(reminder).toContain('#2 [Pending] test it');
  });

  it('restores state in a new process and injects a snapshot on the next run', async () => {
    const first = await start();
    first.llm.push(
      { tool: { id: 't', name: 'todo', args: { action: 'add', text: 'persist me' } } },
      { tool: { id: 'u', name: 'todo', args: { action: 'update', id: 1, status: 'completed' } } },
      { text: 'done' },
    );
    await first.send({ type: 'prompt', message: 'x' });
    await settledAfter(first, 0);
    await first.close();
    agents.splice(agents.indexOf(first), 1);
    const second = await start({ sessionDir: first.sessionDir, workspace: first.workspace });
    second.llm.push({ text: 'hi' });
    await second.send({ type: 'prompt', message: 'continue' });
    await settledAfter(second, 0);
    const body = second.llm.requests[0]!.body;
    const snapshot = userTexts(body).find((text: string) => text.startsWith('Todo snapshot'));
    expect(snapshot).toContain('#1 [Completed] persist me');
    first.llm.stop();
  });

  it('handles /todo commands without calling the model', async () => {
    const agent = await start();
    await agent.send({ type: 'prompt', message: '/todo add Buy milk' });
    const notice = await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.method === 'notify' &&
        e.message === 'Todos updated.',
    );
    expect(notice).toBeTruthy();
    await agent.send({ type: 'prompt', message: '/todo list' });
    const list = await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.method === 'notify' &&
        e.message.includes('Buy milk'),
    );
    expect(list.message).toBe('#1 [Pending] Buy milk');
    expect(agent.llm.requests).toHaveLength(0);
    const commands = await agent.send({ type: 'get_commands' });
    expect(commands.data.commands.map((c: any) => c.name)).toContain('todo');
    // The manual update reaches the model as hidden context on the next prompt.
    agent.llm.push({ text: 'noted' });
    await agent.send({ type: 'prompt', message: 'what now' });
    await settledAfter(agent, 0);
    expect(userTexts(agent.llm.requests[0]!.body).join('\n')).toContain('Buy milk');
  });
});
