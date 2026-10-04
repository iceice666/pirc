import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, expect, it, spyOn } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { formatTime, nextFire } from '../src/daemon/schedules.js';
import { headers, promptSession, startCluster, waitFor } from './helpers.js';

const USER = 'test@example.com';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A chat node `home` and directory nodes `work` and `lab`. */
async function start(daemon: Parameters<typeof startCluster>[1] = {}) {
  const cluster = await startCluster(
    [{ nodeId: 'home', chat: true }, { nodeId: 'work' }, { nodeId: 'lab' }],
    daemon,
  );
  cleanup.push(() => cluster.close());
  const { services } = cluster;
  await waitFor(
    () =>
      ['home:chats', 'lab:test', 'work:test'].every((id) =>
        services.db.listWorkspaces().some((workspace) => workspace.id === id),
      ),
    true,
  );
  services.models.set({
    providers: {
      gw: {
        api: 'openai-chat',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: [{ id: 'model-a', contextWindow: 100_000, maxTokens: 1000 }],
      },
    } as any,
  });
  return cluster;
}

const api = async (app: FastifyInstance, method: string, url: string, payload?: unknown) =>
  await app.inject({
    method: method as 'GET',
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const snapshot = async (app: FastifyInstance, sessionId: string) =>
  (await api(app, 'GET', `/api/sessions/${sessionId}/snapshot`)).json();
const reply = (text: string) => {
  const [, kind, body] = /^gateway:(ok|error) (.*)$/s.exec(text) ?? [];
  if (!kind) throw new Error(`not a gateway reply: ${text}`);
  return { ok: kind === 'ok', body: JSON.parse(body!) };
};
const answer = (
  app: FastifyInstance,
  sessionId: string,
  generation: number,
  interactionId: string,
  confirmed: boolean,
) =>
  api(app, 'POST', `/api/sessions/${sessionId}/interactions/${interactionId}/answer`, {
    clientId: 'browser',
    generation,
    answer: { confirmed },
  });
/** ISO wall time `ms` from now in UTC, without an offset (read in the schedule's zone). */
const soon = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 19);
const runsOf = async (app: FastifyInstance, id: string) =>
  (await api(app, 'GET', `/api/schedules/${id}`)).json().runs as any[];

it('computes fire times in the schedule time zone, across DST', () => {
  const spec = { cron: '30 9 * * 1-5', runAt: null, timezone: 'Asia/Taipei' };
  // Tuesday 2026-09-29 10:00 in Taipei: the next is Wednesday 09:30 (01:30Z).
  expect(new Date(nextFire(spec, Date.parse('2026-09-29T02:00:00Z'))!).toISOString()).toBe(
    '2026-09-30T01:30:00.000Z',
  );
  const ny = { cron: '0 9 * * *', runAt: null, timezone: 'America/New_York' };
  expect(new Date(nextFire(ny, Date.parse('2026-03-07T15:00:00Z'))!).toISOString()).toBe(
    '2026-03-08T13:00:00.000Z',
  );
  expect(formatTime(Date.parse('2026-09-30T01:30:00Z'), 'Asia/Taipei')).toBe(
    '2026-09-30 09:30 (Asia/Taipei)',
  );
  expect(nextFire({ cron: null, runAt: 1000, timezone: 'UTC' }, 2000)).toBeNull();
});

it('lets the user manage schedules and runs one on time in a new session with its model', async () => {
  const { app, services } = await start();
  const created = await api(app, 'POST', '/api/schedules', {
    workspaceId: 'work:test',
    title: 'Nightly check',
    prompt: 'Run the test suite.',
    at: soon(1500),
    timezone: 'UTC',
    model: { provider: 'gw', id: 'model-a' },
    thinking: 'high',
  });
  expect(created.statusCode).toBe(201);
  const schedule = created.json().schedule;
  expect(schedule).toMatchObject({
    title: 'Nightly check',
    status: 'active',
    cron: null,
    workspace: { id: 'work:test', node: 'work', online: true },
    lastRun: null,
  });

  // Invalid input never becomes a schedule.
  for (const [payload, message] of [
    [{ cron: '0 9 * *' }, 'cron needs 5 fields'],
    [{ cron: '0 9 * * * *' }, 'cron needs 5 fields'],
    [{ cron: '61 9 * * *' }, 'Invalid cron'],
    [{ cron: '0 9 * * *', timezone: 'Mars/Base' }, 'Unknown time zone'],
    [{ at: '2020-01-01T00:00' }, 'is in the past'],
    [{ cron: '0 9 * * *', at: soon(60_000) }, 'not both'],
    [{ cron: '0 9 * * *', model: { provider: 'gw', id: 'nope' } }, 'Unknown model'],
    [{}, 'Give cron'],
  ] as const) {
    const response = await api(app, 'POST', '/api/schedules', {
      workspaceId: 'work:test',
      prompt: 'x',
      ...payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(message);
  }

  // It fires on time: a new session named after it gets the prompt, on its model.
  await waitFor(async () => (await runsOf(app, schedule.id))[0]?.status, 'completed', 8000);
  const [run] = await runsOf(app, schedule.id);
  expect(run.result).toBe(`done:${run.id}:scheduled-run`);
  expect(run.session).toBe('Nightly check');
  const session = services.db.getSession(run.sessionId);
  expect([session.workspaceId, session.ownerUser]).toEqual(['work:test', USER]);
  const state = await snapshot(app, run.sessionId);
  const pushed = state.history.find((m: any) => m.customType === 'scheduled-run');
  expect(pushed.details).toEqual({
    scheduleId: schedule.id,
    runId: run.id,
    title: 'Nightly check',
  });
  expect(pushed.content).toContain('Run the test suite.');
  expect(state.history.some((m: any) => m.role === 'user')).toBe(false);
  expect(state.agent).toMatchObject({
    model: { provider: 'gw', id: 'model-a' },
    thinkingLevel: 'high',
  });
  // A one-shot is done afterwards.
  expect((await api(app, 'GET', `/api/schedules/${schedule.id}`)).json().schedule).toMatchObject({
    status: 'done',
    nextRunAt: null,
  });
  // Scheduled-run sessions cannot schedule more.
  expect(services.schedules.isRunSession(run.sessionId)).toBe(true);

  // Edit into a repeating one, pause, resume, run now, delete.
  const edited = (
    await api(app, 'PATCH', `/api/schedules/${schedule.id}`, {
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Taipei',
    })
  ).json().schedule;
  expect(edited).toMatchObject({ status: 'active', cron: '0 9 * * 1-5', runAt: null });
  expect(edited.nextRunAt).toBe(nextFire(edited, Date.now()));
  expect(
    (await api(app, 'PATCH', `/api/schedules/${schedule.id}`, { status: 'paused' })).json().schedule
      .status,
  ).toBe('paused');
  expect(
    (await api(app, 'PATCH', `/api/schedules/${schedule.id}`, { status: 'active' })).json().schedule
      .status,
  ).toBe('active');
  const manual = await api(app, 'POST', `/api/schedules/${schedule.id}/run`, {});
  expect(manual.statusCode).toBe(202);
  await waitFor(async () => (await runsOf(app, schedule.id))[0]?.status, 'completed');
  expect((await runsOf(app, schedule.id)).length).toBe(2);
  expect((await api(app, 'DELETE', `/api/schedules/${schedule.id}`)).statusCode).toBe(204);
  expect((await api(app, 'GET', `/api/schedules/${schedule.id}`)).statusCode).toBe(404);
  expect((await api(app, 'GET', '/api/schedules')).json().schedules).toEqual([]);
}, 20_000);

it('records missed and skipped runs, and runs a missed one only when the user allows it', async () => {
  const { app, services, nodes } = await start();
  // Hourly, half an hour away from now: its latest fire time is always long past.
  const minute = (new Date().getUTCMinutes() + 30) % 60;
  const create = async (prompt: string) =>
    (
      await api(app, 'POST', '/api/schedules', {
        workspaceId: 'work:test',
        prompt,
        cron: `${minute} * * * *`,
        timezone: 'UTC',
      })
    ).json().schedule.id as string;
  const due = (id: string, at: number) => {
    services.db.raw.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(at, id);
    services.schedules.tick();
  };

  // The gateway slept through several fire times: one missed run, for the latest, and nothing runs.
  const slept = await create('Summarize the logs.');
  due(slept, Date.now() - 60 * 60_000);
  let [missed, ...rest] = await runsOf(app, slept);
  expect(rest).toEqual([]);
  expect(missed).toMatchObject({ status: 'missed', sessionId: null });
  expect(Date.now() - missed.dueAt).toBeLessThan(60 * 60_000);
  expect(Date.now() - missed.dueAt).toBeGreaterThan(20 * 60_000);
  const schedule = services.schedules.get(USER, slept);
  expect(schedule.nextRunAt).toBeGreaterThan(Date.now());
  // It waits for the user.
  const attention = async () =>
    ((await api(app, 'GET', '/api/schedules')).json().schedules as any[]).find(
      (item) => item.id === slept,
    ).attention;
  expect(await attention()).toBe(1);
  // Allowing it runs it now.
  const allowed = await api(app, 'POST', `/api/schedules/${slept}/run`, { runId: missed.id });
  expect(allowed.statusCode).toBe(202);
  await waitFor(async () => (await runsOf(app, slept))[0]?.status, 'completed');
  expect(await attention()).toBe(0);
  [missed] = await runsOf(app, slept);
  expect(missed.result).toBe(`done:${missed.id}:scheduled-run`);
  // It cannot be allowed twice.
  expect(
    (await api(app, 'POST', `/api/schedules/${slept}/run`, { runId: missed.id })).statusCode,
  ).toBe(404);

  // A run that waits for the user blocks the next fire time, which is skipped.
  const careful = await create('Please ask the user before you push.');
  due(careful, Date.now());
  await waitFor(async () => (await runsOf(app, careful))[0]?.status, 'waiting_input');
  due(careful, Date.now());
  const [skipped, waiting] = await runsOf(app, careful);
  expect(skipped).toMatchObject({ status: 'skipped' });
  expect(skipped.result).toContain(waiting.id);
  expect((await api(app, 'POST', `/api/schedules/${careful}/run`, {})).statusCode).toBe(409);
  const lease = await api(app, 'POST', `/api/sessions/${waiting.sessionId}/control/acquire`, {
    clientId: 'browser',
  });
  const [dialog] = (await snapshot(app, waiting.sessionId)).interactions;
  await answer(app, waiting.sessionId, lease.json().lease.generation, dialog.id, true);
  await waitFor(
    async () => (await runsOf(app, careful)).find((r) => r.id === waiting.id)?.status,
    'completed',
  );

  // The agent loop fails before any answer (no model): the run failed, it did not succeed.
  const broken = await create('Please crash the loop.');
  due(broken, Date.now());
  await waitFor(async () => (await runsOf(app, broken))[0]?.status, 'failed');
  expect((await runsOf(app, broken))[0].result).toBe(
    'The run failed: Agent loop crashed: No model configured',
  );

  // Its node is offline at the fire time: missed; the user may let it go.
  await nodes[1]!.close();
  await waitFor(() => services.nodes.list().length, 2);
  due(careful, Date.now());
  const [offline] = await runsOf(app, careful);
  expect(offline.status).toBe('missed');
  expect(offline.result).toContain('work was offline');
  expect((await api(app, 'POST', `/api/schedules/${careful}/run`, {})).statusCode).toBe(503);
  const dismissed = await api(app, 'POST', `/api/schedules/${careful}/runs/${offline.id}/dismiss`);
  expect(dismissed.json().run.status).toBe('dismissed');
}, 20_000);

it('lets agents propose schedules the user approves, within their scope', async () => {
  const { app, services } = await start();
  const chat = await promptSession(app, services.events, headers, 'home:chats');

  // The assistant proposes one in a directory workspace; nothing exists until the user approves.
  const proposed = reply(
    await chat.ask(
      `gateway schedule.create ${JSON.stringify({
        workspace: 'work:test',
        prompt: 'Check the CI dashboard.',
        title: 'CI check',
        cron: '0 9 * * 1-5',
        timezone: 'Asia/Taipei',
      })}`,
    ),
  ).body;
  expect(proposed).toMatchObject({ status: 'pending_approval', title: 'CI check' });
  expect(services.schedules.list(USER)).toEqual([]);
  const [confirmation] = (await snapshot(app, chat.sessionId)).interactions;
  expect(confirmation).toMatchObject({
    id: proposed.proposalId,
    kind: 'confirm',
    request: { title: 'Schedule this task?', confirmLabel: 'Schedule' },
  });
  expect(confirmation.request.message).toContain('Where: Test on work');
  expect(confirmation.request.message).toContain('When: cron "0 9 * * 1-5" (Asia/Taipei)');
  expect(confirmation.request.message).not.toContain('Model:');
  expect(confirmation.request.message).toContain('Check the CI dashboard.');

  // Only the user picks a schedule's model.
  expect(
    reply(
      await chat.ask(
        'gateway schedule.create {"prompt":"x","cron":"0 9 * * *","model":"gw/model-a"}',
      ),
    ).body,
  ).toMatchObject({ code: 'invalid_input' });

  // Mistakes come back at once.
  expect(
    reply(await chat.ask('gateway schedule.create {"prompt":"x","cron":"bad"}')).body,
  ).toMatchObject({ code: 'invalid_input' });

  const approved = await answer(app, chat.sessionId, chat.generation, proposed.proposalId, true);
  expect(approved.json()).toMatchObject({ status: 'answered', scheduleId: expect.any(String) });
  const id = approved.json().scheduleId as string;
  expect(services.schedules.get(USER, id)).toMatchObject({
    workspaceId: 'work:test',
    createdBySession: chat.sessionId,
    model: null,
  });
  expect(
    (await answer(app, chat.sessionId, chat.generation, proposed.proposalId, true)).statusCode,
  ).toBe(409);

  // A change is a proposal too; declined, it leaves the schedule alone.
  const change = reply(
    await chat.ask(`gateway schedule.update ${JSON.stringify({ id, cron: '0 10 * * *' })}`),
  ).body;
  const [changeDialog] = (await snapshot(app, chat.sessionId)).interactions;
  expect(changeDialog.request.title).toBe('Change the schedule “CI check”?');
  await answer(app, chat.sessionId, chat.generation, change.proposalId, false);
  expect(services.schedules.get(USER, id).cron).toBe('0 9 * * 1-5');

  // Pausing needs no approval; the list shows it.
  expect(reply(await chat.ask(`gateway schedule.pause {"id":"${id}"}`)).body).toMatchObject({
    status: 'paused',
  });
  const listed = reply(await chat.ask('gateway schedule.list {}')).body;
  expect(listed.timezone).toBe('UTC');
  expect(listed.schedules).toEqual([
    expect.objectContaining({ id, title: 'CI check', status: 'paused', workspace: 'Test on work' }),
  ]);

  // A coding session schedules only in its own workspace, and sees only those.
  const coding = await promptSession(app, services.events, headers, 'work:test');
  expect(reply(await coding.ask('gateway schedule.list {}')).body.schedules).toHaveLength(1);
  expect(
    reply(
      await coding.ask(
        'gateway schedule.create {"workspace":"lab:test","prompt":"x","cron":"0 9 * * *"}',
      ),
    ).body,
  ).toMatchObject({ status: 403 });
  const lab = await promptSession(app, services.events, headers, 'lab:test');
  expect(reply(await lab.ask('gateway schedule.list {}')).body.schedules).toEqual([]);
  expect(reply(await lab.ask(`gateway schedule.delete {"id":"${id}"}`)).body).toMatchObject({
    status: 404,
  });
  const own = reply(
    await coding.ask('gateway schedule.create {"prompt":"Lint.","cron":"0 9 * * *"}'),
  ).body;
  const [ownDialog] = (await snapshot(app, coding.sessionId)).interactions;
  expect(ownDialog.id).toBe(own.proposalId);
  expect(ownDialog.request.message).toContain('Where: Test on work');

  // A scheduled run's session cannot schedule more.
  services.schedules.resume(USER, id);
  services.db.raw.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(Date.now(), id);
  services.schedules.tick();
  await waitFor(async () => (await runsOf(app, id))[0]?.status, 'completed');
  const [run] = await runsOf(app, id);
  expect(services.schedules.isRunSession(run.sessionId)).toBe(true);
  // Its agent may not create, resume or start schedules (here: a session marked as one).
  services.db.raw
    .prepare('UPDATE schedule_runs SET session_id=? WHERE id=?')
    .run(coding.sessionId, run.id);
  for (const op of [
    'schedule.create {"prompt":"Again.","cron":"* * * * *"}',
    `schedule.resume {"id":"${id}"}`,
    `schedule.run {"id":"${id}"}`,
  ])
    expect(reply(await coding.ask(`gateway ${op}`)).body).toMatchObject({
      status: 403,
      message: 'A scheduled run cannot create, change, resume or start schedules',
    });
  expect(reply(await coding.ask(`gateway schedule.pause {"id":"${id}"}`)).ok).toBe(true);
}, 30_000);

it('keeps a long run result whole and lets agents page through it', async () => {
  const { app, services } = await start();
  const created = await api(app, 'POST', '/api/schedules', {
    workspaceId: 'work:test',
    title: 'Report',
    prompt: 'Write a report.',
    at: soon(1500),
    timezone: 'UTC',
  });
  const schedule = created.json().schedule;
  await waitFor(async () => (await runsOf(app, schedule.id))[0]?.status, 'completed', 8000);
  const [{ id }] = await runsOf(app, schedule.id);

  // A longer answer than the run list or one chunk holds: every part is distinct.
  const long = Array.from({ length: 3000 }, (_, i) => `line ${String(i).padStart(4, '0')}\n`).join(
    '',
  );
  services.db.raw.prepare("UPDATE schedule_runs SET status='running' WHERE id=?").run(id);
  (services.schedules as any).finish(id, 'completed', long);
  expect(services.schedules.getRun(USER, id).result).toBe(long);

  // The run list stays small and says how long the whole is.
  const [listed] = await runsOf(app, schedule.id);
  expect(listed.result.length).toBeLessThanOrEqual(4000);
  expect(listed.resultChars).toBe(30_000);

  const chat = await promptSession(app, services.events, headers, 'home:chats');
  const result = async (args: object) =>
    reply(await chat.ask(`gateway schedule.result ${JSON.stringify(args)}`)).body;
  const [brief] = reply(await chat.ask('gateway schedule.list {}')).body.schedules;
  expect(brief.lastRun).toMatchObject({ id, resultChars: 30_000 });
  let text = '';
  let offset: number | undefined = 0;
  const chunks: any[] = [];
  while (offset !== undefined) {
    const chunk: any = await result({ id, offset });
    chunks.push(chunk);
    text += chunk.result;
    offset = chunk.nextOffset;
  }
  expect(text).toBe(long);
  expect(chunks.map((c) => [c.resultOffset, c.nextOffset])).toEqual([
    [0, 12_000],
    [12_000, 24_000],
    [24_000, undefined],
  ]);
  expect((await result({ id, offset: 30_001 })).code).toBe('invalid_input');
  // Only sessions that may manage the schedule read its runs.
  const lab = await promptSession(app, services.events, headers, 'lab:test');
  expect(reply(await lab.ask(`gateway schedule.result {"id":"${id}"}`)).body).toMatchObject({
    status: 404,
  });
}, 30_000);

it('lets proposals lapse', async () => {
  const { app, services } = await start({ delegationTtlMs: 300 });
  const chat = await promptSession(app, services.events, headers, 'home:chats');
  const { proposalId } = reply(
    await chat.ask('gateway schedule.create {"prompt":"Later.","cron":"0 9 * * *"}'),
  ).body;
  await waitFor(async () => (await snapshot(app, chat.sessionId)).interactions.length, 0, 5000);
  expect((await answer(app, chat.sessionId, chat.generation, proposalId, true)).statusCode).toBe(
    409,
  );
  expect(services.schedules.list(USER)).toEqual([]);
});

it('pushes the runs each schedule asks for, to the places the user subscribed', async () => {
  const { app, services } = await start();
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push(new URL(request.url).pathname);
      return new Response(null, { status: 201 });
    },
  });
  cleanup.push(() => server.stop(true));
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };

  const info = (await api(app, 'GET', '/api/push')).json();
  expect(info.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  expect(info.subscriptions).toEqual([]);
  const subscribed = await api(app, 'POST', '/api/push/subscriptions', {
    endpoint: `http://127.0.0.1:${server.port}/browser`,
    keys,
    kind: 'web',
    name: 'Test browser',
  });
  expect(subscribed.statusCode).toBe(201);
  expect((await api(app, 'GET', '/api/push')).json().subscriptions).toEqual([
    expect.objectContaining({
      kind: 'web',
      name: 'Test browser',
      host: `127.0.0.1:${server.port}`,
    }),
  ]);
  expect((await api(app, 'POST', '/api/push/test', {})).json() as unknown).toEqual({
    delivered: 1,
  });

  const minute = (new Date().getUTCMinutes() + 30) % 60;
  const create = async (prompt: string, notify: string) =>
    (
      await api(app, 'POST', '/api/schedules', {
        workspaceId: 'work:test',
        prompt,
        cron: `${minute} * * * *`,
        timezone: 'UTC',
        notify,
      })
    ).json().schedule.id as string;
  const fire = async (id: string, status: string) => {
    services.db.raw.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(Date.now(), id);
    services.schedules.tick();
    await waitFor(async () => (await runsOf(app, id))[0]?.status, status);
  };
  const pushes = async (count: number) => {
    await waitFor(() => received.length, count);
    await Bun.sleep(100);
    expect(received).toHaveLength(count);
  };

  const all = await create('Report.', 'all');
  const quiet = await create('Report quietly.', 'problems');
  const silent = await create('Please crash the loop.', 'none');
  expect(services.schedules.get(USER, quiet).notify).toBe('problems');
  await pushes(1); // the test notification

  await fire(all, 'completed');
  await pushes(2);
  await fire(quiet, 'completed');
  await pushes(2); // a success is not a problem
  await fire(silent, 'failed');
  await pushes(2);
  // A problem pushes even when successes do not.
  await api(app, 'PATCH', `/api/schedules/${silent}`, { notify: 'problems' });
  await fire(silent, 'failed');
  await pushes(3);

  expect(
    (
      await api(app, 'DELETE', '/api/push/subscriptions', {
        endpoint: `http://127.0.0.1:${server.port}/browser`,
      })
    ).statusCode,
  ).toBe(204);
  await fire(all, 'completed');
  await Bun.sleep(200);
  expect(received).toHaveLength(3);
}, 20_000);

