/**
 * The assistant's memory, held by the gateway for each user
 * (docs/history/assistant.md). USER entries say who the user is and what they want;
 * they change only when the user approves a proposal. MEMORY notes are the
 * assistant's own, written directly. Every change is logged as a revision.
 * Forgetting erases an entry's content and history and keeps only hashes, so
 * the same text cannot be saved again.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { redactSecrets } from '../agent/features/memory/redact.js';
import { ApiError } from '../errors.js';
import { now, safeJson } from '../util.js';

export type MemoryKind = 'user' | 'note';
export type MemoryStatus = 'active' | 'removed' | 'forgotten';
export type MemoryAction = 'add' | 'replace' | 'remove';

/** Where a revision's text came from. Always set by code, never by a model. */
export interface MemorySources {
  /** Gateway session the change came from. */
  sessionId?: string;
  /** History entries of that session that back it (the user's quoted messages). */
  entryIds?: string[];
  /** The user's exact words, when the change rests on them (always, for USER). */
  quote?: string;
  /** The approved proposal behind a USER revision. */
  proposalId?: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  /** Empty once forgotten. */
  content: string;
  status: MemoryStatus;
  revision: number;
  /** Origins of the current text (`user`, `assistant`, `tool:<name>`, `custom:<type>`). */
  origins: string[];
  sources: MemorySources;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryVersion {
  revision: number;
  op: 'add' | 'replace' | 'remove' | 'restore' | 'forget';
  /** The text after this change; absent for remove and forget. */
  content: string | null;
  origins: string[];
  sources: MemorySources;
  /** `user:<name>` or `session:<gateway session id>`. */
  actor: string;
  at: number;
}

export interface MemoryProposal {
  id: string;
  action: MemoryAction;
  /** The USER entry changed (for add: the entry created, once approved). */
  targetId: string | null;
  /** The target's revision the assistant saw when it proposed. */
  targetRevision: number | null;
  /** The proposed text; absent for remove, and once forgotten. */
  content: string | null;
  /** The user's exact words the proposal rests on; empty once forgotten. */
  quote: string;
  sources: MemorySources;
  sessionId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt: number | null;
}

export interface MemoryBudgets {
  user: number;
  note: number;
}
export type MemoryUsage = Record<MemoryKind, { used: number; max: number }>;

/** Who is changing memory, and what backs the change. */
export interface MemoryChange {
  actor: string;
  origins: string[];
  sources: MemorySources;
}

export const ENTRY_MAX_CHARS = 1000;
export const QUOTE_MAX_CHARS = 1000;
export const PENDING_PROPOSALS_MAX = 20;
const LABEL: Record<MemoryKind, string> = { user: 'USER', note: 'MEMORY' };

/** Entries are single lines; secrets are removed before anything is stored. */
const clean = (text: string) => redactSecrets(text).replace(/\s+/g, ' ').trim();

/** Hash that ignores case, width and spacing, so trivial rewordings of forgotten text still match. */
export const contentHash = (text: string) =>
  createHash('sha256')
    .update(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');

function entryText(value: string | null | undefined): string {
  const text = clean(value ?? '');
  if (!text) throw new ApiError(400, 'invalid_input', 'content is required');
  if (text.length > ENTRY_MAX_CHARS)
    throw new ApiError(
      413,
      'payload_too_large',
      `One entry holds at most ${ENTRY_MAX_CHARS} characters; split it into separate facts`,
    );
  return text;
}

const entryOf = (row: any): MemoryEntry => ({
  id: row.id,
  kind: row.kind,
  content: row.content,
  status: row.status,
  revision: row.revision,
  origins: safeJson(row.origins_json, []),
  sources: safeJson(row.sources_json, {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const proposalOf = (row: any): MemoryProposal => ({
  id: row.id,
  action: row.action,
  targetId: row.target_id ?? null,
  targetRevision: row.target_revision ?? null,
  content: row.content ?? null,
  quote: row.quote,
  sources: safeJson(row.sources_json, {}),
  sessionId: row.session_id,
  status: row.status,
  createdAt: row.created_at,
  decidedAt: row.decided_at ?? null,
});

export class MemoryStore {
  constructor(
    private readonly db: Database,
    readonly budgets: MemoryBudgets,
  ) {}

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------- reading ----------

  entries(user: string, filter: { kind?: MemoryKind; status?: MemoryStatus } = {}): MemoryEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_entries WHERE owner_user=? ORDER BY created_at, id')
        .all(user) as any[]
    )
      .map(entryOf)
      .filter(
        (entry) =>
          (!filter.kind || entry.kind === filter.kind) &&
          (!filter.status || entry.status === filter.status),
      );
  }

  entry(user: string, id: string): MemoryEntry {
    const row = this.db
      .prepare('SELECT * FROM memory_entries WHERE id=? AND owner_user=?')
      .get(id, user);
    if (!row) throw new ApiError(404, 'not_found', `No memory entry ${id}`);
    return entryOf(row);
  }

  usage(user: string): MemoryUsage {
    const used = { user: 0, note: 0 };
    for (const entry of this.entries(user, { status: 'active' }))
      used[entry.kind] += entry.content.length;
    return {
      user: { used: used.user, max: this.budgets.user },
      note: { used: used.note, max: this.budgets.note },
    };
  }

  /** Newest first. */
  history(user: string, id: string): MemoryVersion[] {
    this.entry(user, id);
    return (
      this.db
        .prepare('SELECT * FROM memory_log WHERE entry_id=? AND owner_user=? ORDER BY seq DESC')
        .all(id, user) as any[]
    ).map((row) => ({
      revision: row.revision,
      op: row.op,
      content: row.content ?? null,
      origins: safeJson(row.origins_json, []),
      sources: safeJson(row.sources_json, {}),
      actor: row.actor,
      at: row.at,
    }));
  }

  proposals(user: string, status?: MemoryProposal['status']): MemoryProposal[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_proposals WHERE owner_user=? ORDER BY created_at, id')
        .all(user) as any[]
    )
      .map(proposalOf)
      .filter((proposal) => !status || proposal.status === status);
  }

  proposal(user: string, id: string): MemoryProposal {
    const row = this.db
      .prepare('SELECT * FROM memory_proposals WHERE id=? AND owner_user=?')
      .get(id, user);
    if (!row) throw new ApiError(404, 'not_found', `No memory proposal ${id}`);
    return proposalOf(row);
  }

  /** What an assistant session starts with. */
  context(user: string, sessionId?: string) {
    const active = this.entries(user, { status: 'active' });
    const brief = ({ id, content, revision, updatedAt }: MemoryEntry) => ({
      id,
      content,
      revision,
      updatedAt,
    });
    return {
      user: active.filter((entry) => entry.kind === 'user').map(brief),
      notes: active.filter((entry) => entry.kind === 'note').map(brief),
      usage: this.usage(user),
      pendingProposals: this.proposals(user, 'pending').length,
      proposalDecisions: sessionId
        ? this.proposals(user)
            .filter((p) => p.sessionId === sessionId && p.status !== 'pending')
            .sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0))
            .slice(-20)
            .map((p) => ({
              id: p.id,
              action: p.action,
              status: p.status,
              targetId: p.targetId,
              decidedAt: p.decidedAt,
            }))
        : [],
    };
  }

  // ---------- the assistant ----------

  /**
   * The assistant adds, replaces or removes one of its notes. For replace and
   * remove, `baseRevision` is the version it last saw; anything else (or none)
   * is a conflict that returns the current version, so another chat's change
   * is never overwritten unseen. An unchanged note is returned as is.
   */
  writeNote(
    user: string,
    input: { action: MemoryAction; id?: string; content?: string; baseRevision?: number | null },
    change: MemoryChange,
  ): { entry: MemoryEntry; unchanged: boolean } {
    return this.tx(() => {
      if (input.action === 'add') {
        const content = entryText(input.content);
        this.refuseForgotten(user, content);
        const same = this.activeWith(user, 'note', content);
        if (same) return { entry: same, unchanged: true };
        this.makeRoom(user, 'note', content.length);
        return { entry: this.insert(user, 'note', content, change), unchanged: false };
      }
      const entry = this.entry(user, input.id ?? '');
      if (entry.kind !== 'note')
        throw new ApiError(
          403,
          'forbidden',
          `${entry.id} is a USER entry; USER changes only when the user approves a proposal`,
        );
      if (entry.status === 'forgotten')
        throw new ApiError(409, 'forgotten', 'The user asked to forget this note');
      if (entry.status === 'removed')
        throw new ApiError(409, 'conflict', `Note ${entry.id} was removed; add a new note instead`);
      if (input.baseRevision !== entry.revision)
        throw new ApiError(409, 'conflict', `Note ${entry.id} changed since you last saw it`, {
          id: entry.id,
          revision: entry.revision,
          content: entry.content,
        });
      if (input.action === 'remove')
        return {
          entry: this.update(user, entry, { status: 'removed' }, 'remove', change.actor),
          unchanged: false,
        };
      const content = entryText(input.content);
      if (contentHash(content) === contentHash(entry.content)) return { entry, unchanged: true };
      this.refuseForgotten(user, content);
      this.makeRoom(user, 'note', content.length - entry.content.length);
      return {
        entry: this.update(
          user,
          entry,
          { content, origins: change.origins, sources: change.sources },
          'replace',
          change.actor,
        ),
        unchanged: false,
      };
    });
  }

  /**
   * The assistant proposes a USER change resting on the user's exact words.
   * Nothing changes until the user approves it. Proposing the same change
   * again returns the pending proposal.
   */
  propose(
    user: string,
    sessionId: string,
    input: {
      action: MemoryAction;
      id?: string;
      content?: string;
      baseRevision?: number | null;
      quote: string;
    },
    sources: MemorySources,
  ): { proposal: MemoryProposal; duplicate: boolean } {
    return this.tx(() => {
      const quote = clean(input.quote);
      if (!quote)
        throw new ApiError(400, 'invalid_input', "A USER change needs the user's exact words");
      if (quote.length > QUOTE_MAX_CHARS)
        throw new ApiError(
          413,
          'payload_too_large',
          `Quote at most ${QUOTE_MAX_CHARS} characters of the user's words`,
        );
      let target: MemoryEntry | undefined;
      if (input.action !== 'add') {
        target = this.entry(user, input.id ?? '');
        if (target.kind !== 'user' || target.status !== 'active')
          throw new ApiError(404, 'not_found', `No USER entry ${input.id}`);
      }
      const content = input.action === 'remove' ? null : entryText(input.content);
      if (content) {
        this.refuseForgotten(user, content);
        if (target && contentHash(content) === contentHash(target.content))
          throw new ApiError(409, 'conflict', `USER entry ${target.id} already says this`);
        const same = this.activeWith(user, 'user', content);
        if (!target && same)
          throw new ApiError(409, 'conflict', `USER already says this (${same.id})`);
      }
      const hash = content ? contentHash(content) : null;
      const matching = (this.db
        .prepare(
          'SELECT * FROM memory_proposals WHERE owner_user=? AND action=? AND target_id IS ? AND content_hash IS ? ORDER BY created_at DESC',
        )
        .all(user, input.action, target?.id ?? null, hash) ?? []) as any[];
      const pending = matching.find((row) => row.status === 'pending');
      if (pending) return { proposal: proposalOf(pending), duplicate: true };
      if (matching.some((row) => row.status === 'rejected'))
        throw new ApiError(
          409,
          'rejected_before',
          'The user already rejected this exact change; do not propose it again',
        );
      const waiting = this.proposals(user, 'pending').length;
      if (waiting >= PENDING_PROPOSALS_MAX)
        throw new ApiError(
          429,
          'too_many_requests',
          `${waiting} proposals are already waiting; ask the user to review them in Settings → Memory`,
        );
      if (content) this.makeRoom(user, 'user', content.length - (target?.content.length ?? 0));
      const id = this.newId('memory_proposals', 'p');
      this.db
        .prepare(
          'INSERT INTO memory_proposals (id,owner_user,action,target_id,target_revision,content,content_hash,quote,sources_json,session_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          user,
          input.action,
          target?.id ?? null,
          target ? (input.baseRevision ?? null) : null,
          content,
          hash,
          quote,
          JSON.stringify(sources),
          sessionId,
          'pending',
          now(),
        );
      return { proposal: this.proposal(user, id), duplicate: false };
    });
  }

  /** Erase entries created here, not entries merely recalled or edited here. */
  forgetSession(user: string, sessionId: string): void {
    this.tx(() => {
      const rows = this.db
        .query('SELECT id FROM memory_entries WHERE owner_user=? AND created_by_session=?')
        .all(user, sessionId) as { id: string }[];
      for (const row of rows) this.forget(user, row.id);
      this.db
        .query('DELETE FROM memory_proposals WHERE owner_user=? AND session_id=?')
        .run(user, sessionId);
    });
  }

  // ---------- the user ----------

  /**
   * Apply a pending proposal. `targetRevision` is the version of the target
   * the user was shown; if it changed since, nothing is applied.
   */
  approve(
    user: string,
    proposalId: string,
    targetRevision?: number,
  ): { proposal: MemoryProposal; entry: MemoryEntry } {
    return this.tx(() => {
      const proposal = this.pending(user, proposalId);
      const actor = `user:${user}`;
      const change: MemoryChange = {
        actor,
        origins: ['user'],
        sources: { ...proposal.sources, quote: proposal.quote, proposalId: proposal.id },
      };
      let entry: MemoryEntry;
      if (proposal.action === 'add') {
        const content = proposal.content!;
        this.refuseForgotten(user, content);
        const same = this.activeWith(user, 'user', content);
        if (same) entry = same;
        else {
          this.makeRoom(user, 'user', content.length);
          entry = this.insert(user, 'user', content, change);
        }
      } else {
        const target = this.entry(user, proposal.targetId!);
        if (target.status !== 'active')
          throw new ApiError(
            409,
            'conflict',
            `USER entry ${target.id} was removed or forgotten since this was proposed; reject the proposal`,
          );
        if (targetRevision !== undefined && targetRevision !== target.revision)
          throw new ApiError(409, 'conflict', `USER entry ${target.id} changed; review it again`, {
            id: target.id,
            revision: target.revision,
          });
        if (proposal.action === 'remove')
          entry = this.update(user, target, { status: 'removed' }, 'remove', actor);
        else {
          const content = proposal.content!;
          this.refuseForgotten(user, content);
          this.makeRoom(user, 'user', content.length - target.content.length);
          entry = this.update(
            user,
            target,
            { content, origins: change.origins, sources: change.sources },
            'replace',
            actor,
          );
        }
      }
      this.db
        .prepare(
          "UPDATE memory_proposals SET status='approved', decided_at=?, target_id=? WHERE id=?",
        )
        .run(now(), entry.id, proposal.id);
      return { proposal: this.proposal(user, proposal.id), entry };
    });
  }

  reject(user: string, proposalId: string): MemoryProposal {
    return this.tx(() => {
      this.pending(user, proposalId);
      this.db
        .prepare("UPDATE memory_proposals SET status='rejected', decided_at=? WHERE id=?")
        .run(now(), proposalId);
      return this.proposal(user, proposalId);
    });
  }

  /**
   * Erase an entry: its text, every earlier version and the proposals that
   * carry them. Hashes of all its versions stay as tombstones, which refuse
   * the same text (ignoring case and spacing) from then on. Rewordings are not
   * caught. Session transcripts on the nodes are not touched.
   */
  forget(user: string, entryId: string): void {
    this.tx(() => {
      const entry = this.entry(user, entryId);
      if (entry.status === 'forgotten') return;
      const versions = this.db
        .prepare(
          'SELECT content FROM memory_log WHERE entry_id=? AND owner_user=? AND content IS NOT NULL',
        )
        .all(entryId, user) as Array<{ content: string }>;
      const hashes = [
        ...new Set(
          [entry.content, ...versions.map((version) => version.content)]
            .filter(Boolean)
            .map(contentHash),
        ),
      ];
      const at = now();
      const tombstone = this.db.prepare(
        'INSERT OR IGNORE INTO memory_tombstones (owner_user,content_hash,forgotten_at) VALUES (?,?,?)',
      );
      for (const hash of hashes) tombstone.run(user, hash, at);
      this.db
        .prepare(
          "UPDATE memory_entries SET content='', status='forgotten', revision=revision+1, origins_json='[]', sources_json='{}', updated_at=? WHERE id=?",
        )
        .run(at, entryId);
      this.db
        .prepare('DELETE FROM memory_log WHERE entry_id=? AND owner_user=?')
        .run(entryId, user);
      this.log(user, this.entry(user, entryId), 'forget', `user:${user}`);
      this.db
        .prepare(
          `UPDATE memory_proposals SET content=NULL, quote='', sources_json='{}', status=CASE WHEN status='pending' THEN 'rejected' ELSE status END, decided_at=COALESCE(decided_at, ?) WHERE owner_user=? AND (target_id=?${hashes.length ? ` OR content_hash IN (${hashes.map(() => '?').join(',')})` : ''})`,
        )
        .run(at, user, entryId, ...hashes);
    });
  }

  /**
   * Bring back a removed entry, or an earlier version (`revision`) of an
   * active or removed one. The user acts directly: USER needs no proposal.
   */
  restore(user: string, entryId: string, revision?: number): MemoryEntry {
    return this.tx(() => {
      const entry = this.entry(user, entryId);
      if (entry.status === 'forgotten')
        throw new ApiError(
          409,
          'forgotten',
          'This entry was forgotten; nothing is left to restore',
        );
      let version: Pick<MemoryEntry, 'content' | 'origins' | 'sources'>;
      if (revision === undefined) {
        if (entry.status === 'active') return entry;
        version = entry;
      } else {
        const row = this.db
          .prepare(
            'SELECT * FROM memory_log WHERE entry_id=? AND owner_user=? AND revision=? AND content IS NOT NULL',
          )
          .get(entryId, user, revision) as any;
        if (!row) throw new ApiError(404, 'not_found', `No version ${revision} of ${entryId}`);
        version = {
          content: row.content,
          origins: safeJson(row.origins_json, []),
          sources: safeJson(row.sources_json, {}),
        };
      }
      if (entry.status === 'active' && version.content === entry.content) return entry;
      this.refuseForgotten(user, version.content);
      this.makeRoom(
        user,
        entry.kind,
        version.content.length - (entry.status === 'active' ? entry.content.length : 0),
      );
      return this.update(
        user,
        entry,
        {
          content: version.content,
          status: 'active',
          origins: version.origins,
          sources: version.sources,
        },
        'restore',
        `user:${user}`,
      );
    });
  }

  // ---------- internals ----------

  private pending(user: string, proposalId: string): MemoryProposal {
    const proposal = this.proposal(user, proposalId);
    if (proposal.status !== 'pending')
      throw new ApiError(409, 'conflict', `Proposal ${proposalId} was already ${proposal.status}`);
    return proposal;
  }

  private activeWith(user: string, kind: MemoryKind, content: string): MemoryEntry | undefined {
    const hash = contentHash(content);
    return this.entries(user, { kind, status: 'active' }).find(
      (entry) => contentHash(entry.content) === hash,
    );
  }

  private refuseForgotten(user: string, content: string): void {
    if (
      this.db
        .prepare('SELECT 1 FROM memory_tombstones WHERE owner_user=? AND content_hash=?')
        .get(user, contentHash(content))
    )
      throw new ApiError(409, 'forgotten', 'The user asked to forget this; do not save it again');
  }

  private makeRoom(user: string, kind: MemoryKind, delta: number): void {
    if (delta <= 0) return;
    const { used, max } = this.usage(user)[kind];
    if (used + delta > max)
      throw new ApiError(
        409,
        'memory_full',
        `${LABEL[kind]} is full (${used.toLocaleString('en-US')}/${max.toLocaleString('en-US')} characters, ${delta.toLocaleString('en-US')} more needed); replace or remove entries to make room`,
        { kind, used, max, needed: delta },
      );
  }

  private newId(table: 'memory_entries' | 'memory_proposals', prefix: string): string {
    const exists = this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`);
    for (;;) {
      const id = `${prefix}${randomBytes(4).toString('hex')}`;
      if (!exists.get(id)) return id;
    }
  }

  private insert(user: string, kind: MemoryKind, content: string, change: MemoryChange) {
    const id = this.newId('memory_entries', kind === 'user' ? 'u' : 'n');
    const at = now();
    this.db
      .prepare(
        "INSERT INTO memory_entries (id,owner_user,kind,content,status,revision,origins_json,sources_json,created_at,updated_at,created_by_session) VALUES (?,?,?,?,'active',1,?,?,?,?,?)",
      )
      .run(
        id,
        user,
        kind,
        content,
        JSON.stringify(change.origins),
        JSON.stringify(change.sources),
        at,
        at,
        change.sources.sessionId ?? null,
      );
    const entry = this.entry(user, id);
    this.log(user, entry, 'add', change.actor);
    return entry;
  }

  private update(
    user: string,
    entry: MemoryEntry,
    next: Partial<Pick<MemoryEntry, 'content' | 'status' | 'origins' | 'sources'>>,
    op: MemoryVersion['op'],
    actor: string,
  ): MemoryEntry {
    const merged = { ...entry, ...next };
    this.db
      .prepare(
        'UPDATE memory_entries SET content=?, status=?, revision=?, origins_json=?, sources_json=?, updated_at=? WHERE id=? AND owner_user=?',
      )
      .run(
        merged.content,
        merged.status,
        entry.revision + 1,
        JSON.stringify(merged.origins),
        JSON.stringify(merged.sources),
        now(),
        entry.id,
        user,
      );
    const updated = this.entry(user, entry.id);
    this.log(user, updated, op, actor);
    return updated;
  }

  private log(user: string, entry: MemoryEntry, op: MemoryVersion['op'], actor: string): void {
    const kept = op !== 'remove' && op !== 'forget';
    this.db
      .prepare(
        'INSERT INTO memory_log (owner_user,entry_id,revision,op,content,origins_json,sources_json,actor,at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        user,
        entry.id,
        entry.revision,
        op,
        kept ? entry.content : null,
        JSON.stringify(kept ? entry.origins : []),
        JSON.stringify(kept ? entry.sources : {}),
        actor,
        now(),
      );
  }
}
