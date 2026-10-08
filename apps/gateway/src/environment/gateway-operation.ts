import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import { canonicalJson, parseJson, digest, type Json } from './json.js';
import { REQUEST_BYTES, RESULT_BYTES, type ExecutionIntent, type Terminal } from './protocol.js';
import { validateSchema } from '../agent/ptc/schema.js';

export interface NodeHookRoute {
  /** Implementations persist distinct phase IDs before dispatch; status retrieves, never replays. */
  preflight(
    intent: ExecutionIntent,
    signal: AbortSignal,
  ): Promise<{ arguments: Json; receiptId: string; receiptDigest: string }>;
  consume(intent: ExecutionIntent, receiptId: string, receiptDigest: string): Promise<Json>;
  post(
    intent: ExecutionIntent,
    receiptId: string,
    result: Terminal,
    signal: AbortSignal,
  ): Promise<void>;
}
/** Central durable intent/result boundary. Callback DB mutations use this exact SQLite transaction. */
export class GatewayOperations {
  readonly db: Database;
  constructor(file: string) {
    this.db = new Database(file, { create: true });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS central_operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT, receipt TEXT, post_state TEXT NOT NULL DEFAULT 'pending');
      UPDATE central_operations SET state='unknown' WHERE state='running';
      UPDATE central_operations SET post_state='unknown' WHERE post_state='running';`);
  }
  async execute(
    intent: ExecutionIntent,
    options: {
      hooks?: NodeHookRoute;
      schema: Record<string, unknown>;
      authorize(intent: ExecutionIntent, args: Json): void;
      /** Synchronous DB-covered effects only. External effects use a separately recoverable service. */
      mutate(db: Database, args: Json): Terminal;
      signal: AbortSignal;
    },
  ): Promise<{ terminal: Terminal; post: string }> {
    const hash = digest(intent, REQUEST_BYTES);
    let row = this.db
      .query('SELECT * FROM central_operations WHERE id=?')
      .get(intent.executionId) as {
      digest: string;
      state: string;
      result: string | null;
      receipt: string | null;
      post_state: string;
    } | null;
    if (row) {
      if (row.digest !== hash) throw new Error('Central execution ID conflict');
      if (row.result)
        return {
          terminal: parseJson(row.result, RESULT_BYTES) as unknown as Terminal,
          post: row.post_state,
        };
      // A consumed receipt or lost hook reply is not proof that its shell/effect did not run.
      return {
        terminal: {
          state: 'unknown',
          effect: 'unknown',
          artifacts: [],
          truncated: false,
          error: {
            code: 'unknown',
            message: 'Reconcile original hook/operation IDs; do not replay',
          },
        },
        post: row.post_state,
      };
    }
    this.db
      .query("INSERT INTO central_operations(id,digest,state) VALUES (?,?,'running')")
      .run(intent.executionId, hash);
    let args = intent.arguments;
    let receipt: { arguments: Json; receiptId: string; receiptDigest: string } | undefined;
    if (options.hooks) {
      receipt = await options.hooks.preflight(intent, options.signal);
      this.db
        .query('UPDATE central_operations SET receipt=? WHERE id=?')
        .run(canonicalJson(receipt, REQUEST_BYTES), intent.executionId);
      args = await options.hooks.consume(intent, receipt.receiptId, receipt.receiptDigest);
    }
    const errors = validateSchema(args, options.schema);
    if (errors.length)
      throw new Error(`Invalid central hook-final arguments: ${errors.join('; ')}`);
    options.signal.throwIfAborted();
    options.authorize(intent, args);
    const terminal = this.db
      .transaction(() => {
        const result = options.mutate(this.db, args);
        const encoded = canonicalJson(result, RESULT_BYTES);
        this.db
          .query("UPDATE central_operations SET state='completed',result=? WHERE id=?")
          .run(encoded, intent.executionId);
        return result;
      })
      .immediate();
    let post = 'none';
    if (!options.hooks)
      this.db
        .query("UPDATE central_operations SET post_state='none' WHERE id=?")
        .run(intent.executionId);
    if (options.hooks && receipt) {
      this.db
        .query("UPDATE central_operations SET post_state='running' WHERE id=?")
        .run(intent.executionId);
      try {
        await options.hooks.post(intent, receipt.receiptId, terminal, options.signal);
        post = 'completed';
      } catch {
        post = 'unknown';
      }
      this.db
        .query('UPDATE central_operations SET post_state=? WHERE id=?')
        .run(post, intent.executionId);
    }
    return { terminal, post };
  }
  close(): void {
    this.db.close();
  }
}
