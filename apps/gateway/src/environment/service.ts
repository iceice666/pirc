import { randomUUID } from 'node:crypto';
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
  execute(
    intent: ExecutionIntent,
    signal: AbortSignal,
    event: (kind: ExecutionEvent['kind'], payload: ExecutionEvent['payload']) => void,
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
    if (
      this.running.size >= 4 ||
      [...this.running.values()].some((item) => this.key(item.binding) === this.key(intent.binding))
    )
      throw new Error('Environment busy');
    if (intent.budgetMs > session.descriptor.limits.maxBudgetMs)
      throw new Error('Execution budget exceeds descriptor');
    const accepted = this.options.journal.accept(intent);
    if (!accepted.fresh) return accepted.record;
    const claimed = this.options.journal.claim(intent.binding, intent.executionId);
    if (claimed.state !== 'running') return claimed;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Execution deadline expired')),
      intent.budgetMs,
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
        terminal = await session.executor.execute(intent, controller.signal, (kind, payload) => {
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
        });
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
    return claimed;
  }
  async status(binding: Binding, executionId: string): Promise<ExecutionRecord> {
    this.session(binding);
    return this.options.journal.status(binding, executionId);
  }
  async cancel(binding: Binding, executionId: string): Promise<ExecutionRecord> {
    this.session(binding);
    const record = this.options.journal.cancel(binding, executionId);
    this.running.get(executionId)?.controller.abort(new Error('Execution cancelled'));
    return record;
  }
  async ack(binding: Binding, executionId: string, resultDigest: string): Promise<void> {
    this.session(binding);
    this.options.journal.ack(binding, executionId, resultDigest);
  }
  disconnect(): void {
    this.online = false;
  }
  reconnect(): void {
    if (this.faulted) throw new Error('Supervisor recovery required after journal failure');
    this.online = true;
  }
  async close(): Promise<void> {
    this.online = false;
    for (const entry of this.running.values())
      entry.controller.abort(new Error('Executor stopping'));
    await Promise.all([...this.running.values()].map((entry) => entry.completion));
  }
}

/** Direction-specific dispatch; trusted lifecycle, evidence and approval APIs are never accepted here. */
export async function dispatchEnvironment(
  environment: Environment,
  request: EnvironmentMessage,
): Promise<EnvironmentMessage> {
  const header = { version: 1 as const, requestId: request.requestId };
  switch (request.type) {
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
