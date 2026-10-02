import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, spyOn } from 'bun:test';
import { GatewayDatabase } from '../src/database.js';
import { MemoryInteractions } from '../src/daemon/memory-interactions.js';
import { headers, startCluster, waitFor, type Cluster } from './helpers.js';

const USER = 'test@example.com';
let cluster: Cluster | undefined;
afterEach(async () => {
  await cluster?.close();
  cluster = undefined;
});
const call = (method: 'POST' | 'GET' | 'DELETE', url: string, payload?: object) =>
  cluster!.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const create = async (workspaceId = 'chat:chats') =>
  (await call('POST', '/api/sessions', { workspaceId })).json().session.id as string;
const propose = (sessionId: string, content: string) =>
  cluster!.services.memory.propose(
    USER,
    sessionId,
    { action: 'add', content, quote: `Please remember ${content}` },
    { sessionId },
  ).proposal;

it('restores pending cards from the database and rejects answers for a stale target revision', async () => {
  cluster = await startCluster([{ nodeId: 'chat', chat: true }]);
  const { db, memory, events } = cluster.services;
  const id = await create();
  const first = memory.approve(USER, propose(id, 'Lives in Taipei.').id).entry;
  const next = memory.propose(
    USER,
    id,
    {
      action: 'replace',
      id: first.id,
      content: 'Lives in Tokyo.',
      quote: 'I moved to Tokyo',
      baseRevision: first.revision,
    },
    { sessionId: id },
  ).proposal;
  const snapshot = (await call('GET', `/api/sessions/${id}/snapshot`)).json();
  const card = snapshot.interactions.find((i: any) => i.id.startsWith('memory:'));
  expect(card.request.message).toContain('Lives in Taipei.');
  expect(card.request.message).toContain('Lives in Tokyo.');
  // A new coordinator has no node RPC state, just persisted proposals.
  const restored = new MemoryInteractions(db, memory, events);
  expect(restored.pendingInteractions(id, USER)).toEqual([card]);
  const lease = (
    await call('POST', `/api/sessions/${id}/control/acquire`, { clientId: 'test' })
  ).json().lease;
  const elsewhere = memory.propose(
    USER,
    id,
    {
      action: 'replace',
      id: first.id,
      content: 'Lives in Kyoto.',
      quote: 'I moved to Kyoto',
      baseRevision: 1,
    },
    { sessionId: id },
  ).proposal;
  expect(
    (await call('POST', `/api/memory/proposals/${elsewhere.id}/approve`, { targetRevision: 1 }))
      .statusCode,
  ).toBe(200);
  const answer = (interactionId: string) =>
    call('POST', `/api/sessions/${id}/interactions/${interactionId}/answer`, {
      clientId: 'test',
      generation: lease.generation,
      answer: { confirmed: true },
    });
  expect((await answer(card.id)).statusCode).toBe(409);
  expect(memory.proposal(USER, next.id).status).toBe('pending');
  const refreshed = (await call('GET', `/api/sessions/${id}/snapshot`))
    .json()
    .interactions.find((i: any) => i.id.startsWith('memory:'));
  expect(refreshed.request.message).toContain('Lives in Kyoto.');
  expect((await answer(refreshed.id)).statusCode).toBe(200);
  expect(memory.entry(USER, first.id).content).toBe('Lives in Tokyo.');
  expect((await call('GET', `/api/sessions/${id}/snapshot`)).json().interactions).toEqual([]);
});

