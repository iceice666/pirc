import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { headers, startCluster, waitFor, type Cluster } from './helpers.js';

const clusters: Cluster[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

it('routes sessions and Pi prompts through two independent outbound nodes', async () => {
  // A second authenticated user who must not see the first user's sessions.
  const cluster = await startCluster([{ nodeId: 'alpha' }, { nodeId: 'beta' }], {
    allowedUsers: new Set(['test@example.com', 'other@example.com']),
  });
  clusters.push(cluster);
  const { app, services, url } = cluster;
  // Workspaces added from the web must stay inside the node's $HOME; use a throwaway one.
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pirc-home-')));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const existing = mkdtempSync(path.join(home, 'pirc-ws-integration-'));
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
    // The node's own refusal reaches the browser unchanged.
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('home directory');
    const linked = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { nodeId: 'alpha', path: link, displayName: 'Escaped link' },
    });
    expect(linked.statusCode).toBe(403);
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
      payload: { workspaceId },
    });
    expect(session.statusCode).toBe(201);
    expect(session.json().session.nodeId).toBe('alpha');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
  const ids: string[] = [];
  for (const id of ['alpha', 'beta']) {
    await waitFor(() => services.db.listWorkspaces().some((w) => w.id === `${id}:test`), true);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: `${id}:test` },
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
    await waitFor(
      () =>
        services.events
          .replay(sessionId, null)
          .events.some(
            (event) => event.type === 'pi_event' && (event.data as any)?.type === 'agent_settled',
          ),
      true,
    );
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
  await waitFor(
    () =>
      browserEvents.some(
        (event) => event.type === 'pi_event' && event.data?.type === 'agent_settled',
      ),
    true,
  );
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
  await cluster.nodes[0]!.close();
  await waitFor(() => services.nodes.list().length, 1);
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
