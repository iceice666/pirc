import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import { canonicalJson, parseJson } from '../environment/json.js';
import { bindingSchema, CONTROL_BYTES, type Binding } from '../environment/protocol.js';
import { transferSchema, type WriterFenceReceipt, type WriterTransfer } from './contracts.js';

/**
 * Harness-only trusted node lifecycle. Not an RPC handler or a cleanup mechanism.
 * The supervisor must stop/fence old runners, approvals and jobs independently.
 * Every legacy launch path must consult this fence before production activation.
 */
export class NodeWriterFence {
  private readonly db: Database;
  private readonly fencing = new Map<string, Promise<WriterFenceReceipt>>();
  constructor(
    file: string,
    private readonly nodeId: string,
  ) {
    this.db = new Database(file, { create: true });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS writer_transfers (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, fenced INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS denied_legacy_writers (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS revoked_gateway_writers (binding TEXT PRIMARY KEY);`);
  }
  close(): void {
    this.db.close();
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
    if (transfer.binding.nodeId !== this.nodeId) throw new Error('Invalid transport node');
    const payload = canonicalJson(transfer, CONTROL_BYTES);
    const done = this.db
      .transaction(() => {
        const old = this.db
          .query('SELECT payload,fenced FROM writer_transfers WHERE id=?')
          .get(transfer.transferId) as { payload: string; fenced: number } | null;
        if (old && old.payload !== payload) throw new Error('Writer transfer conflict');
        if (!old)
          this.db
            .query('INSERT INTO writer_transfers(id,payload) VALUES (?,?)')
            .run(transfer.transferId, payload);
        for (const id of transfer.legacySessionIds)
          this.db.query('INSERT OR IGNORE INTO denied_legacy_writers(id) VALUES (?)').run(id);
        return !!old?.fenced;
      })
      .immediate();
    if (!done) {
      // A throw (including M2 quarantine) leaves a durable deny fence, not a grant.
      // Retry after a crash verifies cleanup; it must not replay hooks or tools.
      await stopAndVerify();
      this.db.query('UPDATE writer_transfers SET fenced=1 WHERE id=?').run(transfer.transferId);
    }
    return { ...transfer, fenced: true };
  }
  /** Trusted supervisor revocation, durable and never cleared by fence retries. */
  revoke(binding: Binding): void {
    binding = bindingSchema.parse(binding);
    if (binding.nodeId !== this.nodeId) throw new Error('Invalid transport node');
    this.db
      .query('INSERT OR IGNORE INTO revoked_gateway_writers(binding) VALUES (?)')
      .run(canonicalJson(binding, CONTROL_BYTES));
  }
  /** Only a previously verified generation may be provisioned, never a claimed binding. */
  assertProvisioned(binding: Binding): void {
    binding = bindingSchema.parse(binding);
    if (
      this.db
        .query('SELECT binding FROM revoked_gateway_writers WHERE binding=?')
        .get(canonicalJson(binding, CONTROL_BYTES))
    )
      throw new Error('Writer generation permanently revoked');
    const rows = this.db.query('SELECT payload FROM writer_transfers WHERE fenced=1').all() as {
      payload: string;
    }[];
    if (
      !rows.some(
        (row) =>
          canonicalJson(
            transferSchema.parse(parseJson(row.payload, CONTROL_BYTES)).binding,
            CONTROL_BYTES,
          ) === canonicalJson(binding, CONTROL_BYTES),
      )
    )
      throw new Error('Unfenced writer generation');
  }
}
