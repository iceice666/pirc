/**
 * Workspace memory from every node, held by the gateway for the assistant's
 * search (docs/history/assistant.md). Nodes mirror their ledgers (`memory_mirror`);
 * this applies the lines the way the ledger fold does, and finds each item's
 * owner and workspace through the session that wrote it. Items whose session
 * the gateway does not know have no owner and are never found.
 *
 * Search matches every word anywhere (`LIKE`), in any script, and ranks by
 * how many words a note holds: the corpus is small (a few thousand notes),
 * and a trigram index would miss two-character Chinese words anyway.
 */
import { z } from 'zod';
import { localStamp } from '../agent/features/memory/ledger.js';
import type { GatewayDatabase } from '../database.js';
import { ApiError } from '../errors.js';
import { now, safeJson } from '../util.js';
import { resolveDirectoryWorkspace } from './delegations.js';

const itemSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  content: z.string().max(20_000),
  relevance: z.enum(['low', 'medium', 'high', 'critical']),
  timestamp: z.string().max(40),
  sessionId: z.string().min(1).max(200).optional(),
  git: z
    .object({
      head: z.string().max(64),
      branch: z.string().max(300).optional(),
      dirty: z.boolean(),
    })
    .optional(),
  sourceMemoryIds: z.array(z.string().max(40)).max(200),
  origins: z.array(z.string().max(100)).max(50).optional(),
});
/** Items are checked one by one, so one bad item never costs its line. */
const lineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('recorded'), items: z.array(z.unknown()).max(2000) }),
  z.object({
    type: z.literal('retired'),
    ids: z.array(z.string().max(40)).max(2000),
    reason: z.enum(['superseded', 'forgotten']),
  }),
  z.object({ type: z.literal('cleared') }),
]);

export interface MirrorFrame {
  ledgerKey: string;
  offset: number;
  end: number;
  reset?: boolean | undefined;
  lines: unknown[];
}

export interface SearchHit {
  id: string;
  kind: 'workspace' | 'delegation';
  workspace: string;
  date: string;
  /** Workspace notes: active or superseded. Delegations: their status. */
  status: string;
  git?: string;
  relevance?: string;
  content: string;
}

const HIT_CHARS = 600;
const MAX_TERMS = 8;
const fold = (text: string) => text.normalize('NFKC').toLowerCase();
const escapeLike = (term: string) => term.replace(/[\\%_]/g, (char) => `\\${char}`);
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const gitLabel = (git: { head?: string; branch?: string; dirty?: boolean } | null) =>
  git?.head
    ? `${git.branch ?? 'detached'}@${git.head.slice(0, 7)}${git.dirty ? '*' : ''}`
    : undefined;
/** "YYYY-MM-DD HH:MM" in the node's local time, as ms (for ordering only). */
const stampTime = (stamp: string) => {
  const time = Date.parse(stamp.replace(' ', 'T'));
  return Number.isNaN(time) ? 0 : time;
};

export class MemoryRecords {
  constructor(private readonly db: GatewayDatabase) {}

  /** How far the gateway holds each of a node's ledgers, sent when it registers. */
  watermarks(nodeId: string): Record<string, number> {
    return Object.fromEntries(
      (
        this.db.raw
          .prepare('SELECT ledger_key, watermark FROM memory_mirrors WHERE node_id=?')
          .all(nodeId) as Array<{ ledger_key: string; watermark: number }>
      ).map((row) => [row.ledger_key, row.watermark]),
    );
  }

