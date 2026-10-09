import { createHash } from 'node:crypto';
import type { Descriptor, Environment, ExecutionIntent } from '../environment/protocol.js';
import { intentDigest } from '../environment/protocol.js';
import type { WriterLease } from './contracts.js';
import type { TurnInput } from './turn-contracts.js';
import type { GatewaySessionAuthority } from './authority.js';
import { untilCancelled } from './cancellation.js';

/** Stable phase identities avoid replay of node hook shells after a gateway retry.
 * Nodes independently journal hooks through the same sandbox executor admission.
 */
export class GatewayLifecycleHooks {
  constructor(
    private readonly environment: Environment,
    private readonly authority?: GatewaySessionAuthority,
  ) {}
  async run(
    lease: WriterLease,
    input: TurnInput,
    descriptor: Descriptor,
    phase: 'sessionStart' | 'beforePrompt' | 'agentSettled',
    signal: AbortSignal,
  ): Promise<string> {
    if (!descriptor.lifecycleHooks?.includes(phase)) return '';
    const bytes = createHash('sha256')
      .update(
        `${lease.binding.sessionId}:${lease.binding.writerEpoch}:${phase}:${phase === 'sessionStart' ? 'session' : input.turnId}`,
      )
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 0x50;
    bytes[8] = (bytes[8]! & 63) | 128;
    const h = bytes.toString('hex');
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    const stable = phase === 'sessionStart' ? id : input.runId;
    const value = {
      binding: lease.binding,
      executionId: id,
      runId: stable,
      turnId: phase === 'sessionStart' ? id : input.turnId,
      toolCallId: id,
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      capability: `lifecycle.${phase}`,
      arguments: phase === 'beforePrompt' ? { prompt: input.text } : {},
      budgetMs: Math.min(descriptor.limits.maxBudgetMs, 120_000),
    };
    const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
    signal.throwIfAborted();
    this.authority?.persistLifecycle(lease, intent, descriptor);
    const cancellation = AbortSignal.any([signal, AbortSignal.timeout(intent.budgetMs + 5000)]);
    const cancel = () => {
      void this.environment.cancel(lease.binding, id).catch(() => {});
    };
    cancellation.addEventListener('abort', cancel, { once: true });
    try {
      cancellation.throwIfAborted();
      let record =
        this.authority?.lifecycleReceipt(lease.binding, id) ??
        (await untilCancelled(this.environment.start(intent), cancellation));
      while (!record.terminal) {
        await untilCancelled(Bun.sleep(20), cancellation);
        record = await untilCancelled(this.environment.status(lease.binding, id), cancellation);
      }
      this.authority?.commitLifecycle(record);
      try {
        await this.environment.ack(lease.binding, id, record.resultDigest!);
        this.authority?.markLifecycleAck(lease.binding, id);
      } catch {}
      if (record.state !== 'completed')
        throw new Error(`Lifecycle hook ${phase} unavailable; reconcile original phase`);
      const output = record.terminal.output as { text?: unknown } | undefined;
      if (typeof output?.text !== 'string' || Buffer.byteLength(output.text) > 512 * 1024)
        throw new Error('Invalid lifecycle hook output');
      return output.text;
    } finally {
      cancellation.removeEventListener('abort', cancel);
    }
  }
}
