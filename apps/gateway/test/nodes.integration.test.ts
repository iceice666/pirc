import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildDaemonApp } from '../src/daemon/app.js';
import { NODE_PROTOCOL_VERSION } from '../src/protocol.js';
import { daemonConfig, headers, waitFor } from './helpers.js';

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function open(url: string, nodeId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { 'x-pirc-node-id': nodeId, authorization: `Bearer ${token}` },
    });
    sockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}
function receive(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    socket.once('close', () => reject(new Error('socket closed before response')));
  });
}

describe('node registrations', () => {
  it('registers independent nodes and removes them on disconnect', async () => {
    const { app } = await buildDaemonApp(
      daemonConfig({
        nodeTokens: new Map([
          ['node-a', 'a'.repeat(32)],
          ['node-b', 'b'.repeat(32)],
        ]),
      }),
    );
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/node/connect`;
    const denied = await app.inject({ method: 'GET', url: '/api/nodes' });
    expect(denied.statusCode).toBe(403);
    const a = await open(url, 'node-a', 'a'.repeat(32));
    const b = await open(url, 'node-b', 'b'.repeat(32));
    const replyA = receive(a);
    a.send(
      JSON.stringify({
        type: 'register',
        protocol: NODE_PROTOCOL_VERSION,
        workspaces: [{ id: 'project', displayName: 'A' }],
      }),
    );
    expect((await replyA).type).toBe('registered');
    const replyB = receive(b);
    b.send(
      JSON.stringify({
        type: 'register',
        protocol: NODE_PROTOCOL_VERSION,
        workspaces: [{ id: 'project', displayName: 'B' }],
      }),
    );
    expect((await replyB).type).toBe('registered');
    expect(
      (await app.inject({ method: 'GET', url: '/api/nodes', headers }))
        .json()
        .nodes.map((n: any) => n.id)
        .sort(),
    ).toEqual(['node-a', 'node-b']);
    const pong = receive(a);
    a.send(JSON.stringify({ type: 'heartbeat' }));
    expect((await pong).type).toBe('heartbeat_ack');
    const closed = new Promise<void>((resolve) => a.once('close', () => resolve()));
    a.close();
    await closed;
    await waitFor(
      async () =>
        (await app.inject({ method: 'GET', url: '/api/nodes', headers }))
          .json()
          .nodes.map((n: any) => n.id)
          .join(','),
      'node-b',
    );
    const replacement = await open(url, 'node-b', 'b'.repeat(32));
    const oldClosed = new Promise<void>((resolve) => b.once('close', () => resolve()));
    const replacementReply = receive(replacement);
    replacement.send(
      JSON.stringify({
        type: 'register',
        protocol: NODE_PROTOCOL_VERSION,
        workspaces: [{ id: 'other', displayName: 'Updated' }],
      }),
    );
    expect((await replacementReply).type).toBe('registered');
    await oldClosed;
    expect(
      (await app.inject({ method: 'GET', url: '/api/nodes', headers })).json().nodes[0]
        .workspaces[0].id,
    ).toBe('other');
    const invalid = await open(url, 'node-a', 'invalid');
    const code = await new Promise<number>((resolve) => invalid.once('close', resolve));
    expect(code).toBe(4401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/nodes', headers })).json().nodes,
    ).toHaveLength(1);
  });

  it('refuses a node that speaks another protocol version', async () => {
    const { app } = await buildDaemonApp(daemonConfig());
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/node/connect`;
    const old = await open(url, 'test', 't'.repeat(32));
    const closed = new Promise<number>((resolve) => old.once('close', resolve));
    old.send(JSON.stringify({ type: 'register', workspaces: [] }));
    expect(await closed).toBe(4426);
    expect(
      (await app.inject({ method: 'GET', url: '/api/nodes', headers })).json().nodes,
    ).toHaveLength(0);
  });

  it('pushes resolved providers to nodes on registration and reload', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pirc-models-'));
    const modelsFile = path.join(dir, 'models.json');
    const keyFile = path.join(dir, 'key');
    writeFileSync(keyFile, 'file-key\n');
    const provider = (extra: Record<string, unknown>) => ({
      api: 'openai-chat',
      baseUrl: 'https://llm.example/v1',
      models: [{ id: 'm1', reasoning: true }],
      ...extra,
    });
    writeFileSync(
      modelsFile,
      JSON.stringify({
        providers: { main: provider({ apiKeyFile: keyFile }) },
        defaultModel: { provider: 'main', id: 'm1' },
      }),
    );
    const { app, services } = await buildDaemonApp(daemonConfig({ modelsFile }));
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/node/connect`;
    const node = await open(url, 'test', 't'.repeat(32));
    const registered = receive(node);
    node.send(
      JSON.stringify({ type: 'register', protocol: NODE_PROTOCOL_VERSION, workspaces: [] }),
    );
    const reply = await registered;
    expect(reply.type).toBe('registered');
    // The key reference is resolved on the gateway; nodes only see the key.
    expect(reply.models.providers.main.apiKey).toBe('file-key');
    expect(reply.models.providers.main.apiKeyFile).toBeUndefined();
    expect(reply.models.defaultModel).toEqual({ provider: 'main', id: 'm1' });

    // The browser list needs no session and never includes keys.
    const listed = (await app.inject({ method: 'GET', url: '/api/models', headers })).json();
    expect(listed.models).toEqual([
      expect.objectContaining({ provider: 'main', id: 'm1', reasoning: true }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('file-key');

    // An invalid file keeps the previous providers and pushes nothing.
    writeFileSync(modelsFile, '{ nope');
    services.reloadModels();
    expect(services.models.current.providers.main?.apiKey).toBe('file-key');

    writeFileSync(
      modelsFile,
      JSON.stringify({ providers: { other: provider({ apiKey: 'literal' }) } }),
    );
    const pushed = receive(node);
    services.reloadModels();
    const update = await pushed;
    expect(update.type).toBe('models');
    expect(Object.keys(update.models.providers)).toEqual(['other']);
    expect(update.models.providers.other.apiKey).toBe('literal');
  });

  it('refuses a models file whose default model is not configured', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pirc-models-'));
    const modelsFile = path.join(dir, 'models.json');
    writeFileSync(
      modelsFile,
      JSON.stringify({
        providers: {},
        defaultModel: { provider: 'missing', id: 'x' },
      }),
    );
    await expect(buildDaemonApp(daemonConfig({ modelsFile }))).rejects.toThrow(/defaultModel/);
  });
});
