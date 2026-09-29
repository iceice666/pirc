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
import { findBrowserExecutable } from '../src/node/browser.js';
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

it('stores a generic file upload in the workspace and points the agent at it', async () => {
  const cluster = await startCluster();
  clusters.push(cluster);
  const { app } = cluster;
  const { sessionId, control } = await openSession(cluster);

  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/uploads?filename=${encodeURIComponent('notes.txt')}`,
    headers: { ...headers, 'content-type': 'text/plain' },
    payload: Buffer.from('hello file'),
  });
  expect(uploaded.statusCode).toBe(201);
  expect(uploaded.json().upload).toMatchObject({
    mimeType: 'text/plain',
    byteSize: 10,
    kind: 'file',
    filename: 'notes.txt',
  });

  // A non-image upload without a filename is rejected.
  const missingFilename = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/uploads`,
    headers: { ...headers, 'content-type': 'text/plain' },
    payload: Buffer.from('no name'),
  });
  expect(missingFilename.statusCode).toBe(400);

  const command = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/commands`,
    headers,
    payload: {
      commandId: 'with-file',
      ...control,
      payload: { type: 'prompt', message: 'look', uploadIds: [uploaded.json().upload.id] },
    },
  });
  expect(command.statusCode).toBe(202);
  const reply = async () =>
    (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers }))
      .json()
      .history.at(-1)?.content?.[0]?.text;
  const deadline = Date.now() + 5000;
  let text: string | undefined;
  while (Date.now() < deadline) {
    text = await reply();
    if (text?.includes('Attached file(s)')) break;
    await Bun.sleep(20);
  }
  expect(text).toContain('echo:look');
  expect(text).toContain('Attached file(s) available to read from the workspace:');
  expect(text).toMatch(/- \.pirc\/uploads\/[^\s]+-notes\.txt/);
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

const browserExecutable = findBrowserExecutable(process.env.PIRC_BROWSER_EXECUTABLE);

it.skipIf(!browserExecutable || !Bun.which('ffmpeg'))(
  'relays the browser live view and serves its recordings with ranges',
  async () => {
    const site = Bun.serve({
      port: 0,
      fetch: () =>
        new Response('<!doctype html><title>Site</title><h1>Hello from the site</h1>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    try {
      const cluster = await startCluster([
        {
          nodeId: 'test',
          browser: {
            enabled: true,
            executable: browserExecutable,
            ffmpeg: 'ffmpeg',
            profilesDir: mkdtempSync(path.join(os.tmpdir(), 'pirc-relay-browser-')),
            idleMs: 60_000,
            viewport: { width: 640, height: 480 },
          },
        },
      ]);
      clusters.push(cluster);
      const { app, url } = cluster;
      const { sessionId, control } = await openSession(cluster);
      const view = terminalSocket(`${url}/api/sessions/${sessionId}/browser/stream`);
      await view.until(() => view.messages.some((m) => m.type === 'state'));
      expect(view.messages[0].state.active).toBe(false);

      const send = (message: Record<string, unknown>) =>
        view.socket.send(JSON.stringify({ ...control, ...message }));
      send({ type: 'takeover' });
      send({ type: 'navigate', url: `http://127.0.0.1:${site.port}/` });
      await view.until(() =>
        view.messages.some((m) => m.type === 'state' && m.state.title === 'Site'),
      );
      await view.until(() => view.messages.some((m) => m.type === 'frame' && m.width === 640));
      send({ type: 'record', action: 'start' });
      await view.until(() =>
        view.messages.some((m) => m.type === 'state' && m.state.recording !== null),
      );
      await Bun.sleep(800);
      send({ type: 'record', action: 'stop' });
      await view.until(() =>
        view.messages.some((m) => m.type === 'log_entry' && m.entry.action.startsWith('Saved')),
      );
      const saved = view.messages.find(
        (m) => m.type === 'log_entry' && m.entry.action.startsWith('Saved'),
      ).entry.action as string;
      const file = saved.replace('Saved recording ', '');
      expect(file).toMatch(/^\.pirc\/recordings\/recording-.*\.webm$/);

      const recording = (range?: string) =>
        app.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/browser/recording?path=${encodeURIComponent(file)}`,
          headers: { ...headers, ...(range ? { range } : {}) },
        });
      const full = await recording();
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toBe('video/webm');
      expect(full.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      const size = full.rawPayload.length;
      const part = await recording('bytes=10-19');
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes 10-19/${size}`);
      expect(part.rawPayload).toEqual(full.rawPayload.subarray(10, 20));
      const tail = await recording('bytes=-5');
      expect(tail.rawPayload).toEqual(full.rawPayload.subarray(size - 5));
      expect((await recording(`bytes=${size + 10}-`)).statusCode).toBe(416);
      const escape = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/browser/recording?path=${encodeURIComponent('../../etc/passwd')}`,
        headers,
      });
      expect(escape.statusCode).toBe(400);
    } finally {
      site.stop(true);
    }
  },
  60_000,
);
