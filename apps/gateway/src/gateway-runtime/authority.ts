import { Database } from 'bun:sqlite';
import { InnerJournal } from '../environment/inner-journal.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  validateTurnDescriptor,
  validateTurnInput,
  type AuthorityTurn,
  type TurnInput,
} from './turn-contracts.js';
import type { Descriptor } from '../environment/protocol.js';
import type { ImageContent } from '../agent/messages.js';
import { redactSecrets } from '../agent/features/memory/redact.js';
import { chmodSync } from 'node:fs';
import { z } from 'zod';
import { canonicalJson, digest, parseJson, type Json } from '../environment/json.js';
import {
  bindingSchema,
  CONTROL_BYTES,
  REQUEST_BYTES,
  RESULT_BYTES,
  validateIntent,
  intentDigest,
  validateRecordDelivery,
  recordSchema,
  artifactSchema,
  type Binding,
  type ExecutionIntent,
  type ExecutionRecord,
  type Environment,
} from '../environment/protocol.js';
import {
  contextEntriesOf,
  historyWithOperations,
  PTC_STORE_ENTRY,
  OPERATION_ENTRY,
} from '../agent/session-store.js';
import {
  planPtc,
  validatePtcStore,
  validatePtcProvenance,
  type PtcStoreSnapshot,
  type PtcPlan,
} from './ptc-contracts.js';
import {
  ENTRY_BYTES,
  entrySchema,
  legacyReferenceSchema,
  transferSchema,
  type AuthorityEntry,
  type EntryInput,
  type WriterFenceReceipt,
  type WriterLease,
  type WriterTransfer,
} from './contracts.js';

interface SessionRow {
  id: string;
  owner: string;
  binding: string;
  transfer: string;
  state: 'pending' | 'active' | 'revoked';
  branch: string;
  context: string;
  store: string;
}
interface ExecutionRow {
  intent: string;
  branch: string;
  receipt: string | null;
}
const recoveredDatabases = new WeakSet<Database>();
const uuid = z.string().uuid();
const sameBinding = (a: Binding, b: Binding) =>
  canonicalJson(a, CONTROL_BYTES) === canonicalJson(b, CONTROL_BYTES);

/**
 * New-session authority foundation. No production routing, JSONL import or worker
 * launch. Only the trusted supervisor owns this database and lifecycle methods.
 * A worker receives a bound interface, never this database or a provision API.
 */
