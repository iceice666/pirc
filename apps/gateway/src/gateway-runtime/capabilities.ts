import type { Database } from 'bun:sqlite';
import { validateSchema } from '../agent/ptc/schema.js';
import { CONTRACT_VERSION, PtcError, type Result } from '../agent/ptc/contracts.js';
import type { Descriptor, ExecutionIntent, Terminal } from '../environment/protocol.js';
import type { InnerJournal } from '../environment/inner-journal.js';
import type { NodeHookRoute } from '../environment/gateway-operation.js';
import { ptcTerminal } from '../environment/ptc-result.js';
import { canonicalJson } from '../environment/json.js';
import { ApiError } from '../errors.js';

export interface CentralCapability {
  /** Runs only after the operation's mutation/result transaction committed. */
  committed?(intent: ExecutionIntent, args: Record<string, unknown>): void;
  /** DB-covered effects share the journal's transaction, never a second database. */
  mutate?(
    db: Database,
    args: Record<string, unknown>,
    intent: ExecutionIntent,
  ): Record<string, unknown>;
  /** Recoverable external services must own original-ID dedup; no implicit retry. */
  execute?(
    args: Record<string, unknown>,
    intent: ExecutionIntent,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

/** Trusted session-scoped central registry, shared by direct and PTC calls. */
export class GatewayCapabilities {
  constructor(
    private readonly options: {
      inner: InnerJournal;
      descriptor(intent: ExecutionIntent): Descriptor;
      authorize(intent: ExecutionIntent, args: Record<string, unknown>): void;
      hooks?(intent: ExecutionIntent): NodeHookRoute | undefined;
      capabilities: ReadonlyMap<string, CentralCapability>;
    },
  ) {}
  async execute(
    intent: ExecutionIntent,
    signal: AbortSignal,
    beforeExecute?: (args: Record<string, unknown>) => Promise<void>,
    nodeFinalArguments?: Record<string, unknown>,
  ): Promise<Result> {
    const descriptor = this.options.descriptor(intent);
    const capability = descriptor.capabilityCatalog.find(
      (entry) => entry.name === intent.capability && entry.placement === 'gateway',
    );
    const handler = this.options.capabilities.get(intent.capability);
    if (!capability || !handler) throw new Error('Central capability unavailable');
    const direct = !intent.parentExecutionId;
    if (!direct && !intent.innerOperationId) throw new Error('Central inner identity unavailable');
    if (
      descriptor.revision !== intent.descriptorRevision ||
      descriptor.policyRevision !== intent.policyRevision ||
      canonicalJson(descriptor.binding, 65536) !== canonicalJson(intent.binding, 65536)
    )
      throw new Error('Stale central capability');
    const mutation = (db: Database, args: Record<string, unknown>, operationId: string): Result => {
      try {
        // A savepoint rolls back all covered writes before recording a domain refusal.
        return db
          .transaction(() => ({
            ok: true as const,
            contractVersion: CONTRACT_VERSION,
            operationId,
            data: JSON.parse(canonicalJson(handler.mutate!(db, args, intent), 16 * 1024 * 1024)),
            attachments: [],
            truncated: false,
          }))
          .immediate();
      } catch (error) {
        if (
          !(error instanceof PtcError && error.outcome === 'not_started') &&
          !(error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500)
        )
          throw error;
        const typed =
          error instanceof PtcError ? error : new PtcError('InvalidArguments', error.message);
        return {
          ok: false,
          contractVersion: CONTRACT_VERSION,
          operationId,
          error: typed.toJSON(operationId),
        };
      }
    };
    if (direct) {
      const hooks = this.options.hooks?.(intent);
      const effect = async (final: Record<string, unknown>) => {
        try {
          return ptcTerminal({
            ok: true,
            contractVersion: CONTRACT_VERSION,
            operationId: intent.executionId,
            data: JSON.parse(
              canonicalJson(await handler.execute!(final, intent, signal), 16 * 1024 * 1024),
            ),
            attachments: [],
            truncated: false,
          });
        } catch (error) {
          return ptcTerminal({
            ok: false,
            contractVersion: CONTRACT_VERSION,
            operationId: intent.executionId,
            error: (error instanceof PtcError
              ? error
              : new PtcError(
                  signal.aborted ? 'Cancelled' : 'OperationFailed',
                  String(error),
                  'unknown',
                )
            ).toJSON(intent.executionId),
          });
        }
      };
      const result = await this.options.inner.operations.execute(intent, {
        ...(hooks ? { hooks } : {}),
        schema: capability.argumentSchema as Record<string, unknown>,
        authorize: (_intent, args) =>
          this.options.authorize(intent, args as Record<string, unknown>),
        ...(handler.mutate
          ? {
              mutate: (db, args) =>
                ptcTerminal(mutation(db, args as Record<string, unknown>, intent.executionId)),
            }
          : { execute: (args) => effect(args as Record<string, unknown>) }),
        signal,
        ...(handler.committed
          ? {
              committed: (args: import('../environment/json.js').Json) =>
                handler.committed!(intent, args as Record<string, unknown>),
            }
          : {}),
      });
      if (!result.terminal.output)
        throw new PtcError('OperationFailed', 'Direct central outcome unresolved', 'unknown');
      return result.terminal.output as unknown as Result;
    }
    const parentId = intent.parentExecutionId!,
      innerId = intent.innerOperationId!;
    const known = this.options.inner.status(intent.binding, parentId, innerId);
    if (canonicalJson(known.intent, 8 * 1024 * 1024) !== canonicalJson(intent, 8 * 1024 * 1024))
      throw new Error('Central inner identity conflict');
    if (known.result?.output) return known.result.output as unknown as Result;
    let args = (nodeFinalArguments ?? intent.arguments) as Record<string, unknown>;
    if (validateSchema(args, capability.argumentSchema as Record<string, unknown>).length)
      throw new Error('Invalid central arguments');
    const hooks = nodeFinalArguments === undefined ? this.options.hooks?.(intent) : undefined;
    if (hooks && (!handler.mutate || !beforeExecute))
      throw new Error('Central hooks require transactional effect and final-argument coordination');
    if (validateSchema(args, capability.argumentSchema as Record<string, unknown>).length)
      throw new Error('Invalid rewritten central arguments');
    signal.throwIfAborted();
    this.options.authorize(intent, args);
    const envelope = (data: Record<string, unknown>): Result => ({
      ok: true,
      contractVersion: CONTRACT_VERSION,
      operationId: intent.innerOperationId!,
      data: JSON.parse(canonicalJson(data, 16 * 1024 * 1024)),
      attachments: [],
      truncated: false,
    });
    const terminal = (result: Result): Terminal => ({
      state: 'completed',
      effect: 'completed',
      output: JSON.parse(JSON.stringify(result)),
      artifacts: [],
      truncated: false,
    });
    let result: Result;
    if (handler.mutate) {
      if (hooks) {
        if (known.state === 'accepted') this.options.inner.claim(intent.binding, parentId, innerId);
        const committed = await this.options.inner.operations.execute(intent, {
          hooks,
          schema: capability.argumentSchema as Record<string, unknown>,
          authorize: (_intent, final) =>
            this.options.authorize(intent, final as Record<string, unknown>),
          beforeExecute: (final) => beforeExecute!(final as Record<string, unknown>),
          mutate: (db, final) =>
            ptcTerminal(mutation(db, final as Record<string, unknown>, innerId)),
          signal,
          ...(handler.committed
            ? {
                committed: (final: import('../environment/json.js').Json) =>
                  handler.committed!(intent, final as Record<string, unknown>),
              }
            : {}),
        });
        if (!committed.terminal.output)
          throw new Error('Central hook outcome unknown; reconcile original ID');
        this.options.inner.finish(intent.binding, parentId, innerId, committed.terminal);
        result = committed.terminal.output as unknown as Result;
      } else {
        await beforeExecute?.(args);
        signal.throwIfAborted();
        const committed = this.options.inner.transact(intent.binding, parentId, innerId, (db) =>
          ptcTerminal(mutation(db, args, innerId)),
        );
        result = committed.output as unknown as Result;
      }
    } else {
      if (!handler.execute) throw new Error('Central handler unavailable');
      if (known.state !== 'accepted')
        throw new Error('Central operation already started; reconcile');
      this.options.inner.claim(intent.binding, parentId, innerId);
      await beforeExecute?.(args);
      signal.throwIfAborted();
      try {
        result = envelope(await handler.execute(args, intent, signal));
        this.options.inner.finish(intent.binding, parentId, innerId, terminal(result));
      } catch (error) {
        result = {
          ok: false,
          contractVersion: CONTRACT_VERSION,
          operationId: innerId,
          error: (error instanceof PtcError
            ? error
            : new PtcError(
                signal.aborted ? 'Cancelled' : 'OperationFailed',
                String(error),
                'unknown',
              )
          ).toJSON(intent.innerOperationId),
        };
        this.options.inner.finish(intent.binding, parentId, innerId, ptcTerminal(result));
      }
    }
    if (result.ok && !hooks) handler.committed?.(intent, args);
    return result;
  }
}
