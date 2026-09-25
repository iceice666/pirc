import { mkdirSync, writeFileSync } from 'node:fs';
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
const runCode = async (agent: AgentProcess, code: string, extra: Record<string, unknown> = {}) => {
  agent.llm.push(
    { tool: { id: `code-${Date.now()}`, name: 'code', args: { code, ...extra } } },
    { text: 'ok' },
  );
  const from = agent.events.length;
  await agent.send({ type: 'prompt', message: 'run code' });
  await settledAfter(agent, from);
  return agent.events.findLast((e) => e.type === 'tool_execution_end')!;
};

describe('code mode (PTC)', () => {
  it('runs TypeScript that calls tools and returns a value', async () => {
    const agent = await start();
    for (const name of ['a', 'b', 'c'])
      writeFileSync(path.join(agent.workspace, `${name}.txt`), name.repeat(3));
    const end = await runCode(
      agent,
      `const list = (await tools.find({ pattern: '*.txt' })).split('\\n');
       const sizes: Record<string, number> = {};
       for (const f of list) sizes[f] = (await tools.read({ path: f })).length;
       console.log('checked', list.length);
       return sizes;`,
    );
    expect(end.isError).toBe(false);
    const out = end.result.content[0].text;
    expect(out).toContain('checked 3');
    expect(out).toContain('"a.txt"');
    expect(out).toContain('[4 tool calls]');
    // Nested tool calls are not separate events.
    expect(agent.events.filter((e) => e.type === 'tool_execution_start')).toHaveLength(1);
  });

  it('keeps workspace limits for nested tool calls and surfaces errors', async () => {
    const outside = path.join(tmpdir(), `pirc-ptc-out-${Date.now()}`);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'x'), 'secret');
    const agent = await start();
    const end = await runCode(
      agent,
      `return await tools.read({ path: ${JSON.stringify(path.join(outside, 'x'))} });`,
    );
    expect(end.isError).toBe(true);
    expect(end.result.content[0].text).toContain('outside the workspace');
    const raw = await runCode(
      agent,
      `const r = await tools.call('write', { path: '.pirc/config.json', content: '{}' }); return r.isError;`,
    );
    expect(raw.result.content[0].text).toContain('[return]\ntrue');
    const syntax = await runCode(agent, `return (;`);
    expect(syntax.isError).toBe(true);
    const disallowed = await runCode(agent, `return await tools.code({ code: 'return 1' });`);
    expect(disallowed.result.content[0].text).toContain('not available in code mode');
  });

  it('runs in the workspace, enforces timeout and caps output', async () => {
    const agent = await start({ config: { limits: { toolOutputBytes: 2000 } } });
    const cwd = await runCode(agent, `return process.cwd();`);
    expect(cwd.result.content[0].text).toContain(agent.workspace.replace('/private', ''));
    const started = Date.now();
    const slow = await runCode(agent, `await new Promise(() => setInterval(() => {}, 1000));`, {
      timeout: 0.5,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(slow.isError).toBe(true);
    expect(slow.result.content[0].text).toContain('[timed out after 0.5s]');
    const noisy = await runCode(
      agent,
      `for (let i = 0; i < 5000; i++) console.log('line ' + i); return 'end';`,
    );
    const text = noisy.result.content[0].text;
    expect(Buffer.byteLength(text)).toBeLessThan(2500);
    expect(text).toContain('bytes truncated');
    expect(text).toContain('line 4999');
  });

  it('applies beforeTool hooks to calls made from code', async () => {
    const agent = await start({
      config: {
        hooks: { beforeTool: [{ matcher: 'bash', command: 'echo "bash denied" >&2; exit 2' }] },
      },
    });
    const end = await runCode(
      agent,
      `try { await tools.bash({ command: 'echo hi' }); } catch (e) { return String(e.message); }`,
    );
    expect(end.result.content[0].text).toContain('bash denied');
  });
});
