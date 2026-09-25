import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { startNodeAgent } from '../src/agent-runtime.js';
import { headers, testConfig } from './helpers.js';

const apps: FastifyInstance[] = [];
const agents: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it('routes sessions and Pi prompts through two independent outbound nodes', async () => {
  const config = testConfig({
    nodeTokens: new Map([
      ['alpha', 'a'.repeat(32)],
      ['beta', 'b'.repeat(32)],
    ]),
  });
  const { app, services } = await buildApp(config);
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  for (const [id, secret] of [
    ['alpha', 'a'.repeat(32)],
    ['beta', 'b'.repeat(32)],
  ]) {
    const nodeConfig = testConfig({
      hostId: id!,
      allowedHosts: new Set(['test.example']),
      allowedOrigins: new Set(['https://test.example']),
    });
    agents.push(await startNodeAgent(nodeConfig, id!, secret!, url));
  }
  await expect.poll(() => services.nodes.list().length).toBe(2);
  const existing = mkdtempSync(path.join(os.homedir(), 'pirc-ws-integration-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'pirc-ws-outside-'));
  const link = path.join(existing, 'outside-link');
  symlinkSync(outside, link);
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { nodeId: 'alpha', path: outside, displayName: 'Outside' },
    });
    expect(denied.statusCode).toBe(503);
    const linked = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { nodeId: 'alpha', path: link, displayName: 'Escaped link' },
    });
    expect(linked.statusCode).toBe(503);
    const created = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { nodeId: 'alpha', path: existing, displayName: 'Independent project' },
    });
    expect(created.statusCode).toBe(201);
    const workspaceId = created.json().workspace.id;
    expect(workspaceId).toMatch(/^alpha:workspace_/);
    expect(created.json().workspace).not.toHaveProperty('canonicalPath');
    expect(
      services.nodes.get('alpha')?.workspaces.some((w) => `alpha:${w.id}` === workspaceId),
    ).toBe(true);
    expect(
      (await app.inject({ method: 'GET', url: '/api/workspaces', headers }))
        .json()
        .workspaces.some((w: { id: string }) => w.id === workspaceId),
    ).toBe(true);
    const session = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId, name: 'Independent session' },
    });
    expect(session.statusCode).toBe(201);
    expect(session.json().session.nodeId).toBe('alpha');
  } finally {
    rmSync(link, { force: true });
    rmSync(existing, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
  const ids: string[] = [];
  for (const id of ['alpha', 'beta']) {
    await expect
      .poll(() => services.db.listWorkspaces().some((w) => w.id === `${id}:test`))
      .toBe(true);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: `${id}:test`, name: `Session ${id}` },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.id as string;
    expect(created.json().session.piSessionId).toBeUndefined();
    expect(created.json().session.ownerUser).toBeUndefined();
    ids.push(sessionId);
    const acquired = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId: 'browser' },
    });
    const generation = acquired.json().lease.generation;
    expect(acquired.statusCode).toBe(200);
    const heartbeat = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/heartbeat`,
      headers,
      payload: { clientId: 'browser', generation },
    });
    expect(heartbeat.statusCode).toBe(200);
    const command = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers,
      payload: {
        commandId: `cmd-${id}`,
        clientId: 'browser',
        generation,
        payload: { type: 'prompt', message: id },
      },
    });
    expect(command.statusCode).toBe(202);
    expect(command.json().command.status).toBe('accepted');
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers,
      payload: {
        commandId: `cmd-${id}`,
        clientId: 'browser',
        generation,
        payload: { type: 'prompt', message: id },
      },
    });
    expect(duplicate.json().duplicate).toBe(true);
    await expect
      .poll(() =>
        services.events
          .replay(sessionId, null)
          .events.some(
            (event) => event.type === 'pi_event' && (event.data as any)?.type === 'agent_settled',
          ),
      )
      .toBe(true);
    const snapshot = (
      await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    ).json();
    expect(snapshot.history.at(-1)?.content?.[0]?.text).toBe(`echo:${id}`);
    expect(snapshot.session.piSessionId).toBeUndefined();
    expect(snapshot.session.ownerUser).toBeUndefined();
    expect(
      services.events.replay(sessionId, null).events.some((event) => event.type === 'pi_event'),
    ).toBe(true);
  }
  expect(services.db.getSession(ids[0]!).nodeId).toBe('alpha');
  const wrongUser = { ...headers, 'x-pirc-user': 'other@example.com' };
  config.allowedUsers.add('other@example.com');
  expect(
    (await app.inject({ method: 'GET', url: '/api/sessions', headers: wrongUser })).json().sessions,
  ).toHaveLength(0);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: `/api/sessions/${ids[0]}/snapshot`,
        headers: wrongUser,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${ids[0]}/commands`,
        headers: wrongUser,
        payload: {
          commandId: 'attack',
          clientId: 'browser',
          generation: 1,
          payload: { type: 'prompt', message: 'bad' },
        },
      })
    ).statusCode,
  ).toBe(403);
  expect(services.db.getSession(ids[1]!).nodeId).toBe('beta');
  const browserSocket = new (await import('ws')).default(
    `${url}/api/events?sessionId=${encodeURIComponent(ids[1]!)}&cursor=0:0`,
    { headers },
  );
  const browserEvents: any[] = [];
  browserSocket.on('message', (raw) => browserEvents.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    browserSocket.once('open', () => resolve());
    browserSocket.once('error', reject);
  });
  await expect
    .poll(() =>
      browserEvents.some(
        (event) => event.type === 'pi_event' && event.data?.type === 'agent_settled',
      ),
    )
    .toBe(true);
  browserSocket.close();
  const lease = (
    await app.inject({ method: 'GET', url: `/api/sessions/${ids[1]}/control`, headers })
  ).json().lease;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${ids[1]}/control/release`,
        headers,
        payload: { clientId: 'browser', generation: lease.generation },
      })
    ).statusCode,
  ).toBe(204);
  await agents[0]!.close();
  agents.shift();
  await expect.poll(() => services.nodes.list().length).toBe(1);
  const offline = await app.inject({
    method: 'GET',
    url: `/api/sessions/${ids[0]}/snapshot`,
    headers,
  });
  expect(offline.statusCode).toBe(503);
  expect(services.db.getSession(ids[0]!).runnerState).toBe('failed');
  expect(
    services.events.replay(ids[0]!, null).events.some((event) => event.type === 'node_offline'),
  ).toBe(true);
  const online = await app.inject({
    method: 'GET',
    url: `/api/sessions/${ids[1]}/snapshot`,
    headers,
  });
  expect(online.statusCode).toBe(200);
});
