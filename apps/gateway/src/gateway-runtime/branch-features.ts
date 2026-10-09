import { randomUUID } from 'node:crypto';
import { applyAction, emptyState, parseState, type Action } from '../agent/features/todo/model.js';
import {
  createGoal,
  applyUpdate,
  isOpen,
  parseGoal,
  type GoalUpdate,
} from '../agent/features/goal/model.js';
import type { CentralCapability } from './capabilities.js';
import type { ExecutionIntent } from '../environment/protocol.js';
import { canonicalJson, parseJson } from '../environment/json.js';
import type { Database } from 'bun:sqlite';
import type { GatewaySessionAuthority } from './authority.js';

/** Small branch state uses the same central transaction as the operation result. The
 * owner callback resolves authoritative branch identity; no branch ID is model input.
 */
export function branchFeatures(
  branch: (intent: ExecutionIntent) => string,
  humanRun?: (intent: ExecutionIntent) => boolean,
  authority?: GatewaySessionAuthority,
  goals?: import('./goals.js').GatewayGoals,
): ReadonlyMap<string, CentralCapability> {
  const read = (db: Database, intent: ExecutionIntent, name: string): unknown => {
    if (authority) return authority.featureState(intent, name);
    db.exec(
      'CREATE TABLE IF NOT EXISTS runtime_feature_state(session TEXT NOT NULL,branch TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session,branch,name));',
    );
    const row = db
      .query('SELECT payload FROM runtime_feature_state WHERE session=? AND branch=? AND name=?')
      .get(intent.binding.sessionId, branch(intent), name) as { payload: string } | null;
    return row ? parseJson(row.payload, 1024 * 1024) : undefined;
  };
  const save = (db: Database, intent: ExecutionIntent, name: string, state: unknown) => {
    if (authority) {
      authority.saveFeatureState(db, intent, name, state);
      return;
    }
    db.query('INSERT OR REPLACE INTO runtime_feature_state VALUES (?,?,?,?)').run(
      intent.binding.sessionId,
      branch(intent),
      name,
      canonicalJson(state, 1024 * 1024),
    );
  };
  return new Map<string, CentralCapability>([
    [
      'todo',
      {
        mutate: (db, args, intent) => {
          const current = parseState(read(db, intent, 'todo')) ?? emptyState();
          const next = applyAction(current, args as unknown as Action);
          save(db, intent, 'todo', next);
          return { text: JSON.stringify(next), action: args.action, todos: next.todos };
        },
      },
    ],
    [
      'get_goal',
      {
        mutate: (db, _args, intent) => {
          const goal = read(db, intent, 'goal') ?? null;
          return { text: JSON.stringify(goal), goal };
        },
      },
    ],
    [
      'create_goal',
      {
        committed: (intent) => goals?.arm({ binding: intent.binding, branchId: branch(intent) }),
        mutate: (db, args, intent) => {
          if (!humanRun?.(intent)) throw new Error('Goal changes require a human-origin run');
          const previous = parseGoal(read(db, intent, 'goal'));
          if (isOpen(previous ?? null)) throw new Error('An open goal already exists');
          const goal = createGoal(
            randomUUID(),
            String(args.objective ?? ''),
            args.max_goal_rounds as number | undefined,
          );
          save(db, intent, 'goal', goal);
          return { text: JSON.stringify(goal), goal };
        },
      },
    ],
    [
      'update_goal',
      {
        committed: (intent, args) => {
          if (args.action === 'resume')
            goals?.arm({ binding: intent.binding, branchId: branch(intent) });
          if (args.action === 'pause' || args.action === 'complete' || args.action === 'blocked')
            goals?.disarm(intent.binding.sessionId);
        },
        mutate: (db, args, intent) => {
          const current = parseGoal(read(db, intent, 'goal'));
          if (!current) throw new Error('No goal');
          if (args.goal_id !== current.id || args.revision !== current.revision)
            throw new Error('Stale goal reference');
          if (['edit', 'pause', 'resume'].includes(String(args.action)) && !humanRun?.(intent))
            throw new Error('Goal changes require a human-origin run');
          if (
            args.action !== 'edit' &&
            (args.objective !== undefined || args.max_goal_rounds !== undefined)
          )
            throw new Error('Objective/round limit requires edit');
          if (args.action !== 'blocked' && args.blocked_reason !== undefined)
            throw new Error('Blocked reason requires blocked action');
          const goal =
            args.action === 'resume' &&
            current.phase === 'active' &&
            !goals?.isArmed({ binding: intent.binding, branchId: branch(intent) })
              ? current
              : applyUpdate(
                  current,
                  {
                    action: args.action as GoalUpdate['action'],
                    ...(args.objective === undefined ? {} : { objective: String(args.objective) }),
                    ...(args.max_goal_rounds === undefined
                      ? {}
                      : { maxRounds: Number(args.max_goal_rounds) }),
                    ...(args.blocked_reason === undefined
                      ? {}
                      : { blockedReason: String(args.blocked_reason) }),
                  },
                  { minBlockedRounds: 1 },
                );
          save(db, intent, 'goal', goal);
          return { text: JSON.stringify(goal), goal };
        },
      },
    ],
  ]);
}
