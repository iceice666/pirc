import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import { canonicalJson, parseJson } from '../environment/json.js';
import { bindingSchema, CONTROL_BYTES, type Binding } from '../environment/protocol.js';
import { EnvironmentCodeError, type ExecutionJournal } from '../environment/journal.js';
import { transferSchema, type WriterFenceReceipt, type WriterTransfer } from './contracts.js';

/** Journal operations the fence needs to retire revoked/superseded generations. */
type FenceJournal = Pick<ExecutionJournal, 'bindings' | 'isRetired' | 'retire'>;
const sameSession = (a: Binding, b: Binding) =>
  a.nodeId === b.nodeId && a.sessionId === b.sessionId;

/**
 * Harness-only trusted node lifecycle. Not an RPC handler or a cleanup mechanism.
 * The supervisor must stop/fence old runners, approvals and jobs independently.
 * Every legacy launch path must consult this fence before production activation.
 *
 * Generation rules (durable, never cleared by retries):
 * - Only the NEWEST fenced transfer of a node session may be provisioned. Order is the
 *   durable transfer creation order; completing a fence supersedes every earlier
 *   generation of that session (recorded, and retired in the journal when known).
 * - Revocation is per writer: it refuses every executor epoch of (nodeId, sessionId,
 *   writerEpoch), including refreshed executor generations created later.
 */
