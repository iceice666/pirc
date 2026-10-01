import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Reply } from './fixtures/fake-llm.js';
import { settledAfter, startAgent, writeRoles, type AgentProcess } from './agent-harness.js';
import { startFakeLlm } from './fixtures/fake-llm.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const texts = (body: any): string =>
  body.messages
    .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
const isSubagent = (body: any) => texts(body).includes('You are a one-shot subagent');
const isTeammate = (body: any) => texts(body).includes('Team message (agent data');
const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name);
const toolEnd = (agent: AgentProcess, name: string) =>
  agent.events.filter((e) => e.type === 'tool_execution_end' && e.toolName === name);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('subagent tool', () => {
  it('runs a foreground one-shot subagent and returns only its final report', async () => {
    const agent = await startAgent({
      config: { features: { sessionTitle: { enabled: false } } },
      roles: { explorer: '---\ntools: [read, grep, ls]\n---\n' },
    });
    agents.push(agent);
    const child: Reply[] = [
      { tool: { id: 'c1', name: 'ls', args: {} } },
      { text: 'Found nothing interesting.' },
    ];
    const parent: Reply[] = [
      {
        tool: {
          id: 'p1',
          name: 'subagent',
          args: { task: 'look around', role: 'explorer', name: 'scout' },
        },
      },
      { text: 'parent done' },
    ];
    agent.llm.route = (body) =>
      (isSubagent(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'delegate' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBeFalsy();
    expect(end!.result.content[0].text).toContain('Subagent scout done');
    expect(end!.result.content[0].text).toContain('Found nothing interesting.');
    // The report arrives as the tool result, not as an extra wakeup.
    expect(
      agent.events.some((e) => e.type === 'message_end' && e.message.customType === 'agent-team'),
    ).toBe(false);
    // Kind allowlist applies, and one-shot subagents get no team or spawn tools.
    const childRequest = agent.llm.requests.find((r) => isSubagent(r.body))!;
    expect(toolNames(childRequest.body).sort()).toEqual(['grep', 'ls', 'read']);
    const state = await agent.send({ type: 'get_panel_state' });
    const scout = state.data.team.agents.find((a: any) => a.name === 'scout');
    expect(scout).toMatchObject({
      mode: 'subagent',
      status: 'done',
      tools: ['read', 'grep', 'ls'],
    });
    await Bun.sleep(300);
    expect(alive(scout.pid)).toBe(false);
  }, 30_000);

  it("writes under the parent session's write lease", async () => {
    const agent = await startAgent({ env: { PIRC_WRITE_BROKER: '1' } });
    agents.push(agent);
    const child: Reply[] = [
      { tool: { id: 'c1', name: 'write', args: { path: 'first.txt', content: 'x' } } },
      { tool: { id: 'c2', name: 'write', args: { path: 'second.txt', content: 'y' } } },
      { text: 'wrote what I could' },
    ];
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'subagent', args: { task: 'write files', name: 'writer' } } },
      { text: 'parent done' },
    ];
    agent.llm.route = (body) =>
      (isSubagent(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'delegate' });
    // The child's requests surface as the parent's own, answered by the node.
    const seen: Array<Record<string, any>> = [];
    for (const granted of [true, false]) {
      const request = await agent.waitFor(
        (event) => event.type === 'write_lease_request' && !seen.includes(event),
        15_000,
      );
      seen.push(request);
      agent.raw({
        type: 'write_lease_response',
        id: request.id,
        granted,
        ...(granted ? {} : { error: 'another session is writing' }),
      });
    }
    await settledAfter(agent, from);
    expect(await Bun.file(`${agent.workspace}/first.txt`).exists()).toBe(true);
    expect(await Bun.file(`${agent.workspace}/second.txt`).exists()).toBe(false);
    const childRequest = agent.llm.requests.filter((r) => isSubagent(r.body)).at(-1)!;
    expect(texts(childRequest.body)).toContain('another session is writing');
  }, 30_000);

  it('asks for sandbox approvals through the parent, named in the reason', async () => {
    const agent = await startAgent({ env: { PIRC_SANDBOX: 'srt' } });
    agents.push(agent);
    const child: Reply[] = [
      {
        tool: {
          id: 'c1',
          name: 'sandbox_allow_domains',
          args: { domains: ['api.example.com'], reason: 'fetch the schema' },
        },
      },
      {
        tool: {
          id: 'c2',
          name: 'unsandboxed_bash',
          args: { command: 'nix build', reason: 'needs the nix daemon' },
        },
      },
      { text: 'asked' },
    ];
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'subagent', args: { task: 'build it', name: 'scout' } } },
      { text: 'parent done' },
    ];
    agent.llm.route = (body) =>
      (isSubagent(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'delegate' });
    // The child's requests reach the node as the parent's own.
    const network = await agent.waitFor((event) => event.type === 'sandbox_request', 15_000);
    expect(network.op).toBe('network');
    expect(network.args.reason).toBe('[asked by scout] fetch the schema');
    agent.raw({
      type: 'sandbox_response',
      id: network.id,
      ok: true,
      result: { granted: ['api.example.com'] },
    });
    const exec = await agent.waitFor(
      (event) => event.type === 'sandbox_request' && event.op === 'exec',
      15_000,
    );
    expect(exec.args).toMatchObject({
      command: 'nix build',
      reason: '[asked by scout] needs the nix daemon',
    });
    agent.raw({
      type: 'sandbox_response',
      id: exec.id,
      ok: false,
      error: { code: 'denied', message: 'The user did not approve' },
    });
    await settledAfter(agent, from);
    const childRequests = agent.llm.requests.filter((r) => isSubagent(r.body));
    expect(toolNames(childRequests[0]!.body)).toEqual(
      expect.arrayContaining(['sandbox_allow_domains', 'unsandboxed_bash']),
    );
    const seen = texts(childRequests.at(-1)!.body);
    expect(seen).toContain('Allowed for this session: api.example.com.');
    // The code survives the relay: a refusal, not a crash.
    expect(seen).toContain('The user did not approve running this outside the sandbox');
  }, 30_000);

  it('delivers a background subagent result once when it finishes', async () => {
    const agent = await startAgent();
    agents.push(agent);
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'subagent', args: { task: 'slow work', background: true } } },
      { text: 'started it' },
      { text: 'got the report' },
    ];
    let childCalls = 0;
    agent.llm.route = (body) => {
      if (!isSubagent(body)) return parent.shift() ?? { text: 'extra' };
      childCalls++;
      return childCalls === 1
        ? { tool: { id: 'c1', name: 'bash', args: { command: 'sleep 0.3' } } }
        : { text: 'background report' };
    };
    await agent.send({ type: 'prompt', message: 'delegate in background' });
    const [start] = await Promise.all([
      agent.waitFor((e) => e.type === 'tool_execution_end' && e.toolName === 'subagent'),
    ]);
    const started = JSON.parse(start.result.content[0].text);
    expect(started).toMatchObject({ mode: 'subagent', background: true });
    expect(started.name).toMatch(/^sub-/);
    const wake = await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.customType === 'agent-team',
      15_000,
    );
    expect(wake.message.content).toContain('subagent_result');
    expect(wake.message.content).toContain('background report');
    await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.content?.[0]?.text === 'got the report',
    );
    await Bun.sleep(300);
    const notices = agent.events.filter(
      (e) => e.type === 'message_end' && e.message.customType === 'agent-team',
    );
    expect(notices).toHaveLength(1);
  }, 30_000);

  it('lets the parent read a truncated report in full through agent_inbox', async () => {
    // Memory workers would answer to the same fake model; keep the script to the parent.
    const agent = await startAgent({
      config: { features: { observationalMemory: { enabled: false } } },
    });
    agents.push(agent);
    // 45,000 characters, every line distinct, past the 40,000-character tool result.
    const report = Array.from(
      { length: 5000 },
      (_, i) => `row ${String(i).padStart(4, '0')}\n`,
    ).join('');
    const total = report.trim().length; // the stored report is trimmed
    expect(total).toBe(44_999);
    const lastTool = (body: any) => {
      const last = body.messages.at(-1);
      return last.role === 'tool' ? String(last.content) : '';
    };
    let eventId = '';
    const parent: Array<(body: any) => Reply> = [
      () => ({ tool: { id: 'p1', name: 'subagent', args: { task: 'write it', name: 'writer' } } }),
      (body) => {
        eventId = /agent_inbox with event_id=(\S+) offset=40000/.exec(lastTool(body))![1]!;
        return { tool: { id: 'p2', name: 'agent_inbox', args: {} } };
      },
      () => ({
        tool: { id: 'p3', name: 'agent_inbox', args: { event_id: eventId, offset: 40_000 } },
      }),
      () => ({ text: 'read it all' }),
    ];
    agent.llm.route = (body) =>
      isSubagent(body) ? { text: report } : (parent.shift()?.(body) ?? { text: 'extra' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'delegate' });
    await settledAfter(agent, from);

    const [end] = toolEnd(agent, 'subagent');
    const shown = end!.result.content[0].text as string;
    expect(shown).toContain('row 4443');
    expect(shown).not.toContain('row 4445');
    expect(shown).toContain('[Result truncated at 40000 of 44999 characters');

    const [page, rest] = toolEnd(agent, 'agent_inbox').map((e) =>
      JSON.parse(e.result.content[0].text),
    );
    const entry = page.items.find((item: any) => item.id === eventId);
    expect(entry).toMatchObject({ truncated: true, total_chars: total, next_offset: 12_000 });
    expect(rest.event).toMatchObject({
      id: eventId,
      from: 'writer',
      to: 'parent',
      offset: 40_000,
      total_chars: total,
      next_offset: null,
    });
    expect(
      shown.split('\n[Result truncated')[0]!.split(':\n').slice(1).join(':\n') + rest.event.body,
    ).toBe(report.trim());
  }, 30_000);

  it('reports a failed subagent as an error result', async () => {
    const agent = await startAgent();
    agents.push(agent);
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'subagent', args: { task: 'break' } } },
      { text: 'noted' },
    ];
    agent.llm.route = (body) =>
      isSubagent(body) ? { status: 400, body: 'bad request' } : (parent.shift() ?? { text: 'x' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'delegate' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBe(true);
    expect(end!.result.content[0].text).toMatch(/failed/);
  }, 30_000);
});