it('deletes a running chat, its private files and source memories while preserving other chats', async () => {
  cluster = await startCluster([{ nodeId: 'chat', chat: true }], {
    allowedUsers: new Set([USER, 'other@example.com']),
  });
  const { db, memory } = cluster.services;
  const id = await create();
  const keep = await create();
  const user = memory.approve(USER, propose(id, 'Prefers tea.').id).entry;
  const note = memory.writeNote(
    USER,
    { action: 'add', content: 'Delete this note' },
    { actor: `session:${id}`, origins: ['assistant'], sources: { sessionId: id } },
  ).entry;
  const other = memory.approve(USER, propose(keep, 'Prefers coffee.').id).entry;
  propose(id, 'Pending source proposal');
  const remote = db.getSession(id).piSessionId!;
  const config = cluster.nodes[0]!.config;
  const local = new GatewayDatabase(config.databasePath);
  const storage = local.getSession(remote).privateSessionPath;
  const root = path.join(config.stateDir, 'chat', 'chats', 'sessions', remote);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'keep-no-memory.txt'), 'chat private file');
  writeFileSync(path.join(storage, 'memory.json'), 'observations');
  const lease = (
    await call('POST', `/api/sessions/${id}/control/acquire`, { clientId: 'test' })
  ).json().lease;
  const command = await call('POST', `/api/sessions/${id}/commands`, {
    clientId: 'test',
    generation: lease.generation,
    commandId: 'holding',
    payload: { type: 'prompt', message: 'hold' },
  });
  expect(command.statusCode).toBe(202);
  expect(
    (
      await cluster.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${id}`,
        headers: { ...headers, 'x-pirc-user': 'other@example.com' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await call('DELETE', `/api/sessions/${id}`)).statusCode).toBe(204);
  expect(existsSync(storage)).toBe(false);
  expect(existsSync(root)).toBe(false);
  expect(local.sessionDeletion(remote)?.status).toBe('deleted');
  expect(() => local.getSession(remote)).toThrow();
  local.close();
  expect((await call('GET', `/api/sessions/${id}/snapshot`)).statusCode).toBe(404);
  expect(memory.entry(USER, user.id).status).toBe('forgotten');
  expect(memory.entry(USER, note.id).status).toBe('forgotten');
  expect(memory.entry(USER, other.id).status).toBe('active');
  expect(memory.proposals(USER).some((p) => p.sessionId === id)).toBe(false);
  expect(db.resolveRemoteSession('chat', remote)).toBeUndefined();
  expect((await call('GET', `/api/sessions/${keep}/snapshot`)).statusCode).toBe(200);
  expect((await call('DELETE', `/api/sessions/${id}`)).statusCode).toBe(204);
});

it('can finish deletion after a lost node acknowledgement and fences writes until retry', async () => {
  cluster = await startCluster([{ nodeId: 'chat', chat: true }]);
  const id = await create();
  const { db, nodes, memory } = cluster.services;
  const remote = db.getSession(id).piSessionId!;
  const entry = memory.approve(USER, propose(id, 'Forget on completed deletion.').id).entry;
  const original = nodes.request.bind(nodes);
  const request = spyOn(nodes, 'request').mockImplementationOnce(async (...args) => {
    const response = await original(...args);
    expect(response.status).toBe(204);
    throw new Error('Acknowledgement lost');
  });
  expect((await call('DELETE', `/api/sessions/${id}`)).statusCode).toBe(500);
  request.mockRestore();
  expect(db.sessionDeletion(id)?.status).toBe('deleting');
  expect(db.resolveRemoteSession('chat', remote)).toBeUndefined();
  expect(
    (await call('POST', `/api/sessions/${id}/control/acquire`, { clientId: 'late' })).statusCode,
  ).toBe(409);
  expect((await call('DELETE', `/api/sessions/${id}`)).statusCode).toBe(204);
  expect(memory.entry(USER, entry.id).status).toBe('forgotten');
});

it('leaves chats intact when offline and does not delete directory sessions', async () => {
  cluster = await startCluster([{ nodeId: 'chat', chat: true }, { nodeId: 'work' }]);
  const id = await create();
  const work = await create('work:test');
  expect((await call('DELETE', `/api/sessions/${work}`)).statusCode).toBe(400);
  const node = cluster.nodes.shift()!;
  await node.close();
  await waitFor(() => cluster!.services.nodes.list().length, 1);
  expect((await call('DELETE', `/api/sessions/${id}`)).statusCode).toBe(503);
  expect(cluster.services.db.sessionDeletion(id)).toBeNull();
  expect(cluster.services.db.getSession(id).id).toBe(id);
});
