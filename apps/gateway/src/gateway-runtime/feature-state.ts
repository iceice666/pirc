import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import { randomUUID } from 'node:crypto';

/** Fresh authority feature reader. Legacy session IDs remain unavailable through authority.
 * File-backed workspace materialization is deliberately not performed on the gateway.
 */
export class GatewayFeatureState {
  constructor(
    private readonly authority: GatewaySessionAuthority,
    private readonly lease: () => WriterLease,
    private readonly owner: string,
  ) {}
  entries(customType: string) {
    const lease = this.lease();
    return this.authority.customEntries(
      lease.binding.sessionId,
      this.owner,
      lease.branchId,
      customType,
    );
  }
  append(customType: string, data: unknown) {
    const lease = this.lease();
    return this.authority.append(lease, randomUUID(), {
      type: 'custom',
      customType,
      data: JSON.parse(JSON.stringify(data)),
    });
  }
  recall(sessionId: string, entryIds: readonly string[], branchId?: string) {
    if (entryIds.length > 64) throw new Error('Recall entry quota exceeded');
    this.authority.assertFreshReference(sessionId);
    this.authority.assertOwner(sessionId, this.owner);
    // Owner alone is insufficient: evidence must remain in this bound workspace.
    const source = this.authority.pending(sessionId).binding,
      target = this.lease().binding;
    if (source.workspaceId !== target.workspaceId || source.nodeId !== target.nodeId)
      throw new Error('Recall workspace mismatch');
    return this.authority.recallEntries(
      sessionId,
      this.owner,
      branchId ?? this.authority.identities(sessionId, this.owner).branchId,
      entryIds,
    );
  }
}
