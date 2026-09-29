import { afterEach, expect, it } from 'bun:test';
import WebSocket from 'ws';
import { headers, startCluster, waitFor, type Cluster } from './helpers.js';

const clusters: Cluster[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

async function openEvents(url: string, query: string) {
  const socket = new WebSocket(`${url}/api/events?${query}`, { headers });
  const received: any[] = [];
  socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, received };
}

it('lists open runs and write leases the node reports, and tells opted-in sockets', async () => {
  const cluster = await startCluster([{ nodeId: 'alpha' }]);
  clusters.push(cluster);
  const { app, services, url } = cluster;
  const root = cluster.nodes[0]!.config.workspaces[0]!.path;
  await waitFor(() => services.db.listWorkspaces().some((w) => w.id === 'alpha:test'), true);

  const open = async (clientId: string) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'alpha:test' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.id as string;
    const acquired = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId },
    });
    const generation = acquired.json().lease.generation as number;
    let count = 0;
    const send = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/commands`,
        headers,
        payload: {
          commandId: `${sessionId}-${++count}`,
          clientId,
          generation,
          payload,
        },
      });
    return { sessionId, send };
  };
  const listed = async (sessionId: string) => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions', headers });
    return (response.json().sessions as any[]).find((session) => session.id === sessionId);
  };

  const holder = await open('browser-1');
  const watcher = await openEvents(
    url,
    `sessionId=${encodeURIComponent(holder.sessionId)}&sessions=1`,
  );
  const plain = await openEvents(url, `sessionId=${encodeURIComponent(holder.sessionId)}`);
  const changes = (socket: { received: any[] }) =>
    socket.received.filter((event) => event.type === 'sessions_changed').length;
  expect(await listed(holder.sessionId)).not.toHaveProperty('writeLease');

  // `hold` keeps the run open with a write lease on the workspace.
  expect((await holder.send({ type: 'prompt', message: `hold ${root}` })).statusCode).toBe(202);
  await waitFor(async () => (await listed(holder.sessionId))?.writeLease === true, true);
  expect((await listed(holder.sessionId)).runStatus).toBe('running');
  expect(changes(watcher)).toBeGreaterThan(0);
  expect(watcher.received.find((event) => event.type === 'sessions_changed')).toEqual({
    type: 'sessions_changed',
  });
  expect(changes(plain)).toBe(0);

  // Stopping settles the run, which gives the lease back.
  const before = changes(watcher);
  expect((await holder.send({ type: 'stop' })).statusCode).toBe(202);
  await waitFor(async () => (await listed(holder.sessionId))?.writeLease, undefined);
  expect((await listed(holder.sessionId)).runStatus).not.toBe('running');
  await waitFor(() => changes(watcher) > before, true);

  watcher.socket.close();
  plain.socket.close();
});

it('names the schedule or delegation that started a session', async () => {
  const cluster = await startCluster([{ nodeId: 'alpha' }]);
  clusters.push(cluster);
  const { app, services } = cluster;
  await waitFor(() => services.db.listWorkspaces().some((w) => w.id === 'alpha:test'), true);
  const create = async () =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { workspaceId: 'alpha:test' },
      })
    ).json().session.id as string;
  const scheduled = await create();
  const delegated = await create();
  const chat = await create();
  const user = headers['x-pirc-user'];
  const raw = (services.db as any).raw;
  raw
    .prepare(
      "INSERT INTO schedules (id, owner_user, workspace_id, title, prompt, cron, timezone, status, created_at, updated_at) VALUES ('sch_1', ?, 'alpha:test', 'Daily digest', 'Summarize', '0 9 * * *', 'UTC', 'active', 1, 1)",
    )
    .run(user);
  raw
    .prepare(
      "INSERT INTO schedule_runs (id, schedule_id, owner_user, due_at, status, session_id, created_at) VALUES ('run_1', 'sch_1', ?, 1000, 'completed', ?, 1)",
    )
    .run(user, scheduled);
  raw
    .prepare(
      "INSERT INTO delegations (id, owner_user, assistant_session_id, workspace_id, title, task, status, target_session_id, expires_at, created_at, updated_at) VALUES ('dlg_1', ?, ?, 'alpha:test', 'Fix the build', 'Fix it', 'completed', ?, 1, 1, 1)",
    )
    .run(user, chat, delegated);

  const response = await app.inject({ method: 'GET', url: '/api/sessions', headers });
  const byId = new Map((response.json().sessions as any[]).map((s) => [s.id, s]));
  expect(byId.get(scheduled).origin).toEqual({
    kind: 'schedule',
    scheduleId: 'sch_1',
    title: 'Daily digest',
    dueAt: 1000,
  });
  expect(byId.get(delegated).origin).toEqual({
    kind: 'delegation',
    delegationId: 'dlg_1',
    title: 'Fix the build',
    fromSessionId: chat,
  });
  expect(byId.get(chat)).not.toHaveProperty('origin');
});
