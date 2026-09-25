import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { buildApp } from '../src/app.js';
import { defaultAgentCommand } from '../src/config.js';
import { writeAgentConfig } from './agent-harness.js';
import { startFakeLlm } from './fixtures/fake-llm.js';
import { headers, testConfig, waitFor } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

it('runs a real pirc agent subprocess end to end through the gateway', async () => {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const configDir = mkdtempSync(path.join(tmpdir(), 'pirc-gw-config-'));
  writeAgentConfig(configDir, llm.url);
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const { app } = await buildApp(testConfig(defaultAgentCommand({})));
  cleanup.push(() => app.close() as Promise<void>);

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
  const generation = lease.json().lease.generation as number;
  llm.push(
    { tool: { id: 'c1', name: 'bash', args: { command: 'echo from-bash' } } },
    { text: 'All done.' },
  );
  const command = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/commands`,
    headers,
    payload: {
      commandId: 'cmd-1',
      clientId: 'browser-1',
      generation,
      payload: { type: 'prompt', message: 'run it' },
    },
  });
  expect(command.statusCode).toBe(202);
  const snapshot = async () =>
    (
      await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    ).json();
  await waitFor(async () => (await snapshot()).run?.status, 'succeeded', 10_000);
  const final = await snapshot();
  expect(final.history.map((m: any) => m.role)).toEqual([
    'user',
    'assistant',
    'toolResult',
    'assistant',
  ]);
  expect(final.history[2].content[0].text).toContain('from-bash');
  expect(final.history.at(-1).content[0].text).toBe('All done.');

  const models = await app.inject({
    method: 'GET',
    url: `/api/models?sessionId=${sessionId}`,
    headers,
  });
  expect(models.json().models.map((m: any) => `${m.provider}/${m.id}`)).toContain(
    'fake/fake-model',
  );
});

it('answers and withdraws agent dialogs through gateway interactions', async () => {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const configDir = mkdtempSync(path.join(tmpdir(), 'pirc-gw-config-'));
  writeAgentConfig(configDir, llm.url);
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const { app } = await buildApp(testConfig(defaultAgentCommand({})));
  cleanup.push(() => app.close() as Promise<void>);
  const sessionId = (
    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'test' },
    })
  ).json().session.id as string;
  const generation = (
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId: 'browser-1' },
    })
  ).json().lease.generation as number;
  const send = (commandId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers,
      payload: { commandId, clientId: 'browser-1', generation, payload },
    });
  const snapshot = async () =>
    (
      await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    ).json();
  llm.push(
    {
      tool: {
        id: 'q',
        name: 'ask_user_question',
        args: {
          questions: [
            {
              question: 'Color?',
              multiSelect: true,
              options: [{ label: 'red' }, { label: 'blue' }],
            },
          ],
        },
      },
    },
    { text: 'noted' },
    { tool: { id: 'q2', name: 'ask_user_question', args: { questions: [{ question: 'Name?' }] } } },
  );
  await send('c1', { type: 'prompt', message: 'ask' });
  await waitFor(async () => (await snapshot()).interactions.length, 1);
  const pending = (await snapshot()).interactions[0];
  expect(pending.request.multiple).toBe(true);
  const answered = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/interactions/${pending.id}/answer`,
    headers,
    payload: {
      clientId: 'browser-1',
      generation,
      answer: { value: 'red, blue', values: ['red', 'blue'] },
    },
  });
  expect(answered.statusCode).toBe(200);
  await waitFor(async () => (await snapshot()).run?.status, 'succeeded', 10_000);
  const result = (await snapshot()).history.find((m: any) => m.role === 'toolResult');
  expect(result.details.answers[0].selected).toEqual(['red', 'blue']);

  await send('c2', { type: 'prompt', message: 'ask again' });
  await waitFor(async () => (await snapshot()).interactions.length, 1);
  await send('c3', { type: 'stop' });
  await waitFor(async () => (await snapshot()).interactions.length, 0, 10_000);
});

