import { randomUUID } from 'node:crypto';
import type { SandboxedEnvironmentExecutor } from '../node/environment-executor.js';
import type { NodeHookRoute } from './gateway-operation.js';
import type { ExecutionJournal } from './journal.js';
import type { HookReceipts } from './hook-receipts.js';
import { intentDigest, type ExecutionIntent, type Terminal } from './protocol.js';
import { canonicalJson, parseJson, digest, type Json } from './json.js';
import { REQUEST_BYTES } from './protocol.js';

/** Trusted phase IDs persist in a private coordinator DB, independent of delivery/reconnect. */
import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
export class JournaledNodeHooks implements NodeHookRoute {
  private db: Database;
  constructor(
    file: string,
    private options: {
      journal: ExecutionJournal;
      receipts: HookReceipts;
      executor(): SandboxedEnvironmentExecutor;
      authorize(intent: ExecutionIntent): void;
    },
  ) {
    this.db = new Database(file, { create: true });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS hook_phases(parent TEXT NOT NULL, phase TEXT NOT NULL, intent TEXT NOT NULL, parent_digest TEXT NOT NULL, PRIMARY KEY(parent,phase));`);
  }
  private async phase(
    intent: ExecutionIntent,
    phase: 'preflight' | 'post',
    signal: AbortSignal,
    result?: Terminal,
    finalArguments?: Json,
  ): Promise<Terminal> {
    this.options.authorize(intent);
    const parentDigest = digest(intent, REQUEST_BYTES);
    let row = this.db
      .query('SELECT intent,parent_digest FROM hook_phases WHERE parent=? AND phase=?')
      .get(intent.executionId, phase) as { intent: string; parent_digest: string } | null;
    let execution: ExecutionIntent;
    if (row) {
      if (row.parent_digest !== parentDigest) throw new Error('Hook parent identity conflict');
      execution = parseJson(row.intent, REQUEST_BYTES) as unknown as ExecutionIntent;
    } else {
      const value = {
        ...intent,
        arguments: finalArguments ?? intent.arguments,
        executionId: randomUUID(),
        parentExecutionId: intent.executionId,
        innerOperationId: randomUUID(),
      };
      execution = { ...value, argumentDigest: intentDigest(value) };
      this.db
        .query('INSERT INTO hook_phases VALUES (?,?,?,?)')
        .run(intent.executionId, phase, canonicalJson(execution, REQUEST_BYTES), parentDigest);
    }
    const accepted = this.options.journal.accept(execution);
    if (!accepted.fresh) {
      const record = accepted.record;
      if (!record.terminal) throw new Error('Hook phase outcome unresolved; never replay');
      return record.terminal;
    }
    const claimed = this.options.journal.claim(execution.binding, execution.executionId);
    if (claimed.state !== 'running') throw new Error('Hook phase expired');
    let terminal: Terminal;
    try {
      terminal = await this.options.executor().executeHook(execution, phase, signal, result);
    } catch (error) {
      terminal = {
        state: 'unknown',
        effect: 'unknown',
        artifacts: [],
        truncated: false,
        error: { code: 'unknown', message: String(error).slice(0, 8192) },
      };
    }
    this.options.journal.finish(execution.binding, execution.executionId, terminal);
    return terminal;
  }
  async preflight(intent: ExecutionIntent, signal: AbortSignal) {
    const terminal = await this.phase(intent, 'preflight', signal);
    if (
      terminal.state !== 'completed' ||
      !terminal.output ||
      typeof terminal.output !== 'object' ||
      Array.isArray(terminal.output)
    )
      throw new Error('Node preflight failed or unknown');
    const args = (terminal.output as Record<string, Json>).arguments!;
    const receipt = this.options.receipts.issue(intent, args);
    return { arguments: receipt.arguments, receiptId: receipt.id, receiptDigest: receipt.digest };
  }
  async consume(intent: ExecutionIntent, receiptId: string, receiptDigest: string): Promise<Json> {
    this.options.authorize(intent);
    return this.options.receipts.consume(intent, receiptId, receiptDigest);
  }
  async post(
    intent: ExecutionIntent,
    receiptId: string,
    result: Terminal,
    signal: AbortSignal,
  ): Promise<void> {
    this.options.authorize(intent);
    if (!this.options.receipts.claimPost(intent.binding, receiptId))
      throw new Error('Post hook already claimed; reconcile phase status');
    const preflight = await this.phase(intent, 'preflight', signal);
    if (
      preflight.state !== 'completed' ||
      !preflight.output ||
      typeof preflight.output !== 'object' ||
      Array.isArray(preflight.output)
    )
      throw new Error('Preflight evidence unavailable');
    const args = (preflight.output as Record<string, Json>).arguments!;
    const terminal = await this.phase(intent, 'post', signal, result, args);
    this.options.receipts.finishPost(intent.binding, receiptId, terminal.state === 'completed');
    if (terminal.state !== 'completed') throw new Error('Post hook failed or unknown');
  }
  close(): void {
    this.db.close();
  }
}
