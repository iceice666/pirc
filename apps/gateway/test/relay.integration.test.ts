/**
 * Browser → daemon → node paths that carry more than JSON: image uploads
 * (binary bodies) and terminal streams (a WebSocket relayed over the node link).
 */
import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadDaemonConfig, loadNodeConfig } from '../src/config.js';
import { headers, startCluster, waitFor, type Cluster } from './helpers.js';

const clusters: Cluster[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

async function openSession(cluster: Cluster) {
  const { app } = cluster;
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers,
    payload: { workspaceId: 'test:test' },
  });
  expect(created.statusCode).toBe(201);
  const sessionId = created.json().session.id as string;
  const lease = (
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId: 'browser-1' },
    })
  ).json().lease;
  return { sessionId, control: { clientId: 'browser-1', generation: lease.generation as number } };
}

function terminalSocket(url: string) {
  const socket = new WebSocket(url, { headers, localAddress: '127.0.0.1' });
  sockets.push(socket);
  let output = '';
  const messages: any[] = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    if (message.type === 'ready') output += message.replay;
    if (message.type === 'output') output += message.data;
  });
  const closed = new Promise<number>((resolve) => socket.once('close', resolve));
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
    expect(predicate()).toBe(true);
  };
  return { socket, messages, output: () => output, closed, until };
}

