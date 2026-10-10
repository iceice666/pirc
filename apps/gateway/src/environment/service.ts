import { randomUUID } from 'node:crypto';
import { planPtc } from '../gateway-runtime/ptc-contracts.js';
import { EnvironmentAdmission } from './admission.js';
import type { ArtifactTransfer } from './artifact-transfer.js';
const sharedAdmission = new EnvironmentAdmission();
import { canonicalJson } from './json.js';
import { EnvironmentCodeError, ExecutionJournal, type EnvironmentErrorCode } from './journal.js';
export { EnvironmentCodeError } from './journal.js';
import {
  CONTROL_BYTES,
  validateIntent,
  descriptorSchema,
  descriptorDigest,
  type Binding,
  type Descriptor,
  type Environment,
  type EnvironmentMessage,
  type ExecutionEvent,
  type ExecutionIntent,
  type ExecutionRecord,
  type Terminal,
} from './protocol.js';

/** An already sandboxed executor; services must never supply a daemon fs/spawn implementation. */
export interface EnvironmentExecutor {
  readonly healthy: boolean;
  /** The subprocess supervisor implements active/absolute human-wait accounting. */
  readonly managesBudget?: boolean;
  execute(
    intent: ExecutionIntent,
    signal: AbortSignal,
    event: (kind: ExecutionEvent['kind'], payload: ExecutionEvent['payload']) => void,
    remainingBudgetMs?: number,
  ): Promise<Terminal>;
}
/** The trusted writer fence as seen by LocalEnvironment (node: NodeWriterFence). */
export interface EnvironmentFence {
  /** Throws unless `binding` is the newest fenced, unrevoked generation of its session. */
  assertProvisioned(binding: Binding): void;
  /** Revocation/supersession notifications; returns an unsubscribe function. */
  subscribe?(listener: (bindings: Binding[]) => void): () => void;
}
interface SessionEnvironment {
  descriptor: Descriptor;
  executor: EnvironmentExecutor;
}
/** Independently provisioned node bindings. No incoming message can create a binding. */
export class LocalEnvironment implements Environment {
  private sessions = new Map<string, SessionEnvironment>();
  private running = new Map<
    string,
    {
      binding: Binding;
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
      completion: Promise<void>;
    }
  >();
  private queued = new Map<string, Binding>();
  /** Fenced generations from before a restart: status and ACK only, never start. */
  private retired = new Set<string>();
  private online = true;
  private faulted = false;
  private readonly unsubscribe: (() => void) | undefined;
  constructor(
    private readonly options: {
      nodeId: string;
      journal: ExecutionJournal;
      authorize(binding: Binding): void;
      event?(event: ExecutionEvent): void;
      result?(record: ExecutionRecord): void;
      fault?(error: Error): void;
      admission?: EnvironmentAdmission;
      /**
       * Trusted durable writer fence (node: `services.writerFence`). provision() refuses
       * any generation that is not the newest fenced, unrevoked one of its session;
       * revocation/supersession notifications drop the retired generation's queue.
       * Required: a production composition MUST pass it.
       */
      fence?: EnvironmentFence;
      /** Test/benchmark harness opt-out of the writer fence. Never set in production. */
      unfencedHarness?: true;
    },
  ) {
    if (!options.fence && options.unfencedHarness !== true)
      throw new Error('LocalEnvironment requires a writer fence (or an explicit unfencedHarness)');
    this.unsubscribe = options.fence?.subscribe?.((bindings) => this.retiredByFence(bindings));
  }
  private key(binding: Binding): string {
    return canonicalJson(binding, CONTROL_BYTES);
  }
  private get admission(): EnvironmentAdmission {
    return this.options.admission ?? sharedAdmission;
  }
  /**
   * A generation was revoked/superseded at the fence. Its journal generation is retired
   * (atomically cancelling queued work) if the fence did not already do so, and its
   * in-memory queue is dropped. Other sessions are untouched; running work is stopped
   * by the supervisor's fenceEnvironment, not here.
   */
  private retiredByFence(bindings: Binding[]): void {
    const keys = new Set(bindings.map((binding) => this.key(binding)));
    for (const binding of bindings)
      if (this.options.journal.isProvisioned(binding) && !this.options.journal.isRetired(binding))
        this.options.journal.retire(binding);
    for (const [id, queuedBinding] of this.queued)
      if (keys.has(this.key(queuedBinding))) {
        this.queued.delete(id);
        this.admission.remove(id);
      }
  }
  /**
   * Trusted supervisor only, side-effect free: would provision(descriptor) be allowed?
   * Checks descriptor integrity, authorization, the writer fence (newest fenced and
   * unrevoked generation) and that no other generation of the session is live, except
   * `replacing` (the one generation a fenced refresh is about to retire).
   */
  assertProvisionable(descriptor: Descriptor, replacing?: Binding): Descriptor {
    descriptor = descriptorSchema.parse(structuredClone(descriptor));
    if (descriptor.revision !== descriptorDigest(descriptor))
      throw new EnvironmentCodeError('stale_revision', 'Invalid descriptor revision');
    this.options.authorize(descriptor.binding);
    if (descriptor.binding.nodeId !== this.options.nodeId)
      throw new EnvironmentCodeError('invalid_binding', 'Invalid transport node');
    if (
      replacing &&
      (replacing.nodeId !== descriptor.binding.nodeId ||
        replacing.sessionId !== descriptor.binding.sessionId)
    )
      throw new EnvironmentCodeError('invalid_binding', 'Replacement must stay in its session');
    if (this.sessions.has(this.key(descriptor.binding)))
      throw new EnvironmentCodeError('conflict', 'Environment already provisioned');
    this.options.fence?.assertProvisioned(descriptor.binding);
    this.options.journal.assertFreshProvisionable(descriptor.binding, replacing);
    return descriptor;
  }
  /** Trusted supervisor only; fixture provisioning is NOT production session adoption. */
  provision(descriptor: Descriptor, executor: EnvironmentExecutor): void {
    descriptor = this.assertProvisionable(descriptor);
    const key = this.key(descriptor.binding);
    // Fresh only: an existing journal generation (e.g. after a restart) is never
    // revived with a new executor; it is swept/retired and adopted read-only instead.
    // The journal re-checks atomically that no other generation of the session is live.
    this.options.journal.provision(
      descriptor.binding,
      descriptor.revision,
      descriptor.policyRevision,
      { fresh: true },
    );
    this.sessions.set(key, { descriptor: structuredClone(descriptor), executor });
  }
  /**
   * Trusted supervisor only, after a node restart: expose a generation that was
   * fenced and recovered before the restart so the gateway can reconcile its
   * outcomes. Nothing can start, cancel or describe through it.
   */
  adoptRetired(binding: Binding): void {
    this.options.authorize(binding);
    if (binding.nodeId !== this.options.nodeId)
      throw new EnvironmentCodeError('invalid_binding', 'Invalid transport node');
    const key = this.key(binding);
    if (this.sessions.has(key))
      throw new EnvironmentCodeError('conflict', 'Environment already provisioned');
    if (!this.options.journal.isRetired(binding))
      throw new EnvironmentCodeError('stale_epoch', 'Generation is not fenced');
    this.retired.add(key);
  }
  /** Bindings whose durable records may be read: live sessions and adopted fenced generations. */
  private readable(binding: Binding): void {
    this.options.authorize(binding);
    if (binding.nodeId !== this.options.nodeId)
      throw new EnvironmentCodeError('invalid_binding', 'Invalid transport node');
    if (!this.retired.has(this.key(binding))) this.session(binding);
  }
  private session(binding: Binding): SessionEnvironment {
    this.options.authorize(binding);
    if (binding.nodeId !== this.options.nodeId)
      throw new EnvironmentCodeError('invalid_binding', 'Invalid transport node');
    const session = this.sessions.get(this.key(binding));
    if (!session) throw new EnvironmentCodeError('invalid_binding', 'Invalid environment binding');
    return session;
  }
  async describe(binding: Binding): Promise<Descriptor> {
    return structuredClone(this.session(binding).descriptor);
  }
  async start(intent: ExecutionIntent): Promise<ExecutionRecord> {
    intent = validateIntent(structuredClone(intent));
    const session = this.session(intent.binding);
    if (!this.online || this.faulted)
      throw new EnvironmentCodeError(
        'unavailable_sandbox',
        'Node offline or supervisor recovery required',
      );
    // Querying duplicates is allowed even when the executor has since gone away.
    let known: ExecutionRecord | undefined;
    try {
      known = this.options.journal.status(intent.binding, intent.executionId);
    } catch {
      /* admission below independently checks binding */
    }
    if (known) return this.options.journal.accept(intent).record;
    if (!session.executor.healthy || !session.descriptor.sandboxStatus.active)
      throw new EnvironmentCodeError('unavailable_sandbox', 'Sandbox unavailable');
    if (
      intent.capability.startsWith('lifecycle.')
        ? !(session.descriptor.lifecycleHooks ?? []).includes(
            intent.capability.slice(10) as 'sessionStart' | 'beforePrompt' | 'agentSettled',
          )
        : intent.capability === 'ptc'
          ? planPtc(intent.arguments, session.descriptor.capabilityCatalog).placement !== 'node'
          : !session.descriptor.capabilityCatalog.some(
              (item) => item.name === intent.capability && item.placement === 'node',
            )
    )
      throw new EnvironmentCodeError('stale_revision', 'Unavailable environment capability');
    if (intent.budgetMs > session.descriptor.limits.maxBudgetMs)
      throw new EnvironmentCodeError('quota_exceeded', 'Execution budget exceeds descriptor');
    const admission = this.admission;
    const deadline = performance.now() + intent.budgetMs;
    admission.reserve({
      id: intent.executionId,
      node: intent.binding.nodeId,
      session: `${intent.binding.nodeId}:${intent.binding.sessionId}`,
      bytes: Buffer.byteLength(canonicalJson(intent, 8 * 1024 * 1024)),
      deadline,
      ready: () => this.online && !this.faulted && session.executor.healthy,
      expire: () => {
        this.queued.delete(intent.executionId);
        try {
          this.options.journal.expire(intent.binding, intent.executionId);
        } catch (error) {
          this.faulted = true;
          this.options.fault?.(error as Error);
        }
      },
      start: async () => {
        this.queued.delete(intent.executionId);
        try {
          await this.executeAccepted(intent, session, deadline);
        } catch (error) {
          this.faulted = true;
          this.options.fault?.(error as Error);
        }
      },
    });
    let accepted;
    try {
      accepted = this.options.journal.accept(intent);
    } catch (error) {
      admission.remove(intent.executionId);
      throw error;
    }
    if (!accepted.fresh) {
      admission.remove(intent.executionId);
      return accepted.record;
    }
    this.queued.set(intent.executionId, intent.binding);
    admission.wake();
    return this.options.journal.status(intent.binding, intent.executionId);
  }
  private async executeAccepted(
    intent: ExecutionIntent,
    session: SessionEnvironment,
    deadline: number,
  ): Promise<void> {
    if (performance.now() >= deadline) {
      this.options.journal.expire(intent.binding, intent.executionId);
      return;
    }
    let claimed: ExecutionRecord;
    try {
      claimed = this.options.journal.claim(intent.binding, intent.executionId);
    } catch (error) {
      // A typed refusal (cancelled meanwhile, not startable) concerns this item only;
      // retired generations already return their cancelled record. Anything else is
      // a journal failure and faults the node.
      if (error instanceof EnvironmentCodeError) return;
      throw error;
    }
    if (claimed.state !== 'running') return;
    const controller = new AbortController();
    const remaining = Math.max(1, deadline - performance.now());
    const timer = setTimeout(
      () => controller.abort(new EnvironmentCodeError('expired', 'Execution deadline expired')),
      remaining + (session.executor.managesBudget ? 30 * 60_000 : 0),
    );
    const entry = { binding: intent.binding, controller, timer, completion: Promise.resolve() };
    this.running.set(intent.executionId, entry);
    // Dispatch after returning the durable running receipt; no operation replays.
    entry.completion = Promise.resolve().then(async () => {
      let terminal: Terminal;
      let progressEvents = 0;
      let progressBytes = 0;
      let operationEvents = 0;
      let lastProgress = -Infinity;
      try {
        terminal = await session.executor.execute(
          intent,
          controller.signal,
          (kind, payload) => {
            if (kind === 'operation' && ++operationEvents > 400)
              throw new Error('Environment operation event quota exceeded');
            if (kind === 'progress' || kind === 'output') {
              const now = performance.now();
              const bytes = Buffer.byteLength(canonicalJson(payload, CONTROL_BYTES / 2));
              if (
                now - lastProgress < 100 ||
                progressEvents >= 256 ||
                progressBytes + bytes > 1024 * 1024
              )
                return;
              lastProgress = now;
              progressEvents++;
              progressBytes += bytes;
            }
            const event = this.options.journal.appendEvent(
              intent.binding,
              intent.executionId,
              kind,
              payload,
            );
            if (this.online) this.options.event?.(event);
          },
          remaining,
        );
      } catch (error) {
        terminal = {
          state: 'unknown',
          effect: 'unknown',
          truncated: false,
          artifacts: [],
          error: {
            code: 'unknown',
            message: String(error).slice(0, 8192),
          },
        };
      }
      try {
        const record = this.options.journal.finish(intent.binding, intent.executionId, terminal);
        if (this.online) {
          try {
            this.options.result?.(record);
          } catch {
            /* Durable result remains queryable after reconnect. */
          }
        }
      } catch (error) {
        // Persistence failure must not emit an unjournaled success. Recovery will
        // leave this execution unknown; the supervisor must stop admission.
        this.online = false;
        this.faulted = true;
        this.options.fault?.(error as Error);
      } finally {
        clearTimeout(timer);
        this.running.delete(intent.executionId);
      }
    });
    await entry.completion;
  }
  /** Config changes require the trusted, fenced replacement lifecycle, not partial revision setters. */
  refresh(descriptor: Descriptor): void {
    const session = this.session(descriptor.binding);
    if (
      descriptor.revision !== session.descriptor.revision ||
      descriptor.policyRevision !== session.descriptor.policyRevision
    )
      throw new EnvironmentCodeError(
        'stale_revision',
        'Policy refresh requires fenced executor-generation replacement',
      );
  }
  /** Unknown IDs are durably tombstoned and reported as `unknown_execution` (journal.query). */
  async status(binding: Binding, executionId: string): Promise<ExecutionRecord> {
    this.readable(binding);
    return this.options.journal.query(binding, executionId);
  }
  async cancel(binding: Binding, executionId: string): Promise<ExecutionRecord> {
    this.session(binding);
    const record = this.options.journal.cancel(binding, executionId);
    this.queued.delete(executionId);
    this.admission.remove(executionId);
    this.running
      .get(executionId)
      ?.controller.abort(new EnvironmentCodeError('cancelled', 'Execution cancelled'));
    return record;
  }
  async ack(binding: Binding, executionId: string, resultDigest: string): Promise<void> {
    this.readable(binding);
    this.options.journal.ack(binding, executionId, resultDigest);
  }
  disconnect(): void {
    this.online = false;
  }
  reconnect(): void {
    if (this.faulted)
      throw new EnvironmentCodeError(
        'unavailable_sandbox',
        'Supervisor recovery required after journal failure',
      );
    this.online = true;
    this.admission.wake();
  }
  async quiesceBinding(binding: Binding, cancelActive = false): Promise<void> {
    const session = this.session(binding);
    // A fenced placeholder blocks new admission without touching other sessions.
    session.executor = {
      healthy: false,
      execute: async () => {
        throw new EnvironmentCodeError('unavailable_sandbox', 'Binding quiesced');
      },
    };
    for (const [id, queuedBinding] of this.queued)
      if (this.key(queuedBinding) === this.key(binding)) {
        this.options.journal.cancel(binding, id);
        this.admission.remove(id);
        this.queued.delete(id);
      }
    const entries = [...this.running.values()].filter(
      (entry) => this.key(entry.binding) === this.key(binding),
    );
    if (cancelActive)
      for (const entry of entries)
        entry.controller.abort(new EnvironmentCodeError('cancelled', 'Binding fenced'));
    await Promise.all(entries.map((entry) => entry.completion));
  }
  async close(): Promise<void> {
    this.online = false;
    this.unsubscribe?.();
    for (const [id, binding] of this.queued) {
      this.options.journal.cancel(binding, id);
      this.admission.remove(id);
    }
    this.queued.clear();
    for (const entry of this.running.values())
      entry.controller.abort(new EnvironmentCodeError('cancelled', 'Executor stopping'));
    await Promise.all([...this.running.values()].map((entry) => entry.completion));
  }
}

