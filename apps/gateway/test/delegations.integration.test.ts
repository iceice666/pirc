import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { defaultAgentCommand } from '../src/config.js';
import { writeAgentConfig, writeRoles } from './agent-harness.js';
import { startFakeLlm } from './fixtures/fake-llm.js';
import { headers, promptSession, startCluster, waitFor, type Cluster } from './helpers.js';

const USER = 'test@example.com';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A chat node `home` and directory nodes `work` and `lab`. */
async function start(daemon: Parameters<typeof startCluster>[1] = {}, agents = {}) {
  const cluster = await startCluster(
    [
      { nodeId: 'home', chat: true, ...agents },
      { nodeId: 'work', ...agents },
      { nodeId: 'lab', ...agents },
    ],
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
  return cluster;
}

const snapshot = async (app: FastifyInstance, sessionId: string) =>
  (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })).json();
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
  app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/interactions/${interactionId}/answer`,
    headers,
    payload: { clientId: 'browser', generation, answer: { confirmed } },
  });
/** Custom messages of a session's history. */
const pushed = async (app: FastifyInstance, sessionId: string, customType: string) =>
  ((await snapshot(app, sessionId)).history as any[]).filter(
    (message) => message.role === 'custom' && message.customType === customType,
  );
/**
 * The chat got its `count`-th delegation update and the (fake) assistant ran
 * on it to the end, so it takes prompts again. Returns that update.
 */
async function heard(app: FastifyInstance, chat: string, count: number) {
  await waitFor(async () => (await pushed(app, chat, 'assistant-delegation-update')).length, count);
  await waitFor(async () => {
    const state = await snapshot(app, chat);
    const last = state.history.at(-1);
    return (
      last?.role === 'assistant' &&
      String(last.content?.[0]?.text).endsWith(':assistant-delegation-update') &&
      state.run?.status === 'succeeded'
    );
  }, true);
  return (await pushed(app, chat, 'assistant-delegation-update'))[count - 1];
}

it('asks the user, runs the task in a new session and reports back, then follows up', async () => {
  const { app, services } = await start();
  const chat = await promptSession(app, services.events, headers, 'home:chats');

  const context = reply(await chat.ask('gateway assistant.context {}')).body;
  expect(context.workspaces).toEqual(
    expect.arrayContaining([
      {
        id: 'work:test',
        name: 'Test',
        node: 'work',
        online: true,
        roles: [expect.objectContaining({ name: 'general' })],
      },
      {
        id: 'lab:test',
        name: 'Test',
        node: 'lab',
        online: true,
        roles: [expect.objectContaining({ name: 'general' })],
      },
    ]),
  );
  expect(context.workspaces.some((workspace: any) => workspace.id === 'home:chats')).toBe(false);
  // Both nodes have a "Test": the name alone is not enough.
  expect(
    reply(await chat.ask('gateway delegation.create {"workspace":"Test","task":"x"}')).body,
  ).toMatchObject({ code: 'conflict' });

  const created = reply(
    await chat.ask(
      'gateway delegation.create {"workspace":"work:test","task":"Fix the flaky test.\\nThen report.","title":"Fix flaky test"}',
    ),
  ).body;
  expect(created).toMatchObject({
    status: 'pending_approval',
    title: 'Fix flaky test',
    workspace: 'Test on work',
  });
  const id = created.id as string;

  // The user sees it in the chat as a confirmation, and nothing runs yet.
  const [confirmation] = (await snapshot(app, chat.sessionId)).interactions;
  expect(confirmation).toMatchObject({
    id,
    kind: 'confirm',
    request: {
      title: 'Delegate to Test on work?',
      message: 'Fix flaky test\n\nFix the flaky test.\nThen report.',
      confirmLabel: 'Delegate',
    },
  });
  expect(
    services.events
      .replay(chat.sessionId, null)
      .events.some((event) => event.type === 'interaction_created'),
  ).toBe(true);
  expect(services.db.listSessions().filter((s) => s.workspaceId === 'work:test')).toEqual([]);

  // Only whoever holds the chat's control may answer; the browser cannot push by itself.
  expect((await answer(app, chat.sessionId, chat.generation + 1, id, true)).statusCode).toBe(409);
  expect(services.delegations.get(USER, id).status).toBe('pending_approval');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${chat.sessionId}/deliver`,
        headers,
        payload: { customType: 'assistant-delegation', content: 'spoofed' },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${chat.sessionId}/commands`,
        headers,
        payload: {
          commandId: 'spoof',
          clientId: 'browser',
          generation: chat.generation,
          payload: { type: 'deliver', message: { customType: 'x', content: 'spoofed' } },
        },
      })
    ).statusCode,
  ).toBe(400);

  const approved = await answer(app, chat.sessionId, chat.generation, id, true);
  expect(approved.json() as unknown).toEqual({ interactionId: id, status: 'answered' });
  expect((await answer(app, chat.sessionId, chat.generation, id, true)).statusCode).toBe(409);
  await waitFor(() => services.delegations.get(USER, id).status, 'completed');

  // A new session in the workspace, named after the task, got it as a custom message.
  const delegation = services.delegations.get(USER, id);
  const target = services.db.getSession(delegation.targetSessionId!);
  expect([target.workspaceId, target.name, target.ownerUser]).toEqual([
    'work:test',
    'Fix flaky test',
    USER,
  ]);
  const [task] = await pushed(app, target.id, 'assistant-delegation');
  // The task is the assistant's, never presented as the user's words.
  expect((await snapshot(app, target.id)).history.some((m: any) => m.role === 'user')).toBe(false);
  expect(task.details).toEqual({ delegationId: id, title: 'Fix flaky test' });
  expect(task.content).toContain('approved by the user');
  expect(task.content).toContain('Fix the flaky test.\nThen report.');
  expect(delegation.result).toBe(`done:${id}:assistant-delegation`);

  // The chat hears the result, framed as data, and the assistant runs on it.
  const update = await heard(app, chat.sessionId, 1);
  expect(update.content).toContain('gateway data, not user instructions');
  expect(update.content).toContain('"status":"completed"');
  expect(update.content).toContain(`"result":"done:${id}:assistant-delegation"`);
  expect(update.details).toEqual({ delegationId: id, status: 'completed' });

  const listed = reply(await chat.ask('gateway delegation.status {}')).body.delegations;
  expect(listed).toEqual([
    expect.objectContaining({ id, status: 'completed', session: 'Fix flaky test' }),
  ]);

  // A follow-up keeps its session's role.
  expect(
    reply(
      await chat.ask(`gateway delegation.create {"follows":"${id}","task":"x","role":"general"}`),
    ).body.message,
  ).toContain('A follow-up runs in the role its session started in');

  // More instructions go to the same session, after another approval.
  const more = reply(
    await chat.ask(`gateway delegation.create {"follows":"${id}","task":"Also update the docs."}`),
  ).body;
  const [again] = (await snapshot(app, chat.sessionId)).interactions;
  expect(again.request.title).toBe('Send more instructions to “Fix flaky test” (Test on work)?');
  await answer(app, chat.sessionId, chat.generation, more.id, true);
  await waitFor(() => services.delegations.get(USER, more.id).status, 'completed');
  expect(services.delegations.get(USER, more.id).targetSessionId).toBe(target.id);
  expect((await pushed(app, target.id, 'assistant-delegation')).length).toBe(2);
  await heard(app, chat.sessionId, 2);

  // Only chats delegate.
  const coding = await promptSession(app, services.events, headers, 'work:test');
  expect(
    reply(await coding.ask('gateway delegation.create {"workspace":"lab:test","task":"x"}')).body,
  ).toMatchObject({ status: 403 });
}, 30_000);

it('runs the task in the role the assistant picks, on the model only the user picks', async () => {
  const { app, services } = await start();
  services.models.set({
    providers: {
      gw: {
        api: 'openai-chat',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: [
          { id: 'model-a', contextWindow: 100_000, maxTokens: 1000 },
          { id: 'model-b', contextWindow: 100_000, maxTokens: 1000 },
        ],
      },
    } as any,
  });
  const chat = await promptSession(app, services.events, headers, 'home:chats');

  // The assistant cannot pick a model or thinking level, nor a role the workspace lacks.
  for (const extra of ['"model":"gw/model-a"', '"thinking":"low"'])
    expect(
      reply(
        await chat.ask(`gateway delegation.create {"workspace":"work:test","task":"x",${extra}}`),
      ).body,
    ).toMatchObject({ code: 'invalid_input' });
  expect(
    reply(
      await chat.ask(
        'gateway delegation.create {"workspace":"work:test","task":"x","role":"nope"}',
      ),
    ).body.message,
  ).toContain('No role nope in Test; roles: general');

  const created = reply(
    await chat.ask(
      'gateway delegation.create {"workspace":"work:test","task":"Refactor it.","role":"general"}',
    ),
  ).body;
  expect(created).toMatchObject({ role: 'general' });
  expect(created.model).toBeUndefined();
  const [confirmation] = (await snapshot(app, chat.sessionId)).interactions;
  expect(confirmation.request.title).toBe('Delegate to Test on work as general?');
  expect(confirmation.request.modelChoice).toEqual({ model: null, thinking: null });

  const pick = (model: unknown, thinking: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${chat.sessionId}/interactions/${created.id}/answer`,
      headers,
      payload: {
        clientId: 'browser',
        generation: chat.generation,
        answer: { confirmed: true, model, thinking },
      },
    });
  // A bad pick leaves it waiting for a good one.
  expect((await pick({ provider: 'gw', id: 'nope' }, 'high')).statusCode).toBe(400);
  expect((await pick('gw/model-b', 'loud')).statusCode).toBe(400);
  expect(services.delegations.get(USER, created.id).status).toBe('pending_approval');

  expect((await pick({ provider: 'gw', id: 'model-b' }, 'high')).statusCode).toBe(200);
  await waitFor(() => services.delegations.get(USER, created.id).status, 'completed');
  const delegation = services.delegations.get(USER, created.id);
  expect([delegation.model, delegation.thinking]).toEqual([
    { provider: 'gw', id: 'model-b' },
    'high',
  ]);
  expect((await snapshot(app, delegation.targetSessionId!)).agent).toMatchObject({
    model: { provider: 'gw', id: 'model-b' },
    thinkingLevel: 'high',
  });

  // The default stays the default.
  const second = reply(
    await chat.ask('gateway delegation.create {"workspace":"lab:test","task":"Again."}'),
  ).body;
  await app.inject({
    method: 'POST',
    url: `/api/sessions/${chat.sessionId}/interactions/${second.id}/answer`,
    headers,
    payload: {
      clientId: 'browser',
      generation: chat.generation,
      answer: { confirmed: true, model: null, thinking: null },
    },
  });
  await waitFor(() => services.delegations.get(USER, second.id).status, 'completed');
  expect(services.delegations.get(USER, second.id).model).toBeNull();
}, 30_000);

