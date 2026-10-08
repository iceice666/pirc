import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { canonicalJson, digest, parseJson, type Json } from './json.js';
import { CONTROL_BYTES, REQUEST_BYTES, type Binding, type ExecutionIntent } from './protocol.js';

/** Node hook receipt authority, private and supervisor-owned. No shell runs here. */
export class HookReceipts {
  private db: Database;
  constructor(file: string) {
    this.db = new Database(file, { create: true });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS hook_receipts(id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE,
        binding TEXT NOT NULL, arguments TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL, post_state TEXT NOT NULL DEFAULT 'pending');`);
  }
  /** Called only AFTER the separately journaled node pre-hook has completed. */
  issue(
    intent: ExecutionIntent,
    finalArguments: Json,
  ): { id: string; digest: string; arguments: Json } {
    const identity = canonicalJson(
      {
        binding: intent.binding,
        executionId: intent.executionId,
        capability: intent.capability,
        descriptorRevision: intent.descriptorRevision,
        policyRevision: intent.policyRevision,
      },
      CONTROL_BYTES,
    );
    const args = canonicalJson(finalArguments, REQUEST_BYTES);
    const hash = digest({ identity, arguments: finalArguments }, REQUEST_BYTES);
    return this.db
      .transaction(() => {
        const previous = this.db
          .query('SELECT id,digest,state FROM hook_receipts WHERE identity=?')
          .get(identity) as { id: string; digest: string; state: string } | null;
        if (previous) {
          if (previous.digest !== hash || previous.state === 'invalid')
            throw new Error('Hook receipt conflict or revoked');
          return { id: previous.id, digest: hash, arguments: parseJson(args, REQUEST_BYTES) };
        }
        const id = randomUUID();
        this.db
          .query(
            "INSERT INTO hook_receipts(id,identity,binding,arguments,digest,state) VALUES (?,?,?,?,?,'ready')",
          )
          .run(id, identity, canonicalJson(intent.binding, CONTROL_BYTES), args, hash);
        return { id, digest: hash, arguments: parseJson(args, REQUEST_BYTES) };
      })
      .immediate();
  }
  /** Atomically consume before central policy/effect. Never blindly replay a consumed effect. */
  consume(intent: ExecutionIntent, id: string, hash: string): Json {
    const identity = canonicalJson(
      {
        binding: intent.binding,
        executionId: intent.executionId,
        capability: intent.capability,
        descriptorRevision: intent.descriptorRevision,
        policyRevision: intent.policyRevision,
      },
      CONTROL_BYTES,
    );
    return this.db
      .transaction(() => {
        const row = this.db
          .query(
            "SELECT arguments FROM hook_receipts WHERE id=? AND identity=? AND digest=? AND state='ready'",
          )
          .get(id, identity, hash) as { arguments: string } | null;
        if (!row) throw new Error('Hook receipt unavailable');
        this.db.query("UPDATE hook_receipts SET state='consumed' WHERE id=?").run(id);
        return parseJson(row.arguments, REQUEST_BYTES);
      })
      .immediate();
  }
  /** Journal a post-hook start before sending it to the executor. */
  claimPost(binding: Binding, id: string): boolean {
    const result = this.db
      .query(
        "UPDATE hook_receipts SET post_state='running' WHERE id=? AND binding=? AND state='consumed' AND post_state='pending'",
      )
      .run(id, canonicalJson(binding, CONTROL_BYTES));
    return result.changes === 1;
  }
  finishPost(binding: Binding, id: string, success: boolean): void {
    const result = this.db
      .query(
        "UPDATE hook_receipts SET post_state=? WHERE id=? AND binding=? AND post_state='running'",
      )
      .run(success ? 'completed' : 'failed', id, canonicalJson(binding, CONTROL_BYTES));
    if (result.changes !== 1) throw new Error('Post-hook was not running');
  }
  invalidate(binding: Binding): void {
    this.db
      .query("UPDATE hook_receipts SET state='invalid' WHERE binding=? AND state='ready'")
      .run(canonicalJson(binding, CONTROL_BYTES));
  }
  close(): void {
    this.db.close();
  }
}
