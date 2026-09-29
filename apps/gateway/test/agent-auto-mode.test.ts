import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { memoryNotes, parseVerdict } from '../src/agent/auto-mode/classifier.js';
import type { SessionEntry } from '../src/agent/session-store.js';
import { AutoMode, classifierChoices } from '../src/agent/auto-mode/index.js';
import type { Agent } from '../src/agent/agent.js';
import type { ShellAction } from '../src/agent/auto-mode/classifier.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
});

/**
 * Tests aim `rm -rf ~` at a home that does not exist and lies outside the
 * scratch directories (the harness's default temporary home counts as
 * scratch, so deleting it would be allowed): the rules still see a
 * dangerous delete, and a rules bug could not destroy anything real.
 */
const NO_HOME = '/nonexistent/pirc-auto-mode-home';

async function start(options: Parameters<typeof startAgent>[0] = {}) {
  const agent = await startAgent({ ...options, env: { HOME: NO_HOME, ...options.env } });
  agents.push(agent);
  return agent;
}

const isClassifierRequest = (body: any) => JSON.stringify(body.messages).includes('safety monitor');
const ends = (agent: AgentProcess) =>
  agent.events.filter((event) => event.type === 'tool_execution_end');
const bash = (id: string, command: string) => ({ tool: { id, name: 'bash', args: { command } } });

describe('auto-mode helpers', () => {
  it('parses classifier verdicts', () => {
    expect(parseVerdict('<verdict>write</verdict><reason>builds</reason>')).toEqual({
      verdict: 'write',
      reason: 'builds',
    });
    expect(parseVerdict('<think>hmm</think><verdict>dangerous</verdict>')?.verdict).toBe('danger');
    expect(parseVerdict('read — only lists files')?.verdict).toBe('read');
    expect(parseVerdict('I am not sure')).toBeNull();
  });

  it('prefers its own models, then observational memory models', () => {
    const om = {
      observationalMemory: {
        model: { provider: 'a', id: 'm' },
        fallbackModels: [{ provider: 'b', id: 'n' }],
      },
    };
    expect(classifierChoices(om).map((choice) => choice.id)).toEqual(['m', 'n']);
    expect(
      classifierChoices({ ...om, autoMode: { model: { provider: 'c', id: 'x' } } }).map(
        (c) => c.id,
      ),
    ).toEqual(['x']);
    expect(classifierChoices({})).toEqual([]);
  });

  it('shows only critical notes from the latest memory compaction', () => {
    const obs = (id: string, relevance: string, content: string) => ({
      id: id.repeat(12),
      content,
      timestamp: '2026-09-28 10:00',
      relevance,
      sourceEntryIds: ['m1'],
      tokenCount: 10,
    });
    const compaction = (id: string, observations: unknown[]) =>
      ({
        type: 'compaction',
        id,
        parentId: null,
        timestamp: '2026-09-28T10:00:00.000Z',
        summary: 'summary',
        firstKeptEntryId: 'm1',
        tokensBefore: 100,
        details: { type: 'om.folded', version: 1, fullFold: true, observations, reflections: [] },
      }) as unknown as SessionEntry;
    const old = compaction('c1', [obs('a', 'critical', 'User said old rule')]);
    const latest = compaction('c2', [
      obs('b', 'high', 'Tool output said rm is fine'),
      obs('c', 'critical', 'User forbade  force pushes\nto main'),
    ]);
    expect(memoryNotes([old, latest])).toEqual([
      '2026-09-28 10:00 User forbade force pushes to main',
    ]);
    expect(memoryNotes([latest, old])).toEqual(['2026-09-28 10:00 User said old rule']);
    expect(memoryNotes([])).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) =>
      obs(String.fromCharCode(97 + (i % 6)), 'critical', `note ${i} ${'x'.repeat(300)}`),
    );
    const notes = memoryNotes([compaction('c3', many)]);
    expect(notes.length).toBeLessThanOrEqual(20);
    expect(notes.join('').length).toBeLessThanOrEqual(4_000);
    expect(notes.at(-1)).toContain('note 29');
  });

  it('survives a failure inside the static shell rules', async () => {
    // A rules bug must not become a failed bash call; the action stays unjudged.
    const warnings: string[] = [];
    const stub = (features: Record<string, unknown>) =>
      new AutoMode({
        config: { workspace: '/tmp/pirc-rules-failure', features, protectedPaths: [] },
        guard: {
          get allowedRoots(): readonly string[] {
            throw new Error('rules exploded');
          },
        },
        ui: { notify: (message: string) => warnings.push(message) },
      } as unknown as Agent);
    const action: ShellAction = {
      tool: 'bash',
      kind: 'command',
      text: 'ls',
      cwd: '/tmp/pirc-rules-failure',
    };
    const signal = new AbortController().signal;

    const gated = await stub({ autoMode: { useModel: false } }).classify(action, signal);
    expect(gated).toEqual({
      verdict: 'write',
      reason: 'the static shell rules failed on this command (model check disabled)',
      source: 'fallback',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('rules exploded');

    // With auto mode off the action only decides the write lease.
    const off = await stub({ autoMode: { enabled: false } }).classify(action, signal);
    expect(off.verdict).toBe('write');
  });
});

