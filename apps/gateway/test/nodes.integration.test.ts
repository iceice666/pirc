import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { headers, testConfig } from './helpers.js';

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
    const { app } = await buildApp(
      testConfig({
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
    a.send(JSON.stringify({ type: 'register', workspaces: [{ id: 'project', displayName: 'A' }] }));
    expect((await replyA).type).toBe('registered');
    const replyB = receive(b);
    b.send(JSON.stringify({ type: 'register', workspaces: [{ id: 'project', displayName: 'B' }] }));
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
    await expect
      .poll(async () =>
        (await app.inject({ method: 'GET', url: '/api/nodes', headers }))
          .json()
          .nodes.map((n: any) => n.id),
      )
      .toEqual(['node-b']);
    const replacement = await open(url, 'node-b', 'b'.repeat(32));
    const oldClosed = new Promise<void>((resolve) => b.once('close', () => resolve()));
    const replacementReply = receive(replacement);
    replacement.send(
      JSON.stringify({ type: 'register', workspaces: [{ id: 'other', displayName: 'Updated' }] }),
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
});
