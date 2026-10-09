import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import type { Question, QuestionResult } from '../agent/features/ask-question.js';
import { userQuestion } from '../agent/features/team/team.js';

/** General questions, not node execution approvals. Human ingress must separately
 * authenticate owner/control before calling answer; peer responses never enter here.
 */
export class GatewayInteractions {
  private readonly waiters = new Set<{ sessionId: string; listener: (waiting: boolean) => void }>();
  onHumanWait(sessionId: string, listener: (waiting: boolean) => void): () => void {
    const entry = { sessionId, listener };
    this.waiters.add(entry);
    listener(
      [...this.pending.values()].some((value) => value.lease.binding.sessionId === sessionId),
    );
    return () => this.waiters.delete(entry);
  }
  private readonly pending = new Map<
    string,
    {
      lease: WriterLease;
      owner: string;
      question: Question;
      resolve(value: QuestionResult): void;
      cleanup(): void;
    }
  >();
  constructor(private readonly authority: GatewaySessionAuthority) {}
  ask(
    lease: WriterLease,
    owner: string,
    value: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<QuestionResult> {
    this.authority.assertOwner(lease.binding.sessionId, owner);
    this.authority.assertWriter(lease);
    signal.throwIfAborted();
    if (this.pending.size >= 128) throw new Error('Question quota exceeded');
    const question = userQuestion(value),
      id = `gateway-question-${randomUUID()}`;
    this.authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: 'runtime.interaction.created',
      data: JSON.parse(JSON.stringify({ id, type: 'question', question })),
    });
    return new Promise((resolve) => {
      const abort = () => this.settle(id, { status: 'cancelled', answers: [] });
      const timer = setTimeout(abort, 30 * 60_000);
      this.pending.set(id, {
        lease,
        owner,
        question,
        resolve,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        },
      });
      for (const entry of this.waiters)
        if (entry.sessionId === lease.binding.sessionId) entry.listener(true);
      const projection = this.list(lease.binding.sessionId, owner).find((item) => item.id === id)!;
      try {
        this.authority.publishClientEvent(lease, { type: 'interaction_created', data: projection });
      } catch (error) {
        this.settle(id, { status: 'cancelled', answers: [] });
        throw error;
      }
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  answer(lease: WriterLease, owner: string, id: string, value: unknown): void {
    this.authority.assertOwner(lease.binding.sessionId, owner);
    this.authority.assertWriter(lease);
    const pending = this.pending.get(id);
    if (
      !pending ||
      pending.owner !== owner ||
      pending.lease.binding.sessionId !== lease.binding.sessionId ||
      pending.lease.binding.writerEpoch !== lease.binding.writerEpoch ||
      pending.lease.branchId !== lease.branchId
    )
      throw new Error('Question is stale');
    const result = z
      .object({
        cancelled: z.boolean().optional(),
        selected: z.array(z.string().max(1000)).max(12).optional(),
        custom: z.string().max(4000).optional(),
      })
      .strict()
      .parse(value);
    const selected = result.selected ?? [];
    const choices = new Set((pending.question.options ?? []).map((option) => option.label));
    if (
      selected.some((label) => !choices.has(label)) ||
      new Set(selected).size !== selected.length ||
      (!pending.question.multiSelect && selected.length > 1)
    )
      throw new Error('Invalid question selection');
    this.settle(
      id,
      result.cancelled
        ? { status: 'cancelled', answers: [] }
        : {
            status: 'answered',
            answers: [
              { question: pending.question.question, selected, customText: result.custom ?? '' },
            ],
          },
    );
  }
  private settle(id: string, result: QuestionResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    try {
      this.authority.append(pending.lease, randomUUID(), {
        type: 'custom',
        customType: 'runtime.interaction.answered',
        data: JSON.parse(JSON.stringify({ id, result })),
      });
    } catch {
      // A failed durable append cannot manufacture a human-origin answer.
      result = { status: 'cancelled', answers: [] };
    } finally {
      try {
        this.authority.publishClientEvent(pending.lease, {
          type: 'interaction_answered',
          data: { interactionId: id },
        });
      } catch {
        /* Revoked writers cannot publish. */
      }
      this.pending.delete(id);
      pending.cleanup();
      pending.resolve(result);
      for (const entry of this.waiters)
        if (
          entry.sessionId === pending.lease.binding.sessionId &&
          ![...this.pending.values()].some(
            (value) => value.lease.binding.sessionId === entry.sessionId,
          )
        )
          entry.listener(false);
    }
  }
  list(sessionId: string, owner: string) {
    this.authority.assertOwner(sessionId, owner);
    const branchId = this.authority.identities(sessionId, owner).branchId;
    return [...this.pending]
      .filter(
        ([, entry]) =>
          entry.lease.binding.sessionId === sessionId &&
          entry.owner === owner &&
          entry.lease.branchId === branchId,
      )
      .map(([id, entry]) => ({
        id,
        type: 'question',
        question: entry.question,
        kind: entry.question.options?.length ? 'select' : 'input',
        status: 'pending',
        runnerEpoch: entry.lease.binding.writerEpoch,
        request: {
          method: entry.question.options?.length ? 'select' : 'input',
          title: entry.question.header ?? entry.question.question,
          message: entry.question.question,
          ...(entry.question.options
            ? {
                options: entry.question.options.map((option) => option.label),
                optionDescriptions: entry.question.options.map(
                  (option) => option.description ?? '',
                ),
                multiple: entry.question.multiSelect === true,
              }
            : {}),
        },
        authority: 'gateway-general-question',
      }));
  }
  close() {
    for (const id of [...this.pending.keys()])
      this.settle(id, { status: 'cancelled', answers: [] });
  }
}