describe('team kinds and results', () => {
  it('keeps coordination tools for restricted teammates and reports once per idle', async () => {
    const agent = await startAgent({
      config: { features: { sessionTitle: { enabled: false } } },
      roles: { reader: '---\ntools: [read]\n---\n' },
    });
    agents.push(agent);
    const child: Reply[] = [
      { text: 'thinking out loud', tool: { id: 'c1', name: 'read', args: { path: 'nope' } } },
      { text: 'final teammate answer' },
    ];
    const parent: Reply[] = [
      {
        tool: {
          id: 'p1',
          name: 'agent_spawn',
          args: { name: 'reader', task: 'read', role: 'reader' },
        },
      },
      { text: 'spawned' },
      { text: 'noted' },
    ];
    agent.llm.route = (body) =>
      (isTeammate(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    await agent.send({ type: 'prompt', message: 'spawn' });
    const wake = await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.customType === 'agent-team',
      15_000,
    );
    expect(wake.message.content).toContain('final teammate answer');
    await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.content?.[0]?.text === 'noted',
    );
    await Bun.sleep(200);
    expect(
      agent.events.filter((e) => e.type === 'message_end' && e.message.customType === 'agent-team'),
    ).toHaveLength(1);
    const childRequest = agent.llm.requests.find((r) => isTeammate(r.body))!;
    const names = toolNames(childRequest.body);
    expect(names).toContain('read');
    expect(names).toContain('task_update');
    expect(names).toContain('agent_send');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('subagent');
  }, 30_000);

  it('lists roles for the parent and gives the child its role instructions', async () => {
    // The node's role files, then the workspace's .pirc/roles/ replaces one and adds one.
    const workspace = mkdtempSync(path.join(tmpdir(), 'pirc-roles-'));
    writeRoles(path.join(workspace, '.pirc', 'roles'), {
      reviewer: [
        '---',
        'description: Read-only code review',
        'tools:',
        '  - read',
        '  - grep',
        '---',
        '',
        'Report findings as file:line with severity.',
        '',
        'Second paragraph.',
      ].join('\n'),
      writer: '---\ndescription: Writes docs\n---\n',
    });
    const agent = await startAgent({
      workspace,
      config: { features: { sessionTitle: { enabled: false } } },
      roles: { reviewer: '---\ndescription: Global reviewer\n---\nGlobal text.\n' },
    });
    agents.push(agent);
    const child: Reply[] = [{ text: 'no findings' }];
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'subagent', args: { task: 'review', role: 'reviewer' } } },
      { text: 'parent done' },
    ];
    agent.llm.route = (body) =>
      (isSubagent(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'delegate' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBeFalsy();
    const parentRequest = agent.llm.requests.find((r) => !isSubagent(r.body))!;
    const role = parentRequest.body.tools.find((t: any) => t.function.name === 'subagent').function
      .parameters.properties;
    expect(role.model).toBeUndefined();
    expect(role.thinking).toBeUndefined();
    expect(role.role.enum).toEqual(['general', 'reviewer', 'writer']);
    expect(role.role.description).toContain(
      '- reviewer: Read-only code review [tools: read, grep]',
    );
    expect(texts(parentRequest.body)).not.toContain('Report findings as file:line');
    const childRequest = agent.llm.requests.find((r) => isSubagent(r.body))!;
    expect(texts(childRequest.body)).toContain('## Role: reviewer');
    expect(texts(childRequest.body)).toContain(
      'Report findings as file:line with severity.\n\nSecond paragraph.',
    );
    expect(texts(childRequest.body)).not.toContain('Global text.');
    expect(toolNames(childRequest.body).sort()).toEqual(['grep', 'read']);
  }, 30_000);

  it('refuses a model or thinking level from the agent', async () => {
    const agent = await startAgent({ config: { features: { sessionTitle: { enabled: false } } } });
    agents.push(agent);
    agent.llm.push(
      { tool: { id: 'a', name: 'subagent', args: { task: 'x', model: 'fake/other' } } },
      { text: 'ok' },
    );
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'try' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBe(true);
    expect(end!.result.content[0].text).toMatch(/set by the role/);
  });

  it('rejects invalid role files', async () => {
    const agent = await startAgent({
      config: { features: { sessionTitle: { enabled: false } } },
      roles: { bad: '---\nthinking: loud\ncolor: red\n---\nText.\n' },
    });
    agents.push(agent);
    agent.llm.push({ tool: { id: 'a', name: 'subagent', args: { task: 'x' } } }, { text: 'ok' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'try' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBe(true);
    expect(end!.result.content[0].text).toMatch(
      /bad\.md: Unknown front matter for role bad: color/,
    );
  });

  it('rejects invalid role tool lists', async () => {
    const agent = await startAgent({
      config: { features: { sessionTitle: { enabled: false } } },
      roles: { bad: '---\ntools: ["Not A Tool"]\n---\n' },
    });
    agents.push(agent);
    agent.llm.push({ tool: { id: 'a', name: 'subagent', args: { task: 'x' } } }, { text: 'ok' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'try' });
    await settledAfter(agent, from);
    const [end] = toolEnd(agent, 'subagent');
    expect(end!.isError).toBe(true);
    expect(end!.result.content[0].text).toMatch(/Invalid tool name/);
  });
});

describe('team task board', () => {
  it('enforces dependencies, claims and revisions', async () => {
    const agent = await startAgent();
    agents.push(agent);
    const call = (id: string, name: string, args: Record<string, unknown>): Reply => ({
      tool: { id, name, args },
    });
    agent.llm.push(
      call('t1', 'task_create', { subject: 'schema', description: 'design schema' }),
      call('t2', 'task_create', { subject: 'api', description: 'build api', blocked_by: ['1'] }),
      call('t3', 'task_update', { task_id: '2', action: 'claim' }),
      call('t4', 'task_update', { task_id: '1', action: 'claim' }),
      call('t5', 'task_update', { task_id: '1', action: 'complete', expected_revision: 0 }),
      call('t6', 'task_update', { task_id: '1', action: 'complete' }),
      call('t7', 'task_list', { ready: true }),
      call('t8', 'task_update', { task_id: '1', action: 'set_dependencies', blocked_by: ['2'] }),
      { text: 'board done' },
    );
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'plan' });
    await settledAfter(agent, from);
    const ends = agent.events.filter((e) => e.type === 'tool_execution_end');
    const body = (i: number) => ends[i]!.result.content[0].text as string;
    expect(JSON.parse(body(1))).toMatchObject({ id: '2', blocked: true, ready: false });
    expect(ends[2]!.isError).toBe(true);
    expect(body(2)).toMatch(/blocked/);
    expect(JSON.parse(body(3))).toMatchObject({ status: 'in_progress', owner: 'parent' });
    expect(ends[4]!.isError).toBe(true);
    expect(body(4)).toMatch(/Revision mismatch/);
    expect(JSON.parse(body(5))).toMatchObject({ status: 'completed' });
    const ready = JSON.parse(body(6)).tasks;
    expect(ready.map((t: any) => t.id)).toEqual(['2']);
    expect(ends[7]!.isError).toBe(true);
    expect(body(7)).toMatch(/cycle/);
    const state = await agent.send({ type: 'get_panel_state' });
    expect(state.data.team.tasks.map((t: any) => t.status)).toEqual(['completed', 'pending']);
  });
});