for (const status of ['running', 'waiting_input'] as const) {
  it(`deleting a ${status} scheduled chat releases the schedule and preserves its history`, async () => {
    const { app, services } = await start();
    const created = await api(app, 'POST', '/api/schedules', {
      workspaceId: 'home:chats',
      title: 'Recurring chat',
      prompt: 'Summarize the logs.',
      cron: '0 0 * * *',
      timezone: 'UTC',
    });
    expect(created.statusCode).toBe(201);
    const schedule = created.json().schedule;
    expect((await api(app, 'POST', `/api/schedules/${schedule.id}/run`, {})).statusCode).toBe(202);
    await waitFor(async () => (await runsOf(app, schedule.id))[0]?.status, 'completed');
    const [history] = await runsOf(app, schedule.id);
    expect((await api(app, 'DELETE', `/api/sessions/${history.sessionId}`)).statusCode).toBe(204);
    expect((await runsOf(app, schedule.id))[0]).toMatchObject({
      id: history.id,
      status: 'completed',
      result: history.result,
      finishedAt: history.finishedAt,
      sessionId: null,
      session: null,
    });

    expect(
      (
        await api(app, 'PATCH', `/api/schedules/${schedule.id}`, {
          prompt:
            status === 'running' ? 'Hold scheduled run.' : 'Please ask the user before proceeding.',
        })
      ).statusCode,
    ).toBe(200);
    expect((await api(app, 'POST', `/api/schedules/${schedule.id}/run`, {})).statusCode).toBe(202);
    await waitFor(async () => {
      const [run] = await runsOf(app, schedule.id);
      if (run.status !== status || !run.sessionId) return false;
      // The scheduler records running before dispatch; wait for the real agent too.
      const snap = await snapshot(app, run.sessionId);
      return snap.history.some((m: any) => m.customType === 'scheduled-run');
    }, true);
    const [active] = await runsOf(app, schedule.id);
    expect((await api(app, 'POST', `/api/schedules/${schedule.id}/run`, {})).statusCode).toBe(409);
    expect((await api(app, 'DELETE', `/api/sessions/${active.sessionId}`)).statusCode).toBe(204);
    const [deleted] = await runsOf(app, schedule.id);
    expect(deleted).toMatchObject({
      id: active.id,
      status: 'failed',
      result: 'The chat was deleted.',
      sessionId: null,
      session: null,
    });
    expect(deleted.finishedAt).toBeGreaterThanOrEqual(active.startedAt);
    expect(services.schedules.get(USER, schedule.id)).toMatchObject({
      status: 'active',
      nextRunAt: schedule.nextRunAt,
    });
    expect((await api(app, 'DELETE', `/api/sessions/${active.sessionId}`)).statusCode).toBe(204);
    expect((await runsOf(app, schedule.id))[0]).toEqual(deleted);

    await api(app, 'PATCH', `/api/schedules/${schedule.id}`, { prompt: 'Continue normally.' });
    expect((await api(app, 'POST', `/api/schedules/${schedule.id}/run`, {})).statusCode).toBe(202);
    await waitFor(async () => (await runsOf(app, schedule.id))[0]?.status, 'completed');
    services.db.raw
      .prepare('UPDATE schedules SET next_run_at=? WHERE id=?')
      .run(Date.now(), schedule.id);
    services.schedules.tick();
    await waitFor(async () => (await runsOf(app, schedule.id))[0]?.status, 'completed');
    const runs = await runsOf(app, schedule.id);
    expect(runs).toHaveLength(4);
    expect(runs.map((run) => run.status)).toEqual([
      'completed',
      'completed',
      'failed',
      'completed',
    ]);
  }, 20_000);
}

