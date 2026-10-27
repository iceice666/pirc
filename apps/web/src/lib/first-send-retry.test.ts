import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import { FirstSend, draftScope, type Preparation, type RetryReceipt } from './first-send';
import { mergePreparation, retryRetired } from './first-send-receipt';
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

async function interrupted() {
  const context = await setup();
  const post = vi.spyOn(context.remote, 'action').mockRejectedValue(new ApiError('lost', 503));
  await expect(context.flow.retry(scope, 'op')).rejects.toThrow('lost');
  const attempt = (await context.store.get(scope, 'op'))!.retryAttempt!;
  const proof: RetryReceipt = {
    preparation: structuredClone(rejected),
    retry: {
      retryId: attempt.retryId,
      previousCommandId: attempt.previousCommandId,
      status: 'not_reserved',
      retired: true,
    },
  };
  return { ...context, post, attempt, proof };
}
it('recovery fences a pre-POST nonce without sending and retains original bytes for a separate user retry', async () => {
  const { store, remote, flow, post, attempt } = await interrupted();
  await store.update(scope, 'op', (row) => ({
    ...row!,
    files: row!.files.map((f) => ({ ...f, blob: new Blob(['hello']) })),
  }));
  remote.calls = [];
  const recovered = await flow.recoverRetry(scope, 'op');
  expect(recovered.retryAttempt).toEqual({ ...attempt, resolved: true, notReserved: true });
  expect(recovered.uncertain).toBe(false);
  expect(recovered.message).toBe('Immutable original');
  expect(await recovered.files[0].blob?.text()).toBe('hello');
  expect(remote.calls).toEqual(['retryLookup', 'receipt', 'acquire', 'retireRetry']);
  expect(post).toHaveBeenCalledTimes(1);
  post.mockResolvedValueOnce(successor(rejected));
  expect((await flow.retry(scope, 'op')).preparation?.state).toBe('admitted');
  expect(post).toHaveBeenCalledTimes(2);
  expect((await store.get(scope, 'op'))!.retryAttempt?.retryId).not.toBe(attempt.retryId);
  expect(await store.list(scope)).toHaveLength(1);
});
it('a lost retirement reply survives reopening and Check resolves only its durable proof without another POST', async () => {
  const { store, remote, flow, post, proof } = await interrupted();
  vi.spyOn(remote, 'retireRetry').mockImplementation(async () => {
    remote.retirements.set(proof.retry.retryId, proof);
    throw new ApiError('lost retirement reply', 503);
  });
  await expect(flow.recoverRetry(scope, 'op')).rejects.toThrow('lost retirement reply');
  expect((await store.get(scope, 'op'))!.retryAttempt?.resolved).not.toBe(true);
  remote.calls = [];
  const row = await new FirstSend(store, remote).check(scope, 'op');
  expect(row.retryAttempt).toMatchObject({ resolved: true, notReserved: true });
  expect(remote.calls).toEqual(['retryLookup']);
  expect(post).toHaveBeenCalledTimes(1);
});
it('retirement local-save failure keeps the journal recoverable through a later proof GET', async () => {
  const { store, remote, flow, proof } = await interrupted();
  vi.spyOn(remote, 'retireRetry').mockImplementation(async () => {
    remote.retirements.set(proof.retry.retryId, proof);
    store.fail = true;
    return proof;
  });
  await expect(flow.recoverRetry(scope, 'op')).rejects.toThrow('storage failed');
  store.fail = false;
  expect((await store.get(scope, 'op'))!.retryAttempt?.resolved).not.toBe(true);
  expect((await new FirstSend(store, remote).check(scope, 'op')).retryAttempt?.notReserved).toBe(
    true,
  );
});
it('unknown, contradictory and mismatched retirement proofs never unlock the saved retry', async () => {
  const { store, remote, flow, proof } = await interrupted();
  const lookup = vi.spyOn(remote, 'retryLookup');
  for (const change of [
    'nonce',
    'previous',
    'status',
    'flag',
    'command',
    'number',
    'ownAttempt',
    'operation',
    'session',
    'workspace',
  ]) {
    const bad = structuredClone(proof);
    if (change === 'nonce') bad.retry.retryId = 'other';
    if (change === 'previous') bad.retry.previousCommandId = 'other';
    if (change === 'status') bad.retry.status = 'outcome_unknown';
    if (change === 'flag') delete bad.retry.retired;
    if (change === 'command') bad.retry.commandId = 'exists';
    if (change === 'number') bad.retry.attemptNumber = 1;
    if (change === 'ownAttempt') bad.preparation.messageAdmission!.retryId = proof.retry.retryId;
    if (change === 'operation') bad.preparation.operationId = 'other';
    if (change === 'session') bad.preparation.sessionId = 'other';
    if (change === 'workspace') bad.preparation.workspaceId = 'other';
    lookup.mockResolvedValueOnce(bad);
    await expect(flow.check(scope, 'op'), change).rejects.toThrow();
    expect((await store.get(scope, 'op'))!.retryAttempt?.resolved, change).not.toBe(true);
    expect((await store.get(scope, 'op'))!.uncertain, change).toBe(true);
  }
});
it('fresh unsupported capability, account change, or control refusal cannot retire a nonce', async () => {
  const { remote, flow } = await interrupted();
  const retire = vi.spyOn(remote, 'retireRetry'),
    caps = await remote.capabilities();
  const capability = vi.spyOn(remote, 'capabilities');
  for (const c of [
    { ...caps, canRetireFirstMessageRetry: false },
    { ...caps, ownerUser: 'bob' },
    { ...caps, clientContract: 1 },
  ]) {
    capability.mockResolvedValueOnce(c);
    await expect(flow.recoverRetry(scope, 'op')).rejects.toThrow('cannot recover');
  }
  vi.spyOn(remote, 'acquire').mockRejectedValue(new ApiError('control held elsewhere', 409));
  await expect(flow.recoverRetry(scope, 'op')).rejects.toThrow('control held elsewhere');
  expect(retire).not.toHaveBeenCalled();
});
it('a peer Stop during acquisition prevents the retirement POST', async () => {
  const { store, remote, flow } = await interrupted();
  const retire = vi.spyOn(remote, 'retireRetry');
  vi.spyOn(remote, 'acquire').mockImplementation(async () => {
    await store.update(scope, 'op', (r) => ({ ...r!, stopCommandId: 'stop' }));
    return 7;
  });
  await expect(flow.recoverRetry(scope, 'op')).rejects.toThrow('attempt changed');
  expect(retire).not.toHaveBeenCalled();
});
it('a reserved-but-unknown retry returned by recovery remains unknown and is never sent again', async () => {
  const { remote, flow, post, attempt } = await interrupted();
  const next = successor(rejected, 'outcome_unknown', 'outcome_unknown');
  next.messageAdmission!.retryId = attempt.retryId;
  vi.spyOn(remote, 'retireRetry').mockResolvedValue({
    preparation: next,
    retry: {
      retryId: attempt.retryId,
      previousCommandId: attempt.previousCommandId,
      commandId: 'cmd-next',
      attemptNumber: 1,
      status: 'outcome_unknown',
    },
  });
  const row = await flow.recoverRetry(scope, 'op');
  expect(row.retryAttempt?.resolved).toBe(true);
  expect(row.retryAttempt?.notReserved).not.toBe(true);
  expect(row.uncertain).toBe(true);
  expect(post).toHaveBeenCalledTimes(1);
});
it('a late retirement receipt cannot resolve a newer local nonce or undo concurrent deletion', async () => {
  for (const deleted of [false, true]) {
    const { store, remote, flow, proof } = await interrupted();
    vi.spyOn(remote, 'retireRetry').mockImplementation(async () => {
      await store.update(scope, 'op', (row) =>
        deleted
          ? {
              ...row!,
              cancelRequested: true,
              message: '',
              files: [],
              preparation: { ...rejected, state: 'cancelled' },
            }
          : {
              ...row!,
              preparation: successor(rejected, 'admission_failed', 'not_admitted'),
              retryAttempt: {
                retryId: 'newer',
                previousCommandId: 'cmd-next',
                previousAttemptNumber: 1,
              },
              uncertain: true,
            },
      );
      return proof;
    });
    const result = await flow.recoverRetry(scope, 'op');
    if (deleted) {
      expect(result.preparation?.state).toBe('cancelled');
      expect(result.message).toBe('');
      expect(result.files).toEqual([]);
    } else {
      expect(result.retryAttempt?.retryId).toBe('newer');
      expect(result.retryAttempt?.resolved).not.toBe(true);
      expect(result.uncertain).toBe(true);
    }
  }
});

it('reserved proof requires a numeric successor ordinal and a nonempty string command', () => {
  const attempt = { retryId: 'nonce', previousCommandId: 'cmd-original', previousAttemptNumber: 0 };
  const proof: RetryReceipt = {
    preparation: successor(rejected, 'outcome_unknown', 'outcome_unknown'),
    retry: {
      retryId: 'nonce',
      previousCommandId: 'cmd-original',
      commandId: 'cmd-next',
      attemptNumber: 1,
      status: 'outcome_unknown',
    },
  };
  expect(retryRetired(attempt, proof)).toBe(false);
  for (const patch of [
    { attemptNumber: '1' },
    { attemptNumber: 0 },
    { attemptNumber: -1 },
    { attemptNumber: 1.5 },
    { commandId: 123 },
    { commandId: ' ' },
    { commandId: null },
  ]) {
    expect(() =>
      retryRetired(attempt, { ...proof, retry: { ...proof.retry, ...patch } } as RetryReceipt),
    ).toThrow('successor');
  }
});
