import { randomUUID } from 'node:crypto';
import { EnvironmentAdmission } from './admission.js';
import type { ArtifactTransfer } from './artifact-transfer.js';
const sharedAdmission = new EnvironmentAdmission();
import { canonicalJson } from './json.js';
import { ExecutionJournal } from './journal.js';
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
  constructor(
    private readonly options: {
      nodeId: string;
      journal: ExecutionJournal;
      authorize(binding: Binding): void;
      event?(event: ExecutionEvent): void;
      result?(record: ExecutionRecord): void;
      fault?(error: Error): void;
      admission?: EnvironmentAdmission;
    },
  ) {}
  private key(binding: Binding): string {
    return canonicalJson(binding, CONTROL_BYTES);
  }
  /** Trusted supervisor only; fixture provisioning is NOT production session adoption. */
  provision(descriptor: Descriptor, executor: EnvironmentExecutor): void {
    descriptor = descriptorSchema.parse(structuredClone(descriptor));
    if (descriptor.revision !== descriptorDigest(descriptor))
      throw new Error('Invalid descriptor revision');
    this.options.authorize(descriptor.binding);
    if (descriptor.binding.nodeId !== this.options.nodeId)
      throw new Error('Invalid transport node');
    const key = this.key(descriptor.binding);
    if (this.sessions.has(key)) throw new Error('Environment already provisioned');
    this.options.journal.provision(
      descriptor.binding,
      descriptor.revision,
      descriptor.policyRevision,
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
    if (binding.nodeId !== this.options.nodeId) throw new Error('Invalid transport node');
    const key = this.key(binding);
    if (this.sessions.has(key)) throw new Error('Environment already provisioned');
    if (!this.options.journal.isRetired(binding)) throw new Error('Generation is not fenced');
    this.retired.add(key);
  }
  /** Bindings whose durable records may be read: live sessions and adopted fenced generations. */
  private readable(binding: Binding): void {
    this.options.authorize(binding);
    if (binding.nodeId !== this.options.nodeId) throw new Error('Invalid transport node');
    if (!this.retired.has(this.key(binding))) this.session(binding);
  }
  private session(binding: Binding): SessionEnvironment {
    this.options.authorize(binding);
    if (binding.nodeId !== this.options.nodeId) throw new Error('Invalid transport node');
    const session = this.sessions.get(this.key(binding));
    if (!session) throw new Error('Invalid environment binding');
    return session;
  }
  async describe(binding: Binding): Promise<Descriptor> {
    return structuredClone(this.session(binding).descriptor);
  }
  async start(intent: ExecutionIntent): Promise<ExecutionRecord> {
    intent = validateIntent(structuredClone(intent));
    const session = this.session(intent.binding);
    if (!this.online || this.faulted)
      throw new Error('Node offline or supervisor recovery required');
    // Querying duplicates is allowed even when the executor has since gone away.
    let known: ExecutionRecord | undefined;
    try {
      known = this.options.journal.status(intent.binding, intent.executionId);
    } catch {
      /* admission below independently checks binding */
    }
    if (known) return this.options.journal.accept(intent).record;
    if (!session.executor.healthy || !session.descriptor.sandboxStatus.active)
      throw new Error('Sandbox unavailable');
    if (
      !session.descriptor.capabilityCatalog.some(
        (item) => item.name === intent.capability && item.placement === 'node',
      )
    )
      throw new Error('Unavailable environment capability');
    if (intent.budgetMs > session.descriptor.limits.maxBudgetMs)
      throw new Error('Execution budget exceeds descriptor');
    const admission = this.options.admission ?? sharedAdmission;
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
    const claimed = this.options.journal.claim(intent.binding, intent.executionId);
    if (claimed.state !== 'running') return;
    const controller = new AbortController();
    const remaining = Math.max(1, deadline - performance.now());
    const timer = setTimeout(
      () => controller.abort(new Error('Execution deadline expired')),
      remaining + (session.executor.managesBudget ? 30 * 60_000 : 0),
    );
    const entry = { binding: intent.binding, controller, timer, completion: Promise.resolve() };
    this.running.set(intent.executionId, entry);
    // Dispatch after returning the durable running receipt; no operation replays.
    entry.completion = Promise.resolve().then(async () => {
      let terminal: Terminal;
      let progressEvents = 0;
      let progressBytes = 0;
      let lastProgress = -Infinity;
      try {
        terminal = await session.executor.execute(
          intent,
          controller.signal,
          (kind, payload) => {
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
      throw new Error('Policy refresh requires fenced executor-generation replacement');
  }
  async status(binding: Binding, executionId: string): Promise<ExecutionRecord> {
    this.readable(binding);
    return this.options.journal.status(binding, executionId);
  }
  async cancel(binding: Binding, executionId: string): Promise<ExecutionRecord> {
    this.session(binding);
    const record = this.options.journal.cancel(binding, executionId);
    this.queued.delete(executionId);
    (this.options.admission ?? sharedAdmission).remove(executionId);
    this.running.get(executionId)?.controller.abort(new Error('Execution cancelled'));
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
    if (this.faulted) throw new Error('Supervisor recovery required after journal failure');
    this.online = true;
    (this.options.admission ?? sharedAdmission).wake();
  }
  async quiesceBinding(binding: Binding, cancelActive = false): Promise<void> {
    const session = this.session(binding);
    // A fenced placeholder blocks new admission without touching other sessions.
    session.executor = {
      healthy: false,
      execute: async () => {
        throw new Error('Binding quiesced');
      },
    };
    for (const [id, queuedBinding] of this.queued)
      if (this.key(queuedBinding) === this.key(binding)) {
        this.options.journal.cancel(binding, id);
        (this.options.admission ?? sharedAdmission).remove(id);
        this.queued.delete(id);
      }
    const entries = [...this.running.values()].filter(
      (entry) => this.key(entry.binding) === this.key(binding),
    );
    if (cancelActive)
      for (const entry of entries) entry.controller.abort(new Error('Binding fenced'));
    await Promise.all(entries.map((entry) => entry.completion));
  }
  async close(): Promise<void> {
    this.online = false;
    for (const [id, binding] of this.queued) {
      this.options.journal.cancel(binding, id);
      (this.options.admission ?? sharedAdmission).remove(id);
    }
    this.queued.clear();
    for (const entry of this.running.values())
      entry.controller.abort(new Error('Executor stopping'));
    await Promise.all([...this.running.values()].map((entry) => entry.completion));
  }
}

/** Direction-specific dispatch; trusted lifecycle, evidence and approval APIs are never accepted here. */
export async function dispatchEnvironment(
  environment: Environment,
  request: EnvironmentMessage,
  artifacts?: ArtifactTransfer,
): Promise<EnvironmentMessage> {
  const header = { version: 1 as const, requestId: request.requestId };
  switch (request.type) {
    case 'artifact.fetch': {
      if (!artifacts) throw new Error('Artifact transfer unavailable');
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
      throw new Error('Unexpected node environment request direction');
  }
}
export const unsolicitedResult = (record: ExecutionRecord): EnvironmentMessage => ({
  version: 1,
  requestId: randomUUID(),
  type: 'execution.result',
  record,
});
