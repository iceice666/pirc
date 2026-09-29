import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { defaultAgentCommand } from '../src/config.js';
import { buildDaemonApp } from '../src/daemon/app.js';
import { NODE_PROTOCOL_VERSION } from '../src/protocol.js';
import { writeAgentConfig } from './agent-harness.js';
import { startFakeLlm } from './fixtures/fake-llm.js';
import { daemonConfig, headers, startCluster, waitFor, type Cluster } from './helpers.js';

const USER = 'test@example.com';
const OTHER = 'other@example.com';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A daemon with node `a` connected over a raw link: chats `a:chats` and a directory `a:w`. */
async function daemonWithNode() {
  const { app, services } = await buildDaemonApp(
    daemonConfig({
      nodeTokens: new Map([['a', 'a'.repeat(32)]]),
      allowedUsers: new Set([USER, OTHER]),
      memoryBudgets: { user: 2000, note: 8000 },
    }),
  );
  cleanup.push(() => app.close() as Promise<void>);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const node = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`${url}/node/connect`, {
      headers: { 'x-pirc-node-id': 'a', authorization: `Bearer ${'a'.repeat(32)}` },
    });
    cleanup.push(() => socket.terminate());
    socket.once('error', reject);
    socket.once('open', () =>
      socket.send(
        JSON.stringify({
          type: 'register',
          protocol: NODE_PROTOCOL_VERSION,
          workspaces: [
            { id: 'chats', displayName: 'Chats', kind: 'chat' },
            { id: 'w', displayName: 'W' },
          ],
        }),
      ),
    );
    socket.once('message', () => resolve(socket));
  });
  const chat = services.db.createSession('a:chats', 'node://a/c1', 'a', 'c1', USER);
  services.db.createSession('a:w', 'node://a/d1', 'a', 'd1', USER);
  services.db.createSession('a:chats', 'node://a/c2', 'a', 'c2', OTHER);
  /** What the node would forward for its session `sessionId`. */
  const ask = (sessionId: string, op: string, args: unknown = {}) =>
    new Promise<any>((resolve) => {
      const requestId = randomUUID();
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'agent_response' || message.requestId !== requestId) return;
        node.off('message', onMessage);
        resolve(message);
      };
      node.on('message', onMessage);
      node.send(JSON.stringify({ type: 'agent_request', requestId, sessionId, op, args }));
    });
  return { app, services, url, ask, chatSessionId: chat.id };
}

const as = (user: string) => ({ ...headers, 'x-pirc-user': user });
const post = (app: FastifyInstance, url: string, payload: unknown = {}, user = USER) =>
  app.inject({ method: 'POST', url, headers: as(user), payload: payload as object });

it('lets chat sessions write notes and propose USER changes that the user decides', async () => {
  const { app, services, url, ask, chatSessionId } = await daemonWithNode();
  // Memory belongs to chats; other sessions get none.
  expect((await ask('d1', 'assistant.context')).body.result).toEqual({ enabled: false });
  expect(
    (await ask('d1', 'memory.note', { action: 'add', content: 'x', origins: ['assistant'] }))
      .status,
  ).toBe(403);

  const events = new WebSocket(
    `${url}/api/events?sessionId=${encodeURIComponent(chatSessionId)}&memory=1`,
    { headers },
  );
  cleanup.push(() => events.terminate());
  const changes: string[] = [];
  events.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'memory_changed') changes.push(message.type);
  });
  await new Promise((resolve) => events.once('open', resolve));

  const added = await ask('c1', 'memory.note', {
    action: 'add',
    content: 'm5pro holds the pirc repo.',
    origins: ['assistant', 'tool:bash'],
  });
  expect(added.body.result).toMatchObject({ revision: 1, unchanged: false });
  const noteId = added.body.result.id as string;
  // A replace that did not see the current revision gets it back, with the content.
  const stale = await ask('c1', 'memory.note', {
    action: 'replace',
    id: noteId,
    content: 'lumo holds it.',
    baseRevision: null,
    origins: ['assistant'],
  });
  expect(stale).toMatchObject({
    status: 409,
    body: {
      error: {
        code: 'conflict',
        details: { id: noteId, revision: 1, content: 'm5pro holds the pirc repo.' },
      },
    },
  });
  // USER changes need the user's words (with the messages that hold them).
  expect(
    (
      await ask('c1', 'memory.proposeUser', {
        action: 'add',
        content: 'Prefers Traditional Chinese.',
        quote: '用繁中',
        entryIds: [],
      })
    ).status,
  ).toBe(400);
  const proposed = await ask('c1', 'memory.proposeUser', {
    action: 'add',
    content: 'Prefers Traditional Chinese.',
    quote: '用繁中',
    entryIds: ['m1'],
  });
  const proposalId = proposed.body.result.proposalId as string;
  await waitFor(() => changes.length, 2);

  const view = (await app.inject({ method: 'GET', url: '/api/memory', headers })).json();
  expect(view.notes).toEqual([
    expect.objectContaining({
      id: noteId,
      origins: ['assistant', 'tool:bash'],
      sources: { sessionId: chatSessionId },
    }),
  ]);
  expect(view.proposals).toEqual([
    expect.objectContaining({ id: proposalId, quote: '用繁中', sessionId: chatSessionId }),
  ]);
  expect(view.sessions).toEqual({ [chatSessionId]: 'New session' });
  expect(view.usage.note).toEqual({ used: 26, max: 8000 });
  // Another user sees nothing of it and cannot decide it.
  const theirs = (
    await app.inject({ method: 'GET', url: '/api/memory', headers: as(OTHER) })
  ).json();
  expect([theirs.notes, theirs.proposals]).toEqual([[], []]);
  expect(
    (await post(app, `/api/memory/proposals/${proposalId}/approve`, {}, OTHER)).statusCode,
  ).toBe(404);
  expect((await ask('c2', 'assistant.context')).body.result.notes).toEqual([]);

  const approved = await post(app, `/api/memory/proposals/${proposalId}/approve`);
  expect(approved.statusCode).toBe(200);
  expect(approved.json().user).toEqual([
    expect.objectContaining({
      content: 'Prefers Traditional Chinese.',
      origins: ['user'],
      sources: { sessionId: chatSessionId, entryIds: ['m1'], quote: '用繁中', proposalId },
    }),
  ]);
  expect(approved.json().proposals).toEqual([]);
  await waitFor(() => changes.length, 3);
  expect((await ask('c1', 'assistant.context')).body.result).toMatchObject({
    enabled: true,
    user: [{ content: 'Prefers Traditional Chinese.', revision: 1 }],
    notes: [{ id: noteId, revision: 1 }],
    pendingProposals: 0,
  });

  // History and restore.
  await ask('c1', 'memory.note', {
    action: 'replace',
    id: noteId,
    content: 'lumo holds the pirc repo.',
    baseRevision: 1,
    origins: ['assistant'],
  });
  const history = await app.inject({
    method: 'GET',
    url: `/api/memory/entries/${noteId}/history`,
    headers,
  });
  expect(history.json().versions.map((v: any) => [v.revision, v.op])).toEqual([
    [2, 'replace'],
    [1, 'add'],
  ]);
  const restored = await post(app, `/api/memory/entries/${noteId}/restore`, { revision: 1 });
  expect(restored.json().notes[0]).toMatchObject({
    content: 'm5pro holds the pirc repo.',
    revision: 3,
  });

  // Forgetting erases it and keeps it from coming back.
  const forgotten = await post(app, `/api/memory/entries/${noteId}/forget`);
  expect(forgotten.json().notes).toEqual([]);
  const again = await ask('c1', 'memory.note', {
    action: 'add',
    content: 'm5pro holds the pirc repo.',
    origins: ['assistant'],
  });
  expect(again).toMatchObject({ status: 409, body: { error: { code: 'forgotten' } } });

  // A paired phone may review memory too.
  const { token } = services.devices.create(USER, 'phone');
  const phone = await app.inject({
    method: 'GET',
    url: '/api/memory',
    headers: { host: 'test.example', authorization: `Bearer ${token}` },
  });
  expect(phone.statusCode).toBe(200);
  expect(phone.json().user).toHaveLength(1);
});

