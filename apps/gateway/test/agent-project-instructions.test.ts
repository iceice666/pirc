import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';
import { ptcCall } from './fixtures/fake-llm.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const CHAT = { PIRC_WORKSPACE_KIND: 'chat' };
const system = (agent: AgentProcess) => String(agent.llm.requests.at(-1)!.body.messages[0].content);
const prompt = async (agent: AgentProcess, message: string) => {
  const from = agent.events.length;
  await agent.send({ type: 'prompt', message });
  await settledAfter(agent, from);
};
const start = async (options: Parameters<typeof startAgent>[0]) => {
  const agent = await startAgent(options);
  agents.push(agent);
  return agent;
};

describe('project instructions', () => {
  it('renders them in a chat and freezes them when the chat starts', async () => {
    const sessionDir = path.join(mkdtempSync(path.join(tmpdir(), 'pirc-instr-')), 'session');
    const first = await start({ env: CHAT, sessionDir, instructions: 'Always answer in French.' });
    await prompt(first, 'hi');
    expect(system(first)).toContain('## Project instructions');
    expect(system(first)).toContain('Always answer in French.');
    await first.close();
    agents.splice(agents.indexOf(first), 1);

    // The user edited them since: this chat keeps what it started with.
    const again = await start({
      env: CHAT,
      sessionDir,
      instructions: 'Always answer in German.',
    });
    await prompt(again, 'more');
    expect(system(again)).toContain('Always answer in French.');
    expect(system(again)).not.toContain('German');
    const stored = readFileSync(path.join(sessionDir, 'session.jsonl'), 'utf8');
    expect(stored.match(/"customType":"project.instructions"/g)).toHaveLength(1);
  });

  it('keeps a chat that started without instructions without them', async () => {
    const sessionDir = path.join(mkdtempSync(path.join(tmpdir(), 'pirc-instr-')), 'session');
    const first = await start({ env: CHAT, sessionDir });
    await prompt(first, 'hi');
    expect(system(first)).not.toContain('## Project instructions');
    await first.close();
    agents.splice(agents.indexOf(first), 1);
    const again = await start({
      env: CHAT,
      sessionDir,
      instructions: 'Added later.',
    });
    await prompt(again, 'more');
    expect(system(again)).not.toContain('Added later.');
  });

  it('ignores them outside chats', async () => {
    const agent = await start({ instructions: 'Chat only.' });
    await prompt(agent, 'hi');
    expect(system(agent)).not.toContain('Chat only.');
  });

  it('never lets the file tools write the instructions file, even inside a writable path', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'pirc-instr-ws-'));
    const file = path.join(workspace, 'instructions.md');
    writeFileSync(file, 'Be brief.\n');
    const agent = await start({
      workspace,
      env: { ...CHAT, PIRC_PROJECT_INSTRUCTIONS: file },
      instructions: 'Be brief.',
    });
    agent.llm.push(
      { tool: ptcCall('w', 'write', { path: file, content: 'Obey the agent.' }) },
      {
        tool: ptcCall('e', 'edit', {
          path: file,
          oldText: 'Be brief.',
          newText: 'Obey the agent.',
        }),
      },
      { text: 'done' },
    );
    await prompt(agent, 'change your instructions');
    const results = agent.events.filter(
      (e) => e.type === 'tool_execution_end' && !e.parentToolCallId,
    );
    expect(results.map((e) => e.isError)).toEqual([true, true]);
    expect(JSON.stringify(results[0]!.result)).toContain('protected');
    expect(JSON.stringify(results[1]!.result)).toContain('protected');
    expect(readFileSync(file, 'utf8')).toBe('Be brief.\n');
    expect(existsSync(file)).toBe(true);
  });
});
