import { afterEach, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { headers, testConfig } from './helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('gateway integration', () => {
  it('rejects untrusted identity and completes a fake Pi prompt', async () => {
    const { app } = await buildApp(testConfig());
    apps.push(app);

    const denied = await app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: { host: 'test.example', 'x-pirc-user': 'mallory@example.com' },
    });
    expect(denied.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'test', name: 'Integration' },
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
});
