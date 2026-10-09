import type { CentralCapability } from './capabilities.js';
import type { Team } from '../agent/features/team/team.js';
import type { ExecutionIntent } from '../environment/protocol.js';

/** Explicit product-service adapters. Callers supply owner/project-scoped existing services;
 * this module neither imports legacy sessions nor authorizes cross-workspace operations.
 */
export function productCapabilities(options: {
  team?: Team;
  /** Trusted runtime binding, never a model-supplied caller name. */
  teamMember?: string;
  defaults?: { cwd: string; model: string; thinking?: string };
  search?(
    args: Record<string, unknown>,
    intent: ExecutionIntent,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  memorySearch?(
    args: Record<string, unknown>,
    intent: ExecutionIntent,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  recall?(
    args: Record<string, unknown>,
    intent: ExecutionIntent,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  askUser?(
    args: Record<string, unknown>,
    intent: ExecutionIntent,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  /** Database-covered mutations must use the supplied central transaction, not legacy handler DBs. */
  mutations?: ReadonlyMap<string, NonNullable<CentralCapability['mutate']>>;
}): ReadonlyMap<string, CentralCapability> {
  const handlers = new Map<string, CentralCapability>();
  for (const [name, fn] of [
    ['web_search', options.search],
    ['memory_search', options.memorySearch],
    ['recall', options.recall],
    ['ask_user_question', options.askUser],
  ] as const)
    if (fn) handlers.set(name, { execute: fn });
  for (const [name, mutate] of options.mutations ?? []) handlers.set(name, { mutate });
  if (options.team) {
    const team = options.team;
    for (const name of [
      'agent_list',
      'agent_inbox',
      'agent_wait',
      'agent_send',
      'agent_ask',
      'agent_reply',
      'agent_stop',
      'board_read',
      'board_post',
      'task_list',
      'task_get',
      'task_create',
      'task_update',
    ])
      handlers.set(name, {
        execute: async (args, _intent, signal) => {
          const value = await team.call(options.teamMember ?? 'parent', name, args, signal);
          return {
            text: JSON.stringify(value),
            ...(value && typeof value === 'object' ? value : { value }),
          };
        },
      });
    if (options.defaults && (!options.teamMember || options.teamMember === 'parent')) {
      handlers.set('agent_spawn', {
        execute: async (args, _intent, signal) => {
          const value = await team.spawn(args, options.defaults!, signal);
          return { text: JSON.stringify(value), ...value };
        },
      });
      handlers.set('subagent', {
        execute: async (args, _intent, signal) => {
          const value = await team.subagent(args, options.defaults!, {
            background: args.background === true,
            signal,
          });
          return { text: JSON.stringify(value), ...value };
        },
      });
    }
  }
  return handlers;
}
