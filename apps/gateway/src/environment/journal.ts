import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import { canonicalJson, digest, parseJson } from './json.js';
import {
  bindingSchema,
  eventSchema,
  recordSchema,
  terminalSchema,
  validateIntent,
  validateEventDelivery,
  validateRecordDelivery,
  CONTROL_BYTES,
  REQUEST_BYTES,
  RESULT_BYTES,
  type Binding,
  type ExecutionEvent,
  type ExecutionIntent,
  type ExecutionRecord,
  type Terminal,
} from './protocol.js';

const DAY = 86_400_000;
const TERMINAL = new Set(['rejected', 'completed', 'failed', 'cancelled', 'unknown']);
interface Row {
  id: string;
  binding: string;
  intent: string;
  record: string;
  accepted_at: number;
  deadline_at: number;
  ack_at: number | null;
}
interface Grant {
  binding: string;
  descriptor: string;
  policy: string;
  retired: number;
}

/**
 * Private, dedicated journal foundation, not wired to production dispatch.
 * Provision/retire/recover are supervisor-only lifecycle operations, NOT wire APIs.
 * Callers must independently authenticate a binding before every operation.
 * One supervisor owns a node journal; recovery is only legal after its old
 * executor has been fenced/stopped. No method launches or replays a tool.
 */
