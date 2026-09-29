import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { hashId } from '../src/agent/features/memory/ledger.js';
import type { WorkspaceItem } from '../src/agent/features/memory/workspace.js';
import { SessionStore } from '../src/agent/session-store.js';
import { GatewayDatabase } from '../src/database.js';
import { headers, promptSession, startCluster, waitFor, type Cluster } from './helpers.js';

const USER = 'test@example.com';
const OTHER = 'other@example.com';
const clusters: Cluster[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

const as = (user: string) => ({ ...headers, 'x-pirc-user': user });
const reply = (text: string) => {
  const [, kind, body] = /^gateway:(ok|error) (.*)$/s.exec(text) ?? [];
  if (!kind) throw new Error(`not a gateway reply: ${text}`);
  return JSON.parse(body!);
};

it('mirrors workspace memory from its node for the assistant to search and recall', async () => {
  const users = new Set([USER, OTHER]);
  const cluster = await startCluster(
    [
      { nodeId: 'home', chat: true, allowedUsers: users },
      { nodeId: 'work', memoryMirrorMs: 100, allowedUsers: users },
    ],
    { allowedUsers: users },
  );
  clusters.push(cluster);
  const { app, services, nodes } = cluster;
  await waitFor(
    () =>
      ['home:chats', 'work:test'].every((id) =>
        services.db.listWorkspaces().some((w) => w.id === id),
      ),
    true,
  );

  // A coding session on work, whose transcript backs the notes.
  const coding = (
    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'work:test' },
    })
  ).json().session.id as string;
  const work = nodes[1]!.config;
  const nodeDb = new GatewayDatabase(work.databasePath);
  const { dir: sessionDir } = nodeDb.raw
    .prepare('SELECT private_session_path AS dir FROM sessions WHERE id=?')
    .get(services.db.getSession(coding).piSessionId!) as { dir: string };
  nodeDb.close();
  const repository = work.workspaces[0]!.path;
  const store = new SessionStore(sessionDir, repository);
  const said = store.append({
    type: 'message',
    message: {
      role: 'user',
      content: 'Deploy through staging first, never straight to prod.',
      timestamp: Date.now(),
    },
  });
  const observation = {
    id: hashId('User requires staging before prod.'),
    content: 'User requires staging before prod.',
    timestamp: '2026-09-27 10:00',
    relevance: 'critical' as const,
    sourceEntryIds: [said.id],
    tokenCount: 10,
  };
  store.append({
    type: 'custom',
    customType: 'om.observations.recorded',
    data: { observations: [observation], coversUpToId: said.id },
  });
  const note = (content: string): WorkspaceItem => ({
    id: hashId(content),
    content,
    relevance: 'critical',
    timestamp: '2026-09-27 10:05',
    sessionId: 'agent-internal-id',
    sessionDir,
    sourceMemoryIds: [observation.id],
    git: { head: 'abcdef123456', branch: 'main', dirty: false, worktree: repository },
    tokenCount: 10,
  });
  const staging = note('Deploys go through staging first.');
  const secret = note('The staging password rotates weekly.');
  mkdirSync(work.workspaceMemoryDir, { recursive: true });
  const ledger = path.join(work.workspaceMemoryDir, `${'d'.repeat(16)}.jsonl`);
  writeFileSync(
    ledger,
    `${JSON.stringify({ type: 'recorded', at: 1, items: [staging, secret] })}\n`,
  );
  await waitFor(() => services.records.find(USER, staging.id).length, 1);
  // The gateway learns the notes, never where they live on the node.
  const stored = JSON.stringify(services.db.raw.prepare('SELECT * FROM memory_records').all());
  expect(stored).not.toContain(sessionDir);
  expect(stored).not.toContain(repository);

  const chat = await promptSession(app, services.events, headers, 'home:chats');
  const hits = reply(await chat.ask('gateway memory.search {"query":"staging prod"}')).hits;
  expect(hits[0]).toMatchObject({
    id: staging.id,
    kind: 'workspace',
    workspace: 'Test on work',
    git: 'main@abcdef1',
    date: '2026-09-27 10:05',
  });
  // Recall asks the node, which reads the session that wrote the note.
  const recalled = reply(await chat.ask(`gateway recall.remote {"id":"${staging.id}"}`)).text;
  expect(recalled).toContain('Test on work');
  expect(recalled).toContain('Deploy through staging first, never straight to prod.');

  // Another user's assistant finds none of it, and cannot read it.
  const theirs = await promptSession(app, services.events, as(OTHER), 'home:chats');
  expect(reply(await theirs.ask('gateway memory.search {"query":"staging"}')).hits).toEqual([]);
  expect(reply(await theirs.ask(`gateway recall.remote {"id":"${staging.id}"}`))).toMatchObject({
    code: 'not_found',
  });

  // The node checks too: only the owner of the session that wrote a note may read it.
  const direct = (user: string) =>
    services.nodes.request('work', {
      method: 'POST',
      url: '/api/workspace-memory/recall',
      user,
      payload: { ledgerKey: 'd'.repeat(16), id: staging.id },
    });
  expect((await direct(USER)).status).toBe(200);
  expect((await direct(OTHER)).status).toBe(404);

  // Forgetting on the node reaches the gateway.
  appendFileSync(
    ledger,
    `${JSON.stringify({ type: 'retired', at: 2, ids: [secret.id], reason: 'forgotten' })}\n`,
  );
  await waitFor(() => services.records.find(USER, secret.id).length, 0);
  expect(reply(await chat.ask('gateway memory.search {"query":"password"}')).hits).toEqual([]);

  // With the node offline, recall answers with the gateway's copy.
  await nodes[1]!.close();
  await waitFor(() => services.nodes.list().length, 1);
  const offline = reply(await chat.ask(`gateway recall.remote {"id":"${staging.id}"}`)).text;
  expect(offline).toContain('Deploys go through staging first.');
  expect(offline).toContain('work is offline');
}, 30_000);
