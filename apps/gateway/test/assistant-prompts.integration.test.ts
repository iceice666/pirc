import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { buildNodeApp } from '../src/node/app.js';
import { GatewayDatabase } from '../src/database.js';
import { NODE_PROTOCOL_VERSION } from '../src/protocol.js';
import {
  headers,
  nodeHeaders,
  startCluster,
  testConfig,
  waitFor,
  type Cluster,
} from './helpers.js';
const clusters: Cluster[] = [];
afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.close();
});

it('relays prompt edits without storing text, enforces auth/schema and reports offline', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-prompt-api-'));
  const prior = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = dir;
  try {
    const cluster = await startCluster([{ nodeId: 'test', chat: true }]);
    clusters.push(cluster);
    const url = '/api/assistant/prompts';
    const put = (text: string) =>
      cluster.app.inject({
        method: 'PUT',
        url: url + '/soul',
        headers,
        payload: { text, nodeId: 'test' },
      });
    expect((await cluster.app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect((await cluster.app.inject({ method: 'GET', url, headers })).json().soul.writable).toBe(
      true,
    );
    expect((await put('  A unique persona API marker.\r\n')).statusCode).toBe(200);
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toBe('A unique persona API marker.\n');
    for (const { name } of cluster.services.db.raw
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[])
      expect(
        JSON.stringify(cluster.services.db.raw.query(`SELECT * FROM "${name}"`).all()),
      ).not.toContain('persona API marker');
    expect((await put('x'.repeat(8001))).statusCode).toBe(413);
    expect(
      (
        await cluster.app.inject({
          method: 'PUT',
          url: url + '/soul',
          headers,
          payload: { text: '', extra: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await cluster.app.inject({
          method: 'PUT',
          url: url + '/soul',
          headers: { ...headers, origin: 'https://evil.example' },
          payload: { text: '' },
        })
      ).statusCode,
    ).toBe(403);
    expect(cluster.services.db.releaseAssistantNode('test')).toBe(true);
    expect(cluster.services.db.claimAssistantNode('replacement')).toBe(true);
    const stale = await put('stale draft');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('binding_changed');
    cluster.services.db.releaseAssistantNode('replacement');
    cluster.services.db.claimAssistantNode('test');
    expect((await put('')).statusCode).toBe(200);
    symlinkSync(path.join(dir, 'missing'), path.join(dir, 'SOUL.md'));
    expect((await put('do not replace')).statusCode).toBe(409);
    expect(
      (
        await cluster.app.inject({
          method: 'GET',
          url,
          headers: { ...headers, 'x-pirc-user': 'other@example.com' },
        })
      ).statusCode,
    ).toBe(403);
    await cluster.nodes[0]!.close();
    await waitFor(() => cluster.services.nodes.list().length, 0);
    expect((await cluster.app.inject({ method: 'GET', url, headers })).statusCode).toBe(503);
    expect(cluster.services.db.assistantNode()).toBe('test');
    cluster.nodes.splice(0);
  } finally {
    if (prior === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
it('does not expose prompts on coding nodes', async () => {
  const { app } = await buildNodeApp(testConfig());
  try {
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant/prompts', headers: nodeHeaders }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assistant/prompts/soul',
          headers: nodeHeaders,
          payload: { text: '' },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
it('persists the singleton binding and releases only the expected ID', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-binding-'));
  try {
    let db = new GatewayDatabase(path.join(dir, 'gateway.sqlite'));
    expect(db.claimAssistantNode('first')).toBe(true);
    db.close();
    db = new GatewayDatabase(path.join(dir, 'gateway.sqlite'));
    expect(db.assistantNode()).toBe('first');
    expect(db.claimAssistantNode('second')).toBe(false);
    expect(db.releaseAssistantNode('second')).toBe(false);
    expect(db.releaseAssistantNode('first')).toBe(true);
    expect(db.claimAssistantNode('second')).toBe(true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('rejects another chat node with 409 without replacing the first, and permits explicit release', async () => {
  const cluster = await startCluster([{ nodeId: 'test', chat: true }], {
    nodeTokens: new Map([
      ['test', 'a'.repeat(32)],
      ['other', 'b'.repeat(32)],
    ]),
  });
  clusters.push(cluster);
  const socket = new WebSocket(cluster.url + '/node/connect', {
    headers: { 'x-pirc-node-id': 'other', authorization: 'Bearer ' + 'b'.repeat(32) },
  });
  try {
    const reply = new Promise<any>((resolve, reject) => {
      socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      socket.once('error', reject);
    });
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(
      JSON.stringify({
        type: 'register',
        role: 'chat',
        protocol: NODE_PROTOCOL_VERSION,
        workspaces: [],
      }),
    );
    expect(await reply).toMatchObject({
      type: 'registration_error',
      status: 409,
      code: 'chat_node_exists',
    });
    expect(cluster.services.nodes.get('test')?.role).toBe('chat');
    await cluster.nodes[0]!.close();
    cluster.nodes.splice(0);
    await waitFor(() => cluster.services.nodes.list().length, 0);
    const release = await cluster.app.inject({
      method: 'POST',
      url: '/api/assistant/node/release',
      headers,
      payload: { nodeId: 'test' },
    });
    expect(release.statusCode).toBe(200);
    expect(cluster.services.db.assistantNode()).toBeNull();
  } finally {
    socket.terminate();
  }
});