  /**
   * Store a mirrored chunk and return the ledger's watermark. A chunk must
   * start exactly where the stored part ends (or start over with `reset`);
   * anything else is ignored, and the answer tells the node where to resume.
   */
  ingest(nodeId: string, frame: MirrorFrame): number {
    return this.db.raw.transaction(() => {
      const stored = this.db.raw
        .prepare('SELECT watermark FROM memory_mirrors WHERE node_id=? AND ledger_key=?')
        .get(nodeId, frame.ledgerKey) as { watermark: number } | undefined;
      const current = stored?.watermark ?? 0;
      if (frame.reset) {
        if (frame.offset !== 0) return current;
        this.db.raw
          .prepare('DELETE FROM memory_records WHERE node_id=? AND ledger_key=?')
          .run(nodeId, frame.ledgerKey);
      } else if (frame.offset !== current) return current;
      if (frame.end < frame.offset) return frame.reset ? 0 : current;
      for (const raw of frame.lines) {
        const line = lineSchema.safeParse(raw);
        if (line.success) this.apply(nodeId, frame.ledgerKey, line.data);
      }
      this.db.raw
        .prepare(
          'INSERT INTO memory_mirrors (node_id,ledger_key,watermark,updated_at) VALUES (?,?,?,?) ON CONFLICT(node_id,ledger_key) DO UPDATE SET watermark=excluded.watermark, updated_at=excluded.updated_at',
        )
        .run(nodeId, frame.ledgerKey, frame.end, now());
      return frame.end;
    })();
  }

  /** One ledger line, applied like `foldWorkspace`. */
  private apply(nodeId: string, key: string, line: z.infer<typeof lineSchema>): void {
    const where = 'node_id=? AND ledger_key=?';
    if (line.type === 'cleared') {
      this.db.raw
        .prepare(`DELETE FROM memory_records WHERE ${where} AND status!='forgotten'`)
        .run(nodeId, key);
      return;
    }
    if (line.type === 'retired') {
      for (const id of line.ids) {
        if (line.reason === 'superseded') {
          this.db.raw
            .prepare(
              `UPDATE memory_records SET status='superseded' WHERE ${where} AND id=? AND status='active'`,
            )
            .run(nodeId, key, id);
          continue;
        }
        // Forgotten: nothing of it stays here, and it is never recorded again.
        const erased = this.db.raw
          .prepare(
            `UPDATE memory_records SET content='', git_json=NULL, source_ids_json='[]', origins_json=NULL, status='forgotten' WHERE ${where} AND id=?`,
          )
          .run(nodeId, key, id).changes;
        if (!erased)
          this.db.raw
            .prepare(
              "INSERT INTO memory_records (node_id,ledger_key,id,content,relevance,recorded_at,source_ids_json,status) VALUES (?,?,?,'','low','','[]','forgotten')",
            )
            .run(nodeId, key, id);
      }
      return;
    }
    const exists = this.db.raw.prepare(`SELECT 1 FROM memory_records WHERE ${where} AND id=?`);
    const insert = this.db.raw.prepare(
      "INSERT INTO memory_records (node_id,ledger_key,id,content,relevance,recorded_at,git_json,source_ids_json,origins_json,node_session_id,session_id,workspace_id,owner_user,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active')",
    );
    for (const raw of line.items) {
      const parsed = itemSchema.safeParse(raw);
      if (!parsed.success) continue;
      const item = parsed.data;
      // First record wins, and a forgotten id stays forgotten.
      if (exists.get(nodeId, key, item.id)) continue;
      const source = this.source(nodeId, item.sessionId);
      insert.run(
        nodeId,
        key,
        item.id,
        item.content,
        item.relevance,
        item.timestamp,
        item.git ? JSON.stringify(item.git) : null,
        JSON.stringify(item.sourceMemoryIds),
        item.origins ? JSON.stringify(item.origins) : null,
        item.sessionId ?? null,
        source.sessionId ?? null,
        source.workspaceId ?? null,
        source.ownerUser ?? null,
      );
    }
  }

  /** The gateway's session behind a node session: its owner and workspace. */
  private source(
    nodeId: string,
    nodeSessionId: string | undefined,
  ): { sessionId?: string; workspaceId?: string; ownerUser?: string } {
    if (!nodeSessionId) return {};
    const sessionId = this.db.resolveRemoteSession(nodeId, nodeSessionId);
    if (!sessionId) return {};
    const session = this.db.getSession(sessionId);
    return {
      sessionId,
      workspaceId: session.workspaceId,
      ...(session.ownerUser ? { ownerUser: session.ownerUser } : {}),
    };
  }

