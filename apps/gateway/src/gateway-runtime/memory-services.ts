import { MemoryStore, type MemoryBudgets, type MemoryAction } from '../daemon/memory.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { CentralCapability } from './capabilities.js';
import type { ExecutionIntent } from '../environment/protocol.js';

/** Reuses existing central memory tables on the operation transaction connection.
 * Caller installs the authority on GatewayDatabase.raw; unrelated records are retained.
 * USER proposals require authoritative quoted user evidence, never tool/peer text.
 */
export function memoryCapabilities(options: {
  authority: GatewaySessionAuthority;
  owner(intent: ExecutionIntent): string;
  budgets: MemoryBudgets;
  chat(intent: ExecutionIntent): boolean;
}): ReadonlyMap<string, CentralCapability> {
  const owner = (intent: ExecutionIntent) => {
    if (!options.chat(intent)) throw new Error('Only chat sessions have assistant memory');
    const user = options.owner(intent);
    options.authority.assertOwner(intent.binding.sessionId, user);
    return user;
  };
  return new Map<string, CentralCapability>([
    [
      'memory_note',
      {
        mutate: (db, args, intent) => {
          if (db !== options.authority.inner.operations.db)
            throw new Error('Memory mutation requires shared authority transaction');
          const user = owner(intent),
            memory = new MemoryStore(db, options.budgets);
          const result = memory.writeNote(
            user,
            {
              action: args.action as MemoryAction,
              ...(typeof args.id === 'string' ? { id: args.id } : {}),
              ...(typeof args.content === 'string' ? { content: args.content } : {}),
              ...(typeof args.baseRevision === 'number' || args.baseRevision === null
                ? { baseRevision: args.baseRevision }
                : {}),
            },
            {
              actor: `session:${intent.binding.sessionId}`,
              origins: ['assistant', `tool:${intent.capability}`],
              sources: { sessionId: intent.binding.sessionId },
            },
          );
          return {
            text: JSON.stringify(result),
            id: result.entry.id,
            revision: result.entry.revision,
            status: result.entry.status,
            unchanged: result.unchanged,
            usage: memory.usage(user).note,
          };
        },
      },
    ],
    [
      'memory_propose_user',
      {
        mutate: (db, args, intent) => {
          if (db !== options.authority.inner.operations.db)
            throw new Error('Memory mutation requires shared authority transaction');
          const user = owner(intent),
            memory = new MemoryStore(db, options.budgets);
          if (typeof args.quote !== 'string' || !args.quote.trim())
            throw new Error('User quote required');
          const ids =
            Array.isArray(args.entryIds) && args.entryIds.every((id) => typeof id === 'string')
              ? (args.entryIds as string[])
              : [];
          const evidence = options.authority.userEvidence(
            intent.binding.sessionId,
            user,
            ids,
            args.quote,
          );
          if (!evidence.length) throw new Error('Quote is not authoritative user evidence');
          const result = memory.propose(
            user,
            intent.binding.sessionId,
            {
              action: args.action as MemoryAction,
              quote: args.quote,
              ...(typeof args.id === 'string' ? { id: args.id } : {}),
              ...(typeof args.content === 'string' ? { content: args.content } : {}),
              ...(typeof args.baseRevision === 'number' || args.baseRevision === null
                ? { baseRevision: args.baseRevision }
                : {}),
            },
            {
              sessionId: intent.binding.sessionId,
              entryIds: evidence,
              quote: args.quote,
            },
          );
          return {
            text: 'Proposed USER change; it remains pending human approval.',
            proposalId: result.proposal.id,
            duplicate: result.duplicate,
          };
        },
      },
    ],
  ]);
}
