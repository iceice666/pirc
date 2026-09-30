import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { headers, promptSession, startCluster, waitFor, type Cluster } from './helpers.js';

const clusters: Cluster[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

it('lets the web edit a project’s instructions, kept on the node and given to new chats', async () => {
  const cluster = await startCluster([{ nodeId: 'test', chat: true }, { nodeId: 'repo' }]);
  clusters.push(cluster);
  const { app, services, nodes } = cluster;
  await waitFor(
    () =>
      ['test:chats', 'repo:test'].every((id) =>
        services.db.listWorkspaces().some((w) => w.id === id),
      ),
    true,
  );
  const created = await app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers,
    payload: { nodeId: 'test', kind: 'chat', displayName: 'Trip' },
  });
  const projectId = created.json().workspace.id as string;
  const url = `/api/workspaces/${encodeURIComponent(projectId)}/instructions`;

  const empty = await app.inject({ method: 'GET', url, headers });
  expect(empty.statusCode).toBe(200);
  expect(empty.json().instructions).toEqual({ text: '', maxChars: 8000 });
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);

  const saved = await app.inject({
    method: 'PATCH',
    url,
    headers,
    payload: { text: '  Plan trips on a budget.\r\n' },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().instructions.text).toBe('Plan trips on a budget.');

  // Kept by the node next to the project's sessions; the gateway stores nothing.
  const chatNode = nodes[0]!.config;
  const local = projectId.slice('test:'.length);
  const file = path.join(chatNode.stateDir, 'chat', local, 'instructions.md');
  expect(readFileSync(file, 'utf8')).toBe('Plan trips on a budget.\n');
  const dump = JSON.stringify(
    services.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
  );
  for (const { name } of JSON.parse(dump) as Array<{ name: string }>)
    expect(JSON.stringify(services.db.raw.prepare(`SELECT * FROM "${name}"`).all())).not.toContain(
      'budget',
    );

  // A new chat in the project gets them on its configure line.
  const chat = await promptSession(app, services.events, headers, projectId);
  expect(await chat.ask('instructions')).toBe('instructions:Plan trips on a budget.');
  const env = await chat.ask('env PIRC_PROJECT_INSTRUCTIONS');
  expect(env).toContain('instructions.md');
  // Outside the project, nothing.
  const other = await promptSession(app, services.events, headers, 'test:chats');
  expect(await other.ask('instructions')).toBe('instructions:');

  const tooLong = await app.inject({
    method: 'PATCH',
    url,
    headers,
    payload: { text: 'x'.repeat(8001) },
  });
  expect(tooLong.statusCode).toBe(413);
  expect(readFileSync(file, 'utf8')).toBe('Plan trips on a budget.\n');

  // Empty text removes them.
  const cleared = await app.inject({ method: 'PATCH', url, headers, payload: { text: '' } });
  expect(cleared.json().instructions.text).toBe('');
  expect(existsSync(file)).toBe(false);

  // Directory workspaces have none.
  const repo = await app.inject({
    method: 'GET',
    url: '/api/workspaces/repo%3Atest/instructions',
    headers,
  });
  expect(repo.statusCode).toBe(400);
});
