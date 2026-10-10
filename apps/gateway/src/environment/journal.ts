import { Database } from 'bun:sqlite';
import { chmodSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { canonicalJson, digest, parseJson } from './json.js';
import { InnerJournal } from './inner-journal.js';
import { relaxedTransaction } from './durability.js';
import {
  bindingSchema,
  eventSchema,
  recordSchema,
  terminalSchema,
  validateIntent,
  validateIntentText,
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type EnvironmentErrorCode = NonNullable<Terminal['error']>['code'];
/**
 * Node-side typed refusal. Dispatch turns it into a correlated `environment.error`
 * reply carrying `code`; the message must stay free of paths and secrets.
 */
export class EnvironmentCodeError extends Error {
  constructor(
    readonly code: EnvironmentErrorCode,
    message: string,
  ) {
    super(message);
  }
}
/**
 * `unknown_execution`: never accepted for this binding and now guaranteed never to run.
 * Only raised when a durable fence (a FULL-committed tombstone or the generation's
 * permanent retirement) guarantees the ID can never be accepted; the gateway may then
 * commit `not_started` for an intent it persisted.
 *
 * PRECONDITION (operational, not enforced): this journal file is never restored from a
 * backup independently of the gateway authority. A node-only restore of an older
 * environment-journal.sqlite would make a retired generation answer `unknown_execution`
 * for work it accepted (and maybe ran) after that backup was taken, letting the gateway
 * commit `not_started` for an effect that happened. Restore both ends together or not at all.
 */
const neverAccepted = () =>
  new EnvironmentCodeError(
    'unknown_execution',
    'Unknown execution: never accepted and cannot start',
  );
const retiredGeneration = () => new EnvironmentCodeError('stale_epoch', 'Retired generation');
const retiredBeforeStart = (): Terminal => ({
  state: 'cancelled',
  effect: 'not_started',
  truncated: false,
  artifacts: [],
  error: {
    code: 'stale_epoch',
    message: 'Writer generation retired before this execution started',
  },
});
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
  readonly inner: InnerJournal;
  constructor(
    private readonly file: string,
    private readonly now = Date.now,
    private readonly softCap = 1024 * 1024 * 1024,
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
      );
      CREATE TABLE IF NOT EXISTS env_quarantines (
        binding TEXT PRIMARY KEY REFERENCES env_bindings(binding), paths TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS env_tombstones (
        binding TEXT NOT NULL REFERENCES env_bindings(binding), id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('never_accepted','reclaimed')), at INTEGER NOT NULL,
        PRIMARY KEY(binding, id)
      );`);
    this.inner = new InnerJournal(this.db);
  }
  close(): void {
    this.db.close();
  }
  usage(): number {
    if (this.file === ':memory:')
      return (
        Number((this.db.query('PRAGMA page_count').get() as { page_count: number }).page_count) *
        4096
      );
    return [this.file, `${this.file}-wal`].reduce((sum, file) => {
      try {
        return sum + statSync(file).size;
      } catch {
        return sum;
      }
    }, 0);
  }
  assertAdmissionCapacity(bytes: number): void {
    // Reserve terminal-write headroom for every active record, not just intent bytes.
    const active = (
      this.db
        .query(
          "SELECT count(*) AS n FROM env_executions WHERE json_extract(record,'$.state') IN ('accepted','running')",
        )
        .get() as { n: number }
    ).n;
    if (this.usage() + bytes + (active + 1) * RESULT_BYTES > this.softCap)
      throw new EnvironmentCodeError('quota_exceeded', 'Journal soft cap exceeded');
  }
  bindings(): Binding[] {
    return (this.db.query('SELECT binding FROM env_bindings').all() as { binding: string }[]).map(
      (row) => bindingSchema.parse(parseJson(row.binding, CONTROL_BYTES)),
    );
  }
  refresh(binding: Binding, descriptor: string, policy: string): void {
    if (![descriptor, policy].every((hash) => /^[a-f0-9]{64}$/.test(hash)))
      throw new Error('Invalid revision');
    const grant = this.grant(binding);
    if (grant.retired) throw retiredGeneration();
    this.db
      .query('UPDATE env_bindings SET descriptor=?,policy=? WHERE binding=?')
      .run(descriptor, policy, grant.binding);
  }
  expire(binding: Binding, id: string): ExecutionRecord {
    const record = this.status(binding, id);
    if (record.state !== 'accepted') return record;
    return this.finishRecord(record, {
      state: 'failed',
      effect: 'not_started',
      artifacts: [],
      truncated: false,
      error: { code: 'expired', message: 'Admission deadline expired' },
    });
  }
  compactRetired(binding: Binding): number {
    const grant = this.grant(binding);
    if (!grant.retired) throw new EnvironmentCodeError('stale_epoch', 'Generation is not fenced');
    return this.db
      .transaction(() => {
        // Retirement already refuses every start, so never-accepted tombstones are
        // redundant here: an unknown ID of a retired generation stays unknown_execution.
        this.db
          .query("DELETE FROM env_tombstones WHERE binding=? AND kind='never_accepted'")
          .run(grant.binding);
        const rows = this.db
          .query('SELECT * FROM env_executions WHERE binding=?')
          .all(grant.binding) as Row[];
        let count = 0;
        for (const row of rows) {
          this.reclaim(binding, row.id);
          if (!this.status(binding, row.id).reclaimed) continue;
          // Remember the ID so a later status cannot claim it was never accepted.
          this.db
            .query(
              "INSERT OR REPLACE INTO env_tombstones(binding,id,kind,at) VALUES (?,?,'reclaimed',?)",
            )
            .run(grant.binding, row.id, this.now());
          this.db.query('DELETE FROM env_executions WHERE id=?').run(row.id);
          count++;
        }
        return count;
      })
      .immediate();
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
    if (!grant) throw new EnvironmentCodeError('invalid_binding', 'Invalid binding');
    return grant;
  }
  /**
   * Revisions are provisioned by trusted node policy resolution, never by start().
   * `fresh` (node executors): refuse an existing generation, so a restart can never
   * bring back an old executor epoch; fenced generations are only adopted read-only.
   */
  provision(
    binding: Binding,
    descriptor: string,
    policy: string,
    options: { fresh?: boolean } = {},
  ): void {
    const key = this.key(binding);
    if (![descriptor, policy].every((hash) => /^[a-f0-9]{64}$/.test(hash)))
      throw new Error('Invalid revision');
    this.db
      .transaction(() => {
        if (options.fresh) {
          this.assertFreshProvisionable(binding);
        } else {
          this.assertNotQuarantined(binding);
          const old = this.db
            .query('SELECT * FROM env_bindings WHERE binding=?')
            .get(key) as Grant | null;
          if (old?.retired) throw retiredGeneration();
          if (old) {
            if (old.descriptor !== descriptor || old.policy !== policy)
              throw new EnvironmentCodeError(
                'conflict',
                'Binding already provisioned with different revisions',
              );
            return;
          }
        }
        this.db
          .query('INSERT INTO env_bindings(binding,descriptor,policy) VALUES (?,?,?)')
          .run(key, descriptor, policy);
      })
      .immediate();
  }
  /**
   * Fresh (node executor) provisioning eligibility, side-effect free: the generation is
   * new, not quarantined, and no OTHER generation of the same node session is still
   * active (two live generations of one session must never coexist). `replacing` is the
   * one generation a fenced replacement is about to retire (refresh pre-check only).
   */
  assertFreshProvisionable(binding: Binding, replacing?: Binding): void {
    const key = this.key(binding);
    this.assertNotQuarantined(binding);
    const old = this.db.query('SELECT retired FROM env_bindings WHERE binding=?').get(key) as Pick<
      Grant,
      'retired'
    > | null;
    if (old?.retired) throw retiredGeneration();
    if (old)
      throw new EnvironmentCodeError(
        'conflict',
        'Binding already provisioned; use a fenced replacement generation',
      );
    const except = replacing ? this.key(replacing) : undefined;
    const live = this.db
      .query(
        `SELECT binding FROM env_bindings WHERE retired=0
          AND json_extract(binding,'$.nodeId')=? AND json_extract(binding,'$.sessionId')=?`,
      )
      .all(binding.nodeId, binding.sessionId) as { binding: string }[];
    if (live.some((row) => row.binding !== except))
      throw new EnvironmentCodeError(
        'conflict',
        'Another generation of this session is still live; fence and retire it first',
      );
  }
  isRetired(binding: Binding): boolean {
    return Boolean(this.grant(binding).retired);
  }
  isProvisioned(binding: Binding): boolean {
    return Boolean(
      this.db.query('SELECT binding FROM env_bindings WHERE binding=?').get(this.key(binding)),
    );
  }
  /** Node supervisor only: persist the fence and retained lease roots before reconciliation. */
  quarantine(binding: Binding, paths: string[]): void {
    if (!paths.every((root) => typeof root === 'string' && isAbsolute(root)))
      throw new Error('Invalid quarantine lease root');
    const grant = this.grant(binding);
    this.db
      .transaction(() => {
        const previous = this.quarantines().find(
          (entry) => this.key(entry.binding) === grant.binding,
        );
        const roots = [...new Set([...(previous?.paths ?? []), ...paths])];
        this.db
          .query('INSERT OR REPLACE INTO env_quarantines(binding,paths) VALUES (?,?)')
          .run(grant.binding, canonicalJson(roots, CONTROL_BYTES));
        this.retire(binding);
      })
      .immediate();
  }
  /** Trusted startup restores these roots before provisioning or admitting any executor. */
  quarantines(): Array<{ binding: Binding; paths: string[] }> {
    return (
      this.db.query('SELECT binding,paths FROM env_quarantines').all() as Array<{
        binding: string;
        paths: string;
      }>
    ).map((row) => {
      const paths = parseJson(row.paths, CONTROL_BYTES);
      if (
        !Array.isArray(paths) ||
        !paths.every((root): root is string => typeof root === 'string' && isAbsolute(root))
      )
        throw new Error('Invalid persisted quarantine lease roots');
      return { binding: bindingSchema.parse(parseJson(row.binding, CONTROL_BYTES)), paths };
    });
  }
  private assertNotQuarantined(binding: Binding): void {
    if (
      this.quarantines().some(
        (entry) =>
          entry.binding.nodeId === binding.nodeId &&
          (entry.binding.sessionId === binding.sessionId ||
            entry.binding.workspaceId === binding.workspaceId),
      )
    )
      throw new EnvironmentCodeError(
        'unavailable_sandbox',
        'Environment binding quarantined; aggregate cleanup unverified',
      );
  }
  /**
   * Permanent fence: records remain queryable, but no old starts are admitted. In the
   * same transaction every still-queued (`accepted`, never claimed) record of the
   * generation becomes `cancelled/not_started`, so revocation never leaves startable
   * work behind. Running work is untouched; its executor still reports a terminal.
   */
  retire(binding: Binding): ExecutionRecord[] {
    return this.db
      .transaction(() => {
        const grant = this.grant(binding);
        this.db.query('UPDATE env_bindings SET retired=1 WHERE binding=?').run(grant.binding);
        const queued = this.db
          .query(
            "SELECT * FROM env_executions WHERE binding=? AND json_extract(record,'$.state')='accepted'",
          )
          .all(grant.binding) as Row[];
        return queued.map((row) => this.finishRecord(this.record(row), retiredBeforeStart()));
      })
      .immediate();
  }
  private row(binding: Binding, id: string): Row {
    const grant = this.grant(binding);
    const row = this.db
      .query('SELECT * FROM env_executions WHERE id=? AND binding=?')
      .get(id, grant.binding) as Row | null;
    if (!row) throw new EnvironmentCodeError('unknown', 'Unknown execution');
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
  /**
   * Wire status lookup (R1). An ID this binding never accepted is durably tombstoned
   * (FULL commit) while the generation is active, so a late start can never create it;
   * a retired generation already refuses every start. Either way the caller gets
   * `unknown_execution`. Lookups are strictly per binding: other bindings' IDs and
   * tombstones are invisible. Reclaimed records report `expired`, never "not accepted".
   */
  query(binding: Binding, id: string): ExecutionRecord {
    // Read first without a write lock: a record, a tombstone or a retired generation is
    // already a stable answer (all are monotonic). Only a missing ID of an active
    // generation needs the IMMEDIATE transaction that writes its tombstone.
    const read = this.lookup(binding, id);
    const record =
      read.record ??
      (read.tombstoned || read.retired
        ? undefined
        : this.db.transaction(() => this.lookupOrTombstone(binding, id)).immediate());
    // Retired/tombstoned: see the backup-restore precondition on neverAccepted().
    if (!record) throw neverAccepted();
    return record;
  }
  private lookup(
    binding: Binding,
    id: string,
  ): { grant: Grant; record?: ExecutionRecord; tombstoned: boolean; retired: boolean } {
    const grant = this.grant(binding);
    if (typeof id !== 'string' || !UUID.test(id))
      throw new EnvironmentCodeError('unknown', 'Unknown execution');
    const row = this.db
      .query('SELECT * FROM env_executions WHERE id=? AND binding=?')
      .get(id, grant.binding) as Row | null;
    if (row) return { grant, record: this.record(row), tombstoned: false, retired: false };
    const tombstone = this.db
      .query('SELECT kind FROM env_tombstones WHERE binding=? AND id=?')
      .get(grant.binding, id) as { kind: string } | null;
    if (tombstone?.kind === 'reclaimed')
      throw new EnvironmentCodeError('expired', 'Execution record was reclaimed');
    return { grant, tombstoned: Boolean(tombstone), retired: Boolean(grant.retired) };
  }
  private lookupOrTombstone(binding: Binding, id: string): ExecutionRecord | undefined {
    const { grant, record, tombstoned } = this.lookup(binding, id);
    if (record) return record;
    if (!tombstoned && !grant.retired) {
      this.assertAdmissionCapacity(1024);
      this.db
        .query("INSERT INTO env_tombstones(binding,id,kind,at) VALUES (?,?,'never_accepted',?)")
        .run(grant.binding, id, this.now());
    }
    return undefined;
  }

  /** Transaction commits acceptance/rejection before callers may start any hook/effect. */
  accept(value: ExecutionIntent): { fresh: boolean; record: ExecutionRecord } {
    const intent = validateIntent(value);
    return this.db
      .transaction(() => {
        const grant = this.grant(intent.binding);
        if (grant.retired) throw retiredGeneration();
        this.assertNotQuarantined(intent.binding);
        if (
          this.db
            .query('SELECT id FROM env_tombstones WHERE binding=? AND id=?')
            .get(grant.binding, intent.executionId)
        )
          throw new EnvironmentCodeError(
            'conflict',
            'Execution ID was tombstoned; it cannot start',
          );
        const previous = this.db
          .query('SELECT * FROM env_executions WHERE id=?')
          .get(intent.executionId) as Row | null;
        if (previous) {
          if (
            previous.binding !== grant.binding ||
            (previous.intent.startsWith('sha256:')
              ? previous.intent !== `sha256:${digest(intent, REQUEST_BYTES)}`
              : previous.intent !== canonicalJson(intent, REQUEST_BYTES))
          )
            throw new EnvironmentCodeError('conflict', 'Execution ID conflict');
          return { fresh: false, record: this.record(previous) };
        }
        this.assertAdmissionCapacity(Buffer.byteLength(canonicalJson(intent, REQUEST_BYTES)));
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

  /**
   * Exactly one successful claim in this executor lifetime. Duplicates cannot run.
   * A retired generation never claims: still-queued work becomes `cancelled/not_started`
   * (normally already done by retire()) and that non-running record is returned; any
   * other record gets a typed `stale_epoch` refusal. Either way a revoked session's
   * queue is a per-item outcome, never a node-wide fault.
   */
  claim(binding: Binding, id: string): ExecutionRecord {
    return this.db
      .transaction(() => {
        const grant = this.grant(binding);
        const row = this.row(binding, id);
        const record = this.record(row);
        if (grant.retired) {
          if (record.state === 'accepted') return this.finishRecord(record, retiredBeforeStart());
          throw retiredGeneration();
        }
        if (record.state !== 'accepted' || record.cancelRequested)
          throw new EnvironmentCodeError('conflict', 'Execution is not startable');
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

  /** Unknown IDs are tombstoned exactly like query(); cancelling them reports `unknown_execution`. */
  cancel(binding: Binding, id: string): ExecutionRecord {
    const result = this.db
      .transaction(() => {
        const record = this.lookupOrTombstone(binding, id);
        if (!record) return undefined;
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
    if (!result) throw neverAccepted();
    return result;
  }

  appendEvent(
    binding: Binding,
    id: string,
    kind: ExecutionEvent['kind'],
    payload: ExecutionEvent['payload'],
  ): ExecutionEvent {
    // Progress/operation events guard no effect; terminal finish (FULL) fsyncs them too.
    return relaxedTransaction(this.db, () => {
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
    });
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
        throw new EnvironmentCodeError('invalid_binding', 'Artifact ownership mismatch');
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
    return this.db.transaction(() => this.recoverRows(binding)).immediate();
  }
  /**
   * Supervisor-only, after the old executor is stopped: classify unfinished work and
   * permanently fence the generation in ONE transaction, so no crash can leave a
   * recovered-but-startable or retired-but-unrecovered generation.
   */
  recoverAndRetire(binding: Binding): ExecutionRecord[] {
    return this.db
      .transaction(() => {
        const recovered = this.recoverRows(binding);
        this.retire(binding);
        return recovered;
      })
      .immediate();
  }
  /**
   * Trusted node startup only, before any executor, lease or admission exists: no
   * executor from the previous process can still report, so every generation left
   * active (or with unfinished records) by an abrupt stop is recovered and retired.
   * Never replays; the gateway reconciles through status on adopted generations.
   */
  sweepStartup(): Array<{ binding: Binding; recovered: ExecutionRecord[] }> {
    return (
      this.db
        .query(
          `SELECT binding FROM env_bindings b WHERE retired=0 OR EXISTS (
            SELECT 1 FROM env_executions e WHERE e.binding=b.binding
            AND json_extract(e.record,'$.state') IN ('accepted','running'))`,
        )
        .all() as { binding: string }[]
    ).map((row) => {
      const binding = bindingSchema.parse(parseJson(row.binding, CONTROL_BYTES));
      return { binding, recovered: this.recoverAndRetire(binding) };
    });
  }
  private recoverRows(binding: Binding): ExecutionRecord[] {
    const grant = this.grant(binding);
    const rows = this.db
      .query('SELECT * FROM env_executions WHERE binding=?')
      .all(grant.binding) as Row[];
    const recovered: ExecutionRecord[] = [];
    for (const row of rows) {
      const record = this.record(row);
      if (
        !row.intent.startsWith('sha256:') &&
        validateIntentText(row.intent).capability === 'ptc'
      ) {
        // Registration may not have happened before the crash. Missing parent is
        // safe; any registered inner operations must be sealed before recovery.
        const parent = this.db.query('SELECT id FROM ptc_parents WHERE id=?').get(row.id);
        if (parent) this.inner.seal(binding, row.id);
      }
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
  }

  ack(binding: Binding, id: string, resultDigest: string): ExecutionRecord {
    return this.db
      .transaction(() => {
        const record = this.status(binding, id);
        if (!record.resultDigest || record.resultDigest !== resultDigest)
          throw new EnvironmentCodeError('conflict', 'Result digest mismatch');
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
        this.db
          .query('UPDATE env_executions SET intent=? WHERE id=?')
          .run(`sha256:${digest(parseJson(row.intent, REQUEST_BYTES), REQUEST_BYTES)}`, id);
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
        if (grant.retired) throw retiredGeneration();
        const encoded = canonicalJson(intent, REQUEST_BYTES);
        const previous = this.db
          .query('SELECT intent FROM env_outbox WHERE id=?')
          .get(intent.executionId) as { intent: string } | null;
        if (previous) {
          if (previous.intent !== encoded) throw new Error('Execution ID conflict');
          return;
        }
        this.assertAdmissionCapacity(Buffer.byteLength(encoded));
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
        const intent = validateIntentText(row.intent);
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