async function realAgentSession(llm: ReturnType<typeof startFakeLlm>) {
  const configDir = mkdtempSync(path.join(tmpdir(), 'pirc-gw-config-'));
  writeAgentConfig(configDir, llm.url);
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const { app } = await buildApp(testConfig(defaultAgentCommand({})));
  cleanup.push(() => app.close() as Promise<void>);
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
  const generation = lease.json().lease.generation as number;
  let commands = 0;
  return {
    prompt: (message: string) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/commands`,
        headers,
        payload: {
          commandId: `cmd-${++commands}`,
          clientId: 'browser-1',
          generation,
          payload: { type: 'prompt', message },
        },
      }),
    snapshot: async () =>
      (
        await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
      ).json(),
  };
}

it('reports the final provider error as a failed run with the current model', async () => {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const session = await realAgentSession(llm);
  llm.push({ status: 400, body: '{"error":{"message":"quota exhausted"}}' });
  expect((await session.prompt('hello')).statusCode).toBe(202);
  await waitFor(async () => (await session.snapshot()).run?.status, 'failed', 10_000);
  const final = await session.snapshot();
  expect(final.run.failureReason).toContain('quota exhausted');
  expect(final.history.at(-1)).toMatchObject({ stopReason: 'error' });
  expect(final.agent).toMatchObject({ model: { provider: 'fake', id: 'fake-model' } });
  expect(typeof final.agent.thinkingLevel).toBe('string');
});

it('does not leave a run failed after an automatic retry recovers', async () => {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const session = await realAgentSession(llm);
  llm.push({ status: 503, body: 'overloaded' }, { text: 'Recovered.' });
  expect((await session.prompt('hello')).statusCode).toBe(202);
  await waitFor(async () => (await session.snapshot()).run?.status, 'succeeded', 12_000);
  const final = await session.snapshot();
  expect(final.run.failureReason ?? null).toBeNull();
  expect(final.history.at(-1).content[0].text).toBe('Recovered.');
});

it('titles an unnamed session from the first message and keeps a later user rename', async () => {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const configDir = mkdtempSync(path.join(tmpdir(), 'pirc-gw-config-'));
  writeAgentConfig(configDir, llm.url, { features: { sessionTitle: { enabled: true } } });
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const { app, services } = await buildApp(testConfig(defaultAgentCommand({})));
  cleanup.push(() => app.close() as Promise<void>);
  const isTitle = (body: any) => JSON.stringify(body.messages).includes('<user-message>');
  llm.route = (body) =>
    isTitle(body) ? { text: '<title>Tidy the build scripts</title>' } : undefined;

  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers,
    // A name cannot be chosen at creation; it is ignored.
    payload: { workspaceId: 'test', name: 'Ignored' },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().session).toMatchObject({ name: 'New session', nameSource: 'auto' });
  const sessionId = created.json().session.id as string;
  const renamedEvents: unknown[] = [];
  services.events.subscribe(sessionId, (event) => {
    if (event.type === 'session_renamed') renamedEvents.push(event.data);
  });
  const generation = (
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId: 'browser-1' },
    })
  ).json().lease.generation as number;
  const name = async () =>
    (await app.inject({ method: 'GET', url: '/api/sessions', headers }))
      .json()
      .sessions.find((session: any) => session.id === sessionId).name;
  llm.push({ text: 'Sure.' });
  await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/commands`,
    headers,
    payload: {
      commandId: 'c1',
      clientId: 'browser-1',
      generation,
      payload: { type: 'prompt', message: 'clean up the build scripts' },
    },
  });
  await waitFor(name, 'Tidy the build scripts', 10_000);
  expect(renamedEvents).toEqual([{ name: 'Tidy the build scripts', source: 'auto' }]);

  const renamed = await app.inject({
    method: 'PATCH',
    url: `/api/sessions/${sessionId}`,
    headers,
    payload: { name: 'My build work' },
  });
  expect(renamed.json().session).toMatchObject({ name: 'My build work', nameSource: 'user' });
  // A late generated title can no longer replace the user's name.
  services.db.autoRenameSession(sessionId, 'Something else');
  expect(await name()).toBe('My build work');
});
