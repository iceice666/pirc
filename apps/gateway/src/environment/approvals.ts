import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { z } from 'zod';
import { canonicalJson, parseJson } from './json.js';
import { bindingSchema, CONTROL_BYTES, type Binding, type ExecutionIntent } from './protocol.js';

export const approvalSchema = z
  .object({
    interactionId: z.string().regex(/^node-environment-[a-f0-9-]{36}$/),
    binding: bindingSchema,
    executionId: z.string().uuid(),
    innerId: z.string().uuid().optional(),
    finalArgumentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    descriptorRevision: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(['danger', 'network', 'host_exec']),
    expiresAtLocal: z.number().finite(),
    title: z.string().max(1024),
    message: z.string().max(24_000),
  })
  .strict();
export type EnvironmentApproval = z.infer<typeof approvalSchema>;

/** Node supervisor authority. Responses arrive only through a separately authenticated human route. */
export class ApprovalAuthority {
  private db: Database;
  private live = new Map<
    string,
    {
      binding: string;
      deadline: number;
      resolve(approved: boolean): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private connected = true;
  private settled = new Set<(id: string) => void>();
  onSettled(callback: (id: string) => void): () => void {
    this.settled.add(callback);
    return () => {
      this.settled.delete(callback);
    };
  }
  constructor(
    file: string,
    private readonly notify: (approval: EnvironmentApproval) => void,
  ) {
    this.db = new Database(file, { create: true });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS environment_approvals(id TEXT PRIMARY KEY, binding TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);
      UPDATE environment_approvals SET state='expired' WHERE state='pending';`);
  }
  request(
    intent: ExecutionIntent,
    input: {
      finalArgumentDigest: string;
      action: EnvironmentApproval['action'];
      title: string;
      message: string;
    },
    signal: AbortSignal,
    remainingAbsoluteMs = intent.budgetMs,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (!this.connected) return Promise.resolve(false);
    if (this.live.size >= 128) throw new Error('Approval quota exceeded');
    const lifetime = Math.min(remainingAbsoluteMs, 300_000);
    if (lifetime <= 0) return Promise.resolve(false);
    const approval = approvalSchema.parse({
      ...input,
      interactionId: `node-environment-${randomUUID()}`,
      binding: intent.binding,
      executionId: intent.executionId,
      ...(intent.innerOperationId ? { innerId: intent.innerOperationId } : {}),
      policyRevision: intent.policyRevision,
      descriptorRevision: intent.descriptorRevision,
      expiresAtLocal: performance.now() + lifetime,
    });
    const binding = canonicalJson(intent.binding, CONTROL_BYTES);
    this.db
      .query('INSERT INTO environment_approvals VALUES (?,?,?,?)')
      .run(approval.interactionId, binding, canonicalJson(approval, CONTROL_BYTES), 'pending');
    return new Promise((resolve) => {
      const expire = () => this.settle(approval.interactionId, false, 'expired');
      signal.addEventListener('abort', expire, { once: true });
      const timer = setTimeout(expire, lifetime);
      this.live.set(approval.interactionId, {
        binding,
        deadline: approval.expiresAtLocal,
        timer,
        resolve: (value) => {
          signal.removeEventListener('abort', expire);
          resolve(value);
        },
      });
      try {
        this.notify(approval);
      } catch {
        expire();
      }
      if (signal.aborted) expire();
    });
  }
  private settle(id: string, approved: boolean, state: string): boolean {
    const entry = this.live.get(id);
    if (!entry) return false;
    const result = this.db
      .query("UPDATE environment_approvals SET state=? WHERE id=? AND state='pending'")
      .run(state, id);
    if (result.changes !== 1) return false;
    this.live.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    for (const callback of this.settled) callback(id);
    return true;
  }
  /**
   * NOT an environment/model operation. The UI ingress must authenticate owner,
   * human origin and control lease before calling this trusted method.
   */
  humanAnswer(
    binding: Binding,
    interactionId: string,
    finalArgumentDigest: string,
    approved: boolean,
  ): boolean {
    const entry = this.live.get(interactionId);
    if (
      !this.connected ||
      !entry ||
      entry.binding !== canonicalJson(binding, CONTROL_BYTES) ||
      performance.now() >= entry.deadline
    )
      return false;
    const row = this.db
      .query('SELECT payload FROM environment_approvals WHERE id=?')
      .get(interactionId) as { payload: string } | null;
    if (!row) return false;
    const record = approvalSchema.parse(parseJson(row.payload, CONTROL_BYTES));
    if (record.finalArgumentDigest !== finalArgumentDigest) return false;
    return this.settle(interactionId, approved, approved ? 'approved' : 'denied');
  }
  invalidate(binding?: Binding): void {
    const key = binding ? canonicalJson(binding, CONTROL_BYTES) : undefined;
    for (const [id, record] of this.live)
      if (!key || record.binding === key) this.settle(id, false, 'expired');
  }
  disconnect(): void {
    this.connected = false;
    this.invalidate();
  }
  reconnect(): void {
    this.connected = true;
  }
  close(): void {
    this.disconnect();
    this.db.close();
  }
}
