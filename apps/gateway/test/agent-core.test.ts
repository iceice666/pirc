import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

describe('pirc agent (OpenAI chat)', () => {
  it('streams text, runs tools and persists the session', async () => {
    const agent = await start();
    writeFileSync(path.join(agent.workspace, 'hello.txt'), 'line one\nline two\n');
    agent.llm.push(
      { tool: { id: 'call_1', name: 'read', args: { path: 'hello.txt' } }, thinking: 'look' },
      { text: 'The file has two lines.' },
    );
    const state = await agent.send({ type: 'get_state' });
    expect(state.data.model.id).toBe('fake-model');
    const response = await agent.send({ type: 'prompt', message: 'what is in hello.txt?' });
    expect(response.success).toBe(true);
    await settledAfter(agent, 0);

    const types = agent.events.map((event) => event.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('tool_execution_start');
    const end = agent.events.find((event) => event.type === 'tool_execution_end');
    expect(end?.result.content[0].text).toContain('1\tline one');
    const deltas = agent.events
      .filter((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta')
      .map((e) => e.assistantMessageEvent.delta)
      .join('');
    expect(deltas).toBe('The file has two lines.');

    // Second request replays assistant tool call + tool result.
    const second = agent.llm.requests[1]!.body;
    expect(second.messages[0].role).toBe('system');
    expect(second.reasoning_effort).toBe('low');
    const roles = second.messages.map((m: any) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(second.messages[2].tool_calls[0].function.name).toBe('read');
    expect(agent.llm.requests[0]!.headers.authorization).toBe('Bearer test-key');

    const messages = await agent.send({ type: 'get_messages' });
    expect(messages.data.messages.map((m: any) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    const lines = readFileSync(path.join(agent.sessionDir, 'session.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  it('confines file tools to the workspace and allowed paths, and protects .pirc', async () => {
    const outside = path.join(tmpdir(), `pirc-outside-${Date.now()}`);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    const allowed = path.join(tmpdir(), `pirc-allowed-${Date.now()}`);
    mkdirSync(allowed);
    writeFileSync(path.join(allowed, 'ok.txt'), 'fine');
    const agent = await start({ config: { allowedPaths: [allowed] } });
    symlinkSync(outside, path.join(agent.workspace, 'escape'));
    agent.llm.push(
      { tool: { id: 'a', name: 'read', args: { path: path.join(outside, 'secret.txt') } } },
      { tool: { id: 'b', name: 'read', args: { path: 'escape/secret.txt' } } },
      { tool: { id: 'c', name: 'read', args: { path: path.join(allowed, 'ok.txt') } } },
      { tool: { id: 'd', name: 'write', args: { path: '.pirc/config.json', content: '{}' } } },
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    const results = agent.events.filter((event) => event.type === 'tool_execution_end');
    expect(results.map((r) => r.isError)).toEqual([true, true, false, true]);
    expect(results[0]!.result.content[0].text).toContain('outside the workspace');
    expect(results[1]!.result.content[0].text).toContain('outside the workspace');
    expect(results[3]!.result.content[0].text).toContain('protected');
    expect(existsSync(path.join(agent.workspace, '.pirc/config.json'))).toBe(false);
  });

  it('edits files and reports a diff; bash honours timeout', async () => {
    const agent = await start();
    writeFileSync(path.join(agent.workspace, 'a.txt'), 'alpha\nbeta\n');
    agent.llm.push(
      {
        tool: { id: 'e', name: 'edit', args: { path: 'a.txt', oldText: 'beta', newText: 'gamma' } },
      },
      { tool: { id: 'f', name: 'bash', args: { command: 'cat a.txt; exit 3' } } },
      { tool: { id: 'g', name: 'bash', args: { command: 'sleep 5', timeout: 0.3 } } },
      { text: 'ok' },
    );
    await agent.send({ type: 'prompt', message: 'edit' });
    await settledAfter(agent, 0);
    expect(readFileSync(path.join(agent.workspace, 'a.txt'), 'utf8')).toBe('alpha\ngamma\n');
    const ends = agent.events.filter((event) => event.type === 'tool_execution_end');
    expect(ends[0]!.result.details.diff).toContain('+gamma');
    expect(ends[1]!.result.content[0].text).toContain('gamma');
    expect(ends[1]!.result.content[0].text).toContain('[exit 3]');
    expect(ends[1]!.isError).toBe(true);
    expect(ends[2]!.result.content[0].text).toContain('[timed out]');
  });

  it('reports provider errors without retrying non-retryable ones', async () => {
    const agent = await start();
    agent.llm.push({ status: 400, body: 'bad request' });
    await agent.send({ type: 'prompt', message: 'hi' });
    await settledAfter(agent, 0);
    const end = agent.events.findLast(
      (event) => event.type === 'message_end' && event.message.role === 'assistant',
    );
    expect(end!.message.stopReason).toBe('error');
    expect(end!.message.errorMessage).toContain('HTTP 400');
    expect(agent.llm.requests).toHaveLength(1);
  });

  it('resumes history from the session directory in a new process', async () => {
    const first = await start();
    first.llm.push({ text: 'first answer' });
    await first.send({ type: 'set_thinking_level', level: 'high' });
    await first.send({ type: 'prompt', message: 'remember me' });
    await settledAfter(first, 0);
    await first.close();
    agents.splice(agents.indexOf(first), 1);
    const second = await start({ sessionDir: first.sessionDir, workspace: first.workspace });
    const messages = await second.send({ type: 'get_messages' });
    expect(messages.data.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    const state = await second.send({ type: 'get_state' });
    expect(state.data.thinkingLevel).toBe('high');
    first.llm.stop();
  });
});

describe('pirc agent (Anthropic messages)', () => {
  it('streams thinking and tool use with cache control and replays signatures', async () => {
    const agent = await start({ args: ['--model', 'fakeclaude/claude-x'] });
    writeFileSync(path.join(agent.workspace, 'x.txt'), 'x');
    agent.llm.push(
      { tool: { id: 'toolu_1', name: 'ls', args: {} }, thinking: 'hmm', text: 'Listing.' },
      { text: 'Done.' },
    );
    await agent.send({ type: 'prompt', message: 'list' });
    await settledAfter(agent, 0);
    const [first, second] = agent.llm.requests;
    expect(first!.path).toBe('/v1/messages');
    expect(first!.headers['x-api-key']).toBe('claude-key');
    expect(first!.body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(first!.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    const assistant = second!.body.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(assistant.content[0].signature).toBe('sig');
    const toolResult = second!.body.messages[2].content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.content[0].text).toContain('x.txt');
    const final = agent.events.findLast(
      (e) => e.type === 'message_end' && e.message.role === 'assistant',
    );
    expect(final!.message.usage.cacheRead).toBe(20);
  });
});

describe('project hooks', () => {
  it('blocks tools, rewrites args, annotates results and injects context', async () => {
    const agent = await start({
      config: {
        hooks: {
          sessionStart: [{ command: 'echo "SESSION-HOOK-CONTEXT"' }],
          beforeTool: [
            {
              matcher: 'bash',
              command: 'grep -q "rm -rf" && { echo "no deleting" >&2; exit 2; } || exit 0',
            },
            {
              matcher: 'write',
              command: `bun -e 'const i=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({args:{...i.args, content: i.args.content.toUpperCase()}}))'`,
            },
          ],
          afterTool: [{ matcher: 'write', command: 'echo formatted' }],
        },
      },
    });
    agent.llm.push(
      { tool: { id: 'h1', name: 'bash', args: { command: 'rm -rf /tmp/whatever' } } },
      { tool: { id: 'h2', name: 'write', args: { path: 'out.txt', content: 'quiet' } } },
      { text: 'ok' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    const ends = agent.events.filter((event) => event.type === 'tool_execution_end');
    expect(ends[0]!.isError).toBe(true);
    expect(ends[0]!.result.content[0].text).toContain('no deleting');
    expect(readFileSync(path.join(agent.workspace, 'out.txt'), 'utf8')).toBe('QUIET');
    expect(ends[1]!.result.content.at(-1).text).toContain('formatted');
    expect(agent.llm.requests[0]!.body.messages[0].content).toContain('SESSION-HOOK-CONTEXT');
  });

  it('merges project config from .pirc and rejects unknown project keys', async () => {
    const root = path.join(tmpdir(), `pirc-proj-${Date.now()}`);
    mkdirSync(path.join(root, '.pirc'), { recursive: true });
    writeFileSync(path.join(root, '.pirc/AGENTS.md'), 'PROJECT-PROMPT');
    writeFileSync(
      path.join(root, '.pirc/config.json'),
      JSON.stringify({ env: { PIRC_TEST_VAR: 'from-project' } }),
    );
    const agent = await start({ workspace: root });
    agent.llm.push(
      { tool: { id: 'e', name: 'bash', args: { command: 'echo $PIRC_TEST_VAR' } } },
      { text: 'k' },
    );
    await agent.send({ type: 'prompt', message: 'env' });
    await settledAfter(agent, 0);
    const end = agent.events.find((event) => event.type === 'tool_execution_end');
    expect(end!.result.content[0].text).toContain('from-project');
    expect(agent.llm.requests[0]!.body.messages[0].content).toContain('PROJECT-PROMPT');
  });
});