/** 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

it('stores an uploaded image on the node and passes it to the agent', async () => {
  const cluster = await startCluster();
  clusters.push(cluster);
  const { app } = cluster;
  const { sessionId, control } = await openSession(cluster);

  const upload = (contentType: string) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/uploads`,
      headers: { ...headers, 'content-type': contentType },
      payload: PNG,
    });
  const uploaded = await upload('image/png');
  expect(uploaded.statusCode).toBe(201);
  expect(uploaded.json().upload).toMatchObject({ mimeType: 'image/png', byteSize: PNG.length });
  // The node validates the bytes; its refusal reaches the browser unchanged.
  expect((await upload('image/jpeg')).statusCode).toBe(400);

  const command = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/commands`,
    headers,
    payload: {
      commandId: 'with-image',
      ...control,
      payload: { type: 'prompt', message: 'look', uploadIds: [uploaded.json().upload.id] },
    },
  });
  expect(command.statusCode).toBe(202);
  const reply = async () =>
    (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers }))
      .json()
      .history.at(-1)?.content?.[0]?.text;
  await waitFor(reply, 'echo:look images:image/png');
});

it('refuses uploads to a session owned by someone else', async () => {
  const cluster = await startCluster(undefined, {
    allowedUsers: new Set(['test@example.com', 'other@example.com']),
  });
  clusters.push(cluster);
  const { sessionId } = await openSession(cluster);
  const denied = await cluster.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/uploads`,
    headers: { ...headers, 'x-pirc-user': 'other@example.com', 'content-type': 'image/png' },
    payload: PNG,
  });
  expect(denied.statusCode).toBe(403);
});

const ptyAvailable = (() => {
  try {
    new Bun.Terminal({ cols: 10, rows: 5 }).close();
    return true;
  } catch {
    return false;
  }
})();

it.skipIf(!ptyAvailable)('relays a node terminal to the browser and replays it', async () => {
  const cluster = await startCluster([{ nodeId: 'test', terminalShell: '/bin/sh' }]);
  clusters.push(cluster);
  const { app, url } = cluster;
  const { sessionId, control } = await openSession(cluster);

  const created = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/terminals`,
    headers,
    payload: { ...control, cols: 80, rows: 24 },
  });
  expect(created.statusCode).toBe(201);
  const terminalId = created.json().terminal.id as string;
  const streamUrl = `${url}/api/sessions/${sessionId}/terminals/${terminalId}/stream`;

  const first = terminalSocket(streamUrl);
  await first.until(() => first.messages.some((m) => m.type === 'ready'));
  first.socket.send(JSON.stringify({ ...control, type: 'input', data: 'echo pirc-$((6*7))\r' }));
  await first.until(() => first.output().includes('pirc-42'));

  // Input without control is refused by the node.
  first.socket.send(JSON.stringify({ clientId: 'x', generation: 99, type: 'input', data: 'x' }));
  await first.until(() => first.messages.some((m) => m.type === 'error'));
  first.socket.close();

  // A new connection replays what already happened.
  const second = terminalSocket(streamUrl);
  await second.until(() => second.output().includes('pirc-42'));

  const listed = (
    await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/terminals`, headers })
  ).json();
  expect(listed.terminals.map((t: any) => t.id)).toEqual([terminalId]);

  const closed = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/terminals/${terminalId}/close`,
    headers,
    payload: control,
  });
  expect(closed.statusCode).toBe(204);
  await second.until(() => second.messages.some((m) => m.type === 'exit'));
});

it.skipIf(!ptyAvailable)('ends relayed terminal streams when the node goes away', async () => {
  const cluster = await startCluster([{ nodeId: 'test', terminalShell: '/bin/sh' }]);
  clusters.push(cluster);
  const { app, url } = cluster;
  const { sessionId, control } = await openSession(cluster);
  const terminalId = (
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/terminals`,
      headers,
      payload: control,
    })
  ).json().terminal.id as string;
  const stream = terminalSocket(`${url}/api/sessions/${sessionId}/terminals/${terminalId}/stream`);
  await stream.until(() => stream.messages.some((m) => m.type === 'ready'));
  await cluster.nodes[0]!.close();
  expect(await stream.closed).toBe(1012);
});

it('closes a terminal stream for an unknown terminal or another user', async () => {
  const cluster = await startCluster(undefined, {
    allowedUsers: new Set(['test@example.com', 'other@example.com']),
  });
  clusters.push(cluster);
  const { url } = cluster;
  const { sessionId } = await openSession(cluster);
  const missing = terminalSocket(`${url}/api/sessions/${sessionId}/terminals/nope/stream`);
  expect(await missing.closed).toBe(4404);

  const socket = new WebSocket(`${url}/api/sessions/${sessionId}/terminals/nope/stream`, {
    headers: { ...headers, 'x-pirc-user': 'other@example.com' },
    localAddress: '127.0.0.1',
  });
  sockets.push(socket);
  expect(await new Promise<number>((resolve) => socket.once('close', resolve))).toBe(4403);
});

it('relays background-task stops to the node, which checks the lease', async () => {
  const cluster = await startCluster();
  clusters.push(cluster);
  const { app } = cluster;
  const { sessionId, control } = await openSession(cluster);
  const url = `/api/sessions/${sessionId}/panel/background/bg1/stop`;
  const refused = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { clientId: control.clientId, generation: control.generation + 5 },
  });
  expect(refused.statusCode).toBe(409);
  // With control it reaches the node; no agent runs in this test, so no task either.
  const relayed = await app.inject({ method: 'POST', url, headers, payload: control });
  expect(relayed.json().error.code).toBe('runner_unavailable');
});

it('keeps daemon and node configuration apart', () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'pirc-cfg-'));
  const daemonEnv = {
    PIRC_TRUSTED_PROXIES: '127.0.0.1',
    PIRC_ALLOWED_USERS: 'a@example.com',
    PIRC_ALLOWED_ORIGINS: 'https://x',
    PIRC_ALLOWED_HOSTS: 'x',
    PIRC_STATE_DIR: path.join(state, 'daemon'),
  };
  expect(() => loadDaemonConfig(daemonEnv)).toThrow('PIRC_NODE_TOKENS');
  const withTokens = { ...daemonEnv, PIRC_NODE_TOKENS: JSON.stringify({ m5: 'k'.repeat(32) }) };
  expect(loadDaemonConfig(withTokens).nodeTokens.get('m5')).toBe('k'.repeat(32));
  // Node settings on the daemon are a misconfiguration, not silently ignored.
  expect(() => loadDaemonConfig({ ...withTokens, PIRC_WORKSPACES: '[]' })).toThrow('pirc node');
  expect(() => loadDaemonConfig({ ...withTokens, PIRC_UPLOAD_MAX_BYTES: '99999999' })).toThrow(
    'frame limit',
  );

  const nodeEnv = {
    PIRC_NODE_ID: 'm5',
    PIRC_NODE_TOKEN: 'k'.repeat(32),
    PIRC_DAEMON_URL: 'wss://daemon.example',
    PIRC_ALLOWED_USERS: 'a@example.com',
    PIRC_STATE_DIR: path.join(state, 'node'),
  };
  expect(loadNodeConfig(nodeEnv).workspaces).toEqual([]);
  expect(() => loadNodeConfig({ ...nodeEnv, PIRC_DAEMON_URL: 'ws://daemon' })).toThrow('wss://');
  // A daemon on the same machine may be reached without TLS.
  for (const host of ['127.0.0.1:8787', '[::1]:8787', 'localhost:8787'])
    expect(loadNodeConfig({ ...nodeEnv, PIRC_DAEMON_URL: `ws://${host}` }).daemonUrl).toBe(
      `ws://${host}`,
    );
  expect(() => loadNodeConfig({ ...nodeEnv, PIRC_NODE_TOKEN: 'short' })).toThrow('32');
});
