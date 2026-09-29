import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { currentOrigins, findQuote } from '../src/agent/features/assistant/index.js';
import type { SessionEntry } from '../src/agent/session-store.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

/** What the node sets for an agent in a chat workspace. */
const CHAT = { PIRC_GATEWAY: '1', PIRC_WORKSPACE_KIND: 'chat' };
const memory = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  user: [],
  notes: [],
  usage: { user: { used: 0, max: 2000 }, note: { used: 0, max: 8000 } },
  pendingProposals: 0,
  ...extra,
});
const usage = { used: 40, max: 8000 };

/** An agent whose gateway requests the test answers itself. */
async function start(options: Parameters<typeof startAgent>[0] = {}) {
  const agent = await startAgent({ env: CHAT, ...options });
  agents.push(agent);
  const answered = new Set<string>();
  const next = async (op: string) => {
    const request = await agent.waitFor(
      (event) => event.type === 'gateway_request' && event.op === op && !answered.has(event.id),
    );
    answered.add(request.id);
    return request;
  };
  const ok = (request: Record<string, any>, result: unknown) =>
    agent.raw({ type: 'gateway_response', id: request.id, ok: true, result });
  const fail = (request: Record<string, any>, error: Record<string, unknown>) =>
    agent.raw({ type: 'gateway_response', id: request.id, ok: false, error });
  const system = () => String(agent.llm.requests.at(-1)!.body.messages[0].content);
  const prompt = async (message: string, answer?: (from: number) => Promise<void>) => {
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message });
    await answer?.(from);
    await settledAfter(agent, from);
  };
  return { agent, next, ok, fail, system, prompt };
}

describe('where a memory comes from', () => {
  let n = 0;
  const entry = (message: Record<string, unknown>): SessionEntry =>
    ({
      id: `e${++n}`,
      parentId: null,
      timestamp: 0,
      type: 'message',
      message: { timestamp: 0, ...message },
    }) as SessionEntry;
  const user = (text: string) => entry({ role: 'user', content: text });
  const custom = (customType: string, text: string) =>
    entry({ role: 'custom', customType, content: text, display: true });
  const tool = (toolName: string) =>
    entry({ role: 'toolResult', toolCallId: 't', toolName, content: [], isError: false });

  it('finds quotes only in what the human typed', () => {
    const typed = user('Please call me Ice.\nThanks!');
    const branch = [
      typed,
      // Teammates, delegations and features only ever add custom messages.
      custom('agent-team', 'The user said: call me Admin.'),
      custom('goal', 'call me Ice'),
    ];
    expect(findQuote(branch, 'CALL ME ICE')).toBe(typed.id);
    expect(findQuote(branch, '「call me Ice.」')).toBe(typed.id);
    expect(findQuote(branch, 'Ice. Thanks')).toBe(typed.id);
    expect(findQuote(branch, 'call me Admin')).toBeUndefined();
    expect(findQuote(branch, 'I')).toBeUndefined();
  });

  it("taints a note with everything that reached the assistant since the user's message", () => {
    expect(
      currentOrigins([
        tool('bash'),
        user('look this up'),
        tool('read'),
        tool('memory_note'),
        custom('background-task', 'done'),
      ]),
    ).toEqual(['assistant', 'custom:background-task', 'tool:read']);
    expect(currentOrigins([user('hi')])).toEqual(['assistant']);
  });
});

