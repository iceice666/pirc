import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GatewayDatabase } from '../src/database.js';
import { captureContext, writeContext } from '../src/agent/context.js';
import { headers, startCluster, type Cluster } from './helpers.js';
const clusters: Cluster[] = [];
afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.close();
});
it('relays stopped snapshots with owner checks and workspace-only source links, without gateway persistence', async () => {
  const cluster = await startCluster(
    [{ nodeId: 'test', allowedUsers: new Set(['test@example.com', 'other@example.com']) }],
    { allowedUsers: new Set(['test@example.com', 'other@example.com']) },
  );
  clusters.push(cluster);
  const created = await cluster.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers,
    payload: { workspaceId: 'test:test' },
  });
  const id = created.json().session.id as string;
  const row = cluster.services.db.getSession(id);
  const url = `/api/sessions/${id}/panel/context`;
  const get = () => cluster.app.inject({ method: 'GET', url, headers });
  expect((await get()).json().error.code).toBe('no_context');
  const node = cluster.nodes[0]!.config;
  const nodeDb = new GatewayDatabase(node.databasePath);
  const dir = nodeDb.getSession(row.piSessionId!).privateSessionPath;
  nodeDb.close();
  const workspace = node.workspaces[0]!.path;
  const file = path.join(workspace, 'AGENTS.md');
  writeFileSync(file, 'Rules');
  mkdirSync(path.join(workspace, 'outside'));
  writeFileSync(path.join(workspace, 'outside', 'SOUL.md'), 'unrelated workspace file');
  const snapshot = captureContext({
    sections: [
      { id: 'agents', title: 'Rules', source: file, text: 'context-private-marker' },
      { id: 'soul', title: 'Soul', source: '/outside/SOUL.md', text: 'persona' },
    ],
    tools: [],
    messages: [],
    memoryTokens: 0,
    model: { provider: 'p', id: 'm', contextWindow: 1000 },
  });
  writeContext(dir, snapshot);
  const response = await get();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ agentRunning: false, source: 'snapshot' });
  expect(response.json().snapshot.sections[0].filePath).toBe('AGENTS.md');
  expect(response.json().snapshot.sections[1].filePath).toBeUndefined();
  expect(
    (
      await cluster.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, 'x-pirc-user': 'other@example.com' },
      })
    ).statusCode,
  ).toBe(403);
  for (const { name } of cluster.services.db.raw
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[])
    expect(
      JSON.stringify(cluster.services.db.raw.query(`SELECT * FROM "${name}"`).all()),
    ).not.toContain('context-private-marker');
});
