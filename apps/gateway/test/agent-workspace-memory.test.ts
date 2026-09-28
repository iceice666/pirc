import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { hashId, type Observation } from '../src/agent/features/memory/ledger.js';
import { recall } from '../src/agent/features/memory/index.js';
import {
  WS_PROMOTED,
  WorkspaceLedger,
  foldWorkspace,
  gitState,
  promoterPrompt as buildPromoterPrompt,
  promoterTool,
  promotionCandidates,
  recallFromWorkspace,
  recallWorkspaceItem,
  renderWorkspaceMemory,
  resolveWorkspace,
  type WorkspaceItem,
} from '../src/agent/features/memory/workspace.js';
import { SessionStore, type SessionEntry } from '../src/agent/session-store.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
const initRepo = () => {
  const repo = tmp('pirc-ws-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
};

const item = (content: string, extra: Partial<WorkspaceItem> = {}): WorkspaceItem => ({
  id: hashId(content),
  content,
  relevance: 'high',
  timestamp: '2026-09-01 10:00',
  sessionId: 's1',
  sessionDir: '/nonexistent',
  sourceMemoryIds: ['aaaaaaaaaaaa'],
  tokenCount: 20,
  ...extra,
});
let n = 0;
const custom = (customType: string, data: unknown): SessionEntry => ({
  id: `c${++n}`,
  parentId: null,
  timestamp: 0,
  type: 'custom',
  customType,
  data,
});
const obs = (content: string, relevance: Observation['relevance']): Observation => ({
  id: hashId(content),
  content,
  timestamp: '2026-09-01 10:00',
  relevance,
  sourceEntryIds: ['m1'],
  tokenCount: 10,
});

describe('workspace memory', () => {
  it('shares one key across git worktrees and records git state', () => {
    const repo = initRepo();
    const worktree = path.join(tmp('pirc-ws-wt-'), 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    const main = resolveWorkspace(repo);
    expect(resolveWorkspace(worktree)).toEqual(main);
    expect(resolveWorkspace(path.join(repo))).toEqual(main);
    expect(main.root).toBe(repo);
    const state = gitState(worktree)!;
    expect(state.branch).toBe('feature');
    expect(state.dirty).toBe(false);
    expect(state.worktree).toBe(worktree);
    writeFileSync(path.join(worktree, 'a.txt'), 'changed\n');
    expect(gitState(worktree)!.dirty).toBe(true);
    // Plain directories fall back to their own path.
    const plain = tmp('pirc-ws-plain-');
    expect(resolveWorkspace(plain).root).toBe(plain);
    expect(gitState(plain)).toBeUndefined();
  });

  it('folds recorded, retired and cleared lines', () => {
    const a = item('first');
    const b = item('second');
    const c = item('third');
    expect(
      foldWorkspace([
        { type: 'recorded', at: 1, items: [a, b] },
        { type: 'retired', at: 2, ids: [a.id], reason: 'superseded' },
      ]).active.map((i) => i.content),
    ).toEqual(['second']);
    const cleared = foldWorkspace([
      { type: 'recorded', at: 1, items: [a, b] },
      { type: 'cleared', at: 2 },
      { type: 'recorded', at: 3, items: [c] },
    ]);
    expect(cleared.active.map((i) => i.content)).toEqual(['third']);
    expect(cleared.items.has(a.id)).toBe(false);
  });

  it('forgets items for good, even across a clear', () => {
    const a = item('first');
    const b = item('second');
    const fold = foldWorkspace([
      { type: 'recorded', at: 1, items: [a, b] },
      { type: 'retired', at: 2, ids: [a.id], reason: 'forgotten' },
      { type: 'retired', at: 3, ids: [b.id], reason: 'superseded' },
    ]);
    expect(fold.active).toEqual([]);
    // Superseded items stay recallable; forgotten ones do not.
    expect(fold.items.has(b.id)).toBe(true);
    expect(fold.items.has(a.id)).toBe(false);
    expect(fold.forgotten.get(a.id)).toBe('first');
    const later = foldWorkspace([
      { type: 'recorded', at: 1, items: [a] },
      { type: 'retired', at: 2, ids: [a.id], reason: 'forgotten' },
      { type: 'cleared', at: 3 },
      { type: 'recorded', at: 4, items: [a] },
    ]);
    expect(later.active).toEqual([]);
    expect(later.forgotten.get(a.id)).toBe('first');
  });

  it('selects reflections and important observations not yet promoted', () => {
    const high = obs('decided X', 'high');
    const low = obs('ran ls', 'low');
    const done = obs('already carried', 'critical');
    const ref = {
      id: hashId('durable'),
      content: 'durable',
      supportingObservationIds: [high.id],
      tokenCount: 3,
    };
    const branch = [
      custom('om.observations.recorded', { observations: [high, low, done], coversUpToId: 'x' }),
      custom('om.reflections.recorded', { reflections: [ref], coversUpToId: 'x' }),
      custom(WS_PROMOTED, { memoryIds: [done.id] }),
    ];
    expect(promotionCandidates(branch).map((c) => `${c.kind}:${c.content}`)).toEqual([
      'reflection:durable',
      'observation:decided X',
    ]);
  });

  it('carries origins from session memory to candidates', () => {
    const fromUser = { ...obs('user chose X', 'high'), origins: ['user'] };
    const legacy = obs('old decision', 'critical');
    const ref = {
      id: hashId('durable X'),
      content: 'durable X',
      supportingObservationIds: [fromUser.id, legacy.id],
      tokenCount: 3,
    };
    const branch = [
      custom('om.observations.recorded', { observations: [fromUser, legacy], coversUpToId: 'x' }),
      custom('om.reflections.recorded', { reflections: [ref], coversUpToId: 'x' }),
    ];
    const origins = new Map(promotionCandidates(branch).map((c) => [c.content, c.origins]));
    expect(origins.get('durable X')).toEqual(['unknown', 'user']);
    expect(origins.get('user chose X')).toEqual(['user']);
    expect(origins.get('old decision')).toEqual(['unknown']);
  });

  it('validates promoter tool calls', () => {
    const existing = item('old note');
    const out = { add: [] as WorkspaceItem[], retire: [] as string[] };
    const tool = promoterTool(
      foldWorkspace([{ type: 'recorded', at: 1, items: [existing] }]),
      [{ id: 'bbbbbbbbbbbb', kind: 'reflection', content: 'x' }],
      {
        sessionId: 's2',
        sessionDir: '/s2',
        git: { head: 'abcdef123456', branch: 'main', dirty: true, worktree: '/w' },
      },
      out,
    );
    const receipt = tool.execute({
      add: [
        { content: 'new note', relevance: 'high', sourceMemoryIds: ['bbbbbbbbbbbb', 'invented'] },
        { content: 'no source', relevance: 'high', sourceMemoryIds: ['invented'] },
        { content: 'old note', relevance: 'high', sourceMemoryIds: ['bbbbbbbbbbbb'] },
      ],
      retire: [existing.id, 'ffffffffffff'],
    });
    expect(receipt).toContain('Added 1, retired 1, rejected 1');
    expect(receipt).toContain('skipped 1 already in workspace memory');
    expect(out.add).toHaveLength(1);
    expect(out.add[0]!.sourceMemoryIds).toEqual(['bbbbbbbbbbbb']);
    // The candidate carried no origins (older session memory).
    expect(out.add[0]!.origins).toEqual(['unknown']);
    expect(out.add[0]!.git?.branch).toBe('main');
    expect(out.retire).toEqual([existing.id]);
  });

  it('skips notes the ledger already knows and records origins without secrets', () => {
    const superseded = item('retired note');
    const gone = item('forgotten note');
    const fold = foldWorkspace([
      { type: 'recorded', at: 1, items: [superseded, gone] },
      { type: 'retired', at: 2, ids: [superseded.id], reason: 'superseded' },
      { type: 'retired', at: 3, ids: [gone.id], reason: 'forgotten' },
    ]);
    const out = { add: [] as WorkspaceItem[], retire: [] as string[] };
    const tool = promoterTool(
      fold,
      [{ id: 'cccccccccccc', kind: 'observation', content: 'y', origins: ['tool:bash', 'user'] }],
      { sessionId: 's3', sessionDir: '/s3', git: undefined },
      out,
    );
    const token = `ghp_${'a'.repeat(36)}`;
    const receipt = tool.execute({
      add: [
        { content: 'retired note', relevance: 'high', sourceMemoryIds: ['cccccccccccc'] },
        { content: 'forgotten note', relevance: 'high', sourceMemoryIds: ['cccccccccccc'] },
        { content: `CI uses ${token}`, relevance: 'high', sourceMemoryIds: ['cccccccccccc'] },
      ],
    });
    expect(receipt).toContain('Added 1, retired 0, rejected 0');
    expect(receipt).toContain('1 recorded before and retired');
    expect(receipt).toContain('1 forgotten by the user');
    expect(out.add.map((i) => i.content)).toEqual(['CI uses ghp_[REDACTED]']);
    expect(out.add[0]!.origins).toEqual(['tool:bash', 'user']);
    // The promoter is told what was forgotten; superseded notes are not listed.
    const prompt = buildPromoterPrompt(fold, [], undefined, 100);
    expect(prompt).toContain(
      'FORGOTTEN (the user asked to forget these; never record them again):\n- forgotten note',
    );
    expect(prompt).not.toContain('retired note');
    expect(buildPromoterPrompt(foldWorkspace([]), [], undefined, 100)).not.toContain('FORGOTTEN');
  });

  it('renders within budget preferring relevant and recent items', () => {
    const items = [
      item('old low', { relevance: 'low' }),
      item('old critical', { relevance: 'critical' }),
      item('new medium', { relevance: 'medium' }),
      item('newer medium', {
        relevance: 'medium',
        git: { head: 'abcdef123456', branch: 'main', dirty: true, worktree: '/w' },
      }),
    ];
    const text = renderWorkspaceMemory(items, '/repo', undefined, 60);
    expect(text).toContain('## Workspace memory');
    expect(text).toContain('old critical');
    expect(text).toContain('newer medium');
    expect(text).toContain('(main@abcdef1*)');
    expect(text).toContain('new medium');
    expect(text).not.toContain('old low');
    // Chronological order is preserved.
    expect(text.indexOf('old critical')).toBeLessThan(text.indexOf('newer medium'));
    expect(renderWorkspaceMemory([], '/repo', undefined, 60)).toBe('');
  });

  it('recalls a workspace item through its source session', () => {
    const dir = tmp('pirc-ws-session-');
    const store = new SessionStore(dir, dir);
    const message = store.append({
      type: 'message',
      message: { role: 'user', content: 'We chose sqlite over postgres.', timestamp: Date.now() },
    });
    const o = { ...obs('User chose sqlite', 'high'), sourceEntryIds: [message.id] };
    store.append({
      type: 'custom',
      customType: 'om.observations.recorded',
      data: { observations: [o], coversUpToId: message.id },
    });
    const found = recallWorkspaceItem(
      item('Chose sqlite', { sessionDir: dir, sourceMemoryIds: [o.id] }),
      recall,
    );
    expect(found.status).toBe('ok');
    expect(found.text).toContain('We chose sqlite over postgres.');
    expect(recallWorkspaceItem(item('gone'), recall).status).toBe('source_unavailable');

    // Through the fold: superseded items still recall, forgotten ones answer without content.
    const kept = item('Chose sqlite', { sessionDir: dir, sourceMemoryIds: [o.id] });
    const dropped = item('Also chose sqlite', { sessionDir: dir, sourceMemoryIds: [o.id] });
    const fold = foldWorkspace([
      { type: 'recorded', at: 1, items: [kept, dropped] },
      { type: 'retired', at: 2, ids: [kept.id], reason: 'superseded' },
      { type: 'retired', at: 3, ids: [dropped.id], reason: 'forgotten' },
    ]);
    expect(recallFromWorkspace(fold, kept.id, recall)?.status).toBe('ok');
    const forgotten = recallFromWorkspace(fold, dropped.id, recall)!;
    expect(forgotten.status).toBe('forgotten');
    expect(forgotten.text).not.toContain('sqlite');
    expect(recallFromWorkspace(fold, 'ffffffffffff', recall)).toBeUndefined();
  });

  it('skips work when another process holds the lock', async () => {
    const ledger = new WorkspaceLedger(tmp('pirc-ws-lock-'), 'k', '/r');
    const inner = await ledger.withLock(async () => ledger.withLock(async () => 'nested'));
    expect(inner).toBeUndefined();
    expect(await ledger.withLock(async () => 'free')).toBe('free');
  });
});

describe('workspace memory agent flow', () => {
  it('promotes session memory and hands it to the next session', async () => {
    const repo = initRepo();
    const memoryDir = tmp('pirc-ws-dir-');
    const config = {
      features: {
        observationalMemory: {
          observeAfterTokens: 5,
          reflectAfterTokens: 5,
          compactAfterTokens: 1_000_000,
          showWorkerNotifications: false,
        },
      },
    };
    const env = { PIRC_WORKSPACE_MEMORY_DIR: memoryDir };
    const system = (body: any) => String(body.messages?.[0]?.content ?? '');
    const first = await startAgent({ config, env, workspace: repo });
    agents.push(first);
    let promoterPrompt = '';
    first.llm.route = (body) => {
      const last = body.messages.at(-1);
      if (body.tools?.[0]?.function?.name === 'record_observations') {
        if (last.role === 'tool') return { text: 'Observed.' };
        const match = /\[Source entry id: (\w+)\]\n\[User/.exec(last.content);
        if (!match) return { text: 'Nothing.' };
        return {
          tool: {
            id: 'o',
            name: 'record_observations',
            args: {
              observations: [
                {
                  timestamp: '2026-09-27 10:00',
                  content: 'User decided to store uploads in S3, not on disk.',
                  relevance: 'high',
                  sourceEntryIds: [match[1]],
                },
              ],
            },
          },
        };
      }
      if (body.tools?.[0]?.function?.name === 'record_reflections') {
        if (last.role === 'tool') return { text: 'Done.' };
        const id = /\[([a-f0-9]{12})\][^\n]*S3/.exec(last.content)?.[1];
        return id
          ? {
              tool: {
                id: 'r',
                name: 'record_reflections',
                args: {
                  reflections: [{ content: 'Uploads live in S3.', supportingObservationIds: [id] }],
                },
              },
            }
          : { text: 'Nothing.' };
      }
      if (body.tools?.[0]?.function?.name === 'record_workspace_memory') {
        if (last.role === 'tool') return { text: 'Recorded.' };
        promoterPrompt = last.content;
        const id = /\[([a-f0-9]{12})\] reflection:/.exec(last.content)?.[1];
        return {
          tool: {
            id: 'w',
            name: 'record_workspace_memory',
            args: {
              add: [
                {
                  content: 'Uploads are stored in S3 (decided by the user), not on local disk.',
                  relevance: 'high',
                  sourceMemoryIds: [id],
                },
              ],
            },
          },
        };
      }
      return undefined;
    };
    first.llm.push({ text: 'Understood, S3 it is.' });
    const from = first.events.length;
    await first.send({ type: 'prompt', message: 'Store uploads in S3, not on disk.' });
    await settledAfter(first, from);
    const ledgerFile = WorkspaceLedger.forCwd(repo, env).file;
    const deadline = Date.now() + 8000;
    const read = () => {
      try {
        return readFileSync(ledgerFile, 'utf8');
      } catch {
        return '';
      }
    };
    while (!read().includes('Uploads are stored in S3') && Date.now() < deadline)
      await Bun.sleep(25);
    expect(read()).toContain('"branch":"main"');
    expect(promoterPrompt).toContain('Current git state: main@');
    expect(readFileSync(path.join(first.sessionDir, 'session.jsonl'), 'utf8')).toContain(
      WS_PROMOTED,
    );

    // A new session in a worktree of the same repo sees the note in its system prompt.
    const worktree = path.join(tmp('pirc-ws-wt-'), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'other', worktree);
    const second = await startAgent({ config, env, workspace: worktree });
    agents.push(second);
    second.llm.push({ text: 'Hello.' }, { text: 'Again.' });
    const start = second.events.length;
    await second.send({ type: 'prompt', message: 'hi' });
    await settledAfter(second, start);
    const mainCalls = () =>
      second.llm.requests.filter(
        (r) => !r.body.tools?.some((t: any) => /^record_/.test(t.function?.name)),
      );
    const prompt = system(mainCalls()[0]!.body);
    expect(prompt).toContain('## Workspace memory');
    expect(prompt).toContain('Uploads are stored in S3');
    expect(prompt).toContain('Current git state: other@');
    // Frozen: a later run uses the identical prompt.
    const again = second.events.length;
    await second.send({ type: 'prompt', message: 'hi again' });
    await settledAfter(second, again);
    expect(system(mainCalls().at(-1)!.body)).toBe(prompt);
    // The workspace id is recallable from the new session.
    const id = /\[([a-f0-9]{12})\] [^\n]*Uploads are stored in S3/.exec(prompt)![1]!;
    second.llm.push({ tool: { id: 'rc', name: 'recall', args: { id } } }, { text: 'ok' });
    const third = second.events.length;
    await second.send({ type: 'prompt', message: 'recall it' });
    await settledAfter(second, third);
    const end = second.events.findLast((e) => e.type === 'tool_execution_end');
    expect(end!.result.content[0].text).toContain('Store uploads in S3, not on disk.');

    // Forgetting it (a namespaced command typed as a prompt) makes recall refuse it.
    await second.send({ type: 'prompt', message: `/om:workspace forget ${id}` });
    await second.waitFor(
      (e) =>
        e.method === 'notify' && String(e.message).startsWith(`Workspace memory: forgot ${id}`),
    );
    expect(read()).toContain('"reason":"forgotten"');
    second.llm.push({ tool: { id: 'rc2', name: 'recall', args: { id } } }, { text: 'gone' });
    const fourth = second.events.length;
    await second.send({ type: 'prompt', message: 'recall it again' });
    await settledAfter(second, fourth);
    const gone = second.events.findLast((e) => e.type === 'tool_execution_end');
    expect(gone!.result.content[0].text).toContain('forgotten at the user');
    expect(gone!.result.content[0].text).not.toContain('Store uploads in S3');
  }, 30_000);

  it('runs chat sessions as a personal assistant without workspace memory', async () => {
    const workspace = tmp('pirc-chat-ws-');
    const env = { PIRC_WORKSPACE_MEMORY_DIR: tmp('pirc-chat-mem-') };
    // A note a session in this directory would normally receive.
    WorkspaceLedger.forCwd(workspace, env).append({
      type: 'recorded',
      at: 1,
      items: [item('Deploys go through staging first.')],
    });
    const systemPrompt = async (extra: Record<string, string>) => {
      const agent = await startAgent({ workspace, env: { ...env, ...extra } });
      agents.push(agent);
      agent.llm.push({ text: 'Hi.' });
      const from = agent.events.length;
      await agent.send({ type: 'prompt', message: 'hello' });
      await settledAfter(agent, from);
      const main = agent.llm.requests.find(
        (r) => !r.body.tools?.some((t: any) => /^record_/.test(t.function?.name)),
      );
      return String(main!.body.messages[0].content);
    };
    const chat = await systemPrompt({ PIRC_WORKSPACE_KIND: 'chat' });
    expect(chat).toContain("the user's personal assistant");
    expect(chat).not.toContain('coding agent');
    expect(chat).not.toContain('## Workspace memory');
    const directory = await systemPrompt({});
    expect(directory).toContain('coding agent');
    expect(directory).toContain('Deploys go through staging first.');
  });
});
