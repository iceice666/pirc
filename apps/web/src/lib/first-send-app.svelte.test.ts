// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { app } from './app.svelte';
import { api } from './api';
import { demoSnapshot } from './mock';
import { MemoryDraftStore, FirstLedger } from './testing/first-send';
import { File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
let store: MemoryDraftStore, remote: FirstLedger;
class Socket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  close() {
    this.readyState = 3;
  }
}
beforeEach(async () => {
  store = new MemoryDraftStore();
  remote = new FirstLedger();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('File', NodeFile);
  for (const name of ['list', 'get', 'update'] as const)
    vi.spyOn(app.firstFlow.store, name).mockImplementation(store[name].bind(store) as never);
  for (const name of [
    'capabilities',
    'find',
    'lookup',
    'prepare',
    'upload',
    'action',
    'acquire',
    'acquirePending',
    'stopPending',
    'stop',
    'remove',
  ] as const)
    vi.spyOn(app.firstFlow.transport, name).mockImplementation(remote[name].bind(remote) as never);
  app.demo = undefined;
  app.firstDraft = undefined;
  app.firstRecoveries = [];
  app.firstCapabilities = undefined;
  app.sessionState = undefined;
  app.activeSessionId = undefined;
  app.commandBusy = false;
  app.firstControlBusy = false;
  app.workspaces = [
    { id: 'node:repo', hostId: 'node', displayName: 'Repo', kind: 'directory', defaults: {} },
  ];
  app.sessions = [];
  app.models = [
    {
      id: 'm',
      provider: 'fake',
      displayName: 'Model',
      available: true,
      thinkingLevels: ['off', 'low'],
    },
  ];
  vi.spyOn(api, 'models').mockResolvedValue(app.models);
  vi.spyOn(api, 'sessions').mockResolvedValue([
    { ...demoSnapshot.session, id: 'public-session', workspaceId: 'node:repo' },
  ]);
  vi.spyOn(api, 'snapshot').mockImplementation(async (id) => ({
    ...demoSnapshot,
    session: { ...demoSnapshot.session, id, workspaceId: 'node:repo' },
    messages: [],
  }));
  vi.spyOn(api, 'control').mockResolvedValue({ heldByCurrentClient: true, generation: 7 });
  await app.initializeFirstSend();
});
afterEach(async () => {
  app.discardDraftSession();
  app.dispose();
  app.firstDraft = undefined;
  app.firstRecoveries = [];
  app.firstCapabilities = undefined;
  app.commandBusy = false;
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('actual Send uses the durable pipeline and clears the composer only after admission', async () => {
  const oldCreate = vi.spyOn(api, 'createSession'),
    ordinary = vi.spyOn(api, 'command');
  await app.createSession('node:repo');
  app.setDraft('First message');
  await app.sendCommand('prompt');
  expect(remote.calls).toContain('dispatch');
  expect(app.activeSessionId).toBe('public-session');
  expect(app.draft).toBe('');
  expect(app.firstDraft).toBeUndefined();
  expect(oldCreate).not.toHaveBeenCalled();
  expect(ordinary).not.toHaveBeenCalled();
  expect(await store.list(JSON.stringify(['http://localhost', 'alice']))).toEqual([]);
});
it('navigation preserves local bytes without publishing a session or jumping back later', async () => {
  await app.createSession('node:repo');
  app.setDraft('Local text');
  await app.uploadFiles([new NodeFile(['bytes'], 'note.txt', { type: 'text/plain' }) as File]);
  const id = app.firstDraft!.operationId,
    scope = app.firstDraft!.scope;
  await app.createSession('node:repo');
  const saved = await store.get(scope, id);
  expect(saved?.message).toBe('Local text');
  expect(await saved?.files[0]?.blob?.text()).toBe('bytes');
  expect(remote.calls).toEqual([]);
  expect(app.sessions).toEqual([]);
  expect(app.activeSessionId).not.toBe(id);
});
it('a restored unknown send can check without a lease or another prompt', async () => {
  await app.createSession('node:repo');
  app.setDraft('One only');
  remote.failDispatch = true;
  await app.sendCommand('prompt');
  expect(app.firstDraft?.frozen).toBe(true);
  expect(app.draft).toBe('One only');
  remote.calls = [];
  const acquire = vi.spyOn(api, 'acquireControl'),
    heartbeat = vi.spyOn(api, 'heartbeatControl');
  await app.checkFirst();
  expect(remote.calls).toEqual(['receipt']);
  expect(acquire).not.toHaveBeenCalled();
  expect(heartbeat).not.toHaveBeenCalled();
  expect(app.firstDraft?.preparation?.state).toBe('admitted');
  expect(app.draft).toBe('One only');
  await app.openStoppedFirst();
  expect(app.firstDraft).toBeUndefined();
  expect(app.draft).toBe('');
});
it('discarding a mutable draft does not expose the legacy send path on the old placeholder', async () => {
  await app.createSession('node:repo');
  app.setDraft('Discard me');
  // Let the serialized local edit commit, as a normal input event does.
  await app.firstFlow.store.get(app.firstDraft!.scope, app.firstDraft!.operationId);
  await Promise.resolve();
  await app.discardFirst();
  expect(app.activeSessionId).toBeUndefined();
  expect(app.sessionState).toBeUndefined();
  expect(app.firstDraft).toBeUndefined();
  expect(remote.calls).toEqual([]);
});
it('another device opens the accepted intent by session ID and does not dispatch it automatically', async () => {
  await remote.prepare('alice', 'other-device', {
    workspaceId: 'node:repo',
    message: 'From another phone',
    attachments: [],
  });
  await remote.action('alice', 'other-device', 'accept');
  remote.calls = [];
  await app.openSession('public-session');
  expect(app.firstDraft?.operationId).toBe('other-device');
  expect(app.firstDraft?.message).toBe('From another phone');
  expect(remote.calls).not.toContain('dispatch');
  expect(remote.calls).not.toContain('acquire');
});
it('account changes hide prior content but retain the old account draft in its own scope', async () => {
  await app.createSession('node:repo');
  app.setDraft('Private Alice draft');
  const original = app.firstDraft!;
  vi.mocked(app.firstFlow.transport.capabilities).mockResolvedValue({
    version: 1,
    ownerUser: 'bob',
    canFenceAccount: true,
    canSubmit: true,
  });
  await app.initializeFirstSend();
  expect(app.draft).toBe('');
  expect(app.firstDraft).toBeUndefined();
  expect(app.firstRecoveries).toEqual([]);
  expect((await store.get(original.scope, original.operationId))?.message).toBe(
    'Private Alice draft',
  );
  expect(remote.calls).toEqual([]);
});
it('a late old-account removal callback cannot hide a new account record with the same operation ID', async () => {
  await app.createSession('node:repo');
  app.setDraft('Alice text');
  await app.firstFlow.store.get(app.firstDraft!.scope, app.firstDraft!.operationId);
  await Promise.resolve();
  const original = app.firstDraft!;
  vi.mocked(app.firstFlow.transport.capabilities).mockResolvedValue({
    version: 1,
    ownerUser: 'bob',
    canFenceAccount: true,
    canSubmit: true,
  });
  await app.initializeFirstSend();
  const scope = JSON.stringify(['http://localhost', 'bob']);
  const bob = await app.firstFlow.save(scope, 'bob', original.operationId, {
    workspaceId: 'node:repo',
    message: 'Bob text',
    files: [],
  });
  app.firstDraft = bob;
  await app.firstFlow.forget(original.scope, original.operationId);
  expect(app.firstDraft?.ownerUser).toBe('bob');
  expect(app.firstRecoveries.some((r) => r.ownerUser === 'bob')).toBe(true);
});

it('failure of the initial local write cannot fall back to legacy creation or lose typed text', async () => {
  const oldCreate = vi.spyOn(api, 'createSession'),
    ordinary = vi.spyOn(api, 'command');
  store.fail = true;
  expect(await app.createSession('node:repo')).toBe(false);
  app.setDraft('Keep this message');
  await app.sendCommand('prompt');
  expect(app.draft).toBe('Keep this message');
  expect(app.firstDraft).toBeDefined();
  expect(oldCreate).not.toHaveBeenCalled();
  expect(ordinary).not.toHaveBeenCalled();
  expect(remote.calls).toEqual([]);
  store.fail = false;
  await app.sendCommand('prompt');
  expect(remote.calls.filter((c) => c === 'dispatch')).toHaveLength(1);
  expect(app.firstDraft).toBeUndefined();
});
it('a delayed initial local commit cannot replace a newer draft after navigation', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const update = store.update.bind(store);
  vi.spyOn(app.firstFlow.store, 'update').mockImplementationOnce(async (...args) => {
    entered();
    await barrier;
    return update(...args);
  });
  const opening = app.createSession('node:repo');
  await started;
  const firstId = app.activeSessionId;
  app.setDraft('Earlier draft text');
  const next = app.createSession('node:repo');
  const newerId = app.activeSessionId;
  release();
  expect(await opening).toBe(false);
  expect(await next).toBe(true);
  expect(app.activeSessionId).toBe(newerId);
  expect(app.firstDraft?.operationId).toBe(newerId);
  expect(newerId).not.toBe(firstId);
  expect((await store.get(JSON.stringify(['http://localhost', 'alice']), firstId!))?.message).toBe(
    'Earlier draft text',
  );
  expect(remote.calls).toEqual([]);
});

it('restores authenticated saved input even when new first sends are disabled', async () => {
  await app.createSession('node:repo');
  app.setDraft('Keep when disabled');
  const original = app.firstDraft!;
  await app.firstFlow.store.get(original.scope, original.operationId);
  await Promise.resolve();
  app.firstRecoveries = [];
  vi.mocked(app.firstFlow.transport.capabilities).mockResolvedValue({
    version: 1,
    ownerUser: 'alice',
    canFenceAccount: true,
    canSubmit: false,
    canStopBeforeAllocation: true,
  });
  await app.initializeFirstSend();
  expect(app.firstEnabled).toBe(false);
  expect(app.firstRecoveries.some((r) => r.message === 'Keep when disabled')).toBe(true);
  expect(remote.calls).not.toContain('dispatch');
});
