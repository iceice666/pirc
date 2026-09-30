import { afterEach, expect, it } from 'bun:test';
import { headers, startCluster, waitFor } from './helpers.js';

const USER = 'test@example.com';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function start() {
  const cluster = await startCluster([{ nodeId: 'home', chat: true }, { nodeId: 'work' }]);
  cleanup.push(() => cluster.close());
  await waitFor(() => cluster.services.db.listWorkspaces().length, 2);
  const { db } = cluster.services;
  const session = db.createSession(
    'home:chats',
    'node://home/policy-test',
    'home',
    'policy-test',
    USER,
  );
  return { ...cluster, session };
}

it('persists strict gateway policy independently of node registration and checks direct agent requests', async () => {
  const { app, services, session } = await start();
  const url = '/api/workspaces/home%3Achats/capabilities';
  const initial = await app.inject({ method: 'GET', url, headers });
  expect(initial.json().capabilities).toEqual({
    version: 1,
    delegation: true,
    memory_search: true,
    remote_recall: true,
    schedules: true,
    web_search: true,
  });
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
  for (const capabilities of [{ web_search: 'false' }, { version: 2 }, { unknown: false }]) {
    expect(
      (await app.inject({ method: 'PATCH', url, headers, payload: { capabilities } })).statusCode,
    ).toBe(400);
  }
  const capabilities = {
    delegation: false,
    memory_search: false,
    remote_recall: false,
    schedules: false,
    web_search: false,
  };
  expect(
    (await app.inject({ method: 'PATCH', url, headers, payload: { capabilities } })).statusCode,
  ).toBe(200);
  const workspace = services.db.getWorkspace('home:chats');
  services.db.syncRemoteWorkspaces('home', [{ ...workspace, id: 'chats' }]);
  expect(services.db.getWorkspaceCapabilities(workspace.id)).toMatchObject(capabilities);
  const operations: Array<[string, object]> = [
    ['delegation.create', { workspace: 'work:test', task: 'x' }],
    ['delegation.status', {}],
    ['memory.search', { query: 'x' }],
    ['recall.remote', { id: 'abcdef123456' }],
    ['web.search', { query: 'x' }],
    ['schedule.list', {}],
    ['schedule.create', { prompt: 'x', cron: '0 9 * * *' }],
    ['schedule.update', { id: 'x' }],
    ['schedule.pause', { id: 'x' }],
    ['schedule.resume', { id: 'x' }],
    ['schedule.delete', { id: 'x' }],
    ['schedule.run', { id: 'x' }],
    ['schedule.result', { id: 'x' }],
  ];
  for (const [op, args] of operations) {
    const response = await services.nodes.onAgentRequest!('home', {
      sessionId: session.piSessionId!,
      op,
      args,
    });
    expect(response).toMatchObject({
      status: 403,
      body: { error: { code: 'capability_disabled' } },
    });
  }
  const context = await services.nodes.onAgentRequest!('home', {
    sessionId: session.piSessionId!,
    op: 'assistant.context',
    args: {},
  });
  expect(context).toMatchObject({ body: { result: { capabilities } } });
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/work%3Atest/capabilities',
        headers,
        payload: { capabilities },
      })
    ).statusCode,
  ).toBe(400);
});

it('rechecks pending delegation and schedule approvals and previously approved schedule runs', async () => {
  const { services, session } = await start();
  const { db, delegations, schedules } = services;
  const delegation = delegations.create(USER, session, { workspace: 'work:test', task: 'x' });
  const propose = () =>
    schedules.propose(
      USER,
      session,
      { workspace: 'work:test', prompt: 'x', cron: '0 9 * * *' },
      (ref) => db.getWorkspace(ref),
    );
  const pending = propose();
  const approved = propose();
  const saved = schedules.answer(session.id, approved.proposalId, USER, { confirmed: true })!;
  db.patchWorkspaceCapabilities(session.workspaceId, { delegation: false, schedules: false });
  expect(() => delegations.answer(session.id, delegation.id, USER, { confirmed: true })).toThrow(
    'Capability delegation is disabled',
  );
  expect(() => schedules.answer(session.id, pending.proposalId, USER, { confirmed: true })).toThrow(
    'Capability schedules is disabled',
  );
  expect(() => schedules.runNow(USER, saved.scheduleId!)).toThrow(
    'Capability schedules is disabled',
  );
  expect(db.listSessions().filter((s) => s.workspaceId === 'work:test')).toHaveLength(0);
  // Disabling work does not prevent rejecting a pending proposal.
  expect(delegations.answer(session.id, delegation.id, USER, { confirmed: false })?.status).toBe(
    'answered',
  );
  expect(schedules.answer(session.id, pending.proposalId, USER, { confirmed: false })?.status).toBe(
    'answered',
  );
});

it('allows everything by default and does not block other workspaces', async () => {
  const { services, session } = await start();
  const { db, delegations } = services;
  expect(db.getWorkspaceCapabilities('work:test')).toMatchObject({
    delegation: true,
    schedules: true,
  });
  const status = await services.nodes.onAgentRequest!('home', {
    sessionId: session.piSessionId!,
    op: 'delegation.status',
    args: {},
  });
  expect(status).toMatchObject({ status: 200 });
  expect(delegations.create(USER, session, { workspace: 'work:test', task: 'x' }).status).toBe(
    'pending_approval',
  );
});

it('stops timed schedule runs and approved delegations that dispatch after the policy changed', async () => {
  const { services, session } = await start();
  const { db, delegations, schedules } = services;
  const proposal = schedules.propose(
    USER,
    session,
    { workspace: 'work:test', prompt: 'x', cron: '0 9 * * *' },
    (ref) => db.getWorkspace(ref),
  );
  const { scheduleId } = schedules.answer(session.id, proposal.proposalId, USER, {
    confirmed: true,
  })!;
  const delegation = delegations.create(USER, session, { workspace: 'work:test', task: 'x' });
  // Approved while allowed, but not yet dispatched (as when the node was slow).
  db.raw.prepare("UPDATE delegations SET status='running' WHERE id=?").run(delegation.id);
  db.patchWorkspaceCapabilities(session.workspaceId, { delegation: false, schedules: false });

  // A timed run (not manual) does not throw: it records a failed run and pauses the schedule.
  const schedule = schedules.get(USER, scheduleId!);
  const run = (schedules as any).start(schedule, Date.now(), undefined, false);
  expect(run.status).toBe('failed');
  expect(run.result).toContain('Capability schedules is disabled');
  expect(schedules.get(USER, scheduleId!).status).toBe('paused');

  await (delegations as any).dispatch(delegation.id);
  const failed = delegations.get(USER, delegation.id);
  expect(failed.status).toBe('failed');
  expect(failed.result).toContain('Capability delegation is disabled');
  expect(db.listSessions().filter((s) => s.workspaceId === 'work:test')).toHaveLength(0);
});

it('refuses user-made schedules that would run in a project with schedules disabled', async () => {
  const { services } = await start();
  const { db, schedules } = services;
  db.patchWorkspaceCapabilities('home:chats', { schedules: false });
  expect(() =>
    schedules.create(USER, { workspace: 'home:chats', prompt: 'x', cron: '0 9 * * *' }, (ref) =>
      db.getWorkspace(ref),
    ),
  ).toThrow('Capability schedules is disabled');
  // Other workspaces are unaffected.
  const other = schedules.create(
    USER,
    { workspace: 'work:test', prompt: 'x', cron: '0 9 * * *' },
    (ref) => db.getWorkspace(ref),
  );
  expect(other.workspaceId).toBe('work:test');
});
