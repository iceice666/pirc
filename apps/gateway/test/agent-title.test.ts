import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { isLowSignalTitleInput, parseTitle } from '../src/agent/features/title.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
});

const isTitleRequest = (body: any) => JSON.stringify(body.messages).includes('<user-message>');

async function start(options: Parameters<typeof startAgent>[0] = {}) {
  const agent = await startAgent({
    ...options,
    config: { features: { sessionTitle: { enabled: true } }, ...options.config },
  });
  agents.push(agent);
  return agent;
}

describe('title parsing', () => {
  it('extracts and cleans the tagged title', () => {
    expect(parseTitle('<title>Fix login button</title>')).toBe('Fix login button');
    expect(parseTitle('<think>scratch</think>\n<title> "Fix login button." </title>')).toBe(
      'Fix login button',
    );
    expect(parseTitle('```json\n{"title": "Debug failing CI"}\n```')).toBe('Debug failing CI');
    expect(parseTitle('{"title": "Truncated JSON')).toBe('Truncated JSON');
    expect(parseTitle('Title: 修正登入按鈕')).toBe('修正登入按鈕');
    expect(parseTitle('<title>none</title>')).toBeNull();
    expect(parseTitle('<title/>')).toBeNull();
    expect(parseTitle('   ')).toBeNull();
    const long = parseTitle(`<title>${'word '.repeat(40)}</title>`)!;
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith('…')).toBe(true);
  });

  it('skips greetings and filler without a model call', () => {
    for (const text of ['hi', 'Hello!', 'thanks.', '42', '👍🎉', '你好', '謝謝！', '  ok  '])
      expect(isLowSignalTitleInput(text)).toBe(true);
    for (const text of ['fix the login bug', '幫我重構 runner', 'hi, can you add tests?'])
      expect(isLowSignalTitleInput(text)).toBe(false);
  });
});

describe('session title feature', () => {
  it('names the session from the first real message in a side request', async () => {
    const agent = await start();
    agent.llm.route = (body) =>
      isTitleRequest(body) ? { text: '<title>Refactor the runner</title>' } : undefined;
    agent.llm.push({ text: 'hello there' }, { text: 'on it' });

    // A greeting does not trigger titling.
    let from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'hi' });
    await settledAfter(agent, from);
    expect(agent.llm.requests.some((request) => isTitleRequest(request.body))).toBe(false);

    from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'please refactor the runner module' });
    const renamed = await agent.waitFor((event) => event.type === 'session_name_changed');
    expect(renamed).toMatchObject({ name: 'Refactor the runner', source: 'auto' });
    await settledAfter(agent, from);

    const titleRequest = agent.llm.requests.find((request) => isTitleRequest(request.body))!;
    expect(titleRequest.body.tools).toBeUndefined();
    expect(JSON.stringify(titleRequest.body.messages)).toContain('refactor the runner module');
    expect((await agent.send({ type: 'get_state' })).data).toMatchObject({
      sessionName: 'Refactor the runner',
      sessionNameSource: 'auto',
    });
    const entries = readFileSync(path.join(agent.sessionDir, 'session.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries.find((entry) => entry.type === 'session_info')).toMatchObject({
      name: 'Refactor the runner',
      source: 'auto',
    });

    // Titled once: later messages make no further title requests.
    const count = agent.llm.requests.filter((request) => isTitleRequest(request.body)).length;
    from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'now add tests for it' });
    await settledAfter(agent, from);
    expect(agent.llm.requests.filter((request) => isTitleRequest(request.body)).length).toBe(count);
  });

  it('leaves a user-named session alone and retries after a failed attempt', async () => {
    const named = await start();
    await named.send({ type: 'set_session_name', name: 'Mine' });
    let from = named.events.length;
    await named.send({ type: 'prompt', message: 'fix the flaky upload test' });
    await settledAfter(named, from);
    expect(named.llm.requests.some((request) => isTitleRequest(request.body))).toBe(false);

    const retry = await start();
    let failures = 1;
    retry.llm.route = (body) => {
      if (!isTitleRequest(body)) return undefined;
      return failures-- > 0
        ? { status: 400, body: 'bad request' }
        : { text: '<title>Upgrade dependencies</title>' };
    };
    from = retry.events.length;
    await retry.send({ type: 'prompt', message: 'upgrade the dependencies' });
    await settledAfter(retry, from);
    await Bun.sleep(50);
    expect(retry.events.some((event) => event.type === 'session_name_changed')).toBe(false);
    await retry.send({ type: 'prompt', message: 'upgrade the dependencies, again' });
    expect(await retry.waitFor((event) => event.type === 'session_name_changed')).toMatchObject({
      name: 'Upgrade dependencies',
    });
  });

  it('is skipped for headless (team sub-agent) sessions', async () => {
    const agent = await start({ args: ['--headless'] });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'write the release notes' });
    await settledAfter(agent, from);
    await Bun.sleep(50);
    expect(agent.llm.requests.some((request) => isTitleRequest(request.body))).toBe(false);
  });
});
