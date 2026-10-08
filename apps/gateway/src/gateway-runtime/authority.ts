import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  validateTurnDescriptor,
  validateTurnInput,
  type AuthorityTurn,
  type TurnInput,
} from './turn-contracts.js';
import type { Descriptor } from '../environment/protocol.js';
import type { ImageContent } from '../agent/messages.js';
import { chmodSync } from 'node:fs';
import { z } from 'zod';
import { canonicalJson, digest, parseJson } from '../environment/json.js';
import {
  bindingSchema,
  CONTROL_BYTES,
  REQUEST_BYTES,
  RESULT_BYTES,
  validateIntent,
  validateRecordDelivery,
  recordSchema,
  type Binding,
  type ExecutionIntent,
  type ExecutionRecord,
  type Environment,
} from '../environment/protocol.js';
import { contextEntriesOf, historyWithOperations } from '../agent/session-store.js';
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
  constructor(
    file: string,
    private readonly now = Date.now,
  ) {
    this.db = new Database(file, { create: true });
    if (file !== ':memory:') chmodSync(file, 0o600);
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
      CREATE TABLE IF NOT EXISTS runtime_turn_sessions (
        session TEXT PRIMARY KEY REFERENCES runtime_sessions(id)
      );
      CREATE TABLE IF NOT EXISTS runtime_turns (
        id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES runtime_sessions(id),
        branch TEXT NOT NULL REFERENCES runtime_branches(id), input TEXT NOT NULL,
        descriptor TEXT NOT NULL, entry TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_tool_identity ON runtime_executions(
        session, json_extract(intent,'$.runId'), json_extract(intent,'$.turnId'),
        json_extract(intent,'$.toolCallId')
      );`);
  }
  close(): void {
    this.db.close();
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
  private appendTo(sessionId: string, branchId: string, input: EntryInput): AuthorityEntry {
    canonicalJson(input, ENTRY_BYTES);
    input = entrySchema.parse(input);
    const branch = this.db
      .query('SELECT leaf FROM runtime_branches WHERE id=? AND session=?')
      .get(branchId, sessionId) as { leaf: string | null } | null;
    if (!branch) throw new Error('Invalid branch');
    if (
      input.type === 'compaction' &&
      !this.chain(sessionId, branchId).some(
        (entry) => entry.id === input.firstKeptEntryId && entry.type === 'message',
      )
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
    return entry;
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
        if (
          atEntryId &&
          !this.chain(session.id, lease.branchId).some((entry) => entry.id === atEntryId)
        )
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
        const entry = this.appendTo(lease.binding.sessionId, lease.branchId, {
          type: 'message',
          message: {
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
            !descriptor.capabilityCatalog.some(
              (capability) => capability.name === intent.capability,
            ) ||
            intent.budgetMs > descriptor.limits.maxBudgetMs
          )
            throw new Error('Execution does not match authoritative turn');
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
          const input = entrySchema.parse({
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: intent.toolCallId,
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
        this.db
          .query('UPDATE runtime_executions SET receipt=? WHERE id=?')
          .run(canonicalJson(record, RESULT_BYTES), record.executionId);
      })
      .immediate();
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
  }
}