export class NodeWriterFence {
  private readonly db: Database;
  private readonly fencing = new Map<string, Promise<WriterFenceReceipt>>();
  private readonly listeners = new Set<(bindings: Binding[]) => void>();
  constructor(
    file: string,
    private readonly nodeId: string,
    /**
     * The node's environment journal. When supplied, revoke() and supersession also
     * retire the generations there, so a fenced-off writer can never admit execution.
     */
    private readonly journal?: FenceJournal,
  ) {
    this.db = new Database(file, { create: true });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS writer_transfers (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, fenced INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS denied_legacy_writers (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS revoked_gateway_writers (binding TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS superseded_gateway_writers (binding TEXT PRIMARY KEY);`);
  }
  close(): void {
    this.db.close();
  }
  /**
   * Trusted in-process subscribers (LocalEnvironment) learn which generations were just
   * revoked or superseded, after the durable fence and journal retirement committed.
   */
  subscribe(listener: (bindings: Binding[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  assertLegacyAllowed(sessionId: string): void {
    if (this.db.query('SELECT id FROM denied_legacy_writers WHERE id=?').get(sessionId))
      throw new Error('Legacy writer permanently fenced');
  }
  async fence(
    value: WriterTransfer,
    stopAndVerify: () => Promise<void>,
  ): Promise<WriterFenceReceipt> {
    canonicalJson(value, CONTROL_BYTES);
    const transfer = transferSchema.parse(value);
    const pending = this.fencing.get(transfer.transferId);
    if (pending) {
      const receipt = await pending;
      const { fenced: _, ...original } = receipt;
      if (canonicalJson(transfer, CONTROL_BYTES) !== canonicalJson(original, CONTROL_BYTES))
        throw new Error('Writer transfer conflict');
      return receipt;
    }
    const work = this.fenceOnce(transfer, stopAndVerify);
    this.fencing.set(transfer.transferId, work);
    try {
      return await work;
    } finally {
      this.fencing.delete(transfer.transferId);
    }
  }
  private async fenceOnce(
    value: WriterTransfer,
    stopAndVerify: () => Promise<void>,
  ): Promise<WriterFenceReceipt> {
    canonicalJson(value, CONTROL_BYTES);
    const transfer = transferSchema.parse(value);
    if (transfer.binding.nodeId !== this.nodeId)
      throw new EnvironmentCodeError('invalid_binding', 'Invalid transport node');
    const payload = canonicalJson(transfer, CONTROL_BYTES);
    const done = this.db
      .transaction(() => {
        const old = this.db
          .query('SELECT payload,fenced FROM writer_transfers WHERE id=?')
          .get(transfer.transferId) as { payload: string; fenced: number } | null;
        if (old && old.payload !== payload) throw new Error('Writer transfer conflict');
        // Legacy denial is recorded even for a refused generation: it only narrows.
        for (const id of transfer.legacySessionIds)
          this.db.query('INSERT OR IGNORE INTO denied_legacy_writers(id) VALUES (?)').run(id);
        if (!old)
          this.db
            .query('INSERT INTO writer_transfers(id,payload) VALUES (?,?)')
            .run(transfer.transferId, payload);
        return !!old?.fenced;
      })
      .immediate();
    // A revoked or superseded generation can never be fenced (again) into service.
    this.assertNotRetired(transfer.binding);
    if (!done) {
      // A throw (including M2 quarantine) leaves a durable deny fence, not a grant.
      // Retry after a crash verifies cleanup; it must not replay hooks or tools.
      await stopAndVerify();
      const superseded = this.db
        .transaction(() => {
          // Re-checked atomically: a newer generation may have completed meanwhile.
          this.assertNotRetired(transfer.binding);
          this.db.query('UPDATE writer_transfers SET fenced=1 WHERE id=?').run(transfer.transferId);
          return this.supersedeEarlier(transfer.transferId, transfer.binding);
        })
        .immediate();
      this.retireGenerations(
        (binding) =>
          sameSession(binding, transfer.binding) &&
          canonicalJson(binding, CONTROL_BYTES) !== canonicalJson(transfer.binding, CONTROL_BYTES),
        superseded,
      );
    } else {
      // Retry of a completed fence: the earlier retirement may have failed after the fence
      // committed (I/O error, not only a crash). Retiring is idempotent, so redo it before
      // reporting success; otherwise a superseded generation could keep accepting work.
      this.retireGenerations(
        (binding) =>
          sameSession(binding, transfer.binding) &&
          canonicalJson(binding, CONTROL_BYTES) !== canonicalJson(transfer.binding, CONTROL_BYTES),
        [],
      );
    }
    return { ...transfer, fenced: true };
  }
  /** Inside the fence transaction: record every earlier transfer of the session as superseded. */
  private supersedeEarlier(transferId: string, binding: Binding): Binding[] {
    const own = canonicalJson(binding, CONTROL_BYTES);
    const rows = this.db
      .query(
        `SELECT payload FROM writer_transfers
          WHERE rowid < (SELECT rowid FROM writer_transfers WHERE id=?)
          AND json_extract(payload,'$.binding.nodeId')=? AND json_extract(payload,'$.binding.sessionId')=?`,
      )
      .all(transferId, binding.nodeId, binding.sessionId) as { payload: string }[];
    const superseded: Binding[] = [];
    for (const row of rows) {
      const earlier = transferSchema.parse(parseJson(row.payload, CONTROL_BYTES)).binding;
      const key = canonicalJson(earlier, CONTROL_BYTES);
      if (key === own) continue;
      this.db
        .query('INSERT OR IGNORE INTO superseded_gateway_writers(binding) VALUES (?)')
        .run(key);
      superseded.push(earlier);
    }
    return superseded;
  }
  /**
   * Retire matching journal generations (cancelling their queued work) and notify
   * in-process subscribers. Runs after the durable fence commit; a crash in between is
   * closed by the startup sweep, which retires every generation left active.
   */
  private retireGenerations(match: (binding: Binding) => boolean, extra: Binding[]): void {
    const affected = new Map<string, Binding>();
    for (const binding of extra) affected.set(canonicalJson(binding, CONTROL_BYTES), binding);
    for (const binding of this.journal?.bindings() ?? []) {
      if (!match(binding)) continue;
      affected.set(canonicalJson(binding, CONTROL_BYTES), binding);
      if (!this.journal!.isRetired(binding)) this.journal!.retire(binding);
    }
    if (!affected.size) return;
    let failure: unknown;
    for (const listener of this.listeners) {
      try {
        listener([...affected.values()]);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  private revoked(binding: Binding): boolean {
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM revoked_gateway_writers WHERE json_extract(binding,'$.nodeId')=?
            AND json_extract(binding,'$.sessionId')=? AND json_extract(binding,'$.writerEpoch')=?`,
        )
        .get(binding.nodeId, binding.sessionId, binding.writerEpoch),
    );
  }
  private assertNotRetired(binding: Binding): void {
    if (this.revoked(binding))
      throw new EnvironmentCodeError('stale_epoch', 'Writer generation permanently revoked');
    if (
      this.db
        .query('SELECT 1 FROM superseded_gateway_writers WHERE binding=?')
        .get(canonicalJson(binding, CONTROL_BYTES))
    )
      throw new EnvironmentCodeError(
        'stale_epoch',
        'Writer generation superseded by a newer fenced generation',
      );
  }
  /**
   * Trusted supervisor revocation, durable and never cleared by fence retries. It
   * covers the writer (nodeId, sessionId, writerEpoch) across every executor epoch.
   * The fence commits first, then the journal generations are retired (queued work
   * cancelled) and subscribers notified; a crash in between is closed by the startup
   * sweep. Running work is not interrupted here: fenceEnvironment stops the executor.
   */
  revoke(binding: Binding): void {
    binding = bindingSchema.parse(binding);
    if (binding.nodeId !== this.nodeId)
      throw new EnvironmentCodeError('invalid_binding', 'Invalid transport node');
    this.db
      .query('INSERT OR IGNORE INTO revoked_gateway_writers(binding) VALUES (?)')
      .run(canonicalJson(binding, CONTROL_BYTES));
    this.retireGenerations(
      (other) => sameSession(other, binding) && other.writerEpoch === binding.writerEpoch,
      [binding],
    );
  }
  /**
   * Only the newest verified generation of a session may be provisioned, never a
   * claimed, revoked or superseded one.
   */
  assertProvisioned(binding: Binding): void {
    binding = bindingSchema.parse(binding);
    if (binding.nodeId !== this.nodeId)
      throw new EnvironmentCodeError('invalid_binding', 'Invalid transport node');
    this.assertNotRetired(binding);
    const newest = this.db
      .query(
        `SELECT payload FROM writer_transfers WHERE fenced=1
          AND json_extract(payload,'$.binding.nodeId')=? AND json_extract(payload,'$.binding.sessionId')=?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(binding.nodeId, binding.sessionId) as { payload: string } | null;
    const own = canonicalJson(binding, CONTROL_BYTES);
    if (
      newest &&
      canonicalJson(
        transferSchema.parse(parseJson(newest.payload, CONTROL_BYTES)).binding,
        CONTROL_BYTES,
      ) === own
    )
      return;
    const fenced = (
      this.db.query('SELECT payload FROM writer_transfers WHERE fenced=1').all() as {
        payload: string;
      }[]
    ).some(
      (row) =>
        canonicalJson(
          transferSchema.parse(parseJson(row.payload, CONTROL_BYTES)).binding,
          CONTROL_BYTES,
        ) === own,
    );
    if (fenced)
      throw new EnvironmentCodeError(
        'stale_epoch',
        'Writer generation superseded by a newer fenced generation',
      );
    throw new EnvironmentCodeError('invalid_binding', 'Unfenced writer generation');
  }
}
