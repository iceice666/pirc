import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import { FirstSend, draftScope, type Preparation } from './first-send';
import { mergePreparation } from './first-send-receipt';
import { FirstLedger, MemoryDraftStore } from './testing/first-send';
const scope = draftScope('https://pirc.test', 'alice');
const rejected: Preparation = {
  operationId: 'op',
  sessionId: 'same-session',
  workspaceId: 'node:repo',
  state: 'admission_failed',
  accepted: true,
  nodeMapped: true,
  cleanupPending: false,
  submission: {
    workspaceId: 'node:repo',
    message: 'Immutable original',
    attachments: [
      {
        id: 'file',
        name: 'original.txt',
        mimeType: 'text/plain',
        byteSize: 5,
        sha256: 'f'.repeat(64),
      },
    ],
  },
  messageAdmission: {
    outcome: 'not_admitted',
    stopRequested: false,
    stopConfirmed: false,
    commandId: 'cmd-original',
    attemptNumber: 0,
    retryEligible: true,
  },
};
const successor = (p: Preparation, state = 'admitted', outcome = 'admitted'): Preparation => ({
  ...p,
  state,
  messageAdmission: {
    ...p.messageAdmission!,
    outcome,
    commandId: 'cmd-next',
    retryId: 'nonce',
    attemptNumber: 1,
    retryEligible: state === 'admission_failed',
  },
});
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const store = new MemoryDraftStore(),
    remote = new FirstLedger(),
    flow = new FirstSend(store, remote);
  remote.entries.set(remote.key('alice', 'op'), structuredClone(rejected));
  await flow.adopt(scope, 'alice', structuredClone(rejected));
  return { store, remote, flow };
}
it('commits nonce/predecessor before POST and uses the same immutable operation without uploads or allocation', async () => {
  const { store, remote, flow } = await setup();
  vi.spyOn(remote, 'action').mockImplementation(async (owner, id, kind, body?: unknown) => {
    expect(kind).toBe('retry');
    expect(owner).toBe('alice');
    expect(id).toBe('op');
    const journal = (await store.get(scope, 'op'))!.retryAttempt!;
    expect(body).toMatchObject({
      retryId: journal.retryId,
      previousCommandId: 'cmd-original',
      generation: 7,
    });
    expect(journal.previousAttemptNumber).toBe(0);
    expect((await store.get(scope, 'op'))!.uncertain).toBe(true);
    const value = successor(rejected);
    value.messageAdmission!.retryId = journal.retryId;
    remote.entries.set(remote.key(owner, id), value);
    return value;
  });
  const result = await flow.retry(scope, 'op');
  expect(result.preparation?.state).toBe('admitted');
  expect(result.retryAttempt?.resolved).toBe(true);
  expect(result.message).toBe('Immutable original');
  expect(result.files[0]?.id).toBe('file');
  expect(result.preparation?.sessionId).toBe('same-session');
  expect(remote.calls).toEqual(['receipt', 'acquire']);
  expect(await store.list(scope)).toHaveLength(1);
});
it('lost replies survive reopening and Check or repeated Retry only queries the saved nonce', async () => {
  const { store, remote, flow } = await setup();
  const post = vi.spyOn(remote, 'action').mockImplementation(async () => {
    throw new ApiError('lost', 503);
  });
  await expect(flow.retry(scope, 'op')).rejects.toThrow('lost');
  const original = (await store.get(scope, 'op'))!.retryAttempt!;
  expect(original.resolved).not.toBe(true);
  const restored = new FirstSend(store, remote);
  remote.calls = [];
  const result = await restored.check(scope, 'op');
  expect(result.uncertain).toBe(true);
  await restored.retry(scope, 'op');
  expect(remote.calls).toEqual(['retryLookup', 'receipt', 'retryLookup', 'receipt']);
  expect(post).toHaveBeenCalledTimes(1);
  expect((await store.get(scope, 'op'))!.retryAttempt?.retryId).toBe(original.retryId);
  remote.entries.set(remote.key('alice', 'op'), successor(rejected));
  expect((await restored.check(scope, 'op')).preparation?.state).toBe('admitted');
  expect(remote.calls[remote.calls.length - 1]).toBe('retryLookup');
});
it('failed durable journal or unavailable capability/control prevents the retry POST', async () => {
  const { store, remote, flow } = await setup();
  const post = vi.spyOn(remote, 'action');
  vi.spyOn(remote, 'acquire').mockImplementation(async () => {
    store.fail = true;
    return 7;
  });
  await expect(flow.retry(scope, 'op')).rejects.toThrow('storage failed');
  expect(post).not.toHaveBeenCalled();
  store.fail = false;
  expect((await store.get(scope, 'op'))!.retryAttempt).toBeUndefined();
});
it('concurrent windows reserve one local nonce and only its winner can POST', async () => {
  const { store, remote, flow } = await setup();
  let done!: (p: Preparation) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const post = vi.spyOn(remote, 'action').mockImplementation(async () => {
    entered();
    return new Promise<Preparation>((r) => (done = r));
  });
  const sending = flow.retry(scope, 'op');
  await started;
  await new FirstSend(store, remote).retry(scope, 'op');
  expect(post).toHaveBeenCalledTimes(1);
  done(successor(rejected));
  await sending;
});
it('a peer Stop during control acquisition prevents reservation and POST', async () => {
  const { store, remote, flow } = await setup();
  const post = vi.spyOn(remote, 'action');
  vi.spyOn(remote, 'acquire').mockImplementation(async () => {
    await store.update(scope, 'op', (row) => ({ ...row!, stopCommandId: 'stop' }));
    return 7;
  });
  await expect(flow.retry(scope, 'op')).rejects.toThrow('attempt changed');
  expect(post).not.toHaveBeenCalled();
});
it('stale predecessor receipts cannot replace a newer rejection, and same-attempt unknown cannot undo a positive rejection', () => {
  const next = successor(rejected, 'admission_failed', 'not_admitted');
  expect(mergePreparation(next, rejected)).toMatchObject({
    state: 'admission_failed',
    messageAdmission: { commandId: 'cmd-next', attemptNumber: 1, retryEligible: true },
  });
  const unknown = successor(rejected, 'outcome_unknown', 'outcome_unknown');
  expect(mergePreparation(next, unknown)).toMatchObject({
    state: 'admission_failed',
    messageAdmission: { outcome: 'not_admitted', retryEligible: true },
  });
  expect(mergePreparation(rejected, unknown)).toMatchObject({
    state: 'outcome_unknown',
    messageAdmission: { outcome: 'outcome_unknown', attemptNumber: 1, retryEligible: false },
  });
});
it('Stop merges globally without borrowing the predecessor rejection for an unknown successor; valid late acceptance and deletion still advance', () => {
  const next = successor(rejected, 'outcome_unknown', 'outcome_unknown');
  const stopped = {
    ...rejected,
    state: 'stopped',
    messageAdmission: { ...rejected.messageAdmission!, stopRequested: true, stopConfirmed: true },
  };
  const value = mergePreparation(next, stopped);
  expect(value).toMatchObject({
    state: 'stopped',
    messageAdmission: {
      commandId: 'cmd-next',
      attemptNumber: 1,
      outcome: 'outcome_unknown',
      stopConfirmed: true,
      retryEligible: false,
    },
  });
  expect(mergePreparation(value, successor(rejected))).toMatchObject({
    state: 'admitted',
    messageAdmission: { outcome: 'admitted', stopConfirmed: true },
  });
  const cancelled = { ...rejected, state: 'cancelled' };
  expect(mergePreparation(value, cancelled).state).toBe('cancelled');
  expect(mergePreparation(cancelled, next).state).toBe('cancelled');
});
it('rejects malformed ordinals and same-ordinal command swaps', () => {
  expect(() =>
    mergePreparation(rejected, {
      ...rejected,
      messageAdmission: { ...rejected.messageAdmission!, attemptNumber: -1 },
    }),
  ).toThrow('attempt number');
  expect(() =>
    mergePreparation(rejected, {
      ...rejected,
      messageAdmission: { ...rejected.messageAdmission!, commandId: 'other' },
    }),
  ).toThrow('identity changed');
});
it('unsupported retries and another account leave the original untouched', async () => {
  const { store, remote, flow } = await setup();
  vi.spyOn(remote, 'capabilities').mockResolvedValue({
    ...(await remote.capabilities()),
    canRetryFirstMessage: false,
  });
  await expect(flow.retry(scope, 'op')).rejects.toThrow('cannot retry');
  expect((await store.get(scope, 'op'))!.retryAttempt).toBeUndefined();
  expect(remote.calls).toEqual(['receipt']);
});

it('only explicit pre-reservation refusal unlocks another user retry; generic conflicts remain query-only', async () => {
  const { store, remote, flow } = await setup();
  const post = vi
    .spyOn(remote, 'action')
    .mockRejectedValueOnce(new ApiError('upgrade Node', 409, 'initial_retry_unsupported'));
  await expect(flow.retry(scope, 'op')).rejects.toThrow('upgrade Node');
  expect((await store.get(scope, 'op'))!.retryAttempt).toMatchObject({
    resolved: true,
    notReserved: true,
  });
  expect((await store.get(scope, 'op'))!.uncertain).toBe(false);
  post.mockRejectedValueOnce(new ApiError('generic conflict', 409));
  await expect(flow.retry(scope, 'op')).rejects.toThrow('generic conflict');
  expect((await store.get(scope, 'op'))!.retryAttempt?.resolved).not.toBe(true);
  await flow.retry(scope, 'op');
  expect(post).toHaveBeenCalledTimes(2);
});
