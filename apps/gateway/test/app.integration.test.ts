import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SESSION_FILE } from '../src/agent/session-store.js';
import { buildNodeApp } from '../src/node/app.js';
import { testModels } from './agent-harness.js';
import { nodeHeaders as headers, testConfig, waitFor } from './helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('node router', () => {
  it('rejects unknown users and completes a fake Pi prompt', async () => {
    const { app } = await buildNodeApp(testConfig());
    apps.push(app);

    const denied = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-pirc-user': 'mallory@example.com' },
      payload: { workspaceId: 'test' },
    });
    expect(denied.statusCode).toBe(403);
    // Without the identity the node runtime sets, nothing is reachable.
    expect((await app.inject({ method: 'POST', url: '/api/sessions' })).statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'test' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.id as string;

    const acquired = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId: 'browser-1' },
    });
    const generation = acquired.json().lease.generation as number;

    const command = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers,
      payload: {
        commandId: 'command-1',
        clientId: 'browser-1',
        generation,
        payload: { type: 'prompt', message: 'hello' },
      },
    });
    expect(command.statusCode).toBe(202);
    expect(command.json().command.status).toBe('accepted');

    await new Promise((resolve) => setTimeout(resolve, 40));
    const snapshot = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/snapshot`,
      headers,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().history.at(-1).content[0].text).toBe('echo:hello');
    expect(snapshot.json().run.status).toBe('succeeded');

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers,
      payload: {
        commandId: 'command-1',
        clientId: 'browser-1',
        generation,
        payload: { type: 'prompt', message: 'hello' },
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
  });

  it('runs overlapping sessions together and lets only one of them write', async () => {
    const base = testConfig();
    // Canonical paths, as the real config produces (macOS tmp is a /private symlink).
    const root = realpathSync(base.workspaces[0]!.path);
    const config = { ...base, workspaces: [{ ...base.workspaces[0]!, path: root }] };
    const { app, services } = await buildNodeApp(config);
    apps.push(app);
    // A nested workspace overlaps the parent one, like ~/code and ~/code/project.
    const nested = `${root}/project`;
    mkdirSync(nested);
    services.db.addWorkspace('nested', 'test', 'Nested', nested);

    const open = async (workspaceId: string, clientId: string) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { workspaceId },
      });
      const sessionId = created.json().session.id as string;
      const lease = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/control/acquire`,
        headers,
        payload: { clientId },
      });
      let n = 0;
      const send = (payload: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/commands`,
          headers,
          payload: {
            commandId: `${sessionId}-${++n}`,
            clientId,
            generation: lease.json().lease.generation,
            payload,
          },
        });
      const texts = async () =>
        (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers }))
          .json()
          .history.map((m: { content: Array<{ text: string }> }) => m.content[0]!.text)
          .join('|');
      return {
        sessionId,
        texts,
        prompt: (message: string) => send({ type: 'prompt', message }),
        stop: () => send({ type: 'stop' }),
      };
    };

    // No runner limit: three sessions over overlapping paths all run.
    const parent = await open('test', 'browser-1');
    const child = await open('nested', 'browser-2');
    const reader = await open('nested', 'browser-3');
    for (const session of [parent, child, reader])
      expect((await session.prompt('hello')).statusCode).toBe(202);
    for (const session of [parent, child, reader])
      await waitFor(session.texts, 'echo:hello', 5_000);
    for (const session of [parent, child, reader])
      expect(services.runners.get(session.sessionId)?.alive).toBe(true);

    // The child holds a write lease for its whole run…
    expect((await child.prompt(`hold ${nested}`)).statusCode).toBe(202);
    await waitFor(async () => services.writes.leases(child.sessionId).join(), nested, 5_000);
    // …so the parent cannot write anywhere overlapping it, while reading goes on.
    expect((await parent.prompt(`write ${root}`)).statusCode).toBe(202);
    await waitFor(
      async () => (await parent.texts()).split('|').at(-1)!.split(' is being')[0],
      'lease:refused ' + nested,
      5_000,
    );
    expect(await parent.texts()).toContain(`(${child.sessionId}); wait until its run finishes`);
    expect(services.writes.leases(parent.sessionId)).toEqual([]);
    expect((await reader.prompt('still reading')).statusCode).toBe(202);
    await waitFor(async () => (await reader.texts()).endsWith('echo:still reading'), true, 5_000);

    // Once the child's run settles its lease is gone and the parent may write.
    expect((await child.stop()).statusCode).toBe(202);
    await waitFor(async () => services.writes.leases(child.sessionId).length, 0, 5_000);
    expect((await parent.prompt(`write ${root}`)).statusCode).toBe(202);
    await waitFor(async () => (await parent.texts()).endsWith('lease:granted'), true, 5_000);
    // A `write` run settles immediately, which releases the lease again.
    await waitFor(async () => services.writes.leases(parent.sessionId).length, 0, 5_000);
  });

  it('forwards send_now for a queued message and validates its payload', async () => {
    const { app } = await buildNodeApp(testConfig());
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'test' },
    });
    const sessionId = created.json().session.id as string;
    const lease = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId: 'browser' },
    });
    let n = 0;
    const send = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/commands`,
        headers,
        payload: {
          commandId: `send-now-${++n}`,
          clientId: 'browser',
          generation: lease.json().lease.generation,
          payload,
        },
      });
    const steering = async () =>
      (
        await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
      ).json().queue.steering as string[];

    expect((await send({ type: 'steer', message: 'go left' })).statusCode).toBe(202);
    await waitFor(async () => (await steering()).join(), 'go left', 5_000);
    expect(
      (await send({ type: 'send_now', queue: 'steering', index: -1, message: 'go left' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await send({ type: 'send_now', queue: 'steering', index: 0, message: 'go left' }))
        .statusCode,
    ).toBe(202);
    await waitFor(async () => (await steering()).length, 0, 5_000);
  });

  it('keeps serving history from the session file after the runner dies', async () => {
    const { app, services } = await buildNodeApp(testConfig());
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'test' },
    });
    const sessionId = created.json().session.id as string;
    const lease = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId: 'browser-1' },
    });
    let n = 0;
    const prompt = (message: string) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/commands`,
        headers,
        payload: {
          commandId: `command-${++n}`,
          clientId: 'browser-1',
          generation: lease.json().lease.generation,
          payload: { type: 'prompt', message },
        },
      });
    const snapshot = async () =>
      (
        await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
      ).json() as { history: Array<{ content: Array<{ text: string }> }>; session: any };
    const texts = async () => (await snapshot()).history.map((m) => m.content[0]!.text).join('|');

    await prompt('first');
    await waitFor(texts, 'echo:first');
    // The runner dies (in production: the agent was killed); no agent answers get_messages now.
    await prompt('crash');
    await waitFor(async () => services.runners.get(sessionId)?.alive ?? false, false);
    const dead = await snapshot();
    expect(dead.session.runnerState).toBe('failed');
    expect(dead.history.map((m) => m.content[0]!.text)).toEqual(['echo:first']);

    // The next prompt starts a fresh runner that continues the same transcript.
    expect((await prompt('second')).statusCode).toBe(202);
    await waitFor(texts, 'echo:first|echo:second');
  });

  it('reports the model and thinking level the next agent will use when no runner is live', async () => {
    const previous = process.env.PIRC_CONFIG_DIR;
    process.env.PIRC_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'pirc-snapshot-config-'));
    const { app, services } = await buildNodeApp(testConfig());
    apps.push(app);
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { workspaceId: 'test' },
      });
      const sessionId = created.json().session.id as string;
      const snapshot = async () =>
        (
          await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
        ).json();
      // No catalog yet: nothing to pick, the agent's default thinking level.
      expect((await snapshot()).agent).toEqual({ model: null, thinkingLevel: 'medium' });
      // A fresh session starts on the default model, not the first listed one.
      services.models.set(
        testModels('http://127.0.0.1:1', {
          defaultModel: { provider: 'fakeclaude', id: 'claude-x', thinking: 'high' },
        }),
      );
      expect((await snapshot()).agent).toEqual({
        model: { provider: 'fakeclaude', id: 'claude-x' },
        thinkingLevel: 'high',
      });

      // Recorded changes win over the default.
      const dir = services.db.getSession(sessionId).privateSessionPath;
      mkdirSync(dir, { recursive: true });
      const entries = [
        { type: 'session', id: 'a', parentId: null, timestamp: 1, version: 1, sessionId, cwd: dir },
        {
          type: 'model_change',
          id: 'b',
          parentId: 'a',
          timestamp: 2,
          provider: 'p',
          modelId: 'old',
        },
        {
          type: 'thinking_level_change',
          id: 'c',
          parentId: 'b',
          timestamp: 3,
          thinkingLevel: 'minimal',
        },
        {
          type: 'model_change',
          id: 'd',
          parentId: 'c',
          timestamp: 4,
          provider: 'p',
          modelId: 'new',
        },
      ];
      writeFileSync(path.join(dir, SESSION_FILE), entries.map((e) => JSON.stringify(e)).join('\n'));
      expect(services.runners.get(sessionId)?.alive ?? false).toBe(false);
      expect((await snapshot()).agent).toEqual({
        model: { provider: 'p', id: 'new' },
        thinkingLevel: 'minimal',
      });
    } finally {
      if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
      else process.env.PIRC_CONFIG_DIR = previous;
    }
  });
});