/** A wire-protocol violation: the only dispatch failure that closes the node link. */
export class EnvironmentProtocolError extends Error {}

/**
 * Classification only, for refusals raised as plain Errors by modules that do not throw
 * EnvironmentCodeError at the origin (admission, artifacts, approvals, ...). The raw
 * message of such errors never reaches the wire; see environmentError().
 */
const ERROR_CODES: Array<[EnvironmentErrorCode, string[]]> = [
  [
    'invalid_binding',
    [
      'Invalid binding',
      'Invalid environment binding',
      'Invalid transport node',
      'Unfenced writer generation',
      'Artifact owner mismatch',
      'Artifact ownership mismatch',
    ],
  ],
  [
    'stale_epoch',
    [
      'Retired generation',
      'Writer generation permanently revoked',
      'Writer generation superseded',
      'Generation is not fenced',
    ],
  ],
  [
    'unavailable_sandbox',
    [
      'Sandbox unavailable',
      'Node offline or supervisor recovery required',
      'Supervisor recovery required',
      'Binding quiesced',
      'Environment binding quarantined',
      'Artifact node offline',
      'Artifact transfer unavailable',
      'Workspace memory service unavailable',
    ],
  ],
  ['stale_revision', ['Unavailable environment capability', 'Policy refresh requires']],
  [
    'quota_exceeded',
    [
      'Execution budget exceeds descriptor',
      'Journal soft cap exceeded',
      'Environment admission quota exceeded',
      'Approval quota exceeded',
      'Session artifact quota exceeded',
      'Artifact exceeds limit',
    ],
  ],
  [
    'conflict',
    [
      'Execution ID conflict',
      'Execution ID admission conflict',
      'Result digest mismatch',
      'Artifact transfer digest mismatch',
    ],
  ],
  ['cancelled', ['Binding fenced', 'Executor stopping', 'Execution cancelled']],
  // No record and no durable fence: the node cannot vouch it never ran.
  ['unknown', ['Unknown execution']],
];
/** Fixed wire text for errors that are not typed at their origin. */
const GENERIC_MESSAGES: Record<EnvironmentErrorCode, string> = {
  incompatible: 'Incompatible environment request',
  invalid_binding: 'Invalid environment binding',
  stale_revision: 'Stale environment revision',
  stale_epoch: 'Stale writer or executor generation',
  unavailable_sandbox: 'Environment unavailable',
  approval_denied: 'Approval denied',
  quota_exceeded: 'Environment quota exceeded',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Environment request failed',
  unknown: 'Execution outcome unknown',
  conflict: 'Environment request conflict',
  unknown_execution: 'Unknown execution',
};
const redact = (text: string) =>
  text.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`,;:()[\]{}<>]+){2,}/g, '<path>').slice(0, 512);
/**
 * Typed, bounded error for a correlated reply. Only an EnvironmentCodeError (raised at
 * the origin with wire-safe text) keeps its message, still path-redacted and bounded;
 * every other error gets its code by classification and a FIXED generic message, so no
 * path, secret or library text can leak. The raw text stays node-local (logs) only.
 * Never `unknown_execution` unless the journal raised it.
 */
export function environmentError(error: unknown): {
  code: EnvironmentErrorCode;
  message: string;
} {
  if (error instanceof EnvironmentCodeError)
    return { code: error.code, message: redact(error.message) || GENERIC_MESSAGES[error.code] };
  if (error instanceof Error && error.name === 'ZodError')
    return { code: 'failed', message: 'Invalid request' };
  const raw = error instanceof Error ? error.message : String(error);
  const code =
    ERROR_CODES.find(([, prefixes]) => prefixes.some((prefix) => raw.startsWith(prefix)))?.[0] ??
    'failed';
  return { code, message: GENERIC_MESSAGES[code] };
}
export const environmentErrorReply = (requestId: string, error: unknown): EnvironmentMessage => ({
  version: 1,
  requestId,
  type: 'environment.error',
  error: environmentError(error),
});

/**
 * Direction-specific dispatch; trusted lifecycle, evidence and approval APIs are never accepted here.
 * Ordinary refusals become a correlated `environment.error` reply; only protocol
 * violations (EnvironmentProtocolError) throw, so callers close the link for them alone.
 */
export async function dispatchEnvironment(
  environment: Environment,
  request: EnvironmentMessage,
  artifacts?: ArtifactTransfer,
): Promise<EnvironmentMessage> {
  try {
    return await dispatchRequest(environment, request, artifacts);
  } catch (error) {
    if (error instanceof EnvironmentProtocolError) throw error;
    return environmentErrorReply(request.requestId, error);
  }
}
async function dispatchRequest(
  environment: Environment,
  request: EnvironmentMessage,
  artifacts?: ArtifactTransfer,
): Promise<EnvironmentMessage> {
  const header = { version: 1 as const, requestId: request.requestId };
  switch (request.type) {
    case 'artifact.pin': {
      if (!artifacts)
        throw new EnvironmentCodeError('unavailable_sandbox', 'Artifact transfer unavailable');
      artifacts.pin({ binding: request.binding, artifact: request.artifact });
      return { ...header, type: 'artifact.pinned' };
    }
    case 'artifact.fetch': {
      if (!artifacts)
        throw new EnvironmentCodeError('unavailable_sandbox', 'Artifact transfer unavailable');
      const { version: _version, requestId: _requestId, type: _type, ...input } = request;
      const chunk = await artifacts.fetch(input);
      return { ...header, type: 'artifact.chunk', ...chunk };
    }
    case 'environment.describe':
      return {
        ...header,
        type: 'environment.descriptor',
        descriptor: await environment.describe(request.binding),
      };
    case 'execution.start':
      return {
        ...header,
        type: 'execution.reply',
        record: await environment.start(request.intent),
      };
    case 'execution.status':
      return {
        ...header,
        type: 'execution.reply',
        record: await environment.status(request.binding, request.executionId),
      };
    case 'execution.cancel':
      return {
        ...header,
        type: 'execution.reply',
        record: await environment.cancel(request.binding, request.executionId),
      };
    case 'execution.ack':
      await environment.ack(request.binding, request.executionId, request.resultDigest);
      return { ...header, type: 'execution.acknowledged' };
    default:
      throw new EnvironmentProtocolError('Unexpected node environment request direction');
  }
}
export const unsolicitedResult = (record: ExecutionRecord): EnvironmentMessage => ({
  version: 1,
  requestId: randomUUID(),
  type: 'execution.result',
  record,
});