it('keeps a long result whole and lets the chat page through it', async () => {
  const { app, services } = await start();
  const chat = await promptSession(app, services.events, headers, 'home:chats');
  const id = reply(
    await chat.ask('gateway delegation.create {"workspace":"work:test","task":"Write a report."}'),
  ).body.id as string;
  await answer(app, chat.sessionId, chat.generation, id, true);
  await waitFor(() => services.delegations.get(USER, id).status, 'completed');
  await heard(app, chat.sessionId, 1);

  // A later answer, longer than one chunk or the update message: every part is distinct.
  const long = Array.from({ length: 3000 }, (_, i) => `line ${String(i).padStart(4, '0')}\n`).join(
    '',
  );
  expect(long.length).toBe(30_000);
  services.db.raw
    .prepare("UPDATE delegations SET status='running', notified_status=NULL WHERE id=?")
    .run(id);
  (services.delegations as any).finish(id, 'completed', long);
  expect(services.delegations.get(USER, id).result).toBe(long);

  // The chat's update carries the start and says how to read on.
  const update = await heard(app, chat.sessionId, 2);
  expect(update.content).toContain('line 0000');
  expect(update.content).not.toContain('line 0500');
  expect(update.content).toContain(`delegation_status id=${id} offset=4000`);

  const status = async (args: object) =>
    reply(await chat.ask(`gateway delegation.status ${JSON.stringify(args)}`)).body;
  let text = '';
  let offset: number | undefined = 0;
  const chunks: any[] = [];
  while (offset !== undefined) {
    const brief: any = (await status({ id, offset })).delegations[0];
    chunks.push(brief);
    text += brief.result;
    offset = brief.nextOffset;
  }
  expect(text).toBe(long);
  expect(chunks.map((c) => [c.resultOffset, c.nextOffset, c.resultChars])).toEqual([
    [0, 12_000, 30_000],
    [12_000, 24_000, 30_000],
    [24_000, undefined, 30_000],
  ]);
  // The list stays short.
  const [listed] = (await status({})).delegations;
  expect(listed.result.length).toBeLessThanOrEqual(600);
  expect((await status({ offset: 5 })).code).toBe('invalid_input');
  expect((await status({ id, offset: 30_001 })).code).toBe('invalid_input');
}, 30_000);