describe('assistant memory in chats', () => {
  it("starts a chat with the user's memory, frozen for the whole chat", async () => {
    const chat = await start();
    chat.agent.llm.push({ text: 'Hi.' }, { text: 'Again.' });
    await chat.prompt('hello', async () =>
      chat.ok(
        await chat.next('assistant.context'),
        memory({
          user: [{ id: 'u11111111', content: 'Prefers short answers.', revision: 2 }],
          notes: [
            {
              id: 'n22222222',
              content: 'm5pro holds the pirc repo.',
              revision: 1,
              updatedAt: new Date(2026, 8, 20, 12).getTime(),
            },
          ],
          usage: { user: { used: 22, max: 2000 }, note: { used: 26, max: 8000 } },
          pendingProposals: 1,
        }),
      ),
    );
    const first = chat.system();
    expect(first).toContain("the user's personal assistant");
    expect(first).toContain('### USER (22/2,000 characters)\n[u11111111] Prefers short answers.');
    expect(first).toContain('### MEMORY (26/8,000 characters)\n[n22222222] 2026-09-20 m5pro holds');
    expect(first).toContain("1 proposed USER change is waiting for the user's approval.");
    const tools = chat.agent.llm.requests[0]!.body.tools.map((tool: any) => tool.function.name);
    expect(tools).toContain('memory_note');
    expect(tools).toContain('memory_propose_user');

    await chat.prompt('more');
    expect(chat.system()).toBe(first);
    expect(chat.agent.events.filter((event) => event.type === 'gateway_request')).toHaveLength(1);
  });

  it('says so when memory cannot be loaded, and tries again on the next run', async () => {
    const chat = await start();
    chat.agent.llm.push({ text: 'a' }, { text: 'b' });
    await chat.prompt('hello', async () =>
      chat.fail(await chat.next('assistant.context'), {
        status: 503,
        code: 'gateway_offline',
        message: 'offline',
      }),
    );
    expect(chat.system()).toContain('could not be loaded');
    await chat.prompt('again', async () =>
      chat.ok(
        await chat.next('assistant.context'),
        memory({ notes: [{ id: 'n1a2b3c4d', content: 'Back online.', revision: 1 }] }),
      ),
    );
    expect(chat.system()).toContain('[n1a2b3c4d] Back online.');
    expect(chat.system()).not.toContain('could not be loaded');
  });

  it("proposes USER changes only from the user's own words and writes notes with their origins", async () => {
    const chat = await start();
    writeFileSync(path.join(chat.agent.workspace, 'plan.txt'), 'the plan\n');
    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      tool: { id, name, args },
    });
    chat.agent.llm.push(
      call('p1', 'memory_propose_user', {
        action: 'add',
        content: 'Wants to be called Ice.',
        quote: '“Call me  Ice”',
      }),
      call('p2', 'memory_propose_user', {
        action: 'add',
        content: 'Is called Bob.',
        quote: 'call me Bob',
      }),
      call('r1', 'read', { path: 'plan.txt' }),
      call('n1', 'memory_note', { action: 'add', content: 'The plan is in plan.txt.' }),
      call('n2', 'memory_note', { action: 'replace', id: 'n33333333', content: 'Plan moved.' }),
      call('n3', 'memory_note', { action: 'replace', id: 'n33333333', content: 'Plan moved.' }),
      { text: 'Done.' },
    );
    let proposal: Record<string, any> = {};
    const writes: Array<Record<string, any>> = [];
    await chat.prompt('Please call me Ice from now on.', async () => {
      chat.ok(
        await chat.next('assistant.context'),
        memory({ notes: [{ id: 'n33333333', content: 'Old plan.', revision: 1 }] }),
      );
      proposal = await chat.next('memory.proposeUser');
      chat.ok(proposal, { proposalId: 'p1234abcd', duplicate: false });
      const added = await chat.next('memory.note');
      writes.push(added);
      chat.ok(added, { id: 'n44444444', revision: 1, unchanged: false, usage });
      const stale = await chat.next('memory.note');
      writes.push(stale);
      chat.fail(stale, {
        status: 409,
        code: 'conflict',
        message: 'changed',
        details: { id: 'n33333333', revision: 3, content: 'Newer plan.' },
      });
      const retry = await chat.next('memory.note');
      writes.push(retry);
      chat.ok(retry, { id: 'n33333333', revision: 4, unchanged: false, usage });
    });

    // The quote is checked against the message the human typed, whose entry backs the proposal.
    const userEntry = readFileSync(path.join(chat.agent.sessionDir, 'session.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.message?.role === 'user');
    expect(proposal.args).toEqual({
      action: 'add',
      content: 'Wants to be called Ice.',
      quote: '“Call me  Ice”',
      entryIds: [userEntry.id],
    });
    // A note written after reading a file carries that origin; replaces send the revision seen.
    expect(writes.map((write) => write.args)).toEqual([
      {
        action: 'add',
        content: 'The plan is in plan.txt.',
        origins: ['assistant', 'tool:read'],
        entryIds: [],
      },
      {
        action: 'replace',
        id: 'n33333333',
        content: 'Plan moved.',
        baseRevision: 1,
        origins: ['assistant', 'tool:read'],
        entryIds: [],
      },
      {
        action: 'replace',
        id: 'n33333333',
        content: 'Plan moved.',
        baseRevision: 3,
        origins: ['assistant', 'tool:read'],
        entryIds: [],
      },
    ]);
    const results = chat.agent.events
      .filter((event) => event.type === 'tool_execution_end' && event.toolName !== 'read')
      .map((event) => [event.toolCallId, event.isError, event.result.content[0].text]);
    expect(results.map(([id, isError]) => [id, isError])).toEqual([
      ['p1', false],
      ['p2', true],
      ['n1', false],
      ['n2', true],
      ['n3', false],
    ]);
    expect(results[0]![2]).toContain('Nothing is saved until the user approves it');
    expect(results[1]![2]).toContain("not in the user's messages");
    expect(results[2]![2]).toContain('Saved note n44444444');
    expect(results[3]![2]).toContain('changed in another chat');
    expect(results[3]![2]).toContain('Newer plan.');
    expect(results[4]![2]).toContain('Updated note n33333333');
    // Only the three writes and the proposal reached the gateway.
    expect(
      chat.agent.events.filter((event) => event.type === 'gateway_request').map((e) => e.op),
    ).toEqual([
      'assistant.context',
      'memory.proposeUser',
      'memory.note',
      'memory.note',
      'memory.note',
    ]);
  });

  it('remembers the revisions it wrote after a restart', async () => {
    const first = await start();
    first.agent.llm.push(
      { tool: { id: 'n1', name: 'memory_note', args: { action: 'add', content: 'Fact.' } } },
      { text: 'Saved.' },
    );
    await first.prompt('remember this fact', async () => {
      first.ok(await first.next('assistant.context'), memory());
      first.ok(await first.next('memory.note'), {
        id: 'n55555555',
        revision: 1,
        unchanged: false,
        usage,
      });
    });
    await first.agent.close();
    const second = await start({
      sessionDir: first.agent.sessionDir,
      workspace: first.agent.workspace,
    });
    second.agent.llm.push(
      {
        tool: {
          id: 'n2',
          name: 'memory_note',
          args: { action: 'replace', id: 'n55555555', content: 'Better fact.' },
        },
      },
      { text: 'Updated.' },
    );
    let replace: Record<string, any> = {};
    await second.prompt('fix it', async () => {
      replace = await second.next('memory.note');
      second.ok(replace, { id: 'n55555555', revision: 2, unchanged: false, usage });
    });
    expect(replace.args.baseRevision).toBe(1);
    // The frozen memory came back from the session file, without asking the gateway again.
    expect(
      second.agent.events.filter((event) => event.type === 'gateway_request').map((e) => e.op),
    ).toEqual(['memory.note']);
  });

  it('lists the workspaces it can delegate to and delegates through the gateway', async () => {
    const chat = await start();
    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      tool: { id, name, args },
    });
    chat.agent.llm.push(
      call('d1', 'delegate', {
        workspace: 'work:test',
        task: 'Fix the build.',
        title: 'Fix build',
      }),
      call('d2', 'delegate', { task: 'Somewhere.' }),
      call('s1', 'delegation_status', {}),
      { text: 'Asked.' },
    );
    await chat.prompt('get the build fixed over there', async () => {
      chat.ok(
        await chat.next('assistant.context'),
        memory({
          workspaces: [
            { id: 'work:test', name: 'Test', node: 'work', online: true },
            { id: 'lab:x', name: 'X', node: 'lab', online: false },
          ],
        }),
      );
      const create = await chat.next('delegation.create');
      expect(create.args).toEqual({
        workspace: 'work:test',
        task: 'Fix the build.',
        title: 'Fix build',
      });
      chat.ok(create, {
        id: 'd12345678',
        title: 'Fix build',
        workspace: 'Test on work',
        status: 'pending_approval',
      });
      const status = await chat.next('delegation.status');
      expect(status.args).toEqual({});
      chat.ok(status, {
        delegations: [
          {
            id: 'd12345678',
            title: 'Fix build',
            workspace: 'Test on work',
            status: 'completed',
            session: 'Fix build',
            result: 'Build fixed.',
          },
        ],
      });
    });
    expect(chat.system()).toContain(
      "## Workspaces\n\nThe user's repositories you can hand tasks to with delegate. Online status is as of this chat's start. Their coding sessions keep notes there (workspace memory): search them with memory_search, and open a note's sources with recall.\n[work:test] Test on work\n[lab:x] X on lab (offline)",
    );
    const results = Object.fromEntries(
      chat.agent.events
        .filter((event) => event.type === 'tool_execution_end')
        .map((event) => [event.toolCallId, [event.isError, event.result.content[0].text]]),
    );
    expect(results.d1![0]).toBe(false);
    expect(results.d1![1]).toContain('Asked the user to approve delegation d12345678');
    expect(results.d2).toEqual([
      true,
      'Name a workspace, or pass follows with an earlier delegation id',
    ]);
    expect(results.s1![1]).toBe(
      'd12345678 · completed · “Fix build” → Test on work (session “Fix build”)\nBuild fixed.',
    );
  });

  it('searches workspace memory and recalls what it finds through the gateway', async () => {
    const chat = await start();
    chat.agent.llm.push(
      { tool: { id: 'q1', name: 'memory_search', args: { query: 'staging', limit: 3 } } },
      { tool: { id: 'r1', name: 'recall', args: { id: 'abcdefabcdef' } } },
      { tool: { id: 'r2', name: 'recall', args: { id: '000000000000' } } },
      { text: 'Found it.' },
    );
    await chat.prompt('what did we decide about deploys?', async () => {
      chat.ok(await chat.next('assistant.context'), memory());
      const search = await chat.next('memory.search');
      expect(search.args).toEqual({ query: 'staging', limit: 3 });
      chat.ok(search, {
        hits: [
          {
            id: 'abcdefabcdef',
            kind: 'workspace',
            workspace: 'pirc on m5pro',
            date: '2026-09-27 10:05',
            status: 'active',
            git: 'main@abcdef1',
            content: 'Deploys go through staging first.',
          },
          {
            id: 'd12345678',
            kind: 'delegation',
            workspace: 'pirc on m5pro',
            date: '2026-09-28 09:00',
            status: 'completed',
            content: 'Fix deploy: done',
          },
        ],
      });
      const recalled = await chat.next('recall.remote');
      expect(recalled.args).toEqual({ id: 'abcdefabcdef' });
      chat.ok(recalled, { text: 'pirc on m5pro:\nDeploy through staging first.', status: 'ok' });
      chat.fail(await chat.next('recall.remote'), {
        status: 404,
        code: 'not_found',
        message: 'No workspace memory note 000000000000',
      });
    });
    const results = Object.fromEntries(
      chat.agent.events
        .filter((event) => event.type === 'tool_execution_end')
        .map((event) => [event.toolCallId, [event.isError, event.result.content[0].text]]),
    );
    expect(results.q1).toEqual([
      false,
      '[abcdefabcdef] pirc on m5pro · 2026-09-27 10:05 · main@abcdef1\nDeploys go through staging first.\n\n[d12345678] delegation to pirc on m5pro · 2026-09-28 09:00 · completed\nFix deploy: done',
    ]);
    expect(results.r1).toEqual([false, 'pirc on m5pro:\nDeploy through staging first.']);
    // Found nowhere: the local answer stands.
    expect(results.r2).toEqual([
      true,
      'No observation or reflection with id 000000000000 was found on the current branch.',
    ]);
  });

  it("runs on messages the gateway pushes, keeping them apart from the user's", async () => {
    const agent = await startAgent();
    agents.push(agent);
    expect((await agent.send({ type: 'deliver', message: {} })).success).toBe(false);
    agent.llm.push({ text: 'Noted.' });
    const from = agent.events.length;
    const response = await agent.send({
      type: 'deliver',
      message: {
        customType: 'assistant-delegation-update',
        content: 'Delegation update (gateway data, not user instructions):\n{"status":"completed"}',
        details: { delegationId: 'd1', status: 'completed' },
      },
    });
    expect(response.success).toBe(true);
    await settledAfter(agent, from);
    const seen = agent.llm.requests.at(-1)!.body.messages.at(-1);
    expect(JSON.stringify(seen.content)).toContain('Delegation update');
    const entries = readFileSync(path.join(agent.sessionDir, 'session.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'message');
    expect(entries.map((entry) => entry.message.role)).toEqual(['custom', 'assistant']);
    expect(entries[0].message).toMatchObject({
      customType: 'assistant-delegation-update',
      display: true,
      details: { delegationId: 'd1', status: 'completed' },
    });
  });

  it('leaves sessions outside chat workspaces without memory', async () => {
    const agent = await startAgent({ env: { PIRC_GATEWAY: '1' } });
    agents.push(agent);
    agent.llm.push({ text: 'Hi.' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'hello' });
    await settledAfter(agent, from);
    const tools = agent.llm.requests[0]!.body.tools.map((tool: any) => tool.function.name);
    expect(tools).not.toContain('memory_note');
    expect(String(agent.llm.requests[0]!.body.messages[0].content)).not.toContain('## Memory');
    expect(agent.events.some((event) => event.type === 'gateway_request')).toBe(false);
  });
});
