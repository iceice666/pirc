import { ApiError } from '../http';
import type { DraftStore } from '../first-send-storage';
import type {
  FirstCapabilities,
  FirstDraft,
  FirstSpec,
  FirstTransport,
  Preparation,
} from '../first-send';
export class MemoryDraftStore implements DraftStore {
  values = new Map<string, FirstDraft>();
  fail = false;
  key(scope: string, id: string) {
    return JSON.stringify([scope, id]);
  }
  async list(scope: string) {
    return [...this.values.values()].filter((row) => row.scope === scope);
  }
  async get(scope: string, id: string) {
    return this.values.get(this.key(scope, id));
  }
  async update(
    scope: string,
    id: string,
    change: (row: FirstDraft | undefined) => FirstDraft | undefined,
  ) {
    if (this.fail) throw new Error('storage failed');
    const key = this.key(scope, id),
      row = change(this.values.get(key));
    if (row) this.values.set(key, row);
    else this.values.delete(key);
    return row;
  }
}
export class FirstLedger implements FirstTransport {
  entries = new Map<string, Preparation>();
  calls: string[] = [];
  failDispatch = false;
  key(owner: string, id: string) {
    return JSON.stringify([owner, id]);
  }
  async capabilities(): Promise<FirstCapabilities> {
    return {
      version: 1,
      clientContract: 2,
      requiredClientContract: 2,
      ownerUser: 'alice',
      canFenceAccount: true,
      canStopBeforeAllocation: true,
      canSubmit: true,
    };
  }
  async find(owner: string, session: string) {
    const row = [...this.entries.entries()].find(
      ([key, row]) =>
        key.startsWith(JSON.stringify([owner]).slice(0, -1)) && row.sessionId === session,
    )?.[1];
    if (!row) throw new ApiError('missing', 404);
    return row;
  }
  async lookup(owner: string, id: string, receipt?: boolean) {
    this.calls.push(receipt ? 'receipt' : 'lookup');
    const row = this.entries.get(this.key(owner, id));
    if (!row) throw new ApiError('missing', 404);
    return row;
  }
  async prepare(owner: string, id: string, submission: FirstSpec) {
    this.calls.push('prepare');
    let row = this.entries.get(this.key(owner, id));
    if (!row) {
      row = {
        operationId: id,
        sessionId: 'public-session',
        workspaceId: submission.workspaceId,
        state: 'preparing',
        accepted: false,
        cleanupPending: false,
        submission,
      };
      this.entries.set(this.key(owner, id), row);
    }
    return row;
  }
  async upload() {
    this.calls.push('upload');
  }
  async action(
    owner: string,
    id: string,
    action: 'accept' | 'materialize' | 'dispatch',
  ): Promise<Preparation> {
    this.calls.push(action);
    const prior = this.entries.get(this.key(owner, id))!;
    const row = {
      ...prior,
      accepted: true,
      nodeMapped: action !== 'accept',
      state: prior.messageAdmission?.stopConfirmed
        ? 'stopped'
        : action === 'accept'
          ? 'accepted'
          : action === 'materialize'
            ? 'ready'
            : 'admitted',
    };
    this.entries.set(this.key(owner, id), row);
    if (action === 'dispatch' && this.failDispatch) {
      this.failDispatch = false;
      throw new ApiError('response lost', 503);
    }
    return row;
  }
  async acquire() {
    this.calls.push('acquire');
    return 7;
  }
  async acquirePending() {
    this.calls.push('acquirePending');
    return { clientId: 'pending-client', generation: 8 };
  }
  async stopPending(owner: string, op: string) {
    this.calls.push('stopPending');
    const key = this.key(owner, op),
      prior = this.entries.get(key)!;
    const row = {
      ...prior,
      state: 'stopping',
      nodeMapped: false,
      messageAdmission: { outcome: 'outcome_unknown', stopRequested: true, stopConfirmed: false },
    };
    this.entries.set(key, row);
    return row;
  }
  async stop(owner: string, session: string) {
    this.calls.push('stop');
    const entry = [...this.entries.entries()].find(([, row]) => row.sessionId === session)!;
    this.entries.set(entry[0], {
      ...entry[1],
      state: 'stopped',
      messageAdmission: { outcome: 'outcome_unknown', stopRequested: true, stopConfirmed: true },
    });
  }
  async remove(owner: string, draft: FirstDraft) {
    this.calls.push('delete');
    const key = this.key(owner, draft.operationId),
      before = this.entries.get(key)!;
    this.entries.set(key, {
      ...before,
      state: 'cancelled',
      cleanupPending: true,
      submission: undefined,
    });
  }
}
