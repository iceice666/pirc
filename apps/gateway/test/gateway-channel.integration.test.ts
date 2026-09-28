import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildDaemonApp } from '../src/daemon/app.js';
import type { EventHub } from '../src/events.js';
import { buildNodeApp } from '../src/node/app.js';
import { NODE_PROTOCOL_VERSION } from '../src/protocol.js';
import {
  daemonConfig,
  headers,
  nodeHeaders,
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

/** Prompt the fake agent through `app` (daemon or node router) and return its reply. */
async function prompter(app: FastifyInstance, events: EventHub, requestHeaders: object) {
  const workspaceId = requestHeaders === headers ? 'test:test' : 'test';
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: requestHeaders as Record<string, string>,
    payload: { workspaceId },
  });
  expect(created.statusCode).toBe(201);
  const sessionId = created.json().session.id as string;
  const acquired = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/control/acquire`,
    headers: requestHeaders as Record<string, string>,
    payload: { clientId: 'browser' },
  });
  const generation = acquired.json().lease.generation as number;
  const settled = () =>
    events
      .replay(sessionId, null)
      .events.filter(
        (event) => event.type === 'pi_event' && (event.data as any)?.type === 'agent_settled',
      ).length;
  let count = 0;
  return async (message: string): Promise<string> => {
    const command = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers: requestHeaders as Record<string, string>,
      payload: {
        commandId: `command-${++count}`,
        clientId: 'browser',
        generation,
        payload: { type: 'prompt', message },
      },
    });
    expect(command.statusCode).toBe(202);
    await waitFor(settled, count);
    const snapshot = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/snapshot`,
      headers: requestHeaders as Record<string, string>,
    });
    return snapshot.json().history.at(-1).content[0].text as string;
  };
}
const errorOf = (text: string) => {
  expect(text.startsWith('gateway:error ')).toBe(true);
  return JSON.parse(text.slice('gateway:error '.length));
};

it('carries an agent request to the gateway and back through its node', async () => {
  const cluster = await startCluster();
  clusters.push(cluster);
  const { app, services } = cluster;
  await waitFor(() => services.db.listWorkspaces().some((w) => w.id === 'test:test'), true);
  const ask = await prompter(app, services.events, headers);
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

it('answers offline without a gateway link and keeps the node secrets from its agent', async () => {
  const saved = { token: process.env.PIRC_NODE_TOKEN, secret: process.env.PIRC_TEST_SECRET };
  process.env.PIRC_NODE_TOKEN = 'n'.repeat(32);
  process.env.PIRC_TEST_SECRET = 'shh';
  try {
    const { app, services } = await buildNodeApp(testConfig());
    apps.push(app);
    const ask = await prompter(app, services.events, nodeHeaders);
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
      socket.once('error', reject);
      socket.once('open', () =>
        socket.send(
          JSON.stringify({
            type: 'register',
            protocol: NODE_PROTOCOL_VERSION,
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
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'agent_response' || message.requestId !== requestId) return;
        socket.off('message', onMessage);
        resolve(message);
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ type: 'agent_request', requestId, sessionId, op, args }));
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
