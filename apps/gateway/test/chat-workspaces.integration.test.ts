import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { loadNodeConfig } from '../src/config.js';
import { buildNodeApp } from '../src/node/app.js';
import {
  headers,
  nodeHeaders,
  promptSession,
  startCluster,
  testConfig,
  waitFor,
  type Cluster,
} from './helpers.js';

const clusters: Cluster[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it('gives a chat node top-level chats, projects and a private directory per chat', async () => {
  const config = testConfig({ chat: true });
  const { app, services } = await buildNodeApp(config);
  apps.push(app);
  const chats = services.db.getWorkspace('chats');
  expect(chats.kind).toBe('chat');
  expect(chats.canonicalPath).toBe(realpathSync(path.join(config.stateDir, 'chat', 'chats')));

  const project = await app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: nodeHeaders,
    payload: { kind: 'chat', displayName: 'Trip' },
  });
  expect(project.statusCode).toBe(201);
  expect(project.json().workspace).toMatchObject({ kind: 'chat', displayName: 'Trip' });
  expect(existsSync(project.json().workspace.canonicalPath)).toBe(true);

  // Each chat works in its own directory, so one chat's writes never block another's.
  const first = await promptSession(app, services.events, nodeHeaders, 'chats');
  const second = await promptSession(app, services.events, nodeHeaders, 'chats');
  expect(await first.ask('cwd')).toBe(
    `cwd:${path.join(chats.canonicalPath, 'sessions', first.sessionId)}`,
  );
  expect(await second.ask('cwd')).toBe(
    `cwd:${path.join(chats.canonicalPath, 'sessions', second.sessionId)}`,
  );
  expect(await first.ask('env PIRC_WORKSPACE_KIND')).toBe('env:PIRC_WORKSPACE_KIND=chat');

  const directory = await promptSession(app, services.events, nodeHeaders, 'test');
  expect(await directory.ask('cwd')).toBe(
    `cwd:${realpathSync(services.db.getWorkspace('test').canonicalPath)}`,
  );
  expect(await directory.ask('env PIRC_WORKSPACE_KIND')).toBe('env:PIRC_WORKSPACE_KIND=directory');
});

it('refuses chat projects on other nodes and reserves the chats id on a chat node', async () => {
  const { app } = await buildNodeApp(testConfig());
  apps.push(app);
  const refused = await app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: nodeHeaders,
    payload: { kind: 'chat', displayName: 'Trip' },
  });
  expect(refused.statusCode).toBe(403);

  const stateDir = mkdtempSync(path.join(tmpdir(), 'pirc-chat-config-'));
  const env = {
    PIRC_NODE_ID: 'n',
    PIRC_NODE_TOKEN: 't'.repeat(32),
    PIRC_DAEMON_URL: 'ws://127.0.0.1:1',
    PIRC_ALLOWED_USERS: 'u@example.com',
    PIRC_STATE_DIR: stateDir,
    PIRC_CHAT: '1',
    PIRC_WORKSPACES: JSON.stringify([{ id: 'chats', path: stateDir }]),
  };
  expect(() => loadNodeConfig(env)).toThrow('must not use the id "chats"');
  expect(loadNodeConfig({ ...env, PIRC_WORKSPACES: '[]' }).chat).toBe(true);
});

it('lets the web create chat projects and tells chat sessions they are the assistant', async () => {
  const cluster = await startCluster([{ nodeId: 'test', chat: true }]);
  clusters.push(cluster);
  const { app, services } = cluster;
  await waitFor(() => services.db.listWorkspaces().some((w) => w.id === 'test:chats'), true);
  const listed = (await app.inject({ method: 'GET', url: '/api/workspaces', headers })).json()
    .workspaces as Array<{ id: string; kind: string; canonicalPath?: string }>;
  expect(listed.map((w) => `${w.id}=${w.kind}`).sort()).toEqual([
    'test:chats=chat',
    'test:test=directory',
  ]);
  expect(listed.every((w) => w.canonicalPath === undefined)).toBe(true);

  const created = await app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers,
    payload: { nodeId: 'test', kind: 'chat', displayName: 'Trip' },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().workspace).toMatchObject({ kind: 'chat', displayName: 'Trip' });
  expect(created.json().workspace.canonicalPath).toBeUndefined();
  const pathless = await app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers,
    payload: { nodeId: 'test', displayName: 'No path' },
  });
  expect(pathless.statusCode).toBe(400);

  const chat = await promptSession(app, services.events, headers, 'test:chats');
  expect(await chat.ask('gateway assistant.context {}')).toBe('gateway:ok {"enabled":true}');
  const directory = await promptSession(app, services.events, headers, 'test:test');
  expect(await directory.ask('gateway assistant.context {}')).toBe('gateway:ok {"enabled":false}');
});
