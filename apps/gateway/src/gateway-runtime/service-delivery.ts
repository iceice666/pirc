import type { GatewaySessionAuthority } from './authority.js';
import type { GatewayAgentRuntime } from './runtime.js';
import type { WriterLease } from './contracts.js';
import type { TurnInput } from './turn-contracts.js';
import type { DeliveredMessage } from '../daemon/session-dispatch.js';
import { canonicalJson, parseJson } from '../environment/json.js';

interface Delivery {
  id: string;
  session: string;
  owner: string;
  lease: string;
  input: string;
  message: string;
  state: string;
  reason: string | null;
}
/** Durable opt-in service admission. Only queued rows may be started; a claimed
 * row after restart never replays configuration, lifecycle hooks or a model run. */
export class GatewayServiceDeliveries {
  private readonly db;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly active = new Set<string>();
  private closed = false;
  constructor(
    private readonly options: {
      authority: GatewaySessionAuthority;
      runtime: GatewayAgentRuntime;
      configure?(
        lease: WriterLease,
        owner: string,
        message: DeliveredMessage,
        signal: AbortSignal,
      ): Promise<void>;
    },
  ) {
    this.db = options.authority.inner.operations.db;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS runtime_service_deliveries(id TEXT PRIMARY KEY,session TEXT NOT NULL,owner TEXT NOT NULL,lease TEXT NOT NULL,input TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL,reason TEXT);`,
    );
    // Composition occurs once per process/connection through recovery guard below.
    if (!recovered.has(this.db)) {
      options.authority.recoverRuntimeOnce();
      this.db
        .transaction(() => {
          const rows = this.db
            .query("SELECT * FROM runtime_service_deliveries WHERE state='claimed'")
            .all() as Delivery[];
          for (const row of rows) {
            const run = options.authority.runState(row.session, row.owner, row.id);
            this.finish(
              row.id,
              run?.state === 'completed' ? 'completed' : 'interrupted',
              run?.reason ??
                'Gateway restarted during delivery admission; original work is not replayed',
            );
          }
        })
        .immediate();
      recovered.add(this.db);
    }
    this.timer = setInterval(() => void this.drain(), 250);
    this.timer.unref();
    queueMicrotask(() => void this.drain());
  }
  admit(lease: WriterLease, owner: string, input: TurnInput, message: DeliveredMessage): void {
    if (this.closed) throw new Error('Service delivery queue closed');
    const serialized = {
      lease: canonicalJson(lease, 65536),
      input: canonicalJson(input, 1024 * 1024),
      message: canonicalJson(message, 1024 * 1024),
    };
    this.db
      .transaction(() => {
        this.options.authority.assertOwner(lease.binding.sessionId, owner);
        this.options.authority.assertWriter(lease);
        const old = this.db
          .query('SELECT * FROM runtime_service_deliveries WHERE id=?')
          .get(input.runId) as Delivery | null;
        if (old) {
          if (
            old.session !== lease.binding.sessionId ||
            old.owner !== owner ||
            old.lease !== serialized.lease ||
            old.input !== serialized.input ||
            old.message !== serialized.message
          )
            throw new Error('Service delivery identity conflict');
          return;
        }
        const global = this.db
          .query(
            "SELECT COUNT(*) AS n FROM runtime_service_deliveries WHERE state IN ('queued','claimed')",
          )
          .get() as { n: number };
        const local = this.db
          .query(
            "SELECT COUNT(*) AS n FROM runtime_service_deliveries WHERE session=? AND state IN ('queued','claimed')",
          )
          .get(lease.binding.sessionId) as { n: number };
        if (global.n >= 128 || local.n >= 32)
          throw new Error('Service delivery queue quota exceeded');
        this.options.authority.enrollServiceTurn(
          lease,
          input,
          message.customType,
          message.details ?? {},
        );
        this.db
          .query("INSERT INTO runtime_service_deliveries VALUES (?,?,?,?,?,?,'queued',NULL)")
          .run(
            input.runId,
            lease.binding.sessionId,
            owner,
            serialized.lease,
            serialized.input,
            serialized.message,
          );
      })
      .immediate();
    void this.drain();
  }
  status(id: string, owner: string): { state: string; reason: string | null } | undefined {
    const row = this.db
      .query('SELECT * FROM runtime_service_deliveries WHERE id=?')
      .get(id) as Delivery | null;
    if (!row) return;
    this.options.authority.assertOwner(row.session, owner);
    if (row.owner !== owner) throw new Error('Service owner mismatch');
    return { state: row.state, reason: row.reason };
  }
  private finish(id: string, state: string, reason?: string | null) {
    this.db
      .query('UPDATE runtime_service_deliveries SET state=?,reason=? WHERE id=?')
      .run(state, reason?.slice(0, 8192) ?? null, id);
  }
  private async drain(): Promise<void> {
    if (this.closed) return;
    const rows = this.db
      .query(
        "SELECT * FROM runtime_service_deliveries WHERE state IN ('queued','claimed') ORDER BY rowid LIMIT 128",
      )
      .all() as Delivery[];
    const sessions = new Set<string>();
    for (const row of rows) {
      if (sessions.has(row.session)) continue;
      sessions.add(row.session);
      if (this.active.has(row.session) || row.state !== 'queued') continue;
      const lease = parseJson(row.lease, 65536) as unknown as WriterLease,
        input = parseJson(row.input, 1024 * 1024) as unknown as TurnInput,
        message = parseJson(row.message, 1024 * 1024) as unknown as DeliveredMessage;
      // A basic delivery queue cannot steal configured scheduler work during
      // shared-host startup. Leave it durable until the trusted adapter exists.
      if ((message.role || message.model || message.thinking) && !this.options.configure) continue;
      this.active.add(row.session);
      void this.start(row, lease, input, message).finally(() => this.active.delete(row.session));
    }
  }
  private async start(
    row: Delivery,
    lease: WriterLease,
    input: TurnInput,
    message: DeliveredMessage,
  ): Promise<void> {
    let claimed = false;
    try {
      const admitted = await this.options.runtime.serviceDelivery(
        lease,
        row.owner,
        input,
        async (signal) => {
          signal.throwIfAborted();
          if (this.closed) throw new Error('Service delivery queue closed');
          this.options.authority.assertOwner(row.session, row.owner);
          this.options.authority.assertWriter(lease);
          const changed = this.db
            .query(
              "UPDATE runtime_service_deliveries SET state='claimed' WHERE id=? AND state='queued'",
            )
            .run(row.id).changes;
          if (!changed) throw new Error('Service delivery already claimed');
          claimed = true;
          if (message.role || message.model || message.thinking) {
            if (!this.options.configure)
              throw new Error('Trusted scheduled model/role configuration unavailable');
            await this.options.configure(lease, row.owner, message, signal);
          }
        },
      );
      if (!admitted) return; // Capacity/offline before any side effect; still queued.
      this.finish(row.id, admitted.state, admitted.reason);
    } catch (error) {
      if (claimed || this.status(row.id, row.owner)?.state === 'queued')
        this.finish(row.id, 'interrupted', String(error));
    }
  }
  cancel(sessionId: string, owner: string): void {
    this.options.authority.assertOwner(sessionId, owner);
    this.db
      .query(
        "UPDATE runtime_service_deliveries SET state='interrupted',reason='Service delivery cancelled before admission' WHERE session=? AND owner=? AND state='queued'",
      )
      .run(sessionId, owner);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all(
      [...this.active].map((session) => {
        const row = this.db
          .query(
            "SELECT owner FROM runtime_service_deliveries WHERE session=? AND state='claimed' LIMIT 1",
          )
          .get(session) as { owner: string } | null;
        return row ? this.options.runtime.cancel(session, row.owner) : Promise.resolve();
      }),
    );
  }
}
const recovered = new WeakSet<object>();