export class GatewaySessionAuthority {
  private readonly db: Database;
  private readonly ownsDatabase: boolean;
  private runtimeRecovered = false;
  readonly inner: InnerJournal;
  constructor(
    file: string | Database,
    private readonly now = Date.now,
  ) {
    this.ownsDatabase = typeof file === 'string';
    this.db = typeof file === 'string' ? new Database(file, { create: true }) : file;
    if (typeof file === 'string' && file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, binding TEXT NOT NULL,
        transfer TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
        branch TEXT NOT NULL, context TEXT NOT NULL UNIQUE, store TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS runtime_legacy (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS runtime_branches (
        id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES runtime_sessions(id), leaf TEXT
      );
      CREATE TABLE IF NOT EXISTS runtime_entries (
        id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES runtime_sessions(id), payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_appends (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, branch TEXT NOT NULL, input TEXT NOT NULL, entry TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_executions (
        id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES runtime_sessions(id),
        branch TEXT NOT NULL REFERENCES runtime_branches(id), intent TEXT NOT NULL, receipt TEXT
      );
      CREATE TABLE IF NOT EXISTS runtime_service_turns(id TEXT PRIMARY KEY,session TEXT NOT NULL,branch TEXT NOT NULL,input TEXT NOT NULL,custom_type TEXT NOT NULL,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_turn_sessions (
        session TEXT PRIMARY KEY REFERENCES runtime_sessions(id)
      );
      CREATE TABLE IF NOT EXISTS runtime_turns (
        id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES runtime_sessions(id),
        branch TEXT NOT NULL REFERENCES runtime_branches(id), input TEXT NOT NULL,
        descriptor TEXT NOT NULL, entry TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_runs (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, branch TEXT NOT NULL,
        turn TEXT NOT NULL UNIQUE, state TEXT NOT NULL, reason TEXT
      );
      CREATE TABLE IF NOT EXISTS runtime_model_calls (
        id TEXT PRIMARY KEY, run TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL, entry TEXT
      );
      CREATE TABLE IF NOT EXISTS runtime_tool_aliases (
        execution TEXT PRIMARY KEY, model_tool TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_acks (execution TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS runtime_ptc_dispatch (
        execution TEXT PRIMARY KEY REFERENCES runtime_executions(id),
        snapshot TEXT NOT NULL, plan TEXT NOT NULL, completion TEXT, outcome TEXT
      );
      CREATE TABLE IF NOT EXISTS runtime_lifecycle (id TEXT PRIMARY KEY,session TEXT NOT NULL,branch TEXT NOT NULL,intent TEXT NOT NULL,receipt TEXT,acked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runtime_contexts (
        branch TEXT PRIMARY KEY, session TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL,
        branch TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_steering (
        id TEXT PRIMARY KEY, run TEXT NOT NULL, input TEXT NOT NULL, consumed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_artifact_refs (
        session TEXT NOT NULL, id TEXT NOT NULL, binding TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(session,id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_tool_identity ON runtime_executions(
        session, json_extract(intent,'$.runId'), json_extract(intent,'$.turnId'),
        json_extract(intent,'$.toolCallId')
      );`);
    this.inner = new InnerJournal(this.db);
  }
  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
  /** Explicit legacy inventory, never reads a legacy transcript. */
  blockLegacy(ids: string[]): void {
    if (ids.length > 1024) throw new Error('Legacy inventory exceeds bound');
    this.db
      .transaction(() => {
        for (const id of ids) {
          legacyReferenceSchema.parse(id);
          if (this.db.query('SELECT id FROM runtime_sessions WHERE id=?').get(id))
            throw new Error('Fresh session cannot be reclassified');
          this.db.query('INSERT OR IGNORE INTO runtime_legacy(id) VALUES (?)').run(id);
        }
      })
      .immediate();
  }
  assertFreshReference(id: string): void {
    legacyReferenceSchema.parse(id);
    if (this.db.query('SELECT id FROM runtime_legacy WHERE id=?').get(id))
      throw new Error('Legacy session unavailable');
    if (!this.db.query('SELECT id FROM runtime_sessions WHERE id=?').get(id))
      throw new Error('Unknown fresh session');
  }
  /** Gateway deny fence is durable before requesting any node fencing. */
  prepare(options: {
    owner: string;
    nodeId: string;
    workspaceId: string;
    legacySessionIds: string[];
  }): WriterTransfer {
    if (!options.owner || options.owner.length > 256) throw new Error('Invalid owner');
    const binding = bindingSchema.parse({
      nodeId: options.nodeId,
      workspaceId: options.workspaceId,
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    });
    const transfer = transferSchema.parse({
      transferId: randomUUID(),
      binding,
      legacySessionIds: options.legacySessionIds,
    });
    const encoded = canonicalJson(transfer, CONTROL_BYTES);
    this.db
      .transaction(() => {
        this.blockLegacy(transfer.legacySessionIds);
        const branch = randomUUID();
        this.db
          .query('INSERT INTO runtime_sessions VALUES (?,?,?,?,?,?,?,?)')
          .run(
            binding.sessionId,
            options.owner,
            canonicalJson(binding, CONTROL_BYTES),
            encoded,
            'pending',
            branch,
            randomUUID(),
            randomUUID(),
          );
        this.db
          .query('INSERT INTO runtime_branches VALUES (?,?,NULL)')
          .run(branch, binding.sessionId);
      })
      .immediate();
    return transfer;
  }
  /** Authenticated supervisor-only receipt: never accept this from model/tool/UI input. */
  activate(receipt: WriterFenceReceipt): WriterLease {
    if (receipt.fenced !== true) throw new Error('Node writer is not fenced');
    const { fenced: _, ...value } = receipt;
    const transfer = transferSchema.parse(value);
    return this.db
      .transaction(() => {
        const session = this.session(transfer.binding.sessionId);
        if (session.transfer !== canonicalJson(transfer, CONTROL_BYTES))
          throw new Error('Writer fence receipt mismatch');
        if (session.state === 'revoked') throw new Error('Writer generation permanently revoked');
        this.db.query("UPDATE runtime_sessions SET state='active' WHERE id=?").run(session.id);
        return { binding: transfer.binding, branchId: session.branch };
      })
      .immediate();
  }
  pending(sessionId: string): WriterTransfer {
    return transferSchema.parse(parseJson(this.session(sessionId).transfer, CONTROL_BYTES));
  }
  revoke(binding: Binding): void {
    const session = this.bound(binding);
    this.db.query("UPDATE runtime_sessions SET state='revoked' WHERE id=?").run(session.id);
  }
  private session(id: string): SessionRow {
    this.assertFreshReference(id);
    return this.db.query('SELECT * FROM runtime_sessions WHERE id=?').get(id) as SessionRow;
  }
  private bound(binding: Binding): SessionRow {
    binding = bindingSchema.parse(binding);
    const session = this.session(binding.sessionId);
    if (session.binding !== canonicalJson(binding, CONTROL_BYTES))
      throw new Error('Stale writer generation');
    return session;
  }
  private writable(lease: WriterLease): SessionRow {
    const session = this.bound(lease.binding);
    if (session.state !== 'active') throw new Error('Writer is not active');
    if (session.branch !== lease.branchId) throw new Error('Stale branch lease');
    return session;
  }
  identities(
    sessionId: string,
    owner: string,
  ): { branchId: string; contextId: string; storeId: string } {
    const session = this.session(sessionId);
    if (session.owner !== owner) throw new Error('Session owner mismatch');
    return { branchId: session.branch, contextId: session.context, storeId: session.store };
  }
  private chain(sessionId: string, branchId: string): AuthorityEntry[] {
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    const entries: AuthorityEntry[] = [];
    let cursor = branch.leaf;
    while (cursor) {
      const row = this.db
        .query('SELECT payload FROM runtime_entries WHERE id=? AND session=?')
        .get(cursor, sessionId) as { payload: string } | null;
      if (!row) throw new Error('Broken authoritative branch');
      const entry = parseJson(row.payload, ENTRY_BYTES) as unknown as AuthorityEntry;
      entries.push(entry);
      cursor = entry.parentId;
    }
    return entries.reverse();
  }
  read(sessionId: string, owner: string, branchId?: string) {
    const session = this.session(sessionId);
    if (session.owner !== owner) throw new Error('Session owner mismatch');
    const entries = this.chain(sessionId, branchId ?? session.branch);
    return { entries, history: historyWithOperations(entries), context: contextEntriesOf(entries) };
  }
  /** Bounded branch custom-state reader; never loads image-bearing history. */
  customEntries(
    sessionId: string,
    owner: string,
    branchId: string,
    customType: string,
    limit = 256,
    latestOnly = false,
  ): AuthorityEntry[] {
    this.assertOwner(sessionId, owner);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('Invalid custom entry limit');
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    const rows = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,depth) AS (
      SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=?
      UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?
    ) SELECT e.id,length(CAST(e.payload AS BLOB)) AS bytes FROM ancestry a JOIN runtime_entries e ON e.id=a.id WHERE json_extract(e.payload,'$.type')='custom' AND json_extract(e.payload,'$.customType')=? ORDER BY a.depth LIMIT ?`,
      )
      .all(branch.leaf, sessionId, sessionId, customType, latestOnly ? 1 : limit + 1) as {
      id: string;
      bytes: number;
    }[];
    if (rows.length > limit || rows.reduce((total, row) => total + row.bytes, 0) > ENTRY_BYTES)
      throw new Error('Custom state history quota exceeded');
    return rows.reverse().map(
      (row) =>
        parseJson(
          (
            this.db.query('SELECT payload FROM runtime_entries WHERE id=?').get(row.id) as {
              payload: string;
            }
          ).payload,
          ENTRY_BYTES,
        ) as unknown as AuthorityEntry,
    );
  }
  sessionOwner(sessionId: string): string {
    return this.session(sessionId).owner;
  }
  assertOwner(sessionId: string, owner: string): void {
    if (this.session(sessionId).owner !== owner) throw new Error('Session owner mismatch');
  }
  /** OM inputs are bounded text-only branch entries; model image data never materializes here. */
  memoryBranch(sessionId: string, owner: string, branchId: string): AuthorityEntry[] {
    this.assertOwner(sessionId, owner);
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    const rows = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,depth) AS (SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=? UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?) SELECT CASE WHEN json_extract(e.payload,'$.type')='message' AND json_type(e.payload,'$.message.content')='array' THEN json_set(e.payload,'$.message.content',json((SELECT json_group_array(json(value)) FROM json_each(e.payload,'$.message.content') WHERE json_extract(value,'$.type')!='image'))) ELSE e.payload END AS payload FROM ancestry a JOIN runtime_entries e ON e.id=a.id ORDER BY a.depth LIMIT 513`,
      )
      .all(branch.leaf, sessionId, sessionId) as { payload: string }[];
    if (
      rows.length > 512 ||
      rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0) > ENTRY_BYTES
    )
      throw new Error('OM branch input quota exceeded');
    return rows
      .reverse()
      .map((row) => parseJson(row.payload, ENTRY_BYTES) as unknown as AuthorityEntry);
  }
  /** Latest branch-inherited settings without loading image-bearing history. */
  settings(sessionId: string, owner: string, branchId?: string) {
    const session = this.session(sessionId);
    this.assertOwner(sessionId, owner);
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId ?? session.branch, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    const rows = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,depth) AS (
        SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=?
        UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?
      ) SELECT json_extract(e.payload,'$.type') AS type,
        json_extract(e.payload,'$.provider') AS provider,
        json_extract(e.payload,'$.modelId') AS modelId,
        json_extract(e.payload,'$.thinkingLevel') AS thinking,
        json_extract(e.payload,'$.name') AS title
        FROM ancestry a JOIN runtime_entries e ON e.id=a.id
        WHERE type IN ('model_change','thinking_level_change','session_info')
        GROUP BY type HAVING a.depth=MIN(a.depth)`,
      )
      .all(branch.leaf, sessionId, sessionId) as {
      type: string;
      provider: string | null;
      modelId: string | null;
      thinking: string | null;
      title: string | null;
    }[];
    const model = rows.find((row) => row.type === 'model_change');
    return {
      model: model ? { provider: model.provider!, id: model.modelId! } : undefined,
      thinking: rows.find((row) => row.type === 'thinking_level_change')?.thinking ?? undefined,
      title: rows.find((row) => row.type === 'session_info')?.title ?? undefined,
    };
  }
  repositorySource(
    sessionId: string,
    owner: string,
    branchId: string,
  ): { nodeId: string; repositoryKey: string | undefined } {
    this.assertOwner(sessionId, owner);
    const session = this.session(sessionId),
      branch = this.db
        .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
        .get(branchId, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid source branch');
    const row = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,depth) AS (SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=? UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?) SELECT t.descriptor FROM ancestry a JOIN runtime_turns t ON json_extract(t.entry,'$.id')=a.id AND t.session=? ORDER BY a.depth LIMIT 1`,
      )
      .get(branch.leaf, sessionId, sessionId, sessionId) as { descriptor: string } | null;
    const binding = bindingSchema.parse(parseJson(session.binding, CONTROL_BYTES));
    return {
      nodeId: binding.nodeId,
      repositoryKey: row
        ? validateTurnDescriptor(parseJson(row.descriptor, ENTRY_BYTES), binding).repositoryKey
        : undefined,
    };
  }
  recallEntries(
    sessionId: string,
    owner: string,
    branchId: string,
    ids: readonly string[],
  ): AuthorityEntry[] {
    this.assertOwner(sessionId, owner);
    if (ids.length > 64) throw new Error('Recall quota exceeded');
    const out: AuthorityEntry[] = [];
    let bytes = 0;
    for (const id of ids) {
      uuid.parse(id);
      if (!this.contains(sessionId, branchId, id, 'message')) continue;
      const row = this.db
        .query(
          "SELECT CASE WHEN json_type(payload,'$.message.content')='array' THEN json_set(payload,'$.message.content',json((SELECT json_group_array(json(value)) FROM json_each(payload,'$.message.content') WHERE json_extract(value,'$.type')!='image'))) ELSE payload END AS payload FROM runtime_entries WHERE id=? AND session=?",
        )
        .get(id, sessionId) as { payload: string };
      bytes += Buffer.byteLength(row.payload);
      if (bytes > 512 * 1024) throw new Error('Recall byte quota exceeded');
      out.push(parseJson(row.payload, ENTRY_BYTES) as unknown as AuthorityEntry);
    }
    return out;
  }
  userEvidence(
    sessionId: string,
    owner: string,
    entryIds: readonly string[],
    quote: string,
  ): string[] {
    this.assertOwner(sessionId, owner);
    if (entryIds.length < 1 || entryIds.length > 64 || quote.length > 4000)
      throw new Error('User evidence quota exceeded');
    const session = this.session(sessionId),
      ids: string[] = [];
    for (const id of entryIds) {
      uuid.parse(id);
      if (!this.contains(sessionId, session.branch, id, 'message')) continue;
      const row = this.db
        .query(
          `SELECT json_extract(payload,'$.message.role') AS role,
        CASE WHEN json_type(payload,'$.message.content')='text' THEN substr(json_extract(payload,'$.message.content'),1,1048576)
        ELSE substr((SELECT group_concat(json_extract(value,'$.text'),'') FROM json_each(payload,'$.message.content') WHERE json_extract(value,'$.type')='text'),1,1048576) END AS text
        FROM runtime_entries WHERE id=? AND session=?`,
        )
        .get(id, sessionId) as { role: string; text: string | null } | null;
      if (row?.role !== 'user') continue;
      if (row.text?.includes(quote)) ids.push(id);
    }
    return ids;
  }
  /** Resolve model-facing quotes from authoritative user text; no invented entry IDs needed. */
  findUserEvidence(sessionId: string, owner: string, quote: string): string[] {
    this.assertOwner(sessionId, owner);
    if (!quote.trim() || quote.length > 4000) throw Error('User evidence quota exceeded');
    const rows = this.db
      .query(
        `SELECT id FROM runtime_entries WHERE session=? AND json_extract(payload,'$.message.role')='user'
      AND instr(CASE WHEN json_type(payload,'$.message.content')='text' THEN json_extract(payload,'$.message.content')
      ELSE (SELECT group_concat(json_extract(value,'$.text'),'') FROM json_each(payload,'$.message.content') WHERE json_extract(value,'$.type')='text') END,?)>0
      ORDER BY rowid DESC LIMIT 256`,
      )
      .all(sessionId, quote) as { id: string }[];
    const branch = this.session(sessionId).branch,
      ids = rows
        .filter((row) => this.contains(sessionId, branch, row.id, 'message'))
        .slice(0, 64)
        .map((row) => row.id);
    return ids.length ? this.userEvidence(sessionId, owner, ids, quote) : [];
  }
  humanTurn(intent: ExecutionIntent): boolean {
    this.bound(intent.binding);
    const row = this.db
      .query(
        "SELECT json_extract(entry,'$.message.role') AS role FROM runtime_turns WHERE id=? AND session=?",
      )
      .get(intent.turnId, intent.binding.sessionId) as { role: string } | null;
    return row?.role === 'user';
  }
  serviceTurnRun(sessionId: string, owner: string, turnId: string): RuntimeRun | undefined {
    this.assertOwner(sessionId, owner);
    uuid.parse(turnId);
    return (
      (this.db
        .query(
          'SELECT r.* FROM runtime_runs r JOIN runtime_service_turns t ON t.id=r.turn AND t.session=r.session WHERE r.session=? AND t.id=?',
        )
        .get(sessionId, turnId) as RuntimeRun | null) ?? undefined
    );
  }
  serviceMessages(
    sessionId: string,
    owner: string,
  ): Array<{ customType: string; details: unknown; turnId: string }> {
    this.assertOwner(sessionId, owner);
    const rows = this.db
      .query(
        'SELECT id,custom_type,details FROM runtime_service_turns WHERE session=? ORDER BY rowid DESC LIMIT 256',
      )
      .all(sessionId) as { id: string; custom_type: string; details: string }[];
    if (rows.reduce((sum, row) => sum + Buffer.byteLength(row.details), 0) > ENTRY_BYTES)
      throw new Error('Service state projection quota exceeded');
    return rows.map((row) => ({
      customType: row.custom_type,
      details: parseJson(row.details, 65536),
      turnId: row.id,
    }));
  }
  runAnswer(sessionId: string, owner: string, runId: string): string {
    this.assertOwner(sessionId, owner);
    const row = this.db
      .query(
        "SELECT substr((SELECT group_concat(json_extract(value,'$.text'),'') FROM json_each(e.payload,'$.message.content') WHERE json_extract(value,'$.type')='text'),1,80000) AS text FROM runtime_model_calls m JOIN runtime_runs r ON r.id=m.run JOIN runtime_entries e ON e.id=m.entry WHERE r.session=? AND r.id=? AND m.state='completed' AND json_extract(e.payload,'$.message.stopReason') NOT IN ('toolUse','error','aborted') ORDER BY m.rowid DESC LIMIT 1",
      )
      .get(sessionId, runId) as { text: string | null } | null;
    return row?.text ?? '';
  }
  serviceRun(
    sessionId: string,
    owner: string,
    customType: string,
    details: unknown,
  ): RuntimeRun | undefined {
    this.assertOwner(sessionId, owner);
    const metadata = canonicalJson(details, 65536);
    const row = this.db
      .query(
        'SELECT r.* FROM runtime_service_turns s JOIN runtime_runs r ON r.turn=s.id WHERE s.session=? AND s.custom_type=? AND s.details=? ORDER BY r.rowid DESC LIMIT 1',
      )
      .get(sessionId, customType, metadata) as RuntimeRun | null;
    return row ?? undefined;
  }
  latestRun(sessionId: string, owner: string, branchId?: string): RuntimeRun | undefined {
    this.assertOwner(sessionId, owner);
    const session = this.session(sessionId);
    return (
      (this.db
        .query(
          'SELECT * FROM runtime_runs WHERE session=? AND branch=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(sessionId, branchId ?? session.branch) as RuntimeRun | null) ?? undefined
    );
  }
  watermark(sessionId: string, owner: string, branchId?: string): number {
    this.assertOwner(sessionId, owner);
    const session = this.session(sessionId);
    return (
      this.db
        .query(
          'SELECT COALESCE(MAX(seq),0) AS seq FROM runtime_outbox WHERE session=? AND branch=?',
        )
        .get(sessionId, branchId ?? session.branch) as { seq: number }
    ).seq;
  }
  /** Newest bounded page for client snapshots; old history remains explicitly paginated. */
  recentHistory(sessionId: string, owner: string, branchId?: string) {
    this.assertOwner(sessionId, owner);
    const session = this.session(sessionId),
      branch = branchId ?? session.branch;
    const row = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branch, sessionId) as { leaf: string | null } | null;
    if (!row) throw new Error('Invalid branch');
    const headers = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,depth) AS (SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=? UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?) SELECT e.id,length(CAST(e.payload AS BLOB)) AS bytes FROM ancestry a JOIN runtime_entries e ON e.id=a.id ORDER BY a.depth LIMIT 33`,
      )
      .all(row.leaf, sessionId, sessionId) as { id: string; bytes: number }[];
    let bytes = 0;
    const entries: AuthorityEntry[] = [];
    for (const header of headers.slice(0, 32)) {
      if (bytes + header.bytes > ENTRY_BYTES) break;
      bytes += header.bytes;
      entries.push(
        parseJson(
          (
            this.db.query('SELECT payload FROM runtime_entries WHERE id=?').get(header.id) as {
              payload: string;
            }
          ).payload,
          ENTRY_BYTES,
        ) as unknown as AuthorityEntry,
      );
    }
    return {
      history: historyWithOperations(entries.reverse()),
      historyPage: {
        truncated: headers.length > entries.length,
        loadedEntries: entries.length,
        olderAvailable: headers.length > entries.length,
        olderCursor: headers.length > entries.length ? (entries[0]?.id ?? null) : null,
      },
    };
  }
  olderHistory(sessionId: string, owner: string, branchId: string, before: string) {
    this.assertOwner(sessionId, owner);
    uuid.parse(before);
    if (!this.contains(sessionId, branchId, before))
      throw new Error('History cursor outside branch');
    const current = this.db
      .query(
        "SELECT json_extract(payload,'$.parentId') AS parent FROM runtime_entries WHERE id=? AND session=?",
      )
      .get(before, sessionId) as { parent: string | null };
    const rows = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,depth) AS (SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=? UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?) SELECT e.id,length(CAST(e.payload AS BLOB)) AS bytes FROM ancestry a JOIN runtime_entries e ON e.id=a.id ORDER BY a.depth LIMIT 33`,
      )
      .all(current.parent, sessionId, sessionId) as { id: string; bytes: number }[];
    let bytes = 0;
    const entries: AuthorityEntry[] = [];
    for (const row of rows.slice(0, 32)) {
      if (bytes + row.bytes > ENTRY_BYTES) break;
      bytes += row.bytes;
      entries.push(
        parseJson(
          (
            this.db.query('SELECT payload FROM runtime_entries WHERE id=?').get(row.id) as {
              payload: string;
            }
          ).payload,
          ENTRY_BYTES,
        ) as unknown as AuthorityEntry,
      );
    }
    const cursor = rows.length > entries.length ? (entries.at(-1)?.id ?? null) : null;
    return {
      history: historyWithOperations(entries.reverse()),
      historyPage: { olderAvailable: cursor !== null, olderCursor: cursor },
    };
  }
  /** At most 32 entries/8 MiB per history page, measured before fetching payloads. */
  historyPage(sessionId: string, owner: string, branchId?: string, offset = 0) {
    const session = this.session(sessionId);
    this.assertOwner(sessionId, owner);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history cursor');
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId ?? session.branch, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    const headers = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,depth) AS (
      SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=?
      UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?
    ) SELECT e.id,length(CAST(e.payload AS BLOB)) AS bytes FROM ancestry a JOIN runtime_entries e ON e.id=a.id ORDER BY a.depth DESC LIMIT 33 OFFSET ?`,
      )
      .all(branch.leaf, sessionId, sessionId, offset) as { id: string; bytes: number }[];
    let bytes = 0;
    const entries: AuthorityEntry[] = [];
    for (const header of headers.slice(0, 32)) {
      if (bytes + header.bytes > ENTRY_BYTES) break;
      bytes += header.bytes;
      const row = this.db
        .query('SELECT payload FROM runtime_entries WHERE id=? AND session=?')
        .get(header.id, sessionId) as { payload: string };
      entries.push(parseJson(row.payload, ENTRY_BYTES) as unknown as AuthorityEntry);
    }
    return {
      history: historyWithOperations(entries),
      offset,
      nextOffset: headers.length > entries.length ? offset + entries.length : null,
    };
  }
  /** Bound the live context before materializing image-bearing transcript payloads. */
  modelContext(sessionId: string, owner: string, branchId?: string) {
    const session = this.session(sessionId);
    this.assertOwner(sessionId, owner);
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId ?? session.branch, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    const ancestry = `WITH RECURSIVE ancestry(id,parent,depth) AS (
      SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=?
      UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e
      JOIN ancestry a ON e.id=a.parent WHERE e.session=?
    )`;
    const parameters = [branch.leaf, sessionId, sessionId] as const;
    const compact = this.db
      .query(
        `${ancestry} SELECT e.payload FROM ancestry a JOIN runtime_entries e ON e.id=a.id WHERE json_extract(e.payload,'$.type')='compaction' ORDER BY a.depth LIMIT 1`,
      )
      .get(...parameters) as { payload: string } | null;
    const compaction = compact
      ? (parseJson(compact.payload, ENTRY_BYTES) as unknown as AuthorityEntry)
      : undefined;
    const boundary =
      compaction?.type === 'compaction'
        ? (this.db
            .query(`${ancestry} SELECT depth FROM ancestry WHERE id=?`)
            .get(...parameters, compaction.firstKeptEntryId) as { depth: number } | null)
        : null;
    if (compaction && !boundary) throw new Error('Invalid persisted compaction boundary');
    const depth = boundary?.depth ?? Number.MAX_SAFE_INTEGER;
    const select = `${ancestry} SELECT e.payload FROM ancestry a JOIN runtime_entries e ON e.id=a.id WHERE a.depth<=? AND json_extract(e.payload,'$.type')='message'`;
    const size = this.db
      .query(`SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM (${select})`)
      .get(...parameters, depth) as { bytes: number };
    if (size.bytes + Buffer.byteLength(compact?.payload ?? '') > REQUEST_BYTES)
      throw new Error('Runtime context byte limit exceeded');
    const rows = this.db.query(`${select} ORDER BY a.depth DESC`).all(...parameters, depth) as {
      payload: string;
    }[];
    const entries = rows.map(
      (row) => parseJson(row.payload, ENTRY_BYTES) as unknown as AuthorityEntry,
    );
    if (compaction) entries.push(compaction);
    return contextEntriesOf(entries);
  }
  private appendTo(sessionId: string, branchId: string, input: EntryInput): AuthorityEntry {
    canonicalJson(input, ENTRY_BYTES);
    input = entrySchema.parse(input);
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    if (
      input.type === 'compaction' &&
      !this.contains(sessionId, branchId, input.firstKeptEntryId, 'message')
    )
      throw new Error('Invalid compaction boundary');
    const entry = {
      ...input,
      id: randomUUID(),
      parentId: branch.leaf,
      timestamp: this.now(),
    } as AuthorityEntry;
    this.db
      .query('INSERT INTO runtime_entries VALUES (?,?,?)')
      .run(entry.id, sessionId, canonicalJson(entry, ENTRY_BYTES));
    this.db.query('UPDATE runtime_branches SET leaf=? WHERE id=?').run(entry.id, branchId);
    this.publish(sessionId, branchId, { type: 'entry.committed', entryId: entry.id });
    return entry;
  }
  private contains(sessionId: string, branchId: string, entryId: string, type?: string): boolean {
    return !!this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent) AS (
      SELECT e.id,json_extract(e.payload,'$.parentId') FROM runtime_entries e JOIN runtime_branches b ON e.id=b.leaf WHERE b.id=? AND b.session=?
      UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId') FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?
    ) SELECT e.id FROM ancestry a JOIN runtime_entries e ON e.id=a.id
      WHERE e.id=? AND (? IS NULL OR json_extract(e.payload,'$.type')=?) LIMIT 1`,
      )
      .get(branchId, sessionId, sessionId, entryId, type ?? null, type ?? null);
  }
  append(lease: WriterLease, operationId: string, input: EntryInput): AuthorityEntry {
    uuid.parse(operationId);
    canonicalJson(input, ENTRY_BYTES);
    const encoded = canonicalJson(entrySchema.parse(input), ENTRY_BYTES);
    return this.db
      .transaction(() => {
        const session = this.writable(lease);
        const old = this.db.query('SELECT * FROM runtime_appends WHERE id=?').get(operationId) as {
          session: string;
          branch: string;
          input: string;
          entry: string;
        } | null;
        if (old) {
          if (old.session !== session.id || old.branch !== lease.branchId || old.input !== encoded)
            throw new Error('Append ID conflict');
          return parseJson(old.entry, ENTRY_BYTES) as unknown as AuthorityEntry;
        }
        const entry = this.appendTo(session.id, lease.branchId, entrySchema.parse(input));
        this.db
          .query('INSERT INTO runtime_appends VALUES (?,?,?,?,?)')
          .run(operationId, session.id, lease.branchId, encoded, canonicalJson(entry, ENTRY_BYTES));
        return entry;
      })
      .immediate();
  }
  /** Fresh branch identity, preserving only explicitly selected new-authority ancestry. */
  fork(lease: WriterLease, atEntryId: string | null): WriterLease {
    return this.db
      .transaction(() => {
        const session = this.writable(lease);
        if (atEntryId && !this.contains(session.id, lease.branchId, atEntryId))
          throw new Error('Invalid fork boundary');
        const branchId = randomUUID();
        this.db
          .query('INSERT INTO runtime_branches VALUES (?,?,?)')
          .run(branchId, session.id, atEntryId);
        this.db
          .query('UPDATE runtime_sessions SET branch=?,context=?,store=? WHERE id=?')
          .run(branchId, randomUUID(), randomUUID(), session.id);
        return { binding: lease.binding, branchId };
      })
      .immediate();
  }
  /** Durable opt-in before the first async preparation, including failed attempts. */
  enrollTurns(lease: WriterLease): void {
    this.db
      .transaction(() => {
        const session = this.writable(lease);
        if (
          this.db.query('SELECT session FROM runtime_turn_sessions WHERE session=?').get(session.id)
        )
          return;
        if (
          this.db.query('SELECT id FROM runtime_executions WHERE session=? LIMIT 1').get(session.id)
        )
          throw new Error('Cannot enroll a foundation session with executions');
        this.db.query('INSERT INTO runtime_turn_sessions VALUES (?)').run(session.id);
      })
      .immediate();
  }
  /** Trusted turn admission; changed configuration requires a separately fenced handoff. */
  checkTurn(
    lease: WriterLease,
    value: TurnInput,
    descriptor?: Descriptor,
  ): AuthorityTurn | undefined {
    const session = this.writable(lease);
    const input = validateTurnInput(value, lease.binding);
    const encoded = canonicalJson(input, ENTRY_BYTES);
    const row = this.db.query('SELECT * FROM runtime_turns WHERE id=?').get(input.turnId) as {
      session: string;
      branch: string;
      input: string;
      descriptor: string;
      entry: string;
    } | null;
    if (
      row &&
      (row.session !== session.id || row.branch !== lease.branchId || row.input !== encoded)
    )
      throw new Error('Turn ID conflict');
    if (descriptor) {
      descriptor = validateTurnDescriptor(descriptor, lease.binding);
      const previous = this.db
        .query('SELECT descriptor FROM runtime_turns WHERE session=? LIMIT 1')
        .get(session.id) as { descriptor: string } | null;
      if (
        previous &&
        (parseJson(previous.descriptor, ENTRY_BYTES) as unknown as Descriptor).revision !==
          descriptor.revision
      )
        throw new Error('Descriptor changed; fenced generation handoff required');
    }
    return row
      ? {
          input: validateTurnInput(
            parseJson(row.input, ENTRY_BYTES) as unknown as TurnInput,
            lease.binding,
          ),
          descriptor: validateTurnDescriptor(parseJson(row.descriptor, ENTRY_BYTES), lease.binding),
          entry: parseJson(row.entry, ENTRY_BYTES) as unknown as AuthorityEntry,
          branchId: row.branch,
        }
      : undefined;
  }
  /** Trusted supervisor ingress only; public TurnInput schema carries no origin fields. */
  enrollServiceTurn(
    lease: WriterLease,
    value: TurnInput,
    customType: string,
    details: unknown,
  ): void {
    const input = validateTurnInput(value, lease.binding);
    if (input.attachments.length || !customType || customType.length > 100)
      throw new Error('Invalid service turn');
    const encoded = canonicalJson(input, ENTRY_BYTES),
      metadata = canonicalJson(details, 65536);
    this.db
      .transaction(() => {
        this.writable(lease);
        const old = this.db
          .query(
            'SELECT session,branch,input,custom_type,details FROM runtime_service_turns WHERE id=?',
          )
          .get(input.turnId) as {
          session: string;
          branch: string;
          input: string;
          custom_type: string;
          details: string;
        } | null;
        if (old) {
          if (
            old.session !== lease.binding.sessionId ||
            old.branch !== lease.branchId ||
            old.input !== encoded ||
            old.custom_type !== customType ||
            old.details !== metadata
          )
            throw new Error('Service turn identity conflict');
          return;
        }
        if (this.db.query('SELECT id FROM runtime_turns WHERE id=?').get(input.turnId))
          throw new Error('Turn already admitted');
        this.db
          .query('INSERT INTO runtime_service_turns VALUES (?,?,?,?,?,?)')
          .run(
            input.turnId,
            lease.binding.sessionId,
            lease.branchId,
            encoded,
            customType,
            metadata,
          );
      })
      .immediate();
  }
  /** Pins must already be durable on the node. Images and provenance commit with the user entry. */
  commitTurn(
    lease: WriterLease,
    value: TurnInput,
    descriptor: Descriptor,
    images: ImageContent[],
  ): AuthorityTurn {
    return this.db
      .transaction(() => {
        this.enrollTurns(lease);
        const prior = this.checkTurn(lease, value, descriptor);
        if (prior) return prior;
        const input = validateTurnInput(value, lease.binding);
        descriptor = validateTurnDescriptor(descriptor, lease.binding);
        if (images.length !== input.attachments.length) throw new Error('Missing turn images');
        images.forEach((image, index) => {
          const ref = input.attachments[index]!;
          const bytes = Buffer.from(image.data, 'base64');
          if (
            image.type !== 'image' ||
            image.mimeType !== ref.mimeType ||
            bytes.length !== ref.bytes ||
            bytes.toString('base64') !== image.data ||
            createHash('sha256').update(bytes).digest('hex') !== ref.digest
          )
            throw new Error('Turn image evidence mismatch');
        });
        const service = this.db
          .query(
            'SELECT input,custom_type,details FROM runtime_service_turns WHERE id=? AND session=? AND branch=?',
          )
          .get(input.turnId, lease.binding.sessionId, lease.branchId) as {
          input: string;
          custom_type: string;
          details: string;
        } | null;
        if (service && service.input !== canonicalJson(input, ENTRY_BYTES))
          throw new Error('Service turn arguments conflict');
        const entry = this.appendTo(lease.binding.sessionId, lease.branchId, {
          type: 'message',
          message: service
            ? {
                role: 'custom',
                customType: service.custom_type,
                content: input.text,
                display: true,
                details: parseJson(service.details, 65536),
                timestamp: this.now(),
              }
            : {
                role: 'user',
                content: [{ type: 'text', text: input.text }, ...images],
                timestamp: this.now(),
              },
        });
        this.db
          .query('INSERT INTO runtime_turns VALUES (?,?,?,?,?,?)')
          .run(
            input.turnId,
            lease.binding.sessionId,
            lease.branchId,
            canonicalJson(input, ENTRY_BYTES),
            canonicalJson(descriptor, ENTRY_BYTES),
            canonicalJson(entry, ENTRY_BYTES),
          );
        for (const artifact of input.attachments) this.registerArtifact(lease.binding, artifact);
        return { input, descriptor, entry, branchId: lease.branchId };
      })
      .immediate();
  }
  /** Owner-checked ancestry projection, 16 turns/page; never materializes image entries. */
  turns(sessionId: string, owner: string, branchId?: string, offset = 0) {
    const session = this.session(sessionId);
    if (session.owner !== owner) throw new Error('Session owner mismatch');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid turn page');
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId ?? session.branch, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    const rows = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,depth) AS (
      SELECT id,json_extract(payload,'$.parentId'),0 FROM runtime_entries WHERE id=? AND session=?
      UNION ALL
      SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e
      JOIN ancestry a ON e.id=a.parent WHERE e.session=?
    ) SELECT t.input,t.descriptor,t.branch,a.id AS entryId FROM ancestry a
      JOIN runtime_turns t ON json_extract(t.entry,'$.id')=a.id AND t.session=?
      ORDER BY a.depth DESC LIMIT 16 OFFSET ?`,
      )
      .all(branch.leaf, sessionId, sessionId, sessionId, offset) as {
      input: string;
      descriptor: string;
      branch: string;
      entryId: string;
    }[];
    return rows.map((row) => ({
      input: parseJson(row.input, ENTRY_BYTES) as unknown as TurnInput,
      descriptor: parseJson(row.descriptor, ENTRY_BYTES) as unknown as Descriptor,
      entryId: row.entryId,
      branchId: row.branch,
    }));
  }
  /** Branch ancestry is authoritative, including at an explicitly selected fork boundary. */
  ptcStore(sessionId: string, owner: string, branchId?: string): PtcStoreSnapshot {
    const session = this.session(sessionId);
    if (session.owner !== owner) throw new Error('Session owner mismatch');
    return this.storeSnapshot(sessionId, branchId ?? session.branch);
  }
  private storeSnapshot(sessionId: string, branchId: string): PtcStoreSnapshot {
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    // Walk IDs in SQLite, stopping at the nearest store. Never materialize old images,
    // messages or previous multi-megabyte snapshots in the trusted supervisor.
    const row = this.db
      .query(
        `WITH RECURSIVE ancestry(id,parent,store) AS (
      SELECT id,json_extract(payload,'$.parentId'),COALESCE(json_extract(payload,'$.type')='custom' AND json_extract(payload,'$.customType')=?,0)
        FROM runtime_entries WHERE id=? AND session=?
      UNION ALL
      SELECT e.id,json_extract(e.payload,'$.parentId'),COALESCE(json_extract(e.payload,'$.type')='custom' AND json_extract(e.payload,'$.customType')=?,0)
        FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=? AND a.store=0
    ) SELECT e.payload FROM ancestry a JOIN runtime_entries e ON e.id=a.id WHERE a.store=1 LIMIT 1`,
      )
      .get(PTC_STORE_ENTRY, branch.leaf, sessionId, PTC_STORE_ENTRY, sessionId) as {
      payload: string;
    } | null;
    const entry = row
      ? (parseJson(row.payload, ENTRY_BYTES) as unknown as AuthorityEntry)
      : undefined;
    if (!entry || entry.type !== 'custom')
      return { branchId, revision: branchId, store: '{}', untrusted: [] };
    const data = entry.data as { store?: unknown; untrusted?: unknown };
    return {
      branchId,
      revision: entry.id,
      store: validatePtcStore(data.store),
      untrusted: validatePtcProvenance(data.untrusted),
    };
  }
  /** Capture placement/store once, before dispatch; duplicate preparation cannot refresh it. */
  preparePtc(
    lease: WriterLease,
    executionId: string,
    images = false,
  ): { snapshot: PtcStoreSnapshot; plan: PtcPlan } {
    uuid.parse(executionId);
    return this.db
      .transaction(() => {
        this.writable(lease);
        const row = this.db
          .query('SELECT intent,branch,receipt FROM runtime_executions WHERE id=? AND session=?')
          .get(executionId, lease.binding.sessionId) as ExecutionRow | null;
        if (!row || row.branch !== lease.branchId) throw new Error('Unknown PTC execution');
        const intent = validateIntent(parseJson(row.intent, REQUEST_BYTES));
        if (intent.capability !== 'ptc' || intent.parentExecutionId)
          throw new Error('Expected outer PTC execution');
        const old = this.db
          .query('SELECT snapshot,plan FROM runtime_ptc_dispatch WHERE execution=?')
          .get(executionId) as { snapshot: string; plan: string } | null;
        if (old)
          return {
            snapshot: parseJson(old.snapshot, ENTRY_BYTES) as unknown as PtcStoreSnapshot,
            plan: parseJson(old.plan, ENTRY_BYTES) as unknown as PtcPlan,
          };
        if (row.receipt) throw new Error('PTC execution already completed');
        const turn = this.db
          .query('SELECT descriptor FROM runtime_turns WHERE id=?')
          .get(intent.turnId) as { descriptor: string } | null;
        if (!turn) throw new Error('PTC requires authoritative turn');
        const descriptor = validateTurnDescriptor(
          parseJson(turn.descriptor, ENTRY_BYTES),
          lease.binding,
        );
        const plan = planPtc(intent.arguments, descriptor.capabilityCatalog);
        const snapshot = this.storeSnapshot(lease.binding.sessionId, lease.branchId);
        if (
          intent.ptc &&
          canonicalJson(
            {
              branchId: intent.ptc.branchId,
              revision: intent.ptc.revision,
              store: intent.ptc.store,
              untrusted: intent.ptc.untrusted,
            },
            ENTRY_BYTES,
          ) !== canonicalJson(snapshot, ENTRY_BYTES)
        )
          throw new Error('PTC dispatch store snapshot mismatch');
        const final = { ...intent, ptc: { ...snapshot, ...(images ? { images: true } : {}) } };
        final.argumentDigest = intentDigest(final);
        this.db
          .query('UPDATE runtime_executions SET intent=? WHERE id=?')
          .run(canonicalJson(final, REQUEST_BYTES), executionId);
        this.inner.register(final, plan.manifest);
        this.db
          .query('INSERT INTO runtime_ptc_dispatch(execution,snapshot,plan) VALUES (?,?,?)')
          .run(executionId, canonicalJson(snapshot, ENTRY_BYTES), canonicalJson(plan, ENTRY_BYTES));
        return { snapshot, plan };
      })
      .immediate();
  }
  /** Recovery of an obligation that provably never reached dispatch finalization. */
  rejectUndispatchedPtc(intent: ExecutionIntent): ExecutionRecord {
    return this.db
      .transaction(() => {
        const current = this.executionIntent(intent.binding, intent.executionId);
        if (
          current.capability !== 'ptc' ||
          current.ptc ||
          this.db
            .query('SELECT execution FROM runtime_ptc_dispatch WHERE execution=?')
            .get(intent.executionId)
        )
          throw new Error('PTC may have been dispatched');
        const terminal = {
          state: 'rejected' as const,
          effect: 'not_started' as const,
          artifacts: [],
          truncated: false,
          error: {
            code: 'cancelled' as const,
            message: 'Gateway stopped before PTC dispatch; script was not started',
          },
        };
        const record: ExecutionRecord = {
          binding: current.binding,
          executionId: current.executionId,
          argumentDigest: current.argumentDigest,
          state: terminal.state,
          effect: terminal.effect,
          finalSeq: 0,
          cancelRequested: false,
          acknowledged: false,
          reclaimed: false,
          terminal,
          resultDigest: digest(
            {
              binding: current.binding,
              executionId: current.executionId,
              argumentDigest: current.argumentDigest,
              finalSeq: 0,
              terminal,
            },
            RESULT_BYTES,
          ),
        };
        this.commitExecutionResult(record, true);
        this.db.query('INSERT OR IGNORE INTO runtime_acks VALUES (?)').run(intent.executionId);
        return record;
      })
      .immediate();
  }
  /** Store proposal, terminal transcript and dedup receipt share the authority transaction.
   * A branch switch conflicts rather than writing the newly active branch or replaying effects.
   * The original execution result remains intact; store conflict is separate durable evidence.
   */
  commitPtcResult(
    value: ExecutionRecord,
    proposal?: { store: string; untrusted: string[] },
  ): 'unchanged' | 'committed' | 'conflict' {
    canonicalJson(value, RESULT_BYTES);
    const record = recordSchema.parse(value);
    const checked =
      proposal === undefined
        ? null
        : {
            store: validatePtcStore(proposal.store),
            untrusted: validatePtcProvenance(proposal.untrusted),
          };
    if (checked && record.state !== 'completed')
      throw new Error('Failed PTC cannot commit a store');
    const completion = canonicalJson(
      { resultDigest: record.resultDigest, proposal: checked },
      ENTRY_BYTES,
    );
    return this.db
      .transaction(() => {
        const session = this.bound(record.binding);
        const dispatch = this.db
          .query('SELECT snapshot,completion,outcome FROM runtime_ptc_dispatch WHERE execution=?')
          .get(record.executionId) as {
          snapshot: string;
          completion: string | null;
          outcome: 'unchanged' | 'committed' | 'conflict' | null;
        } | null;
        if (!dispatch) throw new Error('No PTC dispatch snapshot');
        if (dispatch.completion) {
          if (dispatch.completion !== completion) {
            const previous = this.db
              .query('SELECT receipt FROM runtime_executions WHERE id=?')
              .get(record.executionId) as { receipt: string | null };
            const old =
              previous.receipt && recordSchema.parse(parseJson(previous.receipt, RESULT_BYTES));
            // Refinement adds verified effect evidence, never a late store commit or script replay.
            if (!old || old.state !== 'unknown' || checked !== null)
              throw new Error('PTC completion conflict');
            this.commitExecutionResult(record, true);
            this.db
              .query('UPDATE runtime_ptc_dispatch SET completion=? WHERE execution=?')
              .run(completion, record.executionId);
          } else {
            this.commitExecutionResult(record, true);
          }
          return dispatch.outcome!;
        }
        const snapshot = parseJson(dispatch.snapshot, ENTRY_BYTES) as unknown as PtcStoreSnapshot;
        let outcome: 'unchanged' | 'committed' | 'conflict' = 'unchanged';
        if (checked && checked.store !== snapshot.store) {
          const current = this.storeSnapshot(session.id, snapshot.branchId);
          if (
            session.state !== 'active' ||
            session.branch !== snapshot.branchId ||
            current.revision !== snapshot.revision
          ) {
            outcome = 'conflict';
            this.appendTo(session.id, snapshot.branchId, {
              type: 'custom',
              customType: 'runtime.ptc.store_conflict',
              data: {
                executionId: record.executionId,
                expectedRevision: snapshot.revision,
                actualRevision: current.revision,
              },
            });
          } else {
            const untrusted = validatePtcProvenance([
              ...new Set([...snapshot.untrusted, ...checked.untrusted]),
            ]);
            this.appendTo(session.id, snapshot.branchId, {
              type: 'custom',
              customType: PTC_STORE_ENTRY,
              data: { store: checked.store, untrusted },
            });
            outcome = 'committed';
          }
        }
        this.commitExecutionResult(record, true);
        this.db
          .query('UPDATE runtime_ptc_dispatch SET completion=?,outcome=? WHERE execution=?')
          .run(completion, outcome, record.executionId);
        return outcome;
      })
      .immediate();
  }
  /** Persist intent/branch before dispatch. Offline admission remains supervisor-owned. */
  persistExecution(lease: WriterLease, value: ExecutionIntent): void {
    const intent = validateIntent(value);
    if (!sameBinding(lease.binding, intent.binding)) throw new Error('Execution binding mismatch');
    if (intent.parentExecutionId) throw new Error('Inner PTC operations remain M4');
    const encoded = canonicalJson(intent, REQUEST_BYTES);
    this.db
      .transaction(() => {
        const session = this.writable(lease);
        const turn = this.db
          .query('SELECT input,descriptor,branch FROM runtime_turns WHERE id=?')
          .get(intent.turnId) as { input: string; descriptor: string; branch: string } | null;
        if (
          !turn &&
          this.db.query('SELECT session FROM runtime_turn_sessions WHERE session=?').get(session.id)
        )
          throw new Error('No authoritative turn');
        if (turn) {
          const input = parseJson(turn.input, ENTRY_BYTES) as unknown as TurnInput;
          const descriptor = validateTurnDescriptor(
            parseJson(turn.descriptor, ENTRY_BYTES),
            lease.binding,
          );
          if (
            turn.branch !== lease.branchId ||
            input.runId !== intent.runId ||
            descriptor.revision !== intent.descriptorRevision ||
            descriptor.policyRevision !== intent.policyRevision ||
            (intent.capability !== 'ptc' &&
              !descriptor.capabilityCatalog.some(
                (capability) => capability.name === intent.capability,
              )) ||
            intent.budgetMs > descriptor.limits.maxBudgetMs
          )
            throw new Error('Execution does not match authoritative turn');
          if (intent.capability === 'ptc') planPtc(intent.arguments, descriptor.capabilityCatalog);
        } else if (intent.capability === 'ptc') {
          throw new Error('PTC requires authoritative turn');
        }
        const old = this.db
          .query('SELECT intent,branch FROM runtime_executions WHERE id=?')
          .get(intent.executionId) as { intent: string; branch: string } | null;
        if (old) {
          if (old.intent !== encoded || old.branch !== lease.branchId)
            throw new Error('Execution ID conflict');
          return;
        }
        this.db
          .query('INSERT INTO runtime_executions VALUES (?,?,?,?,NULL)')
          .run(intent.executionId, session.id, lease.branchId, encoded);
      })
      .immediate();
  }
  /** Terminal transcript + dedup receipt commit atomically; old epochs reconcile original branch only. */
  commitResult(value: ExecutionRecord): void {
    this.commitExecutionResult(value, false);
  }
  private commitExecutionResult(value: ExecutionRecord, ptc: boolean): void {
    canonicalJson(value, RESULT_BYTES);
    const record = recordSchema.parse(value);
    validateRecordDelivery(record);
    if (
      record.resultDigest !==
      digest(
        {
          binding: record.binding,
          executionId: record.executionId,
          argumentDigest: record.argumentDigest,
          finalSeq: record.finalSeq,
          terminal: record.terminal ?? null,
        },
        RESULT_BYTES,
      )
    )
      throw new Error('Result digest mismatch');
    if (!record.terminal || !record.resultDigest || record.reclaimed)
      throw new Error('Full terminal evidence required');
    this.db
      .transaction(() => {
        this.bound(record.binding);
        const row = this.db
          .query('SELECT intent,branch,receipt FROM runtime_executions WHERE id=? AND session=?')
          .get(record.executionId, record.binding.sessionId) as ExecutionRow | null;
        if (!row) throw new Error('No authoritative execution intent');
        const intent = validateIntent(parseJson(row.intent, REQUEST_BYTES));
        if (intent.capability === 'ptc' && !ptc)
          throw new Error('PTC requires atomic store/result commit');
        if (
          intent.argumentDigest !== record.argumentDigest ||
          !sameBinding(intent.binding, record.binding)
        )
          throw new Error('Result intent mismatch');
        if (row.receipt) {
          const old = recordSchema.parse(parseJson(row.receipt, RESULT_BYTES));
          if (old.resultDigest === record.resultDigest) return;
          if (
            old.state !== 'unknown' ||
            record.state === 'unknown' ||
            record.state === 'rejected' ||
            record.effect === 'unknown' ||
            old.finalSeq !== record.finalSeq ||
            old.cancelRequested !== record.cancelRequested
          )
            throw new Error('Result conflict');
          // Preserve the visible unknown result; add evidence rather than a second tool result.
          this.appendTo(record.binding.sessionId, row.branch, {
            type: 'custom',
            customType: 'execution.reconciled',
            data: {
              executionId: record.executionId,
              result: parseJson(canonicalJson(record, RESULT_BYTES), RESULT_BYTES),
            },
          });
        } else {
          const terminal = record.terminal!;
          const output = terminal.output as
            | { content?: unknown; details?: unknown; isError?: unknown }
            | undefined;
          const parentToolCallId =
            (
              this.db
                .query('SELECT model_tool FROM runtime_tool_aliases WHERE execution=?')
                .get(intent.executionId) as { model_tool: string } | null
            )?.model_tool ?? intent.toolCallId;
          if (intent.capability === 'ptc') {
            const operations = (output?.details as { operations?: unknown } | undefined)
              ?.operations;
            if (Array.isArray(operations))
              for (const operation of operations.slice(0, 220)) {
                if (
                  !operation ||
                  typeof operation !== 'object' ||
                  typeof operation.operationId !== 'string' ||
                  typeof operation.capability !== 'string'
                )
                  continue;
                if (!operation.operationId.startsWith(`${intent.executionId}:op`))
                  throw new Error('PTC operation origin mismatch');
                this.appendTo(record.binding.sessionId, row.branch, {
                  type: 'custom',
                  customType: OPERATION_ENTRY,
                  data: {
                    toolCallId: operation.operationId,
                    parentToolCallId,
                    toolName: operation.capability,
                    args: {},
                    content: [
                      {
                        type: 'text',
                        text: `${operation.outcome}${operation.delivered ? '' : '; result delivery unverified'}`,
                      },
                    ],
                    details: operation,
                    isError: operation.outcome !== 'completed',
                    timestamp: this.now(),
                  },
                });
              }
          }
          const input = entrySchema.parse({
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId:
                (
                  this.db
                    .query('SELECT model_tool FROM runtime_tool_aliases WHERE execution=?')
                    .get(intent.executionId) as { model_tool: string } | null
                )?.model_tool ?? intent.toolCallId,
              toolName: intent.capability,
              content:
                output && Array.isArray(output.content)
                  ? output.content
                  : [
                      {
                        type: 'text',
                        text:
                          terminal.error?.message ??
                          canonicalJson(terminal.output ?? null, RESULT_BYTES),
                      },
                    ],
              isError: record.state !== 'completed' || output?.isError === true,
              timestamp: this.now(),
              details: {
                executionId: record.executionId,
                state: record.state,
                effect: record.effect,
                truncated: terminal.truncated,
                artifacts: terminal.artifacts,
                ...(output?.details === undefined ? {} : { tool: output.details }),
              },
            },
          });
          this.appendTo(record.binding.sessionId, row.branch, input);
        }
        for (const artifact of record.terminal!.artifacts)
          this.registerArtifact(record.binding, artifact);
        this.db
          .query('UPDATE runtime_executions SET receipt=? WHERE id=?')
          .run(canonicalJson(record, RESULT_BYTES), record.executionId);
      })
      .immediate();
  }
  persistLifecycle(lease: WriterLease, intent: ExecutionIntent, descriptor: Descriptor): void {
    validateIntent(intent);
    validateTurnDescriptor(descriptor, lease.binding);
    if (
      !sameBinding(lease.binding, intent.binding) ||
      !descriptor.lifecycleHooks?.some((phase) => intent.capability === `lifecycle.${phase}`) ||
      intent.descriptorRevision !== descriptor.revision ||
      intent.policyRevision !== descriptor.policyRevision
    )
      throw new Error('Lifecycle intent mismatch');
    this.db
      .transaction(() => {
        this.writable(lease);
        const encoded = canonicalJson(intent, REQUEST_BYTES);
        const old = this.db
          .query('SELECT intent FROM runtime_lifecycle WHERE id=?')
          .get(intent.executionId) as { intent: string } | null;
        if (old) {
          if (old.intent !== encoded) throw new Error('Lifecycle phase conflict');
          return;
        }
        this.db
          .query('INSERT INTO runtime_lifecycle(id,session,branch,intent) VALUES (?,?,?,?)')
          .run(intent.executionId, lease.binding.sessionId, lease.branchId, encoded);
      })
      .immediate();
  }
  commitLifecycle(record: ExecutionRecord): void {
    canonicalJson(record, RESULT_BYTES);
    record = recordSchema.parse(record);
    if (
      !record.terminal ||
      record.reclaimed ||
      record.resultDigest !==
        digest(
          {
            binding: record.binding,
            executionId: record.executionId,
            argumentDigest: record.argumentDigest,
            finalSeq: record.finalSeq,
            terminal: record.terminal,
          },
          RESULT_BYTES,
        )
    )
      throw new Error('Invalid lifecycle terminal');
    this.db
      .transaction(() => {
        this.bound(record.binding);
        const row = this.db
          .query('SELECT intent,branch,receipt FROM runtime_lifecycle WHERE id=? AND session=?')
          .get(record.executionId, record.binding.sessionId) as ExecutionRow | null;
        if (!row) throw new Error('Lifecycle obligation missing');
        const intent = validateIntent(parseJson(row.intent, REQUEST_BYTES));
        if (intent.argumentDigest !== record.argumentDigest)
          throw new Error('Lifecycle result mismatch');
        if (row.receipt) {
          const previous = recordSchema.parse(parseJson(row.receipt, RESULT_BYTES));
          if (previous.resultDigest === record.resultDigest) return;
          if (
            previous.effect !== 'unknown' ||
            record.state === 'unknown' ||
            record.state === 'rejected' ||
            record.effect === 'unknown' ||
            previous.finalSeq !== record.finalSeq ||
            previous.cancelRequested !== record.cancelRequested
          )
            throw new Error('Lifecycle result conflict');
          this.appendTo(record.binding.sessionId, row.branch, {
            type: 'custom',
            customType: 'runtime.lifecycle.reconciled',
            data: {
              executionId: record.executionId,
              result: parseJson(canonicalJson(record, RESULT_BYTES), RESULT_BYTES),
            },
          });
          this.db
            .query('UPDATE runtime_lifecycle SET receipt=?,acked=0 WHERE id=?')
            .run(canonicalJson(record, RESULT_BYTES), record.executionId);
          return;
        }
        this.appendTo(record.binding.sessionId, row.branch, {
          type: 'custom',
          customType: 'runtime.lifecycle.result',
          data: {
            executionId: record.executionId,
            phase: intent.capability,
            result: parseJson(canonicalJson(record, RESULT_BYTES), RESULT_BYTES),
          },
        });
        this.db
          .query('UPDATE runtime_lifecycle SET receipt=? WHERE id=?')
          .run(canonicalJson(record, RESULT_BYTES), record.executionId);
      })
      .immediate();
  }
  lifecycleReceipt(binding: Binding, id: string): ExecutionRecord | undefined {
    this.bound(binding);
    const row = this.db
      .query('SELECT receipt FROM runtime_lifecycle WHERE id=? AND session=?')
      .get(id, binding.sessionId) as { receipt: string | null } | null;
    return row?.receipt ? recordSchema.parse(parseJson(row.receipt, RESULT_BYTES)) : undefined;
  }
  lifecycleRecovery(
    sessionId: string,
    owner: string,
  ): Array<{ intent: ExecutionIntent; receipt: ExecutionRecord | undefined }> {
    this.assertOwner(sessionId, owner);
    return (
      this.db
        .query(
          "SELECT intent,receipt FROM runtime_lifecycle WHERE session=? AND (acked=0 OR json_extract(receipt,'$.effect')='unknown') ORDER BY rowid LIMIT 32",
        )
        .all(sessionId) as { intent: string; receipt: string | null }[]
    ).map((row) => ({
      intent: validateIntent(parseJson(row.intent, REQUEST_BYTES)),
      receipt: row.receipt ? recordSchema.parse(parseJson(row.receipt, RESULT_BYTES)) : undefined,
    }));
  }
  markLifecycleAck(binding: Binding, id: string): void {
    this.bound(binding);
    this.db
      .query(
        'UPDATE runtime_lifecycle SET acked=1 WHERE id=? AND session=? AND receipt IS NOT NULL',
      )
      .run(id, binding.sessionId);
  }
  executionDescriptor(intent: ExecutionIntent): Descriptor {
    const current = this.executionIntent(intent.binding, intent.executionId);
    if (current.argumentDigest !== intent.argumentDigest)
      throw new Error('Execution intent conflict');
    const row = this.db
      .query('SELECT descriptor FROM runtime_turns WHERE id=? AND session=?')
      .get(intent.turnId, intent.binding.sessionId) as { descriptor: string } | null;
    if (!row) throw new Error('Authoritative turn unavailable');
    return validateTurnDescriptor(parseJson(row.descriptor, ENTRY_BYTES), intent.binding);
  }
  executionBranch(intent: ExecutionIntent): string {
    this.bound(intent.binding);
    const id = intent.parentExecutionId ?? intent.executionId;
    const row = this.db
      .query('SELECT branch,intent FROM runtime_executions WHERE id=? AND session=?')
      .get(id, intent.binding.sessionId) as { branch: string; intent: string } | null;
    if (!row) throw new Error('Authoritative execution missing');
    return row.branch;
  }
  featureState(intent: ExecutionIntent, name: string): unknown {
    const owner = this.session(intent.binding.sessionId).owner;
    const entry = this.customEntries(
      intent.binding.sessionId,
      owner,
      this.executionBranch(intent),
      `runtime.feature.${name}`,
      1,
      true,
    ).at(-1);
    return entry?.type === 'custom' ? entry.data : undefined;
  }
  saveFeatureState(db: Database, intent: ExecutionIntent, name: string, value: unknown): void {
    if (db !== this.db) throw new Error('Feature mutation requires authority transaction');
    const branch = this.executionBranch(intent);
    this.bound(intent.binding);
    this.appendTo(intent.binding.sessionId, branch, {
      type: 'custom',
      customType: `runtime.feature.${name}`,
      data: parseJson(canonicalJson(value, ENTRY_BYTES), ENTRY_BYTES),
    });
  }
  modelToolId(binding: Binding, executionId: string): string {
    const intent = this.executionIntent(binding, executionId);
    return (
      (
        this.db
          .query('SELECT model_tool FROM runtime_tool_aliases WHERE execution=?')
          .get(executionId) as { model_tool: string } | null
      )?.model_tool ?? intent.toolCallId
    );
  }
  executionIntent(binding: Binding, executionId: string): ExecutionIntent {
    this.bound(binding);
    const row = this.db
      .query('SELECT intent FROM runtime_executions WHERE id=? AND session=?')
      .get(executionId, binding.sessionId) as { intent: string } | null;
    if (!row) throw new Error('Unknown execution');
    return validateIntent(parseJson(row.intent, REQUEST_BYTES));
  }
  /** Retry safe after restart/lost ACK; never ACK from a mere transport receipt. */
  async acknowledge(
    environment: Pick<Environment, 'ack'>,
    binding: Binding,
    executionId: string,
  ): Promise<void> {
    this.bound(binding);
    const row = this.db
      .query('SELECT receipt FROM runtime_executions WHERE id=? AND session=?')
      .get(executionId, binding.sessionId) as { receipt: string | null } | null;
    if (!row?.receipt) throw new Error('No committed transcript result');
    const record = recordSchema.parse(parseJson(row.receipt, RESULT_BYTES));
    await environment.ack(binding, executionId, record.resultDigest!);
    this.db.query('INSERT OR IGNORE INTO runtime_acks VALUES (?)').run(executionId);
  }

  assertWriter(lease: WriterLease): void {
    this.writable(lease);
  }
  hasUnresolvedExecutions(sessionId: string, owner: string): boolean {
    this.assertOwner(sessionId, owner);
    if (
      this.db
        .query(
          "SELECT id FROM runtime_lifecycle WHERE session=? AND (receipt IS NULL OR json_extract(receipt,'$.effect')='unknown') LIMIT 1",
        )
        .get(sessionId)
    )
      return true;
    return !!this.db
      .query('SELECT id FROM runtime_executions WHERE session=? AND receipt IS NULL LIMIT 1')
      .get(sessionId);
  }
  private registerArtifact(binding: Binding, value: unknown): void {
    const artifact = artifactSchema.parse(value);
    if (
      artifact.sessionId !== binding.sessionId ||
      artifact.nodeId !== binding.nodeId ||
      artifact.workspaceId !== binding.workspaceId
    )
      throw new Error('Artifact owner mismatch');
    const payload = canonicalJson(artifact, CONTROL_BYTES);
    const previous = this.db
      .query('SELECT payload,binding FROM runtime_artifact_refs WHERE session=? AND id=?')
      .get(binding.sessionId, artifact.artifactId) as { payload: string; binding: string } | null;
    const encodedBinding = canonicalJson(binding, CONTROL_BYTES);
    if (previous && (previous.payload !== payload || previous.binding !== encodedBinding))
      throw new Error('Artifact reference conflict');
    this.db
      .query('INSERT OR IGNORE INTO runtime_artifact_refs VALUES (?,?,?,?)')
      .run(binding.sessionId, artifact.artifactId, encodedBinding, payload);
  }
  artifact(sessionId: string, owner: string, artifactId: string) {
    this.assertOwner(sessionId, owner);
    uuid.parse(artifactId);
    const row = this.db
      .query('SELECT binding,payload FROM runtime_artifact_refs WHERE session=? AND id=?')
      .get(sessionId, artifactId) as { binding: string; payload: string } | null;
    if (!row) throw new Error('Artifact is not referenced by this session');
    return {
      binding: bindingSchema.parse(parseJson(row.binding, CONTROL_BYTES)),
      reference: artifactSchema.parse(parseJson(row.payload, CONTROL_BYTES)),
    };
  }
  /** Owner/workspace-scoped fresh evidence. Image bodies and legacy files are never read. */
  recap(workspaceId: string, owner: string, days = 14) {
    if (!Number.isSafeInteger(days) || days < 1 || days > 90)
      throw new Error('Invalid recap window');
    const until = this.now(),
      since = until - days * 86_400_000;
    const sessions = this.db
      .query(
        "SELECT id,branch FROM runtime_sessions WHERE owner=? AND json_extract(binding,'$.workspaceId')=? ORDER BY rowid DESC LIMIT 16",
      )
      .all(owner, workspaceId) as { id: string; branch: string }[];
    let remaining = 80_000;
    let truncated = false;
    const evidence = sessions.map((session) => {
      const rows = this.db
        .query(
          `WITH RECURSIVE ancestry(id,parent,depth) AS (
        SELECT e.id,json_extract(e.payload,'$.parentId'),0 FROM runtime_entries e JOIN runtime_branches b ON e.id=b.leaf WHERE b.id=? AND b.session=?
        UNION ALL SELECT e.id,json_extract(e.payload,'$.parentId'),a.depth+1 FROM runtime_entries e JOIN ancestry a ON e.id=a.parent WHERE e.session=?
      ) SELECT e.id,json_extract(e.payload,'$.message.timestamp') AS timestamp,
        json_extract(e.payload,'$.message.role') AS role,
        json_extract(e.payload,'$.message.toolName') AS toolName,
        json_extract(e.payload,'$.message.isError') AS isError,
        CASE WHEN json_type(e.payload,'$.message.content')='text' THEN substr(json_extract(e.payload,'$.message.content'),1,4000)
        ELSE substr((SELECT group_concat(json_extract(value,'$.text'),'') FROM json_each(e.payload,'$.message.content') WHERE json_extract(value,'$.type')='text'),1,4000) END AS text
        FROM ancestry a JOIN runtime_entries e ON e.id=a.id WHERE json_extract(e.payload,'$.message.role') IN ('user','assistant','toolResult') AND timestamp BETWEEN ? AND ? ORDER BY a.depth LIMIT 32`,
        )
        .all(session.branch, session.id, session.id, since, until) as {
        id: string;
        timestamp: number;
        role: string;
        toolName: string | null;
        isError: number | null;
        text: string | null;
      }[];
      const result = rows.reverse().flatMap((row) => {
        if (!remaining) {
          truncated = true;
          return [];
        }
        const text = redactSecrets(row.text ?? '').slice(0, remaining);
        remaining -= text.length;
        return [
          {
            entryId: row.id,
            timestamp: row.timestamp,
            role: row.role === 'toolResult' ? 'tool' : row.role,
            text,
            ...(row.toolName ? { toolName: row.toolName, isError: !!row.isError } : {}),
          },
        ];
      });
      return { sessionId: session.id, evidence: result, truncated: rows.length === 32 };
    });
    return {
      version: 1 as const,
      scope: { workspaceId, days, since, until },
      sampling:
        'Up to 16 fresh sessions and 32 recent messages per session; 80,000 characters total',
      sessions: evidence,
      skipped: [],
      truncated:
        truncated || sessions.length === 16 || evidence.some((session) => session.truncated),
    };
  }
  private publish(session: string, branch: string, payload: unknown): void {
    this.db
      .query('INSERT INTO runtime_outbox(session,branch,payload) VALUES (?,?,?)')
      .run(session, branch, canonicalJson(payload, CONTROL_BYTES));
  }
  /** Trusted client projector only; append the bounded compatibility event atomically with state. */
  publishClientEvent(lease: WriterLease, event: unknown): void {
    this.writable(lease);
    this.publish(lease.binding.sessionId, lease.branchId, { type: 'client.event', event });
  }
  /** Durable event cursor, owner and branch scoped; contains references, never image bytes. */
  events(sessionId: string, owner: string, after = 0, branchId?: string) {
    const session = this.session(sessionId);
    if (session.owner !== owner) throw new Error('Session owner mismatch');
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor');
    const branch = branchId ?? session.branch;
    if (
      !this.db
        .query('SELECT id FROM runtime_branches WHERE id=? AND session=?')
        .get(branch, sessionId)
    )
      throw new Error('Invalid branch');
    return (
      this.db
        .query(
          'SELECT seq,payload FROM runtime_outbox WHERE session=? AND branch=? AND seq>? ORDER BY seq LIMIT 128',
        )
        .all(sessionId, branch, after) as { seq: number; payload: string }[]
    ).map((row) => ({ seq: row.seq, event: parseJson(row.payload, CONTROL_BYTES) }));
  }
  /** Starts a single durable run. Reusing an ID never repeats a provider request or tools. */
  startRun(lease: WriterLease, turn: AuthorityTurn): RuntimeRun {
    return this.db
      .transaction(() => {
        this.writable(lease);
        const prior = this.run(turn.input.runId, lease.binding.sessionId);
        if (prior) {
          if (prior.branch !== lease.branchId || prior.turn !== turn.input.turnId)
            throw new Error('Run ID conflict');
          return prior;
        }
        if (!this.checkTurn(lease, turn.input, turn.descriptor))
          throw new Error('Turn is not committed');
        if (
          this.db
            .query("SELECT id FROM runtime_runs WHERE session=? AND state='running'")
            .get(lease.binding.sessionId)
        )
          throw new Error('Session run already active');
        this.db
          .query("INSERT INTO runtime_runs VALUES (?,?,?,?,'running',NULL)")
          .run(turn.input.runId, lease.binding.sessionId, lease.branchId, turn.input.turnId);
        this.publish(lease.binding.sessionId, lease.branchId, {
          type: 'run.started',
          runId: turn.input.runId,
        });
        return this.run(turn.input.runId, lease.binding.sessionId)!;
      })
      .immediate();
  }
  private run(id: string, session: string): RuntimeRun | undefined {
    uuid.parse(id);
    return (
      (this.db
        .query('SELECT * FROM runtime_runs WHERE id=? AND session=?')
        .get(id, session) as RuntimeRun | null) ?? undefined
    );
  }
  runState(sessionId: string, owner: string, runId: string): RuntimeRun | undefined {
    const session = this.session(sessionId);
    if (session.owner !== owner) throw new Error('Session owner mismatch');
    return this.run(runId, sessionId);
  }
  finishRun(
    binding: Binding,
    runId: string,
    state: Exclude<RuntimeRun['state'], 'running'>,
    reason?: string,
  ): void {
    this.db
      .transaction(() => {
        this.bound(binding);
        const run = this.run(runId, binding.sessionId);
        if (!run) throw new Error('Unknown run');
        if (run.state !== 'running') return;
        this.db
          .query('UPDATE runtime_runs SET state=?,reason=? WHERE id=?')
          .run(state, reason?.slice(0, 8192) ?? null, runId);
        this.publish(binding.sessionId, run.branch, { type: 'run.finished', runId, state });
      })
      .immediate();
  }
  /** Once per authority startup, not once per child runtime instance. */
  recoverRuntimeOnce(): void {
    if (this.runtimeRecovered || recoveredDatabases.has(this.db)) return;
    this.recoverRuns();
    this.runtimeRecovered = true;
    recoveredDatabases.add(this.db);
  }
  /** Single trusted supervisor startup. Interrupted model calls/stacks are never replayed. */
  recoverRuns(): void {
    this.db
      .transaction(() => {
        const runs = this.db
          .query("SELECT * FROM runtime_runs WHERE state='running'")
          .all() as RuntimeRun[];
        for (const run of runs) {
          this.db
            .query(
              "UPDATE runtime_runs SET state='interrupted',reason='Gateway restarted; reconcile original executions' WHERE id=?",
            )
            .run(run.id);
          this.publish(run.session, run.branch, {
            type: 'run.finished',
            runId: run.id,
            state: 'interrupted',
          });
        }
        this.db
          .query("UPDATE runtime_model_calls SET state='interrupted' WHERE state='pending'")
          .run();
      })
      .immediate();
  }
  beginModel(lease: WriterLease, runId: string, request: unknown, snapshot?: unknown): string {
    return this.db
      .transaction(() => {
        this.writable(lease);
        const run = this.run(runId, lease.binding.sessionId);
        if (!run || run.state !== 'running' || run.branch !== lease.branchId)
          throw new Error('Inactive run');
        const id = randomUUID();
        this.db
          .query("INSERT INTO runtime_model_calls VALUES (?,?,?,'pending',NULL)")
          .run(id, runId, digest(request, REQUEST_BYTES));
        if (snapshot !== undefined)
          this.db
            .query('INSERT OR REPLACE INTO runtime_contexts VALUES (?,?,?)')
            .run(lease.branchId, lease.binding.sessionId, canonicalJson(snapshot, ENTRY_BYTES));
        return id;
      })
      .immediate();
  }
  /** Assistant, provider metadata, tool mappings and dispatch intents share one transaction. */
  commitModel(
    lease: WriterLease,
    callId: string,
    input: EntryInput,
    executions: Array<{ intent: ExecutionIntent; modelToolCallId: string }> = [],
  ): AuthorityEntry {
    return this.db
      .transaction(() => {
        this.writable(lease);
        const call = this.db.query('SELECT * FROM runtime_model_calls WHERE id=?').get(callId) as {
          run: string;
          state: string;
          entry: string | null;
        } | null;
        const run = call && this.run(call.run, lease.binding.sessionId);
        if (
          !call ||
          !run ||
          run.state !== 'running' ||
          run.branch !== lease.branchId ||
          call.state !== 'pending'
        )
          throw new Error('Invalid model completion');
        const parsed = entrySchema.parse(input);
        if (parsed.type !== 'message' || parsed.message.role !== 'assistant')
          throw new Error('Expected assistant completion');
        const tools = parsed.message.content.filter((part) => part.type === 'toolCall');
        if (new Set(tools.map((tool) => tool.id)).size !== tools.length)
          throw new Error('Duplicate model tool call');
        if (
          executions.length &&
          (executions.length > tools.length ||
            new Set(executions.map((execution) => execution.modelToolCallId)).size !==
              executions.length ||
            parsed.message.stopReason !== 'toolUse')
        )
          throw new Error('Model execution mismatch');
        const entry = this.appendTo(lease.binding.sessionId, lease.branchId, parsed);
        for (const execution of executions) {
          const tool = tools.find((tool) => tool.id === execution.modelToolCallId);
          if (
            !tool ||
            tool.name !== execution.intent.capability ||
            canonicalJson(tool.arguments, REQUEST_BYTES) !==
              canonicalJson(execution.intent.arguments, REQUEST_BYTES) ||
            execution.intent.runId !== run.id
          )
            throw new Error('Model execution arguments mismatch');
          this.persistExecution(lease, execution.intent);
          this.db
            .query('INSERT INTO runtime_tool_aliases VALUES (?,?)')
            .run(execution.intent.executionId, execution.modelToolCallId);
        }
        this.db
          .query("UPDATE runtime_model_calls SET state='completed',entry=? WHERE id=?")
          .run(entry.id, callId);
        return entry;
      })
      .immediate();
  }
  failAuxiliary(lease: WriterLease, callId: string): void {
    this.writable(lease);
    const call = this.db.query('SELECT run FROM runtime_model_calls WHERE id=?').get(callId) as {
      run: string;
    } | null;
    if (!call || !this.run(call.run, lease.binding.sessionId))
      throw new Error('Invalid auxiliary failure');
    this.db
      .query("UPDATE runtime_model_calls SET state='interrupted' WHERE id=? AND state='pending'")
      .run(callId);
  }
  /** Title/memory/compaction responses retain replay metadata without entering ordinary history. */
  commitAuxiliary(
    lease: WriterLease,
    callId: string,
    purpose: 'title' | 'memory' | 'compaction',
    message: unknown,
    projection?: EntryInput,
  ): void {
    this.db
      .transaction(() => {
        this.writable(lease);
        const call = this.db
          .query('SELECT run,state FROM runtime_model_calls WHERE id=?')
          .get(callId) as { run: string; state: string } | null;
        const run = call && this.run(call.run, lease.binding.sessionId);
        if (
          !call ||
          !run ||
          run.state !== 'running' ||
          run.branch !== lease.branchId ||
          call.state !== 'pending'
        )
          throw new Error('Invalid auxiliary model completion');
        const input = entrySchema.parse({ type: 'message', message });
        if (input.type !== 'message' || input.message.role !== 'assistant')
          throw new Error('Expected assistant completion');
        const entry = this.appendTo(lease.binding.sessionId, lease.branchId, {
          type: 'custom',
          customType: `runtime.model.${purpose}`,
          data: parseJson(canonicalJson(input.message, ENTRY_BYTES), ENTRY_BYTES),
        });
        if (projection) this.appendTo(lease.binding.sessionId, lease.branchId, projection);
        this.db
          .query("UPDATE runtime_model_calls SET state='completed',entry=? WHERE id=?")
          .run(entry.id, callId);
      })
      .immediate();
  }
  executions(sessionId: string, owner: string, runId?: string) {
    const session = this.session(sessionId);
    if (session.owner !== owner) throw new Error('Session owner mismatch');
    if (runId) uuid.parse(runId);
    const rows = this.db
      .query(
        "SELECT e.*,a.execution AS ack FROM runtime_executions e LEFT JOIN runtime_acks a ON a.execution=e.id WHERE e.session=? AND (? IS NULL OR json_extract(e.intent,'$.runId')=?) ORDER BY e.rowid",
      )
      .all(sessionId, runId ?? null, runId ?? null) as (ExecutionRow & { ack: string | null })[];
    return rows.map((row) => ({
      intent: validateIntent(parseJson(row.intent, REQUEST_BYTES)),
      receipt: row.receipt ? recordSchema.parse(parseJson(row.receipt, RESULT_BYTES)) : undefined,
      acknowledged: !!row.ack,
      branchId: row.branch,
    }));
  }
  /** Recovery page measured before parsing; completed acknowledged work is excluded. */
  recoveryPage(sessionId: string, owner: string, after = 0) {
    this.assertOwner(sessionId, owner);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid recovery cursor');
    const headers = this.db
      .query(
        `SELECT e.id,e.rowid AS cursor,
      length(CAST(e.intent AS BLOB))+COALESCE(length(CAST(e.receipt AS BLOB)),0) AS bytes
      FROM runtime_executions e LEFT JOIN runtime_acks a ON a.execution=e.id
      WHERE e.session=? AND e.rowid>? AND (a.execution IS NULL OR json_extract(e.receipt,'$.state')='unknown')
      ORDER BY e.rowid LIMIT 33`,
      )
      .all(sessionId, after) as { id: string; cursor: number; bytes: number }[];
    let bytes = 0;
    let cursor = after;
    const executions: ExecutionIntent[] = [];
    for (const header of headers.slice(0, 32)) {
      if (bytes + header.bytes > REQUEST_BYTES + RESULT_BYTES) break;
      bytes += header.bytes;
      const row = this.db
        .query('SELECT intent FROM runtime_executions WHERE id=? AND session=?')
        .get(header.id, sessionId) as { intent: string };
      executions.push(validateIntent(parseJson(row.intent, REQUEST_BYTES)));
      cursor = header.cursor;
    }
    return { executions, nextCursor: headers.length > executions.length ? cursor : null };
  }
  contextSnapshot(sessionId: string, owner: string, branchId?: string): Json | undefined {
    const session = this.session(sessionId);
    if (session.owner !== owner) throw new Error('Session owner mismatch');
    const row = this.db
      .query('SELECT payload FROM runtime_contexts WHERE session=? AND branch=?')
      .get(sessionId, branchId ?? session.branch) as { payload: string } | null;
    return row ? parseJson(row.payload, ENTRY_BYTES) : undefined;
  }
  steer(lease: WriterLease, input: TurnInput): void {
    input = validateTurnInput(input, lease.binding);
    this.writable(lease);
    const run = this.run(input.runId, lease.binding.sessionId);
    if (!run || run.state !== 'running' || run.branch !== lease.branchId)
      throw new Error('Inactive steering run');
    const encoded = canonicalJson(input, ENTRY_BYTES);
    const previous = this.db
      .query('SELECT input FROM runtime_steering WHERE id=?')
      .get(input.turnId) as { input: string } | null;
    if (previous) {
      if (previous.input !== encoded) throw new Error('Steering ID conflict');
      return;
    }
    const count = this.db
      .query('SELECT COUNT(*) AS count FROM runtime_steering WHERE run=? AND consumed=0')
      .get(run.id) as { count: number };
    if (count.count >= 16) throw new Error('Steering queue exceeded');
    this.db
      .query('INSERT INTO runtime_steering VALUES (?,?,?,0)')
      .run(input.turnId, run.id, encoded);
  }
  queuedSteering(lease: WriterLease, runId: string): TurnInput[] {
    this.writable(lease);
    const run = this.run(runId, lease.binding.sessionId);
    if (!run || run.state !== 'running' || run.branch !== lease.branchId)
      throw new Error('Inactive run');
    return (
      this.db
        .query('SELECT input FROM runtime_steering WHERE run=? AND consumed=0 ORDER BY rowid')
        .all(runId) as { input: string }[]
    ).map((row) =>
      validateTurnInput(parseJson(row.input, ENTRY_BYTES) as unknown as TurnInput, lease.binding),
    );
  }
  consumeSteering(lease: WriterLease, input: TurnInput): void {
    this.writable(lease);
    if (!this.checkTurn(lease, input)) throw new Error('Steering turn not committed');
    this.db
      .query('UPDATE runtime_steering SET consumed=1 WHERE id=? AND run=?')
      .run(input.turnId, input.runId);
  }
}

export interface RuntimeRun {
  id: string;
  session: string;
  branch: string;
  turn: string;
  state: 'running' | 'completed' | 'interrupted' | 'unknown' | 'failed';
  reason: string | null;
}
