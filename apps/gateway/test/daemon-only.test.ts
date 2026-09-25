import { expect, it } from 'bun:test';
import { buildApp } from '../src/app.js';
import { loadConfig, parseWorkspaces } from '../src/config.js';
import { headers, testConfig } from './helpers.js';

it('requires node credentials and rejects daemon-only mode on an agent', () => {
  expect(parseWorkspaces({ PIRC_DAEMON_ONLY: 'true' })).toEqual([]);
  expect(parseWorkspaces({ PIRC_DAEMON_ONLY: 'true', PIRC_WORKSPACES: '[]' })).toEqual([]);
  expect(() => parseWorkspaces({ PIRC_WORKSPACES: '[]' })).toThrow();
  expect(() => loadConfig({ PIRC_DAEMON_ONLY: 'true' })).toThrow('PIRC_NODE_TOKENS');
  expect(() => loadConfig({ PIRC_DAEMON_ONLY: 'true', PIRC_NODE_ID: 'agent' })).toThrow(
    'cannot be used on a node agent',
  );
});

it('hides persisted local workspaces and forbids daemon-local session operations', async () => {
  const { app, services } = await buildApp(
    testConfig({ daemonOnly: true, nodeTokens: new Map([['node-a', 'a'.repeat(32)]]) }),
  );
  try {
    expect(services.db.listWorkspaces().some((workspace) => workspace.id === 'test')).toBe(true);
    expect(
      (await app.inject({ method: 'GET', url: '/api/workspaces', headers })).json().workspaces,
    ).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: '/api/sessions', headers })).json().sessions,
    ).toEqual([]);
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'test', name: 'not allowed' },
    });
    expect(create.statusCode).toBe(403);
    expect(services.db.listSessions()).toHaveLength(0);
    const legacy = services.db.createSession(
      'test',
      'existing local session',
      '/tmp/legacy-daemon-session',
    );
    expect(
      (await app.inject({ method: 'GET', url: '/api/sessions', headers })).json().sessions,
    ).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: `/api/sessions/${legacy.id}/snapshot`, headers }))
        .statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
