import { approvalSchema, type EnvironmentApproval } from '../environment/approvals.js';
import { canonicalJson } from '../environment/json.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import { untilCancelled } from './cancellation.js';

/** Presentation/relay only. The authenticated node owns digests, expiry and approval grants.
 * No model or peer ingress can publish an approval or provide the relay callback.
 */
export class GatewayEnvironmentInteractions {
  private readonly pending = new Map<
    string,
    {
      lease: WriterLease;
      approval: EnvironmentApproval;
      relay(approval: EnvironmentApproval, confirmed: boolean): Promise<void>;
      answering: boolean;
    }
  >();
  constructor(private readonly authority: GatewaySessionAuthority) {}
  publish(
    lease: WriterLease,
    parentExecutionId: string,
    value: EnvironmentApproval,
    relay: (approval: EnvironmentApproval, confirmed: boolean) => Promise<void>,
  ): void {
    this.authority.assertWriter(lease);
    const approval = approvalSchema.parse(value),
      intent = this.authority.executionIntent(lease.binding, parentExecutionId);
    if (
      this.authority.executionBranch(intent) !== lease.branchId ||
      canonicalJson(approval.binding, 65536) !== canonicalJson(lease.binding, 65536) ||
      approval.descriptorRevision !== intent.descriptorRevision ||
      approval.policyRevision !== intent.policyRevision ||
      (!approval.innerId && approval.executionId !== parentExecutionId) ||
      (approval.innerId && intent.capability !== 'ptc')
    )
      throw new Error('Node approval binding mismatch');
    const old = this.pending.get(approval.interactionId);
    if (old) {
      if (canonicalJson(old.approval, 65536) !== canonicalJson(approval, 65536))
        throw new Error('Node approval identity conflict');
      return;
    }
    if (this.pending.size >= 128) throw new Error('Node approval quota exceeded');
    this.pending.set(approval.interactionId, { lease, approval, relay, answering: false });
    try {
      const owner = this.authority.sessionOwner(lease.binding.sessionId);
      this.authority.publishClientEvent(lease, {
        type: 'interaction_created',
        data: this.list(lease, owner).find((item) => item.id === approval.interactionId),
      });
    } catch (error) {
      this.pending.delete(approval.interactionId);
      throw error;
    }
  }
  list(lease: WriterLease, owner: string) {
    this.authority.assertOwner(lease.binding.sessionId, owner);
    return [...this.pending.values()]
      .filter(
        (item) =>
          item.lease.binding.sessionId === lease.binding.sessionId &&
          item.lease.branchId === lease.branchId &&
          canonicalJson(item.lease.binding, 65536) === canonicalJson(lease.binding, 65536),
      )
      .map(({ approval }) => ({
        id: approval.interactionId,
        rpcId: approval.interactionId,
        kind: 'confirm',
        status: 'pending',
        runnerEpoch: lease.binding.writerEpoch,
        authority: 'node-environment',
        request: { method: 'confirm', title: approval.title, message: approval.message },
      }));
  }
  async answer(lease: WriterLease, owner: string, id: string, confirmed: boolean): Promise<void> {
    this.authority.assertOwner(lease.binding.sessionId, owner);
    this.authority.assertWriter(lease);
    const item = this.pending.get(id);
    if (!item || item.answering || canonicalJson(item.lease, 65536) !== canonicalJson(lease, 65536))
      throw new Error('Node approval is stale');
    item.answering = true;
    try {
      await item.relay(item.approval, confirmed);
    } finally {
      this.settled(id);
    }
  }
  /** Called on authenticated node settlement/expiry/disconnect. */
  settled(id: string): void {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    try {
      this.authority.publishClientEvent(item.lease, {
        type: 'interaction_answered',
        data: { interactionId: id },
      });
    } catch {
      /* Revoked writers cannot publish. */
    }
  }
  async close(): Promise<void> {
    const pending = [...this.pending.values()];
    this.pending.clear();
    const deadline = AbortSignal.timeout(5000);
    await Promise.allSettled(
      pending.map(async (item) => untilCancelled(item.relay(item.approval, false), deadline)),
    );
  }
}
