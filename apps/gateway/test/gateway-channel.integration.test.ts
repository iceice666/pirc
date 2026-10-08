import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { sharedTestNode } from './fixtures/shared-node.js';
const peers = new WeakMap<WebSocket, ReturnType<typeof sharedTestNode>>();
import { buildDaemonApp } from '../src/daemon/app.js';
import { buildNodeApp } from '../src/node/app.js';
import { NODE_PROTOCOL_VERSION } from '../src/protocol.js';
import {
  daemonConfig,
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
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const errorOf = (text: string) => {
  expect(text.startsWith('gateway:error ')).toBe(true);
  return JSON.parse(text.slice('gateway:error '.length));
};

it('carries an agent request to the gateway and back through its node', async () => {
  const cluster = await startCluster();
  clusters.push(cluster);
  const { app, services } = cluster;
  await waitFor(() => services.db.listWorkspaces().some((w) => w.id === 'test:test'), true);
  const { ask } = await promptSession(app, services.events, headers, 'test:test');
  expect(await ask('gateway assistant.context {}')).toBe('gateway:ok {"enabled":false}');
  expect(errorOf(await ask('gateway nope.op {}'))).toMatchObject({
    status: 404,
    code: 'unknown_operation',
  });
  expect(errorOf(await ask('gateway assistant.context {"extra":1}'))).toMatchObject({
    status: 400,
    code: 'invalid_input',
  });
  // Refused by the runner, before anything reaches the gateway.
  expect(errorOf(await ask('gateway Not-An-Op {}'))).toMatchObject({
    status: 400,
    code: 'invalid_input',
  });
});

it('offers web search to any session and refuses it without a gateway key', async () => {
  const cluster = await startCluster();
  clusters.push(cluster);
  const { app, services } = cluster;
  await waitFor(() => services.db.listWorkspaces().some((w) => w.id === 'test:test'), true);
  const { ask } = await promptSession(app, services.events, headers, 'test:test');
  expect(errorOf(await ask('gateway web.search {"query":"bun"}'))).toMatchObject({
    status: 503,
    message: expect.stringContaining('EXA_API_KEY'),
  });
  expect(
    errorOf(
      await ask(
        'gateway web.search {"query":"bun","includeDomains":["a.com"],"excludeDomains":["b.com"]}',
      ),
    ),
  ).toMatchObject({ status: 400, code: 'invalid_input' });
});

it('answers offline without a gateway link and keeps the node secrets from its agent', async () => {
  const saved = { token: process.env.PIRC_NODE_TOKEN, secret: process.env.PIRC_TEST_SECRET };
  process.env.PIRC_NODE_TOKEN = 'n'.repeat(32);
  process.env.PIRC_TEST_SECRET = 'shh';
  try {
    const { app, services } = await buildNodeApp(testConfig());
    apps.push(app);
    const { ask } = await promptSession(app, services.events, nodeHeaders, 'test');
    expect(errorOf(await ask('gateway assistant.context {}'))).toMatchObject({
      status: 503,
      code: 'gateway_offline',
    });
    expect(
      errorOf(await ask(`gateway assistant.context {"blob":"${'x'.repeat(70_000)}"}`)),
    ).toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(await ask('env PIRC_NODE_TOKEN')).toBe('env:PIRC_NODE_TOKEN unset');
    expect(await ask('env PIRC_TEST_SECRET')).toBe('env:PIRC_TEST_SECRET unset');
    expect(await ask('env PIRC_GATEWAY')).toBe('env:PIRC_GATEWAY=1');
    // Recap is answered by this node even with the gateway offline. The
    // caller cannot choose another workspace, session or private path.
    const recap = await ask('gateway recap.collect {}');
    expect(recap.startsWith('gateway:ok ')).toBe(true);
    expect(JSON.parse(recap.slice('gateway:ok '.length))).toMatchObject({
      version: 1,
      scope: { workspaceId: 'test', days: 14 },
      sessions: [],
    });
    expect(errorOf(await ask('gateway recap.collect {"workspaceId":"other"}'))).toMatchObject({
      status: 400,
      code: 'invalid_input',
    });
  } finally {
    for (const [name, value] of [
      ['PIRC_NODE_TOKEN', saved.token],
      ['PIRC_TEST_SECRET', saved.secret],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

it('answers only for sessions of the asking node whose owner is still allowed', async () => {
  const { app, services } = await buildDaemonApp(
    daemonConfig({
      nodeTokens: new Map([
        ['a', 'a'.repeat(32)],
        ['b', 'b'.repeat(32)],
      ]),
    }),
  );
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/node/connect`;
  const connect = (nodeId: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { 'x-pirc-node-id': nodeId, authorization: `Bearer ${nodeId.repeat(32)}` },
      });
      sockets.push(socket);
      peers.set(socket, sharedTestNode(socket));
      socket.once('error', reject);
      socket.once('open', () =>
        socket.send(
          JSON.stringify({
            type: 'register',
            role: 'node',
            protocol: NODE_PROTOCOL_VERSION,
            sharedLink: 1,
            workspaces: [{ id: 'w', displayName: 'W' }],
          }),
        ),
      );
      socket.once('message', () => resolve(socket));
    });
  const a = await connect('a');
  const b = await connect('b');
  services.db.createSession('a:w', 'node://a/s1', 'a', 's1', 'test@example.com');
  services.db.createSession('a:w', 'node://a/s2', 'a', 's2', 'mallory@example.com');
  services.db.createSession('a:w', 'node://a/s3', 'a', 's3');
  const ask = (socket: WebSocket, sessionId: string, op: string, args: unknown = {}) =>
    new Promise<any>((resolve) => {
      const requestId = randomUUID();
      const peer = peers.get(socket)!;
      const off = peer.onMessage((message) => {
        if (message.type !== 'agent_response' || message.requestId !== requestId) return;
        off();
        resolve(message);
      });
      void peer.send({ type: 'agent_request', requestId, sessionId, op, args });
    });
  expect(await ask(a, 's1', 'assistant.context')).toMatchObject({
    status: 200,
    body: { result: { enabled: false } },
  });
  // Node b cannot name node a's session, and unknown sessions are unknown.
  expect((await ask(b, 's1', 'assistant.context')).status).toBe(404);
  expect((await ask(a, 'nope', 'assistant.context')).status).toBe(404);
  // Owners who are no longer allowed, and sessions without one, get nothing.
  expect((await ask(a, 's2', 'assistant.context')).status).toBe(403);
  expect((await ask(a, 's3', 'assistant.context')).status).toBe(403);
  expect((await ask(a, 's1', 'nope.op')).body).toMatchObject({
    error: { code: 'unknown_operation' },
  });
  // Bad agent input is answered; it does not close the node's link.
  expect((await ask(a, 's1', 'Not An Op')).status).toBe(400);
  expect((await ask(a, 's1', 'assistant.context', { blob: 'x'.repeat(70_000) })).status).toBe(413);
  expect((await ask(a, 's1', 'assistant.context')).status).toBe(200);
  expect(a.readyState).toBe(WebSocket.OPEN);
});
