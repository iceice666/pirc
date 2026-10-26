import { describe, it, expect, vi, afterEach } from 'vitest';
import { FirstSend, draftScope, firstTransport } from './first-send';
import { MemoryDraftStore, FirstLedger } from './testing/first-send';
import { ApiError } from './http';
import { BrowserDraftStore } from './first-send-storage';
const scope = draftScope('https://pirc.test', 'alice');
const value = {
  workspaceId: 'node:repo',
  message: 'Original text',
  model: { provider: 'fake', id: 'm' },
  thinking: 'low' as const,
  files: [
    {
      id: 'file-1',
      name: 'input.txt',
      mimeType: 'text/plain',
      byteSize: 5,
      blob: new Blob(['hello']),
    },
  ],
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const store = new MemoryDraftStore(),
    remote = new FirstLedger(),
    flow = new FirstSend(store, remote);
  await flow.save(scope, 'alice', 'operation-1', value);
  return { store, remote, flow };
}
it('stores original text and attachment bytes before freezing one durable operation', async () => {
  const { store, remote, flow } = await setup();
  expect(remote.calls).toEqual([]);
  const row = await flow.run(scope, 'operation-1');
  expect(row.preparation?.state).toBe('admitted');
  expect(remote.calls).toEqual([
    'lookup',
    'prepare',
    'upload',
    'accept',
    'materialize',
    'acquire',
    'dispatch',
  ]);
  expect((await store.get(scope, 'operation-1'))?.files[0]?.sha256).toBe(
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  expect(await row.files[0]!.blob!.text()).toBe('hello');
  expect(row.model).toEqual(value.model);
  expect(row.thinking).toBe('low');
});
it('a lost dispatch reply reloads the same identity and read-only checking never acquires or sends', async () => {
  const { store, remote, flow } = await setup();
  remote.failDispatch = true;
  await expect(flow.run(scope, 'operation-1')).rejects.toThrow('response lost');
  expect((await store.get(scope, 'operation-1'))?.uncertain).toBe(true);
  const restored = new FirstSend(store, remote);
  remote.calls = [];
  expect((await restored.check(scope, 'operation-1')).preparation?.state).toBe('admitted');
  expect(remote.calls).toEqual(['receipt']);
  await restored.run(scope, 'operation-1');
  expect(remote.calls).toEqual(['receipt', 'receipt']);
});
it('unknown admission stays query-only even when Continue is invoked repeatedly', async () => {
  const { remote, flow } = await setup();
  await flow.run(scope, 'operation-1');
  remote.entries.set(remote.key('alice', 'operation-1'), {
    ...(await remote.lookup('alice', 'operation-1')),
    state: 'outcome_unknown',
  });
  // Use a fresh record to model an unacknowledged send, rather than downgrade known admission.
  const store = new MemoryDraftStore(),
    next = new FirstSend(store, remote);
  await next.adopt(scope, 'alice', await remote.lookup('alice', 'operation-1'));
  remote.calls = [];
  await next.run(scope, 'operation-1');
  await next.check(scope, 'operation-1');
  expect(remote.calls).toEqual(['receipt', 'receipt']);
});
it('storage refusal prevents every network mutation and retains the editable original', async () => {
  const { store, remote, flow } = await setup();
  store.fail = true;
  await expect(flow.run(scope, 'operation-1')).rejects.toThrow('storage failed');
  expect(remote.calls).toEqual([]);
  expect((await store.get(scope, 'operation-1'))?.message).toBe(value.message);
});
it('an empty browser store is an error rather than silent in-memory fallback', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(new BrowserDraftStore().list(scope)).rejects.toThrow(
    'Local draft storage is unavailable',
  );
});
it('revisions reject a stale tab and frozen input cannot be edited or retargeted', async () => {
  const { flow } = await setup();
  await flow.save(scope, 'alice', 'operation-1', { ...value, message: 'Newer text' }, 1);
  await expect(flow.save(scope, 'alice', 'operation-1', value, 1)).rejects.toThrow('another tab');
  await expect(flow.run(scope, 'operation-1', 1)).rejects.toThrow('another tab');
  await flow.run(scope, 'operation-1', 2);
  await expect(
    flow.save(scope, 'alice', 'operation-1', { ...value, workspaceId: 'other' }),
  ).rejects.toThrow('another tab');
});
it('cancel during a delayed acceptance cannot restore cleared bytes or continue to dispatch', async () => {
  const { remote, store, flow } = await setup();
  let release!: (value: any) => void, started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const original = remote.action.bind(remote);
  vi.spyOn(remote, 'action').mockImplementation(async (owner, id, action) => {
    if (action !== 'accept') return original(owner, id, action);
    const stale = { ...(await remote.lookup(owner, id)), accepted: true, state: 'accepted' };
    started();
    return new Promise((r) => {
      release = () => r(stale);
    });
  });
  const running = flow.run(scope, 'operation-1');
  await ready;
  await flow.discard(scope, 'operation-1');
  release(undefined);
  await running;
  const cancelled = await store.get(scope, 'operation-1');
  expect(cancelled?.preparation?.state).toBe('cancelled');
  expect(cancelled?.message).toBe('');
  expect(cancelled?.files).toEqual([]);
  expect(remote.calls).not.toContain('dispatch');
  expect(remote.calls).not.toContain('materialize');
  expect((await flow.discard(scope, 'operation-1'))?.preparation?.state).toBe('cancelled');
});
it('account scopes isolate content and the HTTP transport pins the expected account on raw uploads', async () => {
  const { store, flow } = await setup();
  const other = draftScope('https://pirc.test', 'bob');
  expect(await store.list(other)).toEqual([]);
  await flow.save(other, 'bob', 'operation-1', { ...value, message: 'Bob text' });
  expect((await store.get(scope, 'operation-1'))?.message).toBe('Original text');
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await firstTransport.upload('使用者@example.test', 'op', value.files[0]!);
  const init = fetch.mock.calls[0]![1] as RequestInit;
  expect(new Headers(init.headers).get('x-pirc-account')).toBe(
    encodeURIComponent('使用者@example.test'),
  );
  expect(new Headers(init.headers).get('content-type')).toBe('application/octet-stream');
});
it('another device can adopt an accepted intent without local file bytes, and Stop retains the original', async () => {
  const { remote, flow, store } = await setup();
  await remote.prepare('alice', 'operation-1', { ...value, attachments: [] });
  await remote.action('alice', 'operation-1', 'accept');
  await remote.action('alice', 'operation-1', 'materialize');
  const otherScope = draftScope('https://other.test', 'alice'),
    otherFlow = new FirstSend(store, remote);
  await otherFlow.adopt(otherScope, 'alice', await remote.lookup('alice', 'operation-1'));
  const stopped = await otherFlow.stop(otherScope, 'operation-1');
  expect(stopped.message).toBe('Original text');
  expect(stopped.preparation?.messageAdmission?.stopConfirmed).toBe(true);
  await otherFlow.release(otherScope, 'operation-1');
  expect((await store.get(otherScope, 'operation-1'))?.released).toBe(true);
  expect((await store.get(scope, 'operation-1'))?.files[0]?.blob).toBeDefined();
});
it('mismatched session receipts preserve input and cannot advance execution', async () => {
  const { flow, remote } = await setup();
  await flow.run(scope, 'operation-1');
  remote.calls = [];
  vi.spyOn(remote, 'lookup').mockResolvedValue({
    operationId: 'different',
    sessionId: 'foreign',
    workspaceId: 'node:repo',
    state: 'admitted',
    accepted: true,
    cleanupPending: false,
  });
  await expect(flow.check(scope, 'operation-1')).rejects.toThrow('different submission');
  expect(remote.calls).toEqual([]);
});
it('a hash failure before any prepare attempt can be discarded locally without network mutation', async () => {
  const { remote, store, flow } = await setup();
  vi.stubGlobal('crypto', undefined);
  await expect(flow.run(scope, 'operation-1')).rejects.toThrow('hashing is unavailable');
  expect((await store.get(scope, 'operation-1'))?.prepareAttempted).toBe(false);
  await flow.discard(scope, 'operation-1');
  expect(await store.get(scope, 'operation-1')).toBeUndefined();
  expect(remote.calls).toEqual([]);
});
it('invalid empty attachments stay editable and never create a frozen unsendable operation', async () => {
  const { remote, flow, store } = await setup();
  await flow.save(
    scope,
    'alice',
    'operation-1',
    { ...value, files: [{ ...value.files[0]!, byteSize: 0, blob: new Blob([]) }] },
    1,
  );
  await expect(flow.run(scope, 'operation-1')).rejects.toThrow('empty content');
  expect((await store.get(scope, 'operation-1'))?.frozen).toBe(false);
  await flow.discard(scope, 'operation-1');
  expect(remote.calls).toEqual([]);
});
it('a late queued edit cannot recreate a draft that was explicitly discarded', async () => {
  const { flow, store } = await setup();
  await flow.discard(scope, 'operation-1');
  await expect(flow.save(scope, 'alice', 'operation-1', value, 1)).rejects.toThrow(
    'no longer available',
  );
  expect(await store.get(scope, 'operation-1')).toBeUndefined();
});
it('a missing preparation receipt allows an explicit same-key continuation after checking', async () => {
  const { flow, remote, store } = await setup();
  vi.spyOn(remote, 'prepare').mockRejectedValueOnce(new ApiError('prepare response lost', 503));
  await expect(flow.run(scope, 'operation-1')).rejects.toThrow('prepare response lost');
  expect((await store.get(scope, 'operation-1'))?.uncertain).toBe(true);
  remote.calls = [];
  const checked = await flow.check(scope, 'operation-1');
  expect(checked.uncertain).toBe(false);
  expect(remote.calls).toEqual(['lookup']);
  const admitted = await flow.run(scope, 'operation-1');
  expect(admitted.operationId).toBe('operation-1');
  expect(admitted.preparation?.state).toBe('admitted');
  expect(remote.entries.size).toBe(1);
  expect(remote.calls.filter((c) => c === 'dispatch')).toHaveLength(1);
});
