import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function setup(overrides = {}) {
  const config = testConfig(overrides);
  const { app } = await buildApp(config);
  apps.push(app);
  const workspace = config.workspaces[0]!.path;
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers,
    payload: { workspaceId: 'test' },
  });
  const sessionId = created.json().session.id as string;
  const get = (url: string) =>
    app.inject({ method: 'GET', url: `/api/sessions/${sessionId}${url}`, headers });
  return { app, config, workspace, sessionId, get };
}

describe('side panel: workspace inspection', () => {
  it('reports git status, diffs, history and commit details', async () => {
    const { workspace, get } = await setup();
    git(workspace, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(workspace, 'a.txt'), 'one\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-q', '-m', 'first commit');
    writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\n');
    writeFileSync(path.join(workspace, 'new file.txt'), 'fresh\n');

    const status = (await get('/git/status')).json();
    expect(status.repo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.files).toEqual([
      { path: 'a.txt', index: ' ', worktree: 'M' },
      { path: 'new file.txt', index: '?', worktree: '?' },
    ]);

    const diff = (await get('/git/diff?path=a.txt')).json();
    expect(diff.diff).toContain('+two');
    const untracked = (
      await get(`/git/diff?path=${encodeURIComponent('new file.txt')}&untracked=1`)
    ).json();
    expect(untracked.diff).toContain('+fresh');

    const log = (await get('/git/log')).json();
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0].subject).toBe('first commit');
    expect(log.more).toBe(false);

    const show = (await get(`/git/commits/${log.commits[0].short}`)).json();
    expect(show.message).toBe('first commit');
    expect(show.diff).toContain('+one');

    expect((await get('/git/commits/not-a-sha')).statusCode).toBe(400);
  });

  it('reports a workspace that is not a repository', async () => {
    const { get } = await setup();
    const status = await get('/git/status');
    expect(status.statusCode).toBe(200);
    expect(status.json().repo).toBe(false);
    expect((await get('/git/log')).json().commits).toEqual([]);
  });

  it('lists and reads files but never escapes the workspace', async () => {
    const { workspace, config, get } = await setup();
    mkdirSync(path.join(workspace, 'src'));
    writeFileSync(path.join(workspace, 'src', 'main.ts'), 'export {};\n');
    writeFileSync(path.join(workspace, 'bin.dat'), Buffer.from([1, 0, 2]));
    writeFileSync(path.join(config.stateDir, 'secret.txt'), 'nope');
    symlinkSync(path.join(config.stateDir, 'secret.txt'), path.join(workspace, 'leak'));

    const root = (await get('/files')).json();
    expect(root.entries.map((entry: any) => [entry.name, entry.kind])).toEqual([
      ['src', 'dir'],
      ['bin.dat', 'file'],
      ['leak', 'symlink'],
    ]);
    expect((await get('/files?path=src')).json().entries[0].name).toBe('main.ts');
    const file = (await get('/files/content?path=src/main.ts')).json();
    expect(file.content).toBe('export {};\n');
    expect((await get('/files/content?path=bin.dat')).json()).toMatchObject({
      binary: true,
    });

    expect((await get('/files/content?path=leak')).statusCode).toBe(403);
    expect((await get('/files/content?path=../secret.txt')).statusCode).toBe(403);
    expect((await get(`/files?path=${encodeURIComponent('..')}`)).statusCode).toBe(403);
    expect((await get('/git/diff?path=../secret.txt')).statusCode).toBe(400);
  });

  it('reports memory from the session file while the agent is stopped', async () => {
    const { get } = await setup();
    const state = (await get('/panel/state')).json();
    expect(state.agentRunning).toBe(false);
    expect(state.memory.counts.observations).toBe(0);
    expect(state.memory.thresholds.observation.max).toBeGreaterThan(0);
    expect(state.backgroundTasks).toEqual([]);
  });

  it('denies other users', async () => {
    const { app, sessionId } = await setup();
    const denied = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/files`,
      headers: { ...headers, 'x-pirc-user': 'mallory@example.com' },
    });
    expect(denied.statusCode).toBe(403);
  });
});

const ptyAvailable = (() => {
  try {
    new Bun.Terminal({ cols: 10, rows: 5 }).close();
    return true;
  } catch {
    return false;
  }
})();

describe('side panel: terminals', () => {
  it('requires control to create a terminal', async () => {
    const { app, sessionId } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/terminals`,
      headers,
      payload: { clientId: 'browser-1', generation: 1 },
    });
    expect(response.statusCode).toBe(409);
  });

  it('can be disabled', async () => {
    const { get } = await setup({ terminalsEnabled: false });
    expect((await get('/terminals')).statusCode).toBe(403);
  });

  it.skipIf(!ptyAvailable)('runs a shell, streams output and replays it', async () => {
    const { app, sessionId } = await setup({ terminalShell: '/bin/sh' });
    const lease = (
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/control/acquire`,
        headers,
        payload: { clientId: 'browser-1' },
      })
    ).json().lease;
    const control = { clientId: 'browser-1', generation: lease.generation };
    const created = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/terminals`,
      headers,
      payload: { ...control, cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(201);
    const terminalId = created.json().terminal.id as string;

    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const connect = () => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}/stream`,
        { headers, localAddress: '127.0.0.1' },
      );
      sockets.push(socket);
      let output = '';
      const messages: any[] = [];
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        messages.push(message);
        if (message.type === 'ready') output += message.replay;
        if (message.type === 'output') output += message.data;
      });
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
        expect(predicate()).toBe(true);
      };
      return { socket, messages, output: () => output, until };
    };

    const first = connect();
    await new Promise((resolve) => first.socket.once('open', resolve));
    first.socket.send(JSON.stringify({ ...control, type: 'input', data: 'echo pirc-$((6*7))\r' }));
    await first.until(() => first.output().includes('pirc-42'));

    // Input without control is refused.
    first.socket.send(JSON.stringify({ clientId: 'x', generation: 99, type: 'input', data: 'x' }));
    await first.until(() => first.messages.some((m) => m.type === 'error'));
    first.socket.close();

    // A new connection replays what already happened.
    const second = connect();
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
});