it('reports refusals and sessions that wait for the user, and refuses offline workspaces', async () => {
  const { app, services, nodes } = await start();
  const chat = await promptSession(app, services.events, headers, 'home:chats');
  const create = async (task: string) =>
    reply(
      await chat.ask(
        `gateway delegation.create ${JSON.stringify({ workspace: 'work:test', task })}`,
      ),
    ).body.id as string;

  const refused = await create('Delete the old branch.');
  await answer(app, chat.sessionId, chat.generation, refused, false);
  expect(services.delegations.get(USER, refused).status).toBe('rejected');
  expect((await heard(app, chat.sessionId, 1)).content).toContain('"status":"rejected"');

  // The delegated agent stops for the user; the chat is told, and hears again once it is done.
  const careful = await create('Please ask the user before you push.');
  await answer(app, chat.sessionId, chat.generation, careful, true);
  await waitFor(() => services.delegations.get(USER, careful).status, 'waiting_input');
  expect((await heard(app, chat.sessionId, 2)).content).toContain('waiting for the user');
  const target = services.delegations.get(USER, careful).targetSessionId!;
  const lease = await app.inject({
    method: 'POST',
    url: `/api/sessions/${target}/control/acquire`,
    headers,
    payload: { clientId: 'browser' },
  });
  const [dialog] = (await snapshot(app, target)).interactions;
  expect(dialog.request.title).toBe('May I go on?');
  expect(
    (await answer(app, target, lease.json().lease.generation, dialog.id, true)).statusCode,
  ).toBe(200);
  await waitFor(() => services.delegations.get(USER, careful).status, 'completed');
  await heard(app, chat.sessionId, 3);

  await nodes[1]!.close();
  await waitFor(() => services.nodes.list().length, 2);
  expect(
    reply(await chat.ask('gateway delegation.create {"workspace":"work:test","task":"Anything."}'))
      .body,
  ).toMatchObject({ code: 'node_offline' });
}, 30_000);

