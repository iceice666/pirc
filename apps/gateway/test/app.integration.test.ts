import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, realpathSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildNodeApp } from '../src/node/app.js';
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

  it('stops an idle runner that overlaps a new session but never a busy one', async () => {
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
      return {
        sessionId,
        prompt: (message: string) =>
          app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/commands`,
            headers,
            payload: {
              commandId: `${sessionId}-${++n}`,
              clientId,
              generation: lease.json().lease.generation,
              payload: { type: 'prompt', message },
            },
          }),
      };
    };

    const parent = await open('test', 'browser-1');
    expect((await parent.prompt('hello')).statusCode).toBe(202);
    await waitFor(async () => services.runners.get(parent.sessionId)?.idle, true, 5_000);

    const child = await open('nested', 'browser-2');
    const accepted = await child.prompt('hello');
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().command.status).toBe('accepted');
    expect(services.runners.get(parent.sessionId)?.alive ?? false).toBe(false);
    expect(services.db.getSession(parent.sessionId).runnerState).toBe('stopped');

    // Once idle, a dialog prompt keeps the nested session busy; it must win.
    await waitFor(async () => services.runners.get(child.sessionId)?.idle, true, 5_000);
    const asked = await child.prompt('ask');
    expect(asked.statusCode).toBe(202);
    await waitFor(async () => services.db.pendingInteractions(child.sessionId).length, 1, 5_000);
    const blocked = await parent.prompt('hello again');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toBe('Workspace overlaps an active runner');
    expect(services.runners.get(child.sessionId)?.alive).toBe(true);
  });
});