export class ExecutionJournal {
  private readonly db: Database;
  constructor(
    file: string,
    private readonly now = Date.now,
  ) {
    this.db = new Database(file, { create: true });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS env_bindings (
        binding TEXT PRIMARY KEY, descriptor TEXT NOT NULL, policy TEXT NOT NULL,
        retired INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS env_executions (
        id TEXT PRIMARY KEY, binding TEXT NOT NULL REFERENCES env_bindings(binding),
        intent TEXT NOT NULL, record TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL, ack_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS env_events (
        id TEXT NOT NULL REFERENCES env_executions(id), seq INTEGER NOT NULL,
        event TEXT NOT NULL, PRIMARY KEY(id, seq)
      );
      CREATE TABLE IF NOT EXISTS env_outbox (
        id TEXT PRIMARY KEY, binding TEXT NOT NULL REFERENCES env_bindings(binding),
        intent TEXT NOT NULL, receipt TEXT
      );`);
  }
  close(): void {
    this.db.close();
  }
  private key(binding: Binding): string {
    canonicalJson(binding, CONTROL_BYTES);
    return canonicalJson(bindingSchema.parse(binding), CONTROL_BYTES);
  }
  private grant(binding: Binding): Grant {
    const key = this.key(binding);
    const grant = this.db
      .query('SELECT * FROM env_bindings WHERE binding=?')
      .get(key) as Grant | null;
    if (!grant) throw new Error('Invalid binding');
    return grant;
  }
  /** Revisions are provisioned by trusted node policy resolution, never by start(). */
  provision(binding: Binding, descriptor: string, policy: string): void {
    const key = this.key(binding);
    if (![descriptor, policy].every((hash) => /^[a-f0-9]{64}$/.test(hash)))
      throw new Error('Invalid revision');
    this.db
      .transaction(() => {
        const old = this.db
          .query('SELECT * FROM env_bindings WHERE binding=?')
          .get(key) as Grant | null;
        if (old?.retired) throw new Error('Retired generation');
        if (old) {
          if (old.descriptor !== descriptor || old.policy !== policy)
            throw new Error('Binding already provisioned with different revisions');
          return;
        }
        this.db
          .query('INSERT INTO env_bindings(binding,descriptor,policy) VALUES (?,?,?)')
          .run(key, descriptor, policy);
      })
      .immediate();
  }
  /** Permanent fence: records remain queryable, but no old starts are admitted. */
  retire(binding: Binding): void {
    const grant = this.grant(binding);
    this.db.query('UPDATE env_bindings SET retired=1 WHERE binding=?').run(grant.binding);
  }
  private row(binding: Binding, id: string): Row {
    const grant = this.grant(binding);
    const row = this.db
      .query('SELECT * FROM env_executions WHERE id=? AND binding=?')
      .get(id, grant.binding) as Row | null;
    if (!row) throw new Error('Unknown execution');
    return row;
  }
  private record(row: Row): ExecutionRecord {
    return recordSchema.parse(parseJson(row.record, RESULT_BYTES));
  }
  private save(record: ExecutionRecord): ExecutionRecord {
    validateRecordDelivery(record);
    this.db
      .query('UPDATE env_executions SET record=? WHERE id=? AND binding=?')
      .run(canonicalJson(record, RESULT_BYTES), record.executionId, this.key(record.binding));
    return record;
  }
  status(binding: Binding, id: string): ExecutionRecord {
    return this.record(this.row(binding, id));
  }

  /** Transaction commits acceptance/rejection before callers may start any hook/effect. */
  accept(value: ExecutionIntent): { fresh: boolean; record: ExecutionRecord } {
    const intent = validateIntent(value);
    return this.db
      .transaction(() => {
        const grant = this.grant(intent.binding);
        if (grant.retired) throw new Error('Retired generation');
        const previous = this.db
          .query('SELECT * FROM env_executions WHERE id=?')
          .get(intent.executionId) as Row | null;
        if (previous) {
          if (
            previous.binding !== grant.binding ||
            previous.intent !== canonicalJson(intent, REQUEST_BYTES)
          )
            throw new Error('Execution ID conflict');
          return { fresh: false, record: this.record(previous) };
        }
        const now = this.now();
        const record: ExecutionRecord = {
          binding: intent.binding,
          executionId: intent.executionId,
          argumentDigest: intent.argumentDigest,
          state: 'accepted',
          effect: 'not_started',
          finalSeq: 0,
          cancelRequested: false,
          acknowledged: false,
          reclaimed: false,
        };
        this.db
          .query(
            'INSERT INTO env_executions(id,binding,intent,record,accepted_at,deadline_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            intent.executionId,
            grant.binding,
            canonicalJson(intent, REQUEST_BYTES),
            canonicalJson(record, RESULT_BYTES),
            now,
            now + intent.budgetMs,
          );
        if (
          intent.descriptorRevision !== grant.descriptor ||
          intent.policyRevision !== grant.policy
        ) {
          return {
            fresh: false,
            record: this.finishRecord(record, {
              state: 'rejected',
              effect: 'not_started',
              truncated: false,
              artifacts: [],
              error: { code: 'stale_revision', message: 'Refresh the environment descriptor' },
            }),
          };
        }
        return { fresh: true, record };
      })
      .immediate();
  }

  /** Exactly one successful claim in this executor lifetime. Duplicates cannot run. */
  claim(binding: Binding, id: string): ExecutionRecord {
    return this.db
      .transaction(() => {
        const grant = this.grant(binding);
        if (grant.retired) throw new Error('Retired generation');
        const row = this.row(binding, id);
        const record = this.record(row);
        if (record.state !== 'accepted' || record.cancelRequested)
          throw new Error('Execution is not startable');
        if (this.now() >= row.deadline_at)
          return this.finishRecord(record, {
            state: 'failed',
            effect: 'not_started',
            truncated: false,
            artifacts: [],
            error: { code: 'expired', message: 'Admission deadline expired' },
          });
        // The future executor owns a monotonic deadline. Wall time is used here
        // only for queue expiry/retention, never to restore or extend a grant.
        return this.save({ ...record, state: 'running', effect: 'unknown' });
      })
      .immediate();
  }

  cancel(binding: Binding, id: string): ExecutionRecord {
    return this.db
      .transaction(() => {
        const record = this.status(binding, id);
        if (TERMINAL.has(record.state)) return record;
        record.cancelRequested = true;
        if (record.state === 'accepted')
          return this.finishRecord(record, {
            state: 'cancelled',
            effect: 'not_started',
            truncated: false,
            artifacts: [],
          });
        // Persist a request only. The executor must terminate process groups and
        // separately report a terminal outcome; receipt is not rollback.
        return this.save(record);
      })
      .immediate();
  }

  appendEvent(
    binding: Binding,
    id: string,
    kind: ExecutionEvent['kind'],
    payload: ExecutionEvent['payload'],
  ): ExecutionEvent {
    return this.db
      .transaction(() => {
        const record = this.status(binding, id);
        if (TERMINAL.has(record.state)) throw new Error('Execution is terminal');
        const event = eventSchema.parse({
          binding,
          executionId: id,
          seq: record.finalSeq + 1,
          kind,
          payload,
        });
        validateEventDelivery(event);
        const encoded = canonicalJson(event, CONTROL_BYTES);
        this.db
          .query('INSERT INTO env_events(id,seq,event) VALUES (?,?,?)')
          .run(id, event.seq, encoded);
        this.save({ ...record, finalSeq: event.seq });
        return event;
      })
      .immediate();
  }
  events(binding: Binding, id: string, after = 0, limit = 100): ExecutionEvent[] {
    this.row(binding, id);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Invalid event page');
    return (
      this.db
        .query('SELECT event FROM env_events WHERE id=? AND seq>? ORDER BY seq LIMIT ?')
        .all(id, after, limit) as Array<{ event: string }>
    ).map((row) => eventSchema.parse(parseJson(row.event, CONTROL_BYTES)));
  }
  private finishRecord(record: ExecutionRecord, terminal: Terminal): ExecutionRecord {
    canonicalJson(terminal, RESULT_BYTES);
    terminal = terminalSchema.parse(terminal);
    for (const artifact of terminal.artifacts) {
      if (
        artifact.nodeId !== record.binding.nodeId ||
        artifact.workspaceId !== record.binding.workspaceId ||
        artifact.sessionId !== record.binding.sessionId
      )
        throw new Error('Artifact ownership mismatch');
    }
    const resultDigest = digest(
      {
        binding: record.binding,
        executionId: record.executionId,
        argumentDigest: record.argumentDigest,
        finalSeq: record.finalSeq,
        terminal,
      },
      RESULT_BYTES,
    );
    return this.save({
      ...record,
      state: terminal.state,
      effect: terminal.effect,
      terminal,
      resultDigest,
    });
  }
  finish(binding: Binding, id: string, value: Terminal): ExecutionRecord {
    return this.db
      .transaction(() => {
        const record = this.status(binding, id);
        canonicalJson(value, RESULT_BYTES);
        const terminal = terminalSchema.parse(value);
        if (TERMINAL.has(record.state)) {
          if (
            record.terminal &&
            canonicalJson(record.terminal, RESULT_BYTES) === canonicalJson(terminal, RESULT_BYTES)
          )
            return record;
          throw new Error('Terminal result conflict');
        }
        if (record.state !== 'running') throw new Error('Execution has not started');
        if (terminal.state === 'rejected') throw new Error('Cannot reject running work');
        return this.finishRecord(record, terminal);
      })
      .immediate();
  }

  /**
   * Supervisor-only verified evidence, never a retry or execution callback.
   * Refines an unknown original outcome and resets ACK for the new result digest.
   * The caller must verify evidence independently; IDs/digests are not evidence.
   */
  reconcile(binding: Binding, id: string, evidence: Terminal): ExecutionRecord {
    return this.db
      .transaction(() => {
        const record = this.status(binding, id);
        canonicalJson(evidence, RESULT_BYTES);
        const terminal = terminalSchema.parse(evidence);
        if (
          record.state !== 'unknown' ||
          terminal.state === 'unknown' ||
          terminal.state === 'rejected' ||
          terminal.effect === 'unknown'
        )
          throw new Error('Only verified evidence may refine an unknown execution');
        this.db.query('UPDATE env_executions SET ack_at=NULL WHERE id=?').run(id);
        return this.finishRecord({ ...record, acknowledged: false }, terminal);
      })
      .immediate();
  }

  /** Only after fencing the prior executor; never automatically dispatch recovered work. */
  recover(binding: Binding): ExecutionRecord[] {
    return this.db
      .transaction(() => {
        const grant = this.grant(binding);
        const rows = this.db
          .query('SELECT * FROM env_executions WHERE binding=?')
          .all(grant.binding) as Row[];
        const recovered: ExecutionRecord[] = [];
        for (const row of rows) {
          const record = this.record(row);
          if (record.state === 'running' || record.state === 'accepted')
            recovered.push(
              this.finishRecord(record, {
                state: record.state === 'running' ? 'unknown' : 'failed',
                effect: record.state === 'running' ? 'unknown' : 'not_started',
                truncated: false,
                artifacts: [],
                error: {
                  code: 'unknown',
                  message: 'Executor stopped; do not replay this execution',
                },
              }),
            );
        }
        return recovered;
      })
      .immediate();
  }

  ack(binding: Binding, id: string, resultDigest: string): ExecutionRecord {
    return this.db
      .transaction(() => {
        const record = this.status(binding, id);
        if (!record.resultDigest || record.resultDigest !== resultDigest)
          throw new Error('Result digest mismatch');
        if (!record.acknowledged) {
          this.db.query('UPDATE env_executions SET ack_at=? WHERE id=?').run(this.now(), id);
          record.acknowledged = true;
          this.save(record);
        }
        return record;
      })
      .immediate();
  }
  /** Only acknowledged bulky results after 24h; uncertain outcomes stay intact. */
  reclaim(binding: Binding, id: string): boolean {
    return this.db
      .transaction(() => {
        const row = this.row(binding, id);
        const record = this.record(row);
        if (
          row.ack_at === null ||
          this.now() - row.ack_at < DAY ||
          record.effect === 'unknown' ||
          record.reclaimed
        )
          return false;
        delete record.terminal;
        record.reclaimed = true;
        this.save(record);
        this.db.query('DELETE FROM env_events WHERE id=?').run(id);
        return true;
      })
      .immediate();
  }

  /** Gateway intent persisted before send. Does not claim node acceptance. */
  persistIntent(value: ExecutionIntent): void {
    const intent = validateIntent(value);
    this.db
      .transaction(() => {
        const grant = this.grant(intent.binding);
        if (grant.retired) throw new Error('Retired generation');
        const encoded = canonicalJson(intent, REQUEST_BYTES);
        const previous = this.db
          .query('SELECT intent FROM env_outbox WHERE id=?')
          .get(intent.executionId) as { intent: string } | null;
        if (previous) {
          if (previous.intent !== encoded) throw new Error('Execution ID conflict');
          return;
        }
        this.db
          .query('INSERT INTO env_outbox(id,binding,intent) VALUES (?,?,?)')
          .run(intent.executionId, grant.binding, encoded);
      })
      .immediate();
  }
  /** Durable gateway receipt foundation; M3 must atomically couple transcript commit to ACK. */
  receiveResult(binding: Binding, value: ExecutionRecord): void {
    canonicalJson(value, RESULT_BYTES);
    const record = recordSchema.parse(value);
    validateRecordDelivery(record);
    this.db
      .transaction(() => {
        const grant = this.grant(binding);
        if (this.key(record.binding) !== grant.binding || !record.terminal || !record.resultDigest)
          throw new Error('Invalid result binding or missing terminal data');
        const row = this.db
          .query('SELECT intent,receipt FROM env_outbox WHERE id=? AND binding=?')
          .get(record.executionId, grant.binding) as {
          intent: string;
          receipt: string | null;
        } | null;
        if (!row) throw new Error('No persisted intent');
        const intent = validateIntent(parseJson(row.intent, REQUEST_BYTES));
        if (intent.argumentDigest !== record.argumentDigest)
          throw new Error('Result intent mismatch');
        const expected = digest(
          {
            binding: record.binding,
            executionId: record.executionId,
            argumentDigest: record.argumentDigest,
            finalSeq: record.finalSeq,
            terminal: record.terminal,
          },
          RESULT_BYTES,
        );
        if (expected !== record.resultDigest) throw new Error('Result digest mismatch');
        const encoded = canonicalJson(record, RESULT_BYTES);
        if (row.receipt) {
          const previous = recordSchema.parse(parseJson(row.receipt, RESULT_BYTES));
          if (previous.resultDigest === record.resultDigest) return;
          // Only the original unknown outcome can gain verified evidence.
          // Ordinary terminal results stay immutable; stale replies cannot undo it.
          if (
            previous.state !== 'unknown' ||
            record.state === 'unknown' ||
            record.state === 'rejected' ||
            record.effect === 'unknown' ||
            previous.finalSeq !== record.finalSeq ||
            previous.cancelRequested !== record.cancelRequested
          )
            throw new Error('Result conflict');
        }
        this.db
          .query('UPDATE env_outbox SET receipt=? WHERE id=?')
          .run(encoded, record.executionId);
      })
      .immediate();
  }
  receipt(binding: Binding, id: string): ExecutionRecord | undefined {
    const grant = this.grant(binding);
    const row = this.db
      .query('SELECT receipt FROM env_outbox WHERE id=? AND binding=?')
      .get(id, grant.binding) as { receipt: string | null } | null;
    return row?.receipt ? recordSchema.parse(parseJson(row.receipt, RESULT_BYTES)) : undefined;
  }
}