describe('session roles', () => {
  it('starts a delegated session in a workspace role, once, and keeps it on restart', async () => {
    const config = { features: { sessionTitle: { enabled: false } } };
    const roles = {
      reviewer: '---\nthinking: high\ntools: read, grep\n---\nReview only; cite file:line.\n',
    };
    const agent = await startAgent({ config, roles });
    agents.push(agent);
    const unknown = await agent.send({ type: 'set_role', role: 'nope' });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain('Unknown role: nope; available: general, reviewer');
    expect((await agent.send({ type: 'set_role', role: 'reviewer' })).success).toBe(true);
    // Setting the same role again is harmless; another one is not.
    expect((await agent.send({ type: 'set_role', role: 'reviewer' })).success).toBe(true);
    expect((await agent.send({ type: 'set_role', role: 'general' })).success).toBe(false);
    agent.llm.push({ text: 'reviewed' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'look' });
    await settledAfter(agent, from);
    const [request] = agent.llm.requests;
    expect(texts(request!.body)).toContain('## Role: reviewer');
    expect(texts(request!.body)).toContain('Review only; cite file:line.');
    expect(toolNames(request!.body).sort()).toEqual(['grep', 'read']);
    expect((await agent.send({ type: 'get_state' })).data.thinkingLevel).toBe('high');
    await agent.close();
    agents.splice(agents.indexOf(agent), 1);

    // The same session, restarted: still in the role.
    const again = await startAgent({
      config,
      roles,
      workspace: agent.workspace,
      sessionDir: agent.sessionDir,
      args: ['--continue'],
    });
    agents.push(again);
    again.llm.push({ text: 'again' });
    const next = again.events.length;
    await again.send({ type: 'prompt', message: 'more' });
    await settledAfter(again, next);
    const [resumed] = again.llm.requests;
    expect(texts(resumed!.body)).toContain('## Role: reviewer');
    expect(toolNames(resumed!.body).sort()).toEqual(['grep', 'read']);
  }, 30_000);
});

