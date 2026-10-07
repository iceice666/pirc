import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { Agent } from '../src/agent/agent.js';
import {
  loadAgentConfig,
  projectTrustFields,
  projectTrustHash,
  readProjectConfig,
} from '../src/agent/config.js';
import { RpcUi } from '../src/agent/rpc.js';
import { SessionStore } from '../src/agent/session-store.js';
import { builtinTools } from '../src/agent/tools/index.js';
import type { AssistantMessage } from '../src/agent/messages.js';
import { settledAfter, startAgent, testModels, type AgentProcess } from './agent-harness.js';
import { ptcCall } from './fixtures/fake-llm.js';
import { CODING_SURFACE } from './fixtures/surface.js';

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
      { tool: ptcCall('call_1', 'read', { path: 'hello.txt' }), thinking: 'look' },
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
    const end = agent.events.find(
      (event) => event.type === 'tool_execution_end' && !event.parentToolCallId,
    );
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
    expect(second.messages[2].tool_calls[0].function.name).toBe('ptc');
    // The provider sees exactly the two PTC tools.
    expect(second.tools.map((tool: any) => tool.function.name)).toEqual(CODING_SURFACE);
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

  /**
   * An agent in this process with scripted replies (content per LLM call), so
   * `onEvent` runs at the exact instant each event is emitted.
   */
  const runInProcess = async (
    replies: AssistantMessage['content'][],
    onEvent: (event: Record<string, any>, store: SessionStore) => void,
    setup?: (workspace: string) => void,
  ) => {
    const root = mkdtempSync(path.join(tmpdir(), 'pirc-inproc-'));
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    setup?.(workspace);
    const store = new SessionStore(path.join(root, 'session'), workspace);
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    let calls = 0;
    const agent = new Agent({
      config: loadAgentConfig(workspace, testModels('http://127.0.0.1:1'), {
        PIRC_CONFIG_DIR: path.join(root, 'config'),
      }),
      store,
      ui: new RpcUi(() => {}),
      hasUI: false,
      tools: builtinTools(),
      emit: (event: Record<string, any>) => {
        onEvent(event, store);
        if (event.type === 'agent_settled') settled();
      },
      streamOverride: async (request) => {
        const content = replies[calls++]!;
        return {
          role: 'assistant',
          content,
          api: 'openai-chat',
          provider: request.providerName,
          model: request.model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        };
      },
    });
    await agent.init();
    agent.prompt('go');
    await done;
  };

  it('writes every message to the session file before its message_end', async () => {
    // The node reads snapshot history from the file; an event must never be ahead of it.
    const seen: Array<{ role: string; stored: number }> = [];
    await runInProcess(
      [
        [
          {
            type: 'toolCall',
            id: 'call_1',
            name: 'ptc',
            arguments: { code: 'return (await tools.ls({})).text;' },
          },
        ],
        [{ type: 'text', text: 'Listed.' }],
      ],
      (event, store) => {
        if (event.type === 'message_end')
          seen.push({ role: event.message.role, stored: store.allMessages().length });
      },
    );
    expect(seen).toEqual([
      { role: 'user', stored: 1 },
      { role: 'assistant', stored: 2 },
      { role: 'toolResult', stored: 3 },
      { role: 'assistant', stored: 4 },
    ]);
  });

  it('keeps every event line small even when a turn produces a lot of output', async () => {
    // The node kills an agent whose stdout line exceeds 1 MiB. Each tool result
    // is capped on its own, but turn_end/agent_end used to repeat a whole
    // turn/run of them in one line.
    const calls = Array.from({ length: 30 }, (_, index) => ({
      type: 'toolCall' as const,
      id: `call_${index}`,
      name: 'ptc',
      arguments: { code: 'return (await tools.read({ path: "big.txt" })).text;' },
    }));
    const sizes: Record<string, number> = {};
    await runInProcess(
      [calls, [{ type: 'text', text: 'Read it thirty times.' }]],
      (event) => {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        sizes[event.type] = Math.max(sizes[event.type] ?? 0, bytes);
      },
      (workspace) =>
        writeFileSync(
          path.join(workspace, 'big.txt'),
          Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'),
        ),
    );
    const total = sizes.tool_execution_end! * calls.length;
    expect(total).toBeGreaterThan(1024 * 1024); // the turn as a whole is over the limit
    expect(Math.max(...Object.values(sizes))).toBeLessThan(1024 * 1024);
    expect(sizes.turn_end).toBeLessThan(100);
    expect(sizes.agent_end).toBeLessThan(100);
  });

  it('reads anywhere but credential stores, writes only to allowed paths, and protects .pirc', async () => {
    const outside = path.join(tmpdir(), `pirc-outside-${Date.now()}`);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'notes.txt'), 'readable');
    const allowed = path.join(tmpdir(), `pirc-allowed-${Date.now()}`);
    mkdirSync(allowed);
    const agent = await start({ config: { allowedPaths: [allowed] } });
    // The harness gives the agent a HOME of its own.
    const ssh = path.join(path.dirname(agent.workspace), 'home', '.ssh');
    mkdirSync(ssh, { recursive: true });
    writeFileSync(path.join(ssh, 'id_ed25519'), 'key');
    symlinkSync(outside, path.join(agent.workspace, 'escape'));
    agent.llm.push(
      { tool: ptcCall('a', 'read', { path: path.join(outside, 'notes.txt') }) },
      { tool: ptcCall('b', 'write', { path: 'escape/new.txt', content: 'x' }) },
      { tool: ptcCall('c', 'write', { path: path.join(allowed, 'ok.txt'), content: 'y' }) },
      { tool: ptcCall('d', 'read', { path: path.join(ssh, 'id_ed25519') }) },
      { tool: ptcCall('e', 'write', { path: '.pirc/config.json', content: '{}' }) },
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    const results = agent.events.filter(
      (event) => event.type === 'tool_execution_end' && !event.parentToolCallId,
    );
    expect(results.map((r) => r.isError)).toEqual([false, true, false, true, true]);
    expect(results[0]!.result.content[0].text).toContain('readable');
    expect(results[1]!.result.content[0].text).toContain('outside the writable paths');
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(readFileSync(path.join(allowed, 'ok.txt'), 'utf8')).toBe('y');
    expect(results[3]!.result.content[0].text).toContain('is private');
    expect(results[4]!.result.content[0].text).toContain('protected');
    expect(existsSync(path.join(agent.workspace, '.pirc/config.json'))).toBe(false);
  });

  it('applies the node sandbox policy it is given', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pirc-policy-'));
    const state = path.join(root, 'state');
    const session = path.join(state, 'sessions', 'mine');
    mkdirSync(session, { recursive: true });
    writeFileSync(path.join(state, 'node.sqlite'), 'db');
    writeFileSync(path.join(session, 'log.jsonl'), 'mine');
    const workspace = path.join(root, 'ws');
    mkdirSync(workspace);
    const policy = {
      denyRead: [state],
      allowRead: [session],
      allowWrite: [workspace, session],
      denyWrite: [path.join(workspace, '.pirc')],
    };
    const agent = await start({
      workspace,
      env: { PIRC_SANDBOX: 'srt', PIRC_SANDBOX_POLICY: JSON.stringify(policy) },
      // Under srt the node's policy decides; the agent's own allowedPaths do not widen it.
      config: { allowedPaths: [root] },
    });
    agent.llm.push(
      { tool: ptcCall('a', 'read', { path: path.join(state, 'node.sqlite') }) },
      { tool: ptcCall('b', 'read', { path: path.join(session, 'log.jsonl') }) },
      { tool: ptcCall('c', 'write', { path: path.join(root, 'x.txt'), content: 'x' }) },
      { tool: ptcCall('d', 'write', { path: 'ok.txt', content: 'ok' }) },
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    const results = agent.events.filter(
      (event) => event.type === 'tool_execution_end' && !event.parentToolCallId,
    );
    expect(results.map((r) => r.isError)).toEqual([true, false, true, false]);
    expect(results[0]!.result.content[0].text).toContain('is private');
    expect(results[2]!.result.content[0].text).toContain('outside the writable paths');
  });

  it('edits files and reports a diff; bash honours timeout', async () => {
    const agent = await start();
    writeFileSync(path.join(agent.workspace, 'a.txt'), 'alpha\nbeta\n');
    agent.llm.push(
      { tool: ptcCall('e', 'edit', { path: 'a.txt', oldText: 'beta', newText: 'gamma' }) },
      { tool: ptcCall('f', 'bash', { command: 'cat a.txt; exit 3' }) },
      { tool: ptcCall('g', 'bash', { command: 'sleep 5', timeout: 0.3 }) },
      { text: 'ok' },
    );
    await agent.send({ type: 'prompt', message: 'edit' });
    await settledAfter(agent, 0);
    expect(readFileSync(path.join(agent.workspace, 'a.txt'), 'utf8')).toBe('alpha\ngamma\n');
    const ends = agent.events.filter(
      (event) => event.type === 'tool_execution_end' && !event.parentToolCallId,
    );
    // The edit's diff lived in the former per-tool details, which ptc does not
    // keep; the model sees the edit's text and the ptc details record the operation.
    expect(ends[0]!.isError).toBe(false);
    expect(ends[0]!.result.content[0].text).toContain('Edited a.txt (1 replacement)');
    expect(ends[0]!.result.details.operations).toMatchObject([
      { capability: 'edit', outcome: 'completed' },
    ]);
    expect(ends[1]!.result.content[0].text).toContain('gamma');
    expect(ends[1]!.result.content[0].text).toContain('[exit 3]');
    // A non-zero exit is a result in scripts (the script reads exitCode); a timeout fails.
    expect(ends[1]!.isError).toBe(false);
    expect(ends[2]!.isError).toBe(true);
    expect(ends[2]!.result.content[0].text).toContain('[timed out]');
  });

  it('asks the node write broker before write/edit and does not write when refused', async () => {
    const agent = await start({ env: { PIRC_WRITE_BROKER: '1' } });
    writeFileSync(path.join(agent.workspace, 'a.txt'), 'alpha\n');
    agent.llm.push(
      { tool: ptcCall('w', 'write', { path: 'sub/b.txt', content: 'new' }) },
      { tool: ptcCall('e', 'edit', { path: 'a.txt', oldText: 'alpha', newText: 'beta' }) },
      { tool: ptcCall('r', 'read', { path: 'a.txt' }) },
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'write' });
    const requests: Array<Record<string, any>> = [];
    for (const granted of [false, true]) {
      const request = await agent.waitFor(
        (event) => event.type === 'write_lease_request' && !requests.includes(event),
      );
      requests.push(request);
      agent.raw({
        type: 'write_lease_response',
        id: request.id,
        granted,
        ...(granted ? {} : { error: 'busy elsewhere' }),
      });
    }
    await settledAfter(agent, 0);
    // Leases are for the workspace root, whichever file is written under it.
    const root = realpathSync(agent.workspace);
    expect(requests.map((request) => request.path)).toEqual([root, root]);
    expect(agent.events.filter((event) => event.type === 'write_lease_request')).toHaveLength(2);
    const ends = agent.events.filter(
      (event) => event.type === 'tool_execution_end' && !event.parentToolCallId,
    );
    expect(ends.map((end) => end.isError)).toEqual([true, false, false]);
    expect(ends[0]!.result.content[0].text).toContain('busy elsewhere');
    // A refused lease is an OperationFailed inside the script.
    expect(ends[0]!.result.content[0].text).toContain('[error] OperationFailed');
    expect(ends[2]!.result.content[0].text).toContain('beta');
    expect(existsSync(path.join(agent.workspace, 'sub'))).toBe(false);
    expect(readFileSync(path.join(agent.workspace, 'a.txt'), 'utf8')).toBe('beta\n');
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
      { tool: ptcCall('toolu_1', 'ls', {}), thinking: 'hmm', text: 'Listing.' },
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
    expect(assistant.content[2].name).toBe('ptc');
    expect(first!.body.tools.map((tool: any) => tool.name)).toEqual(CODING_SURFACE);
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
      { tool: ptcCall('h1', 'bash', { command: 'rm -rf /tmp/whatever' }) },
      { tool: ptcCall('h2', 'write', { path: 'out.txt', content: 'quiet' }) },
      { text: 'ok' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    const ends = agent.events.filter(
      (event) => event.type === 'tool_execution_end' && !event.parentToolCallId,
    );
    expect(ends[0]!.isError).toBe(true);
    expect(ends[0]!.result.content[0].text).toContain('no deleting');
    // A hook block is an ApprovalDenied inside the script.
    expect(ends[0]!.result.content[0].text).toContain('[error] ApprovalDenied');
    expect(readFileSync(path.join(agent.workspace, 'out.txt'), 'utf8')).toBe('QUIET');
    expect(ends[1]!.result.content.at(-1).text).toContain('formatted');
    expect(agent.llm.requests[0]!.body.messages[0].content).toContain('SESSION-HOOK-CONTEXT');
  });

  it('merges trusted project config from .pirc', async () => {
    const root = path.join(tmpdir(), `pirc-proj-${Date.now()}`);
    mkdirSync(path.join(root, '.pirc'), { recursive: true });
    writeFileSync(path.join(root, '.pirc/AGENTS.md'), 'PROJECT-PROMPT');
    writeFileSync(
      path.join(root, '.pirc/config.json'),
      JSON.stringify({ env: { PIRC_TEST_VAR: 'from-project' } }),
    );
    // Project env applies only once trusted (agent-project-trust.test.ts).
    const trust = projectTrustHash(projectTrustFields(readProjectConfig(root)));
    const agent = await start({ workspace: root, env: { PIRC_PROJECT_TRUST: trust } });
    agent.llm.push(
      { tool: ptcCall('e', 'bash', { command: 'echo $PIRC_TEST_VAR' }) },
      { text: 'k' },
    );
    await agent.send({ type: 'prompt', message: 'env' });
    await settledAfter(agent, 0);
    const end = agent.events.find(
      (event) => event.type === 'tool_execution_end' && !event.parentToolCallId,
    );
    expect(end!.result.content[0].text).toContain('from-project');
    expect(agent.llm.requests[0]!.body.messages[0].content).toContain('PROJECT-PROMPT');
  });
});
