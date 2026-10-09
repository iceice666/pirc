import { randomUUID } from 'node:crypto';
import {
  parseGoal,
  startRound,
  atLimit,
  autoPause,
  type Goal,
} from '../agent/features/goal/model.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import { canonicalJson } from '../environment/json.js';
import { CONTROL_BYTES } from '../environment/protocol.js';
/** Goal arming is process-local and never restored implicitly after restart. Durable
 * objective/revision/rounds remain branch inherited in authority custom snapshots.
 */
export class GatewayGoals {
  private readonly armed = new Map<string, { binding: string; branchId: string; goalId: string }>();
  constructor(private readonly authority: GatewaySessionAuthority) {}
  arm(lease: WriterLease) {
    this.authority.assertWriter(lease);
    const owner = this.authority.sessionOwner(lease.binding.sessionId),
      goal = this.state(lease, owner);
    if (goal?.phase === 'active')
      this.armed.set(lease.binding.sessionId, {
        binding: canonicalJson(lease.binding, CONTROL_BYTES),
        branchId: lease.branchId,
        goalId: goal.id,
      });
  }
  isArmed(lease: WriterLease): boolean {
    const entry = this.armed.get(lease.binding.sessionId);
    return (
      entry?.branchId === lease.branchId &&
      entry.binding === canonicalJson(lease.binding, CONTROL_BYTES)
    );
  }
  disarm(sessionId: string) {
    this.armed.delete(sessionId);
  }
  state(lease: WriterLease, owner: string): Goal | null {
    const entry = this.authority
      .customEntries(
        lease.binding.sessionId,
        owner,
        lease.branchId,
        'runtime.feature.goal',
        1,
        true,
      )
      .at(-1);
    return parseGoal(entry?.type === 'custom' ? entry.data : null) ?? null;
  }
  continuation(lease: WriterLease, owner: string): string | undefined {
    this.authority.assertWriter(lease);
    const goal = this.state(lease, owner);
    if (
      !goal ||
      goal.phase !== 'active' ||
      !this.isArmed(lease) ||
      this.armed.get(lease.binding.sessionId)?.goalId !== goal.id
    )
      return;
    if (atLimit(goal)) {
      this.save(lease, autoPause(goal, 'Continuation round limit reached'));
      this.disarm(lease.binding.sessionId);
      return;
    }
    const next = startRound(goal);
    this.save(lease, next);
    return `Goal continuation (agent coordination, not new human instructions):\nObjective: ${next.objective}\nRound ${next.rounds}. Continue toward the objective; complete or report a genuine blocker with update_goal.`;
  }
  private save(lease: WriterLease, goal: Goal) {
    this.authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: 'runtime.feature.goal',
      data: JSON.parse(JSON.stringify(goal)),
    });
  }
}
