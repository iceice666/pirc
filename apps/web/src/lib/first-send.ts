/** Durable, account-scoped first Send. Reconnect checks never advance execution. */
import { request, ApiError } from './http';
import { uuid } from './id';
import { getClientId } from './storage';
import type { ThinkingLevel } from './types';
import type { DraftStore } from './first-send-storage';
export interface FirstCapabilities {
  version: number;
  ownerUser?: string;
  canSubmit: boolean;
  canFenceAccount?: boolean;
  canFindPendingSession?: boolean;
}
export interface FirstFile {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number;
  sha256?: string;
  blob?: Blob;
}
export interface FirstSpec {
  workspaceId: string;
  message: string;
  model?: { provider: string; id: string };
  thinking?: ThinkingLevel;
  attachments: Array<Omit<FirstFile, 'blob'>>;
}
export interface Preparation {
  operationId: string;
  sessionId: string;
  workspaceId: string;
  state: string;
  accepted: boolean;
  cleanupPending: boolean;
  cleanupError?: string;
  deliveryError?: string;
  submission?: FirstSpec;
  messageAdmission?: { outcome: string; stopRequested: boolean; stopConfirmed: boolean };
}
export interface FirstDraft {
  scope: string;
  ownerUser: string;
  operationId: string;
  revision: number;
  workspaceId: string;
  message: string;
  model?: { provider: string; id: string };
  thinking?: ThinkingLevel;
  files: FirstFile[];
  frozen: boolean;
  prepareAttempted?: boolean;
  released?: boolean;
  preparation?: Preparation;
  error?: string;
  uncertain?: boolean;
  cancelRequested?: boolean;
  stopCommandId?: string;
  updatedAt: number;
}
export interface FirstTransport {
  capabilities(): Promise<FirstCapabilities>;
  find(owner: string, session: string): Promise<Preparation>;
  lookup(owner: string, op: string, receipt?: boolean): Promise<Preparation>;
  prepare(owner: string, op: string, spec: FirstSpec): Promise<Preparation>;
  upload(owner: string, op: string, file: FirstFile): Promise<void>;
  action(
    owner: string,
    op: string,
    action: 'accept' | 'materialize' | 'dispatch',
    body?: unknown,
  ): Promise<Preparation>;
  acquire(owner: string, session: string, force?: boolean): Promise<number>;
  stop(owner: string, session: string, command: string, generation: number): Promise<void>;
  remove(owner: string, draft: FirstDraft): Promise<void>;
}
const path = (id: string) => `/api/conversation-submissions/${encodeURIComponent(id)}`;
const headers = (owner: string) => ({ 'x-pirc-account': encodeURIComponent(owner) });
const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
const prep = async (promise: Promise<{ preparation: Preparation }>) => (await promise).preparation;
export const firstTransport: FirstTransport = {
  capabilities: () => request('/api/conversation-submissions/capabilities'),
  find: (owner, session) =>
    prep(request(`${path('session')}/${encodeURIComponent(session)}`, { headers: headers(owner) })),
  lookup: (owner, op, receipt) =>
    prep(request(`${path(op)}${receipt ? '/receipt' : ''}`, { headers: headers(owner) })),
  prepare: (owner, op, submission) =>
    prep(
      request('/api/conversation-submissions/prepare', {
        method: 'POST',
        headers: headers(owner),
        body: JSON.stringify({ expectedOwner: owner, operationId: op, submission }),
      }),
    ),
  async upload(owner, op, file) {
    if (!file.blob) throw new Error('The original attachment is missing from local storage.');
    await request(`${path(op)}/attachments/${encodeURIComponent(file.id)}`, {
      method: 'PUT',
      headers: { ...headers(owner), 'content-type': 'application/octet-stream' },
      body: file.blob,
    });
  },
  action: (owner, op, action, body) =>
    prep(
      request(`${path(op)}/${action}`, {
        method: 'POST',
        headers: headers(owner),
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    ),
  async acquire(owner, session, force = false) {
    const { lease } = await request<{ lease: { clientId: string; generation: number } }>(
      `${sessionPath(session)}/control/acquire`,
      {
        method: 'POST',
        headers: headers(owner),
        body: JSON.stringify({ clientId: getClientId(), force }),
      },
    );
    if (lease.clientId !== getClientId() || !lease.generation)
      throw new Error('Another device has control. Take control before continuing.');
    return lease.generation;
  },
  async stop(owner, session, command, generation) {
    try {
      const existing = await request<{ command: { status: string } }>(
        `${sessionPath(session)}/commands/${encodeURIComponent(command)}`,
        { headers: headers(owner) },
      );
      if (existing.command.status === 'accepted') return;
      // A known identity is never replayed just because it is uncertain.
      throw new Error('Stop is still unconfirmed. Check the result before retrying.');
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    const result = await request<{ command: { status: string } }>(
      `${sessionPath(session)}/commands`,
      {
        method: 'POST',
        headers: headers(owner),
        body: JSON.stringify({
          commandId: command,
          clientId: getClientId(),
          generation,
          payload: { type: 'stop' },
        }),
      },
    );
    if (result.command.status !== 'accepted')
      throw new Error('Stop is still unconfirmed. Check the result before retrying.');
  },
  async remove(owner, draft) {
    await request(
      draft.preparation?.accepted
        ? sessionPath(draft.preparation.sessionId)
        : path(draft.operationId),
      { method: 'DELETE', headers: headers(owner) },
    );
  },
};
export const draftScope = (origin: string, owner: string) => JSON.stringify([origin, owner]);
export const pendingFirst = (draft: FirstDraft) =>
  draft.frozen &&
  draft.preparation?.state !== 'admitted' &&
  draft.preparation?.state !== 'cancelled';
export class FirstSend {
  constructor(
    readonly store: DraftStore,
    readonly transport: FirstTransport = firstTransport,
    readonly changed: (draft: FirstDraft | undefined, id: string, scope: string) => void = () => {},
  ) {}
  #write(
    scope: string,
    id: string,
    change: (row: FirstDraft | undefined) => FirstDraft | undefined,
  ) {
    return this.store.update(scope, id, change).then((row) => {
      this.changed(row, id, scope);
      return row;
    });
  }
  async save(
    scope: string,
    ownerUser: string,
    operationId: string,
    value: Pick<FirstDraft, 'workspaceId' | 'message' | 'model' | 'thinking' | 'files'>,
    revision?: number,
  ) {
    return (await this.#write(scope, operationId, (old) => {
      if (!old && revision !== undefined) throw new Error('This draft is no longer available.');
      if (old && (old.frozen || revision === undefined || old.revision !== revision))
        throw new Error('This draft changed in another tab. Reopen the saved version.');
      return {
        ...value,
        scope,
        ownerUser,
        operationId,
        frozen: false,
        prepareAttempted: false,
        revision: (old?.revision ?? 0) + 1,
        updatedAt: Date.now(),
      };
    }))!;
  }
  async #read(scope: string, id: string, allowCancel = false) {
    const row = await this.store.get(scope, id);
    if (!row || (!allowCancel && row.cancelRequested))
      throw new Error('This draft was cancelled. Check its saved outcome.');
    return row;
  }
  async #change(scope: string, id: string, change: (row: FirstDraft) => FirstDraft) {
    return (await this.#write(scope, id, (old) => {
      if (!old) throw new Error('This draft is no longer available.');
      return { ...change(old), revision: old.revision + 1, updatedAt: Date.now() };
    }))!;
  }
  async #receipt(scope: string, id: string, value: Preparation) {
    if (value.operationId !== id) throw new Error('The server returned a different submission.');
    return this.#change(scope, id, (row) => {
      if (
        row.workspaceId !== value.workspaceId ||
        (row.preparation && row.preparation.sessionId !== value.sessionId)
      )
        throw new Error('The original conversation binding changed.');
      const previous = row.preparation;
      // Late replies cannot un-delete content or turn a known acceptance into a draft.
      const keep =
        (previous?.state === 'cancelled' &&
          (value.state !== 'cancelled' || (!previous.cleanupPending && value.cleanupPending))) ||
        (previous?.state === 'admitted' && !['admitted', 'cancelled'].includes(value.state)) ||
        (previous?.accepted && !value.accepted) ||
        (previous?.messageAdmission?.stopConfirmed === true &&
          value.state !== 'cancelled' &&
          value.messageAdmission?.stopConfirmed !== true);
      const current = keep ? previous! : value;
      return {
        ...row,
        preparation: current,
        uncertain: current.state === 'outcome_unknown',
        error: undefined,
        ...(current.state === 'cancelled' ? { message: '', files: [] } : {}),
      };
    });
  }
  #validate(row: FirstDraft) {
    if (
      !row.workspaceId ||
      row.message.length > 1_000_000 ||
      (!row.message.trim() && !row.files.length) ||
      row.files.length > 16
    )
      throw new Error('Check the draft text and attachment count before sending.');
    for (const file of row.files) {
      if (
        !file.byteSize ||
        !file.name.trim() ||
        file.name.length > 255 ||
        /[\\/\0]/.test(file.name) ||
        file.mimeType.length > 127 ||
        !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mimeType)
      )
        throw new Error('An attachment has an unsupported name, type or empty content.');
    }
  }
  async #prepare(row: FirstDraft, cancelling = false) {
    row = await this.#change(row.scope, row.operationId, (old) => {
      if (old.cancelRequested && !cancelling)
        throw new Error('This draft was cancelled. Check its saved outcome.');
      return { ...old, prepareAttempted: true };
    });
    return this.#receipt(
      row.scope,
      row.operationId,
      await this.transport.prepare(row.ownerUser, row.operationId, this.#spec(row)),
    );
  }
  async #hashed(row: FirstDraft) {
    if (!row.preparation?.accepted) this.#validate(row);
    if (!row.frozen)
      row = await this.#change(row.scope, row.operationId, (old) => {
        if (old.revision !== row.revision)
          throw new Error('This draft changed in another tab. Reopen the saved version.');
        return { ...old, frozen: true };
      });
    const files = await Promise.all(
      row.files.map(async (file) => {
        if (file.sha256) return file;
        if (!file.blob) throw new Error('The original attachment is missing from local storage.');
        if (!globalThis.crypto?.subtle)
          throw new Error(
            'Secure local attachment hashing is unavailable. Your files have not been sent.',
          );
        const digest = await crypto.subtle.digest('SHA-256', await file.blob.arrayBuffer());
        return {
          ...file,
          sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
            '',
          ),
        };
      }),
    );
    return this.#change(row.scope, row.operationId, (old) =>
      old.preparation?.state === 'cancelled' ? old : { ...old, files },
    );
  }
  #spec(row: FirstDraft): FirstSpec {
    return {
      workspaceId: row.workspaceId,
      message: row.message,
      ...(row.model ? { model: row.model } : {}),
      ...(row.thinking ? { thinking: row.thinking } : {}),
      attachments: row.files.map(({ blob: _, ...file }) => file),
    };
  }
  async check(scope: string, id: string) {
    const row = await this.#read(scope, id, true);
    if (!row.frozen) return row;
    try {
      return await this.#receipt(
        scope,
        id,
        await this.transport.lookup(row.ownerUser, id, !!row.preparation?.accepted),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && !row.preparation)
        return this.#change(scope, id, (current) => ({
          ...current,
          uncertain: false,
          error: undefined,
        }));
      throw error;
    }
  }
  async run(scope: string, id: string, revision?: number) {
    let row = await this.#read(scope, id);
    if (!row.frozen && revision !== undefined && revision !== row.revision)
      throw new Error('This draft changed in another tab. Reopen the saved version.');
    try {
      row = await this.#hashed(row);
      row = await this.check(scope, id);
      if (!row.preparation) {
        await this.#read(scope, id);
        row = await this.#prepare(row);
      }
      if (row.preparation?.state === 'preparing') {
        for (const file of row.files) {
          await this.#read(scope, id);
          await this.transport.upload(row.ownerUser, id, file);
        }
        await this.#read(scope, id);
        row = await this.#receipt(
          scope,
          id,
          await this.transport.action(row.ownerUser, id, 'accept'),
        );
      }
      if (row.preparation?.state === 'accepted') {
        await this.#read(scope, id);
        row = await this.#receipt(
          scope,
          id,
          await this.transport.action(row.ownerUser, id, 'materialize'),
        );
      }
      if (row.preparation?.state === 'ready') {
        await this.#read(scope, id);
        const generation = await this.transport.acquire(row.ownerUser, row.preparation.sessionId);
        await this.#read(scope, id);
        row = await this.#receipt(
          scope,
          id,
          await this.transport.action(row.ownerUser, id, 'dispatch', {
            clientId: getClientId(),
            generation,
          }),
        );
      }
      return row;
    } catch (error) {
      await this.#change(scope, id, (old) => ({
        ...old,
        error: error instanceof Error ? error.message : String(error),
        uncertain:
          old.prepareAttempted === true && !(error instanceof ApiError && error.status < 500),
      }));
      throw error;
    }
  }
  async adopt(scope: string, ownerUser: string, value: Preparation) {
    if (!value.accepted || !value.submission)
      throw new Error('The accepted first message is unavailable.');
    const spec = value.submission;
    return (await this.#write(
      scope,
      value.operationId,
      (old) =>
        old ?? {
          scope,
          ownerUser,
          operationId: value.operationId,
          revision: 1,
          workspaceId: spec.workspaceId,
          message: spec.message,
          model: spec.model,
          thinking: spec.thinking,
          files: spec.attachments,
          frozen: true,
          prepareAttempted: true,
          preparation: value,
          updatedAt: Date.now(),
        },
    ))!;
  }
  async takeControl(scope: string, id: string) {
    const row = await this.#read(scope, id);
    if (!row.preparation?.accepted || row.preparation.state === 'accepted')
      throw new Error(
        'The Node is still preparing this conversation. Check again before stopping it.',
      );
    return this.transport.acquire(row.ownerUser, row.preparation.sessionId, true);
  }
  async stop(scope: string, id: string) {
    let row = await this.check(scope, id);
    if (!row.preparation?.accepted || row.preparation.state === 'accepted')
      throw new Error(
        'The Node is still preparing this conversation. Check again before stopping it.',
      );
    row = await this.#change(scope, id, (old) => ({
      ...old,
      stopCommandId: old.stopCommandId ?? uuid(),
    }));
    const generation = await this.transport.acquire(row.ownerUser, row.preparation!.sessionId);
    await this.transport.stop(
      row.ownerUser,
      row.preparation!.sessionId,
      row.stopCommandId!,
      generation,
    );
    return this.check(scope, id);
  }
  async discard(scope: string, id: string) {
    let row = await this.#write(scope, id, (old) => {
      if (!old) return undefined;
      // This explicit false is committed before any network attempt. Its
      // atomic removal also stops a peer that was still freezing/hashing.
      if ((!old.frozen || old.prepareAttempted === false) && !old.preparation) return undefined;
      return { ...old, cancelRequested: true, revision: old.revision + 1, updatedAt: Date.now() };
    });
    if (!row) return;
    if (row.preparation?.state === 'cancelled') return this.check(scope, id);
    row = await this.#hashed(row);
    row = await this.check(scope, id);
    if (!row.preparation) row = await this.#prepare(row, true);
    await this.transport.remove(row.ownerUser, row);
    return this.check(scope, id);
  }

  release(scope: string, id: string) {
    return this.#change(scope, id, (row) => {
      if (!row.preparation?.messageAdmission?.stopConfirmed)
        throw new Error('Stop is still unconfirmed. Check the result before retrying.');
      return { ...row, released: true };
    });
  }
  pruneEmpty(scope: string, id: string) {
    return this.#write(scope, id, (row) =>
      row && (row.frozen || row.message || row.files.length) ? row : undefined,
    );
  }
  forget(scope: string, id: string) {
    return this.#write(scope, id, () => undefined);
  }
}