it('does not revive a deleted scheduled chat when an older progress snapshot arrives', async () => {
  const { app, services } = await start();
  const created = await api(app, 'POST', '/api/schedules', {
    workspaceId: 'home:chats',
    prompt: 'Please ask the user before proceeding.',
    cron: '0 0 * * *',
    timezone: 'UTC',
  });
  const schedule = created.json().schedule;
  await api(app, 'POST', `/api/schedules/${schedule.id}/run`, {});
  await waitFor(async () => (await runsOf(app, schedule.id))[0]?.status, 'waiting_input');
  const [run] = await runsOf(app, schedule.id);
  const session = services.db.getSession(run.sessionId);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let fetched!: () => void;
  const ready = new Promise<void>((resolve) => (fetched = resolve));
  const original = services.nodes.request.bind(services.nodes);
  const request = spyOn(services.nodes, 'request').mockImplementation(async (...args) => {
    const response = await original(...args);
    if (args[1].url === `/api/sessions/${encodeURIComponent(session.piSessionId!)}/snapshot`) {
      fetched();
      await held;
    }
    return response;
  });
  try {
    services.db.raw.prepare("UPDATE schedule_runs SET status='running' WHERE id=?").run(run.id);
    const checking = (services.schedules as unknown as { check(id: string): Promise<void> }).check(
      run.id,
    );
    await ready;
    expect((await api(app, 'DELETE', `/api/sessions/${run.sessionId}`)).statusCode).toBe(204);
    release();
    await checking;
    expect((await runsOf(app, schedule.id))[0]).toMatchObject({
      id: run.id,
      status: 'failed',
      result: 'The chat was deleted.',
      sessionId: null,
    });
  } finally {
    release();
    request.mockRestore();
  }
}, 20_000);
