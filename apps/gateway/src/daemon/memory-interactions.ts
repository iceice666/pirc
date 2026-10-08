/** Durable confirmations projected from memory_proposals, never node RPC state. */
import type { GatewayDatabase } from '../database.js';
import { ApiError } from '../errors.js';
import type { EventHub } from '../events.js';
import type { MemoryProposal, MemoryStore } from './memory.js';

export class MemoryInteractions {
  private readonly known = new Map<string, Map<string, ReturnType<MemoryInteractions['card']>>>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly memory: MemoryStore,
    private readonly events: EventHub,
  ) {
    for (const row of db.raw
      .query("SELECT DISTINCT owner_user FROM memory_proposals WHERE status='pending'")
      .all() as { owner_user: string }[])
      this.known.set(row.owner_user, this.cards(row.owner_user));
  }

  private card(user: string, proposal: MemoryProposal) {
    const target = proposal.targetId ? this.memory.entry(user, proposal.targetId) : undefined;
    // Bind the answer to precisely the target version displayed, including after reconnect.
    const id = `memory:${proposal.id}:${target?.revision ?? 0}`;
    return {
      id,
      rpcId: id,
      sessionId: proposal.sessionId,
      runnerEpoch: 0,
      kind: 'confirm',
      status: 'pending',
      expiresAt: null,
      createdAt: proposal.createdAt,
      request: {
        method: 'confirm',
        title: `${{ add: 'Add', replace: 'Replace', remove: 'Remove' }[proposal.action]} USER memory?`,
        message: [
          target ? `Current memory (${target.id}):\n${target.content || '(forgotten)'}` : '',
          proposal.content ? `Proposed memory:\n${proposal.content}` : '',
          `Your words:\n“${proposal.quote}”`,
          'Your decision is saved immediately. The assistant will see it on its next turn.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        confirmLabel: 'Approve',
        cancelLabel: 'Reject',
      },
    };
  }

  private cards(user: string) {
    return new Map(
      this.memory.proposals(user, 'pending').map((p) => {
        const card = this.card(user, p);
        return [card.id, card];
      }),
    );
  }

  pendingInteractions(sessionId: string, user: string) {
    return [...this.cards(user).values()].filter((card) => card.sessionId === sessionId);
  }

  changed(user: string) {
    const before = this.known.get(user) ?? new Map();
    const after = this.cards(user);
    this.known.set(user, after);
    const publish = (sessionId: string, type: string, data: unknown) => {
      const session = this.db
        .listSessions()
        .find((s) => s.id === sessionId && s.ownerUser === user);
      if (session) this.events.publish(sessionId, session.runnerEpoch, type, data);
    };
    for (const [id, card] of before)
      if (!after.has(id)) publish(card.sessionId, 'interaction_answered', { interactionId: id });
    for (const [id, card] of after)
      if (!before.has(id)) publish(card.sessionId, 'interaction_created', card);
  }

  answer(sessionId: string, interactionId: string, user: string, answer: unknown) {
    if (!interactionId.startsWith('memory:')) return undefined;
    const card = this.pendingInteractions(sessionId, user).find((c) => c.id === interactionId);
    if (!card)
      throw new ApiError(
        409,
        'stale_interaction',
        'This memory proposal changed or was already answered. Refresh the chat before deciding.',
      );
    const confirmed = (answer as { confirmed?: unknown } | null)?.confirmed;
    if (typeof confirmed !== 'boolean')
      throw new ApiError(400, 'invalid_input', 'A memory decision must be Approve or Reject');
    const [, proposalId, revision] = interactionId.split(':');
    if (confirmed) this.memory.approve(user, proposalId!, Number(revision) || undefined);
    else this.memory.reject(user, proposalId!);
    return { interactionId, status: 'answered' };
  }
}