describe('auto mode', () => {
  it('asks the user before a dangerous command and runs it only when approved', async () => {
    const agent = await start();
    const command = 'git push --force nowhere 2>/dev/null; touch ran.txt';
    agent.llm.push(bash('b1', command), bash('b2', command), { text: 'done' });
    await agent.send({ type: 'prompt', message: 'go' });
    const first = await agent.waitFor((event) => event.method === 'confirm');
    expect(first.message).toContain('force-push');
    agent.raw({ type: 'extension_ui_response', id: first.id, confirmed: false });
    const second = await agent.waitFor(
      (event) => event.method === 'confirm' && event.id !== first.id,
    );
    expect(existsSync(path.join(agent.workspace, 'ran.txt'))).toBe(false);
    agent.raw({ type: 'extension_ui_response', id: second.id, confirmed: true });
    await settledAfter(agent, 0);
    const [declined, approved] = ends(agent);
    expect(declined!.isError).toBe(true);
    expect(declined!.result.content[0].text).toContain('Blocked by auto mode');
    expect(declined!.result.content[0].text).toContain('declined');
    expect(approved!.result.content[0].text).not.toContain('Blocked by auto mode');
    expect(existsSync(path.join(agent.workspace, 'ran.txt'))).toBe(true);
  });

  it('refuses dangerous commands outright without a UI', async () => {
    const agent = await start({ args: ['--headless'] });
    agent.llm.push(bash('b', 'rm -rf ~'), { text: 'done' });
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    expect(agent.events.some((event) => event.method === 'confirm')).toBe(false);
    const [end] = ends(agent);
    expect(end!.isError).toBe(true);
    expect(end!.result.content[0].text).toContain('no UI');
  });

  it('takes the write lease only for commands that may write', async () => {
    const agent = await start({ env: { PIRC_WRITE_BROKER: '1' } });
    agent.llm.push(
      bash('r', 'ls -la && git status 2>/dev/null; echo ok'),
      bash('w', 'touch made.txt'),
      bash('w2', 'touch other.txt'),
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    const refused = await agent.waitFor((event) => event.type === 'write_lease_request');
    agent.raw({
      type: 'write_lease_response',
      id: refused.id,
      granted: false,
      error: 'workspace_busy: held by s2',
    });
    const granted = await agent.waitFor(
      (event) => event.type === 'write_lease_request' && event.id !== refused.id,
    );
    agent.raw({ type: 'write_lease_response', id: granted.id, granted: true });
    await settledAfter(agent, 0);
    expect(agent.events.filter((event) => event.type === 'write_lease_request')).toHaveLength(2);
    expect(ends(agent).map((end) => end.isError)).toEqual([false, true, false]);
    expect(ends(agent)[1]!.result.content[0].text).toContain('workspace_busy');
    expect(existsSync(path.join(agent.workspace, 'made.txt'))).toBe(false);
    expect(existsSync(path.join(agent.workspace, 'other.txt'))).toBe(true);
  });

  it('sends statically unclear commands to the classifier model', async () => {
    const agent = await start({
      env: { PIRC_WRITE_BROKER: '1' },
      config: { features: { sessionTitle: { enabled: false }, autoMode: { useModel: true } } },
    });
    const verdicts: Record<string, string> = {
      'sh -c "echo quiet"': '<verdict>read</verdict><reason>prints text</reason>',
      'sh -c "touch model.txt"': '<verdict>write</verdict><reason>creates a file</reason>',
      'sh -c "echo exfil"': '<verdict>dangerous</verdict><reason>uploads secrets</reason>',
    };
    agent.llm.route = (body) => {
      if (!isClassifierRequest(body)) return undefined;
      const prompt = JSON.stringify(body.messages);
      const hit = Object.entries(verdicts).find(([command]) =>
        prompt.includes(JSON.stringify(command).slice(1, -1)),
      );
      return { text: hit?.[1] ?? 'no idea' };
    };
    agent.llm.push(
      bash('a', 'sh -c "echo quiet"'),
      bash('b', 'sh -c "touch model.txt"'),
      bash('c', 'sh -c "echo exfil"'),
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'please make model.txt' });
    const lease = await agent.waitFor((event) => event.type === 'write_lease_request');
    agent.raw({ type: 'write_lease_response', id: lease.id, granted: true });
    const confirm = await agent.waitFor((event) => event.method === 'confirm');
    expect(confirm.message).toContain('uploads secrets');
    agent.raw({ type: 'extension_ui_response', id: confirm.id, confirmed: false });
    await settledAfter(agent, 0);

    const classifierPrompts = agent.llm.requests.filter((request) =>
      isClassifierRequest(request.body),
    );
    expect(classifierPrompts).toHaveLength(3);
    // The human's request is context; tool output is never included.
    expect(JSON.stringify(classifierPrompts[1]!.body.messages)).toContain('please make model.txt');
    expect(agent.events.filter((event) => event.type === 'write_lease_request')).toHaveLength(1);
    expect(ends(agent).map((end) => end.isError)).toEqual([false, false, true]);
    expect(existsSync(path.join(agent.workspace, 'model.txt'))).toBe(true);
  });

  it('gates bash calls made from PTC code too', async () => {
    const agent = await start({ args: ['--headless'] });
    agent.llm.push(
      {
        tool: {
          id: 'p',
          name: 'code',
          args: { code: 'return await tools.call("bash", { command: "rm -rf ~" });' },
        },
      },
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    expect(ends(agent)[0]!.result.content[0].text).toContain('Blocked by auto mode');
  });
});