  // ---------- reading ----------

  /**
   * Notes and delegations of `user` holding any of the words in `query`, most
   * words first, then current before superseded, then newest.
   */
  search(user: string, query: string, options: { workspace?: string; limit?: number } = {}) {
    const terms = [...new Set(fold(query).split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
    if (!terms.length) throw new ApiError(400, 'invalid_input', 'query is required');
    const limit = Math.min(20, Math.max(1, Math.floor(options.limit ?? 8)));
    const workspace = options.workspace
      ? resolveDirectoryWorkspace(this.db, options.workspace)
      : undefined;
    const patterns = terms.map((term) => `%${escapeLike(term)}%`);
    const anyTerm = (column: string) =>
      `(${terms.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    const records = this.db.raw
      .prepare(
        `SELECT * FROM memory_records WHERE owner_user=? AND status IN ('active','superseded') AND ${anyTerm('content')}${
          workspace
            ? " AND (node_id || '/' || ledger_key) IN (SELECT node_id || '/' || ledger_key FROM memory_records WHERE workspace_id=?)"
            : ''
        }`,
      )
      .all(user, ...patterns, ...(workspace ? [workspace.id] : [])) as any[];
    const delegations = this.db.raw
      .prepare(
        `SELECT * FROM delegations WHERE owner_user=? AND ${anyTerm("(title || ' ' || task || ' ' || COALESCE(result, ''))")}${workspace ? ' AND workspace_id=?' : ''}`,
      )
      .all(user, ...patterns, ...(workspace ? [workspace.id] : [])) as any[];
    const score = (text: string) => {
      const folded = fold(text);
      return terms.filter((term) => folded.includes(term)).length;
    };
    const ranked: Array<{ score: number; current: boolean; time: number; hit: SearchHit }> = [
      ...records.map((row) => {
        const git = gitLabel(safeJson(row.git_json ?? 'null', null));
        return {
          score: score(row.content),
          current: row.status === 'active',
          time: stampTime(row.recorded_at),
          hit: {
            id: row.id,
            kind: 'workspace' as const,
            workspace: this.label(row.workspace_id, row.node_id),
            date: row.recorded_at,
            status: row.status,
            ...(git ? { git } : {}),
            relevance: row.relevance,
            content: clip(row.content, HIT_CHARS),
          },
        };
      }),
      ...delegations.map((row) => ({
        score: score(`${row.title} ${row.task} ${row.result ?? ''}`),
        current: true,
        time: row.updated_at,
        hit: {
          id: row.id,
          kind: 'delegation' as const,
          workspace: this.label(row.workspace_id),
          date: localStamp(row.updated_at),
          status: row.status,
          content: clip(`${row.title}: ${row.result ?? row.task}`, HIT_CHARS),
        },
      })),
    ];
    return ranked
      .sort((a, b) => b.score - a.score || Number(b.current) - Number(a.current) || b.time - a.time)
      .slice(0, limit)
      .map((item) => item.hit);
  }

  /** The user's mirrored notes with this id (usually one), for recall. */
  find(user: string, id: string) {
    return (
      this.db.raw
        .prepare(
          "SELECT * FROM memory_records WHERE id=? AND owner_user=? AND status!='forgotten' ORDER BY rowid",
        )
        .all(id, user) as any[]
    ).map((row) => ({
      nodeId: row.node_id as string,
      ledgerKey: row.ledger_key as string,
      workspace: this.label(row.workspace_id, row.node_id),
      date: row.recorded_at as string,
      status: row.status as string,
      content: row.content as string,
    }));
  }

  private label(workspaceId: string | null, nodeId?: string): string {
    if (workspaceId)
      try {
        const workspace = this.db.getWorkspace(workspaceId);
        return `${workspace.displayName} on ${workspace.hostId}`;
      } catch {
        /* removed since */
      }
    return nodeId ? `a repository on ${nodeId}` : (workspaceId ?? 'a workspace');
  }
}
