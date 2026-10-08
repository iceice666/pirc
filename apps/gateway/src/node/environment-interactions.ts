import type { GatewayDatabase, InteractionRow } from '../database.js';
import type { EventHub } from '../events.js';
import { ApiError } from '../errors.js';
import type { ApprovalAuthority, EnvironmentApproval } from '../environment/approvals.js';
import type { Binding } from '../environment/protocol.js';

/** Harness-only bridge into the existing authenticated session/control-lease UI ingress. */
export class EnvironmentInteractions {
  private records = new Map<
    string,
    { approval: EnvironmentApproval; epoch: number; authority: ApprovalAuthority }
  >();
  private authorities = new Map<ApprovalAuthority, () => void>();
  constructor(
    private readonly db: GatewayDatabase,
    private readonly events: EventHub,
  ) {}
  publish(approval: EnvironmentApproval, epoch: number, authority: ApprovalAuthority): void {
    if (!this.authorities.has(authority))
      this.authorities.set(
        authority,
        authority.onSettled((rpcId) => {
          const record = this.records.get(rpcId);
          if (!record) return;
          this.records.delete(rpcId);
          const cancelled = this.db.cancelInteractionByRpcId(
            record.approval.binding.sessionId,
            record.epoch,
            rpcId,
          );
          if (cancelled)
            this.events.publish(
              record.approval.binding.sessionId,
              record.epoch,
              'interaction_answered',
              { interactionId: cancelled, cancelled: true },
            );
        }),
      );
    if (this.records.size >= 128) throw new Error('Environment interaction quota exceeded');
    const session = this.db.getSession(approval.binding.sessionId);
    const localWorkspace = approval.binding.workspaceId.slice(approval.binding.nodeId.length + 1);
    if (session.workspaceId !== localWorkspace || session.runnerEpoch !== epoch)
      throw new Error('Invalid interaction binding');
    const interaction = this.db.createInteraction(
      session.id,
      epoch,
      approval.interactionId,
      'confirm',
      {
        type: 'extension_ui_request',
        id: approval.interactionId,
        method: 'confirm',
        title: approval.title,
        message: approval.message,
      },
      Date.now() + Math.max(0, approval.expiresAtLocal - performance.now()),
    );
    this.records.set(approval.interactionId, { approval, epoch, authority });
    this.events.publish(session.id, epoch, 'interaction_created', interaction);
  }
  handles(interaction: InteractionRow): boolean {
    return interaction.rpcId.startsWith('node-environment-');
  }
  answer(
    sessionId: string,
    interaction: InteractionRow,
    answer: { confirmed?: boolean; cancelled?: boolean },
  ): void {
    const record = this.records.get(interaction.rpcId);
    if (
      !record ||
      record.approval.binding.sessionId !== sessionId ||
      record.epoch !== interaction.runnerEpoch
    )
      throw new ApiError(409, 'stale_interaction', 'Environment approval is stale');
    // Authority/digest/epochs come solely from the node record, never the UI body.
    if (
      !record.authority.humanAnswer(
        record.approval.binding,
        interaction.rpcId,
        record.approval.finalArgumentDigest,
        answer.confirmed === true,
      )
    )
      throw new ApiError(409, 'stale_interaction', 'Environment approval expired');
    this.records.delete(interaction.rpcId);
  }
  close(): void {
    for (const unsubscribe of this.authorities.values()) unsubscribe();
    this.authorities.clear();
    this.records.clear();
  }
  invalidate(binding: Binding): void {
    for (const [rpcId, record] of this.records)
      if (record.approval.binding.sessionId === binding.sessionId) {
        record.authority.invalidate(binding);
        this.db.cancelInteractionByRpcId(binding.sessionId, record.epoch, rpcId);
        this.records.delete(rpcId);
      }
  }
}
