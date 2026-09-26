/**
 * Pure goal state: one persisted completion objective per session, advanced
 * by automatic continuation rounds until it is completed, blocked or paused.
 */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

export interface Goal {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  /** Automatic continuation rounds started so far. */
  rounds: number;
  maxRounds?: number;
  /** Why the goal is blocked (phase `blocked`). */
  blockedReason?: string;
  /** Why the goal was paused automatically (abort, error, round limit). */
  pausedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export type GoalAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked';

export interface GoalUpdate {
  action: GoalAction;
  objective?: string;
  maxRounds?: number;
  blockedReason?: string;
}

export const MAX_OBJECTIVE = 4000;
export const MAX_REASON = 2000;

const clean = (text: string) => text.replace(/\r\n?/g, '\n').trim();

export function validMaxRounds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('max_goal_rounds must be a positive safe integer');
  return value;
}

export function validObjective(value: unknown): string {
  const text = typeof value === 'string' ? clean(value) : '';
  if (!text) throw new Error('objective must be a non-empty string');
  if (text.length > MAX_OBJECTIVE)
    throw new Error(`objective must be at most ${MAX_OBJECTIVE} characters`);
  return text;
}

export function createGoal(
  id: string,
  objective: string,
  maxRounds: number | undefined,
  now = Date.now(),
): Goal {
  const limit = validMaxRounds(maxRounds);
  return {
    id,
    revision: 1,
    objective: validObjective(objective),
    phase: 'active',
    rounds: 0,
    ...(limit === undefined ? {} : { maxRounds: limit }),
    createdAt: now,
    updatedAt: now,
  };
}

/** A goal that still needs work; a new one may not replace it. */
export const isOpen = (goal: Goal | null): goal is Goal =>
  !!goal && (goal.phase === 'active' || goal.phase === 'paused');

export const atLimit = (goal: Goal) =>
  goal.maxRounds !== undefined && goal.rounds >= goal.maxRounds;

function next(goal: Goal, patch: Partial<Goal>, now: number): Goal {
  const out: Goal = { ...goal, ...patch, revision: goal.revision + 1, updatedAt: now };
  if (out.phase !== 'blocked') delete out.blockedReason;
  if (out.phase !== 'paused') delete out.pausedReason;
  for (const key of Object.keys(out) as Array<keyof Goal>)
    if (out[key] === undefined) delete out[key];
  return out;
}

/** Apply an update; throws with a model-readable reason when it is not allowed. */
export function applyUpdate(
  goal: Goal,
  update: GoalUpdate,
  options: { minBlockedRounds: number; now?: number },
): Goal {
  const now = options.now ?? Date.now();
  switch (update.action) {
    case 'edit': {
      if (update.objective === undefined && update.maxRounds === undefined)
        throw new Error('edit needs objective and/or max_goal_rounds');
      const patch: Partial<Goal> = {};
      if (update.objective !== undefined) patch.objective = validObjective(update.objective);
      const limit = validMaxRounds(update.maxRounds);
      if (limit !== undefined) patch.maxRounds = limit;
      return next(goal, patch, now);
    }
    case 'pause':
      if (goal.phase !== 'active') throw new Error(`Cannot pause a ${goal.phase} goal`);
      return next(goal, { phase: 'paused' }, now);
    case 'resume': {
      if (goal.phase === 'active') throw new Error('The goal is already active');
      if (goal.phase === 'complete') throw new Error('Cannot resume a completed goal');
      if (atLimit(goal))
        throw new Error(
          `The goal used all ${goal.maxRounds} continuation rounds; raise max_goal_rounds with edit first`,
        );
      return next(goal, { phase: 'active' }, now);
    }
    case 'complete':
      if (goal.phase === 'complete') throw new Error('The goal is already complete');
      return next(goal, { phase: 'complete' }, now);
    case 'blocked': {
      if (goal.phase !== 'active') throw new Error(`Cannot block a ${goal.phase} goal`);
      const reason = clean(update.blockedReason ?? '');
      if (!reason) throw new Error('blocked needs blocked_reason');
      if (goal.rounds < options.minBlockedRounds)
        throw new Error(
          `blocked is rejected before ${options.minBlockedRounds} continuation rounds (${goal.rounds} so far); keep working or report the blocker`,
        );
      return next(goal, { phase: 'blocked', blockedReason: reason.slice(0, MAX_REASON) }, now);
    }
  }
}

/** Automatic transitions (round started, auto-pause). */
export const startRound = (goal: Goal, now = Date.now()): Goal =>
  next(goal, { rounds: goal.rounds + 1 }, now);

export const autoPause = (goal: Goal, reason: string, now = Date.now()): Goal => ({
  ...next(goal, { phase: 'paused' }, now),
  pausedReason: reason,
});

export function parseGoal(value: unknown): Goal | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const goal = value as Goal;
  if (
    typeof goal.id !== 'string' ||
    typeof goal.objective !== 'string' ||
    !Number.isSafeInteger(goal.revision) ||
    !Number.isSafeInteger(goal.rounds) ||
    !['active', 'paused', 'blocked', 'complete'].includes(goal.phase)
  )
    return undefined;
  return goal;
}

export function formatGoal(goal: Goal | null): string {
  if (!goal) return 'No goal.';
  const lines = [
    `Goal ${goal.id} (revision ${goal.revision}) — ${goal.phase}`,
    `Objective: ${goal.objective}`,
    `Continuation rounds: ${goal.rounds}${goal.maxRounds === undefined ? '' : ` / ${goal.maxRounds}`}`,
  ];
  if (goal.blockedReason) lines.push(`Blocked: ${goal.blockedReason}`);
  if (goal.pausedReason) lines.push(`Paused: ${goal.pausedReason}`);
  return lines.join('\n');
}