it('lets approvals lapse and tells the chat', async () => {
  const { app, services } = await start({ delegationTtlMs: 300 });
  const chat = await promptSession(app, services.events, headers, 'home:chats');
  const id = reply(
    await chat.ask('gateway delegation.create {"workspace":"work:test","task":"Later."}'),
  ).body.id as string;
  await waitFor(() => services.delegations.get(USER, id).status, 'expired', 5000);
  expect((await snapshot(app, chat.sessionId)).interactions).toEqual([]);
  expect((await answer(app, chat.sessionId, chat.generation, id, true)).statusCode).toBe(409);
  expect((await heard(app, chat.sessionId, 1)).content).toContain('"status":"expired"');
});

it('delegates end to end between real agents', async () => {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-delegation-e2e-'));
  const configDir = path.join(dir, 'node-config');
  // A role the assistant picks; the node reports it and the coding agent starts in it.
  writeAgentConfig(configDir);
  writeRoles(path.join(configDir, 'roles'), {
    fixer: '---\ndescription: Fixes builds\n---\nFixer role text.\n',
  });
  const saved = {
    config: process.env.PIRC_CONFIG_DIR,
    workspaceMemory: process.env.PIRC_WORKSPACE_MEMORY_DIR,
  };
  process.env.PIRC_CONFIG_DIR = configDir;
  // Keep the agents' workspace memory out of whatever the host uses.
  process.env.PIRC_WORKSPACE_MEMORY_DIR = path.join(dir, 'workspace-memory');
  cleanup.push(() => {
    for (const [name, value] of [
      ['PIRC_CONFIG_DIR', saved.config],
      ['PIRC_WORKSPACE_MEMORY_DIR', saved.workspaceMemory],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const modelsFile = path.join(dir, 'models.json');
  writeFileSync(
    modelsFile,
    JSON.stringify({
      providers: {
        gw: {
          api: 'openai-chat',
          baseUrl: `${llm.url}/v1`,
          apiKey: 'key',
          models: [{ id: 'model-a', contextWindow: 100_000, maxTokens: 1000 }],
        },
      },
      defaultModel: { provider: 'gw', id: 'model-a' },
    }),
  );
  const text = (message: any) =>
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  // The assistant delegates, then reports; the coding agent in the workspace does the work.
  llm.route = (body) => {
    const system = String(body.messages[0].content);
    const last = body.messages.at(-1);
    if (!system.includes("the user's personal assistant")) return { text: 'Build fixed.' };
    if (text(last).includes('Delegation update')) return { text: 'The build is fixed.' };
    if (last.role === 'tool') return { text: 'I asked you to approve it.' };
    return {
      tool: {
        id: 'd1',
        name: 'delegate',
        args: { workspace: 'work:test', task: 'Fix the build.', title: 'Fix build', role: 'fixer' },
      },
    };
  };
  const { app, services } = await start({ modelsFile }, defaultAgentCommand({}));
  const chatId = (
    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'home:chats' },
    })
  ).json().session.id as string;
  const generation = (
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${chatId}/control/acquire`,
      headers,
      payload: { clientId: 'browser' },
    })
  ).json().lease.generation as number;
  await app.inject({
    method: 'POST',
    url: `/api/sessions/${chatId}/commands`,
    headers,
    payload: {
      commandId: 'c1',
      clientId: 'browser',
      generation,
      payload: { type: 'prompt', message: 'Please get the build fixed in Test on work.' },
    },
  });
  await waitFor(async () => (await snapshot(app, chatId)).interactions.length, 1, 15_000);
  const [confirmation] = (await snapshot(app, chatId)).interactions;
  expect(confirmation.request.message).toBe('Fix build\n\nFix the build.');
  expect(confirmation.request.title).toBe('Delegate to Test on work as fixer?');
  await answer(app, chatId, generation, confirmation.id, true);
  await waitFor(() => services.delegations.get(USER, confirmation.id).status, 'completed', 15_000);
  expect(services.delegations.get(USER, confirmation.id).result).toBe('Build fixed.');
  // The coding agent got the task as a message from the assistant, not from the user.
  const coding = llm.requests.find(
    (request) => !String(request.body.messages[0].content).includes('personal assistant'),
  )!;
  expect(text(coding.body.messages.at(-1))).toContain('Fix the build.');
  expect(String(coding.body.messages[0].content)).toContain('## Role: fixer\n');
  expect(String(coding.body.messages[0].content)).toContain('Fixer role text.');
  // The assistant saw the role among the workspace's roles.
  const assistant = llm.requests.find((request) =>
    String(request.body.messages[0].content).includes('personal assistant'),
  )!;
  expect(String(assistant.body.messages[0].content)).toContain('- fixer: Fixes builds');
  // The chat ran on the result.
  await waitFor(
    async () => (await snapshot(app, chatId)).history.at(-1)?.content?.[0]?.text,
    'The build is fixed.',
    15_000,
  );
  expect(text(llm.requests.at(-1)!.body.messages.at(-1))).toContain('Build fixed.');
}, 45_000);
