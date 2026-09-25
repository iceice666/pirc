import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Message } from './messages.js';

/**
 * Append-only JSONL session. Every entry has a stable id and parent id so the
 * format can grow branches later; the active branch is the chain ending at
 * the most recently appended entry.
 */
interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: number;
}
export type SessionEntry = EntryBase &
  (
    | { type: 'session'; version: 1; sessionId: string; cwd: string }
    | { type: 'message'; message: Message }
    /** Extension state; never sent to the model. */
    | { type: 'custom'; customType: string; data: unknown }
    | {
        type: 'compaction';
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        details?: unknown;
      }
    | { type: 'model_change'; provider: string; modelId: string }
    | { type: 'thinking_level_change'; thinkingLevel: string }
    | { type: 'session_info'; name: string }
  );

type NewEntry = SessionEntry extends infer E
  ? E extends SessionEntry
    ? Omit<E, 'id' | 'parentId' | 'timestamp'>
    : never
  : never;

export const SESSION_FILE = 'session.jsonl';

export class SessionStore {
  readonly file: string;
  private readonly entries: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;

  constructor(
    readonly dir: string,
    cwd: string,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, SESSION_FILE);
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as SessionEntry;
          this.entries.push(entry);
          this.byId.set(entry.id, entry);
          this.leafId = entry.id;
        } catch {
          /* a torn final line after a crash is skipped */
        }
      }
    }
    if (!this.entries.length)
      this.append({
        type: 'session',
        version: 1,
        sessionId: randomBytes(8).toString('hex'),
        cwd,
      });
  }

  get sessionId(): string {
    const header = this.entries[0];
    return header?.type === 'session' ? header.sessionId : 'unknown';
  }

  get isNew(): boolean {
    return this.entries.length <= 1;
  }

  append(entry: NewEntry): SessionEntry {
    let id: string;
    do id = randomBytes(4).toString('hex');
    while (this.byId.has(id));
    const full = { ...entry, id, parentId: this.leafId, timestamp: Date.now() } as SessionEntry;
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    this.entries.push(full);
    this.byId.set(id, full);
    this.leafId = id;
    return full;
  }

  get(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  /** Entries on the active branch, root first. */
  branch(): SessionEntry[] {
    const chain: SessionEntry[] = [];
    let cursor = this.leafId ? this.byId.get(this.leafId) : undefined;
    while (cursor) {
      chain.push(cursor);
      cursor = cursor.parentId ? this.byId.get(cursor.parentId) : undefined;
    }
    return chain.reverse();
  }

  latest<T extends SessionEntry['type']>(type: T): Extract<SessionEntry, { type: T }> | undefined {
    const branch = this.branch();
    for (let index = branch.length - 1; index >= 0; index--)
      if (branch[index]!.type === type) return branch[index] as Extract<SessionEntry, { type: T }>;
    return undefined;
  }

  customEntries(customType: string): Array<Extract<SessionEntry, { type: 'custom' }>> {
    return this.branch().filter(
      (entry): entry is Extract<SessionEntry, { type: 'custom' }> =>
        entry.type === 'custom' && entry.customType === customType,
    );
  }

  /** Every message on the branch (for UI history), including compacted ones. */
  allMessages(): Message[] {
    const out: Message[] = [];
    for (const entry of this.branch()) {
      if (entry.type === 'message') out.push(entry.message);
      else if (entry.type === 'compaction')
        out.push({
          role: 'compactionSummary',
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: entry.timestamp,
        });
    }
    return out;
  }

  /**
   * Messages the model sees: latest compaction summary followed by messages
   * from its `firstKeptEntryId` onward.
   */
  contextEntries(): Array<{ entryId: string; message: Message }> {
    const branch = this.branch();
    let start = 0;
    let summary: { entryId: string; message: Message } | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index]!;
      if (entry.type !== 'compaction') continue;
      const kept = branch.findIndex((item) => item.id === entry.firstKeptEntryId);
      start = kept === -1 ? index + 1 : kept;
      summary = {
        entryId: entry.id,
        message: {
          role: 'compactionSummary',
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: entry.timestamp,
        },
      };
      break;
    }
    const out = summary ? [summary] : [];
    for (const entry of branch.slice(start))
      if (entry.type === 'message') out.push({ entryId: entry.id, message: entry.message });
    return out;
  }

  contextMessages(): Message[] {
    return this.contextEntries().map((item) => item.message);
  }
}
