import { randomUUID } from 'node:crypto';
import { canonicalJson } from './json.js';
import { ExecutionJournal } from './journal.js';
import type { CentralLink } from './central-link.js';
import type { ArtifactReference } from './artifact-transfer.js';
import {
  CONTROL_BYTES,
  validateIntent,
  type Binding,
  type Descriptor,
  type Environment,
  type EnvironmentMessage,
  type ExecutionEvent,
  type ExecutionIntent,
  type ExecutionRecord,
} from './protocol.js';

/** Gateway adapter: supplied bindings come from trusted service state, never model input. */
export class RemoteEnvironment implements Environment {
  private pending = new Map<
    string,
    {
      resolve(message: EnvironmentMessage): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private online = true;
  private starting = new Map<string, Promise<ExecutionRecord>>();
  constructor(
    private readonly options: {
      nodeId: string;
      journal: ExecutionJournal;
      authorize(binding: Binding): void;
      send(message: EnvironmentMessage): Promise<void>;
      event?(event: ExecutionEvent): Promise<void>;
      timeoutMs?: number;
      central?: CentralLink;
    },
  ) {}
  private authorize(binding: Binding): void {
    if (binding.nodeId !== this.options.nodeId) throw new Error('Invalid transport node binding');
    this.options.authorize(binding);
  }
  private async request(message: EnvironmentMessage): Promise<EnvironmentMessage> {
    if (!this.online) throw new Error('Node offline; outcome may be unknown');
    if (this.pending.size >= 128) throw new Error('Environment request quota exceeded');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(
          new Error('Environment request timed out; query original execution, do not restart'),
        );
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(message.requestId, { resolve, reject, timer });
      this.options.send(message).catch((error) => {
        const request = this.pending.get(message.requestId);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.requestId);
        reject(error);
      });
    });
  }
  /** Called only by the authenticated node subchannel after strict wire decoding. */
  async receive(message: EnvironmentMessage): Promise<void> {
    if (!this.online) return;
    if (await this.options.central?.receive(message)) return;
    if (message.type === 'execution.event') {
      this.authorize(message.event.binding);
      await this.options.event?.(message.event);
      return;
    }
    if (message.type === 'execution.result' || message.type === 'execution.reply') {
      this.authorize(message.record.binding);
      if (message.record.terminal)
        this.options.journal.receiveResult(message.record.binding, message.record);
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.type === 'environment.error')
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else pending.resolve(message);
  }
  disconnect(): void {
    this.online = false;
    this.options.central?.disconnect();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Node offline; query original execution on reconnect'));
    }
    this.pending.clear();
  }
  reconnect(): void {
    this.options.central?.reconnect();
    this.online = true;
  }
  async describe(binding: Binding): Promise<Descriptor> {
    this.authorize(binding);
    const reply = await this.request({
      version: 1,
      requestId: randomUUID(),
      type: 'environment.describe',
      binding,
    });
    if (
      reply.type !== 'environment.descriptor' ||
      canonicalJson(reply.descriptor.binding, CONTROL_BYTES) !==
        canonicalJson(binding, CONTROL_BYTES)
    )
      throw new Error('Unexpected descriptor reply');
    return reply.descriptor;
  }
  async workspaceSnapshot(binding: Binding) {
    this.authorize(binding);
    const reply = await this.request({
      version: 1,
      requestId: randomUUID(),
      type: 'workspace.snapshot',
      binding,
    });
    if (
      reply.type !== 'workspace.snapshot.result' ||
      canonicalJson(reply.binding, CONTROL_BYTES) !== canonicalJson(binding, CONTROL_BYTES)
    )
      throw new Error('Workspace snapshot reply mismatch');
    return { repositoryKey: reply.repositoryKey, items: reply.items };
  }
  async workspaceAppend(binding: Binding, input: Record<string, unknown>) {
    this.authorize(binding);
    const reply = await this.request({
      version: 1,
      requestId: randomUUID(),
      type: 'workspace.append',
      binding,
      input: JSON.parse(canonicalJson(input, 1024 * 1024)),
    });
    if (
      reply.type !== 'workspace.append.result' ||
      canonicalJson(reply.binding, CONTROL_BYTES) !== canonicalJson(binding, CONTROL_BYTES)
    )
      throw new Error('Workspace append reply mismatch');
    return reply.item;
  }
  private result(
    reply: EnvironmentMessage,
    binding: Binding,
    executionId: string,
  ): ExecutionRecord {
    if (
      (reply.type !== 'execution.reply' && reply.type !== 'execution.result') ||
      reply.record.executionId !== executionId ||
      canonicalJson(reply.record.binding, CONTROL_BYTES) !== canonicalJson(binding, CONTROL_BYTES)
    )
      throw new Error('Unexpected execution reply');
    return reply.record;
  }
  async start(intent: ExecutionIntent): Promise<ExecutionRecord> {
    intent = validateIntent(structuredClone(intent));
    this.authorize(intent.binding);
    if (!this.online) throw new Error('Node offline');
    this.options.journal.persistIntent(intent);
    const pending = this.request({
      version: 1,
      requestId: randomUUID(),
      type: 'execution.start',
      intent,
    }).then((reply) => this.result(reply, intent.binding, intent.executionId));
    this.starting.set(intent.executionId, pending);
    try {
      return await pending;
    } finally {
      if (this.starting.get(intent.executionId) === pending)
        this.starting.delete(intent.executionId);
    }
  }
  async status(binding: Binding, executionId: string): Promise<ExecutionRecord> {
    this.authorize(binding);
    return this.result(
      await this.request({
        version: 1,
        requestId: randomUUID(),
        type: 'execution.status',
        binding,
        executionId,
      }),
      binding,
      executionId,
    );
  }
  async cancel(binding: Binding, executionId: string): Promise<ExecutionRecord> {
    this.authorize(binding);
    // Control may overtake data chunks; await our start's durable admission.
    // Unknown/offline admission rejects instead of promising cancellation.
    await this.starting.get(executionId);
    return this.result(
      await this.request({
        version: 1,
        requestId: randomUUID(),
        type: 'execution.cancel',
        binding,
        executionId,
      }),
      binding,
      executionId,
    );
  }
  async pinArtifact(binding: Binding, artifact: ArtifactReference): Promise<void> {
    this.authorize(binding);
    const reply = await this.request({
      version: 1,
      requestId: randomUUID(),
      type: 'artifact.pin',
      binding,
      artifact,
    });
    if (reply.type !== 'artifact.pinned') throw new Error('Invalid artifact pin reply');
  }
  async fetchArtifact(
    binding: Binding,
    artifact: ArtifactReference,
    offset: number,
    limit: number,
  ): Promise<{ offset: number; data: string }> {
    this.authorize(binding);
    const reply = await this.request({
      version: 1,
      requestId: randomUUID(),
      type: 'artifact.fetch',
      binding,
      artifact,
      offset,
      limit,
    });
    if (reply.type !== 'artifact.chunk' || reply.offset !== offset)
      throw new Error('Invalid artifact reply');
    return { offset: reply.offset, data: reply.data };
  }
  /** Explicit caller decision AFTER its durable completion sink; never automatic on receipt. */
  async ack(binding: Binding, executionId: string, resultDigest: string): Promise<void> {
    this.authorize(binding);
    if (this.options.journal.receipt(binding, executionId)?.resultDigest !== resultDigest)
      throw new Error('No matching durable receipt');
    const reply = await this.request({
      version: 1,
      requestId: randomUUID(),
      type: 'execution.ack',
      binding,
      executionId,
      resultDigest,
    });
    if (reply.type !== 'execution.acknowledged') throw new Error('Unexpected ACK reply');
  }
}