it('remembers across chats end to end: a real agent proposes and notes, the user approves', async () => {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-assistant-e2e-'));
  const configDir = path.join(dir, 'node-config');
  writeAgentConfig(configDir);
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
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
  const cluster: Cluster = await startCluster(
    [{ nodeId: 'home', chat: true, ...defaultAgentCommand({}) }],
    { modelsFile },
  );
  cleanup.push(() => cluster.close());
  const { app, services } = cluster;
  await waitFor(() => services.db.listWorkspaces().some((w) => w.id === 'home:chats'), true);

  const openChat = async () => {
    const sessionId = (
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
        url: `/api/sessions/${sessionId}/control/acquire`,
        headers,
        payload: { clientId: 'browser-1' },
      })
    ).json().lease.generation as number;
    const prompt = async (message: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/commands`,
        headers,
        payload: {
          commandId: `${sessionId}-${randomUUID()}`,
          clientId: 'browser-1',
          generation,
          payload: { type: 'prompt', message },
        },
      });
      expect(response.statusCode).toBe(202);
      await waitFor(
        async () =>
          (
            await app.inject({
              method: 'GET',
              url: `/api/sessions/${sessionId}/snapshot`,
              headers,
            })
          ).json().run?.status,
        'succeeded',
        15_000,
      );
    };
    return { sessionId, prompt };
  };

  const first = await openChat();
  llm.push(
    {
      tool: {
        id: 'p',
        name: 'memory_propose_user',
        args: { action: 'add', content: 'Wants to be called Ice.', quote: 'call me Ice' },
      },
      also: [
        {
          id: 'n',
          name: 'memory_note',
          args: { action: 'add', content: 'Ice is building pirc, a personal assistant.' },
        },
      ],
    },
    { text: 'Got it, Ice.' },
  );
  await first.prompt('Hi! Please call me Ice. I am building pirc, my own assistant.');

  const view = (await app.inject({ method: 'GET', url: '/api/memory', headers })).json();
  expect(view.proposals).toEqual([
    expect.objectContaining({
      action: 'add',
      content: 'Wants to be called Ice.',
      quote: 'call me Ice',
      sessionId: first.sessionId,
    }),
  ]);
  expect(view.notes).toEqual([
    expect.objectContaining({
      content: 'Ice is building pirc, a personal assistant.',
      origins: ['assistant'],
      sources: { sessionId: first.sessionId },
    }),
  ]);
  const approved = await app.inject({
    method: 'POST',
    url: `/api/memory/proposals/${view.proposals[0].id}/approve`,
    headers,
    payload: {},
  });
  expect(approved.statusCode).toBe(200);

  const second = await openChat();
  llm.push({ text: 'Hello again, Ice.' });
  await second.prompt('hi');
  const system = String(llm.requests.at(-1)!.body.messages[0].content);
  expect(system).toContain('### USER');
  expect(system).toContain('Wants to be called Ice.');
  expect(system).toContain('Ice is building pirc, a personal assistant.');
  // The first chat keeps the memory it started with: nothing then.
  expect(String(llm.requests[0]!.body.messages[0].content)).toContain('(none yet)');
}, 30_000);
