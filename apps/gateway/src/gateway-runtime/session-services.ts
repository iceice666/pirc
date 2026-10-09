import type { GatewayAgentRuntime } from './runtime.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import { GatewayServiceDeliveries } from './service-delivery.js';

/** Opt-in schedule/delegation dispatch adapter. Existing scheduler records are never
 * remapped from legacy IDs; caller explicitly creates fresh sessions on the bound node.
 */
export class GatewaySessionServices {
  private readonly deliveries: GatewayServiceDeliveries;
  constructor(
    private readonly options: {
      authority: GatewaySessionAuthority;
      runtime: GatewayAgentRuntime;
      owner: string;
      writer(id: string): WriterLease;
      create(workspaceId: string, title: string): Promise<WriterLease>;
    },
  ) {
    this.deliveries = new GatewayServiceDeliveries({
      authority: options.authority,
      runtime: options.runtime,
    });
  }
  async start(workspaceId: string, title: string) {
    const lease = await this.options.create(workspaceId, title);
    if (lease.binding.workspaceId !== workspaceId)
      throw new Error('Created session workspace mismatch');
    this.options.authority.assertOwner(lease.binding.sessionId, this.options.owner);
    return lease;
  }
  async deliver(
    id: string,
    content: string,
    operationId: string,
    customType = 'service.delivery',
    details: Record<string, unknown> = {},
  ) {
    this.options.authority.assertFreshReference(id);
    const lease = this.options.writer(id);
    if (lease.binding.sessionId !== id) throw new Error('Writer mismatch');
    const input = { runId: operationId, turnId: operationId, text: content, attachments: [] };
    this.deliveries.admit(lease, this.options.owner, input, { customType, content, details });
    return this.deliveries.status(operationId, this.options.owner);
  }
  progress(id: string, runId: string) {
    this.options.authority.assertFreshReference(id);
    return (
      this.options.authority.runState(id, this.options.owner, runId) ??
      this.deliveries.status(runId, this.options.owner) ?? { state: 'unknown' }
    );
  }
  close() {
    return this.deliveries.close();
  }
  cancel(id: string) {
    this.options.authority.assertFreshReference(id);
    this.deliveries.cancel(id, this.options.owner);
    return this.options.runtime.cancel(id, this.options.owner);
  }
}