describe('role model fallback', () => {
  const model = (id: string) => ({
    id,
    reasoning: false,
    contextWindow: 100_000,
    maxTokens: 1000,
    input: ['text'],
    compat: {},
  });
  const providers = (url: string) => ({
    fake: {
      api: 'openai-chat',
      baseUrl: `${url}/v1`,
      apiKey: 'fake-key',
      headers: {},
      compat: {},
      models: [model('m-1'), model('m-2')],
    },
    other: {
      api: 'openai-chat',
      baseUrl: `${url}/v1`,
      apiKey: 'other-key',
      headers: {},
      compat: {},
      models: [model('m-2')],
    },
  });

  it('starts on the first match and moves along the role models when a call fails', async () => {
    const llm = startFakeLlm();
    const agent = await startAgent({
      llm,
      config: {
        features: { sessionTitle: { enabled: false } },
        providers: providers(llm.url),
        defaultModel: { provider: 'fake', id: 'm-1' },
      },
      // No such model, then fake/m-2 and other/m-2, then the rest of fake.
      roles: { worker: '---\nmodel: [gone/x, "*/m-2", "fake/*"]\n---\n' },
    });
    agents.push(agent);
    try {
      expect((await agent.send({ type: 'set_role', role: 'worker' })).success).toBe(true);
      expect((await agent.send({ type: 'get_state' })).data.model).toMatchObject({
        provider: 'fake',
        id: 'm-2',
      });
      llm.push(
        { status: 429, body: 'rate limited' },
        { status: 503, body: 'overloaded' },
        { text: 'done' },
      );
      const from = agent.events.length;
      await agent.send({ type: 'prompt', message: 'go' });
      await settledAfter(agent, from);
      // Each failure moves on at once, without waiting to retry the same model.
      expect(
        llm.requests.map((r) => `${r.headers.authorization?.split(' ')[1]}:${r.body.model}`),
      ).toEqual(['fake-key:m-2', 'other-key:m-2', 'fake-key:m-1']);
      expect(agent.events.filter((e) => e.type === 'auto_retry_start')).toHaveLength(0);
      // The session stays on the fallback.
      expect((await agent.send({ type: 'get_state' })).data.model).toMatchObject({
        provider: 'fake',
        id: 'm-1',
      });
      llm.push({ text: 'again' });
      const next = agent.events.length;
      await agent.send({ type: 'prompt', message: 'more' });
      await settledAfter(agent, next);
      expect(llm.requests.at(-1)!.body.model).toBe('m-1');
    } finally {
      llm.stop();
    }
  }, 30_000);

  it('starts a subagent on the role model, and the child falls back by itself', async () => {
    const llm = startFakeLlm();
    const agent = await startAgent({
      llm,
      config: {
        features: { sessionTitle: { enabled: false } },
        providers: providers(llm.url),
        defaultModel: { provider: 'fake', id: 'm-1' },
      },
      roles: { worker: '---\nmodel: "*/m-2"\n---\n' },
    });
    agents.push(agent);
    try {
      const child: Reply[] = [{ status: 429, body: 'rate limited' }, { text: 'child done' }];
      const parent: Reply[] = [
        { tool: { id: 'p1', name: 'subagent', args: { task: 'work', role: 'worker' } } },
        { text: 'parent done' },
      ];
      llm.route = (body) =>
        (isSubagent(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
      const from = agent.events.length;
      await agent.send({ type: 'prompt', message: 'delegate' });
      await settledAfter(agent, from);
      const [end] = toolEnd(agent, 'subagent');
      expect(end!.result.content[0].text).toContain('child done');
      expect(
        llm.requests
          .filter((r) => isSubagent(r.body))
          .map((r) => `${r.headers.authorization?.split(' ')[1]}:${r.body.model}`),
      ).toEqual(['fake-key:m-2', 'other-key:m-2']);
    } finally {
      llm.stop();
    }
  }, 30_000);
});
