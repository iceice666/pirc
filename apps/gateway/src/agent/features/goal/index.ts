import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Agent } from '../../agent.js';
import type { Feature } from '../../feature.js';
import type { CustomMessage } from '../../messages.js';
import type { Tool } from '../../tools/types.js';
import { teamChildMode } from '../team/channel.js';
import {
  applyUpdate,
  atLimit,
  autoPause,
  createGoal,
  formatGoal,
  isOpen,
  parseGoal,
  startRound,
  validMaxRounds,
  type Goal,
  type GoalAction,
} from './model.js';

/**
 * Session goals, after DeepSeek Harness / Codex: one persisted completion
 * objective that keeps the agent working across automatic continuation rounds
 * until the model marks it complete or blocked, a round limit is reached, or
 * the user pauses it.
 *
 * A round starts once the agent is fully idle after a run that ended cleanly
 * (each round is its own run, so `limits.maxTurns` applies per round). An
 * aborted or failed run pauses the goal instead. A restarted agent process
 * restores an active goal disarmed: it continues only after a resume.
 *
 * Authority: creating, editing, pausing and resuming need a human request (the
 * latest input came from the user, not from a continuation round); complete
 * and blocked are always allowed, blocked only after `minBlockedRounds`.
 */

export const GOAL_ENTRY = 'goal-state-v1';
export const GOAL_WIDGET = 'goal';
const CONTEXT = 'goal-context';
const CONTINUATION = 'goal-continuation';
const COMPACTION_RETRY_MS = 250;

const settingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Rounds that must pass before the model may mark a goal blocked. */
    minBlockedRounds: z.number().int().min(0).max(100).default(3),
    /** Round limit for goals created without `max_goal_rounds`. */
    defaultMaxRounds: z.number().int().positive().optional(),
  })
  .default({});
type Settings = z.infer<typeof settingsSchema>;

const HELP = `/goal: Show the goal
/goal set <objective>: Create a goal and start working on it
/goal edit <objective>: Replace the objective
/goal rounds <n>: Set the continuation round limit
/goal pause: Stop continuing after the current run
/goal resume: Continue (also rearms a restored goal)
/goal clear: Remove the goal (confirmation required)`;

const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();

/**
 * Plain-text widget; the web goal dock parses it back:
 * `GOAL · <phase>[ · disarmed] · <rounds>[/<max>]`, the objective on one line,
 * then an optional reason line.
 */
export function goalWidget(goal: Goal, armed: boolean): string[] {
  const rounds = `${goal.rounds}${goal.maxRounds === undefined ? '' : `/${goal.maxRounds}`}`;
  const lines = [
    `GOAL · ${goal.phase}${goal.phase === 'active' && !armed ? ' · disarmed' : ''} · ${rounds}`,
    safe(goal.objective),
  ];
  const reason = goal.blockedReason ?? goal.pausedReason;
  if (reason) lines.push(safe(reason));
  return lines;
}

export function goalFeature(): Feature {
  let goal: Goal | null = null;
  /** In-memory: a restored active goal waits for a resume before continuing. */
  let armed = false;
  /** The current run was started or steered by the user (not a continuation or a notice). */
  let human = false;
  /** User input arrived since the last run started. */
  let humanPending = false;
  /** The last run reached a clean stop (not aborted, failed or cut off). */
  let cleanEnd = false;
  /** The model has not seen the current goal state yet. */
  let needsSnapshot = false;
  let scheduled = false;
  let closed = false;
  const child = teamChildMode() !== undefined;

  const settings = (agent: Agent): Settings => {
    const parsed = settingsSchema.safeParse(agent.config.features.goal ?? {});
    return parsed.success ? parsed.data : settingsSchema.parse({});
  };
  const enabled = (agent: Agent) => !child && settings(agent).enabled;

  const paint = (agent: Agent) => {
    if (!agent.hasUI || closed) return;
    agent.ui.setWidget(GOAL_WIDGET, goal ? goalWidget(goal, armed) : undefined);
  };

  const save = (agent: Agent, next: Goal | null) => {
    agent.store.append({ type: 'custom', customType: GOAL_ENTRY, data: structuredClone(next) });
    goal = next;
    paint(agent);
  };

  const read = (agent: Agent) => {
    let invalid = false;
    goal = null;
    for (const entry of agent.store.customEntries(GOAL_ENTRY)) {
      const parsed = parseGoal(entry.data);
      if (parsed === undefined) invalid = true;
      else goal = parsed;
    }
    if (invalid)
      agent.ui.notify('Invalid goal history; corrupted snapshots were skipped.', 'warning');
  };

  const describe = (current: Goal | null) =>
    current?.phase === 'active' && !armed
      ? `${formatGoal(current)}\n(Disarmed after a restart: it continues once the user asks to resume.)`
      : formatGoal(current);

  const snapshotMessage = (): CustomMessage => ({
    role: 'custom',
    customType: CONTEXT,
    display: false,
    content: `Goal state (replaces earlier goal state):\n${describe(goal)}`,
    timestamp: Date.now(),
  });

  const continuationText = (current: Goal, agent: Agent) => {
    const { minBlockedRounds } = settings(agent);
    const limit = current.maxRounds === undefined ? '' : ` of ${current.maxRounds}`;
    return [
      `Goal continuation round ${current.rounds}${limit} (goal ${current.id}, revision ${current.revision}).`,
      `Objective: ${current.objective}`,
      '',
      'Keep working toward the objective: check what is already done, then make concrete progress. Do not redo finished work.',
      'When the objective is fully achieved and verified, call update_goal with action "complete".',
      `If the same concrete blocker has persisted for at least ${minBlockedRounds} rounds, call update_goal with action "blocked" and a blocked_reason. Difficulty, uncertainty or remaining work is not a blocker.`,
    ].join('\n');
  };

  /** Start the next round once the agent is idle and not compacting. */
  const tryContinue = (agent: Agent) => {
    scheduled = false;
    if (closed || !enabled(agent) || goal?.phase !== 'active' || !armed) return;
    // Another run (user input, background notice) settles and schedules again.
    if (agent.isRunning || agent.pendingCount) return;
    if (agent.isCompacting) {
      scheduled = true;
      setTimeout(() => tryContinue(agent), COMPACTION_RETRY_MS);
      return;
    }
    if (atLimit(goal)) {
      save(agent, autoPause(goal, `Used all ${goal.maxRounds} continuation rounds.`));
      needsSnapshot = true;
      agent.ui.notify(`Goal paused: used all ${goal.maxRounds} continuation rounds.`, 'warning');
      return;
    }
    const next = startRound(goal);
    save(agent, next);
    humanPending = false;
    needsSnapshot = false;
    agent.deliver(
      {
        customType: CONTINUATION,
        display: true,
        content: continuationText(next, agent),
        details: { goalId: next.id, revision: next.revision, round: next.rounds },
      },
      { triggerTurn: true },
    );
  };

  const schedule = (agent: Agent) => {
    if (scheduled) return;
    scheduled = true;
    // After the other features settled (e.g. memory schedules its compaction first).
    setTimeout(() => tryContinue(agent), 0);
  };

  const requireHuman = (action: string) => {
    if (!human)
      throw new Error(
        `${action} requires a direct request from the user; it is not allowed during an automatic continuation round.`,
      );
  };

  const newId = () => randomBytes(6).toString('hex');

  const create = (agent: Agent, objective: string, maxRounds: number | undefined): Goal => {
    if (isOpen(goal))
      throw new Error(
        `Goal ${goal.id} is still ${goal.phase}; complete it or change it with update_goal edit instead of creating another.`,
      );
    const next = createGoal(newId(), objective, maxRounds ?? settings(agent).defaultMaxRounds);
    armed = true;
    save(agent, next);
    return next;
  };

  const update = (
    agent: Agent,
    action: GoalAction,
    fields: { objective?: string; maxRounds?: number; blockedReason?: string },
  ): Goal => {
    if (!goal) throw new Error('There is no goal.');
    // Resuming a restored active goal only rearms it.
    if (action === 'resume' && goal.phase === 'active') {
      if (armed) throw new Error('The goal is already active');
      armed = true;
      paint(agent);
      return goal;
    }
    const next = applyUpdate(
      goal,
      { action, ...fields },
      { minBlockedRounds: settings(agent).minBlockedRounds },
    );
    if (action === 'resume') armed = true;
    save(agent, next);
    if (action === 'complete') agent.ui.notify('Goal complete.', 'info');
    if (action === 'blocked') agent.ui.notify(`Goal blocked: ${next.blockedReason}`, 'warning');
    return next;
  };

  const result = (text: string, current: Goal | null, isError = false) => ({
    content: [{ type: 'text' as const, text }],
    details: { goal: current, armed },
    ...(isError ? { isError: true } : {}),
  });

  const maxRoundsField = {
    type: 'integer',
    minimum: 1,
    description: 'Optional limit on automatic continuation rounds.',
  };

  const tools = (agent: Agent): Tool[] => [
    {
      name: 'create_goal',
      description:
        'Create one persisted session goal when the current direct user request is a long-running objective that should continue across automatic rounds (you may infer that intent). The agent then keeps working in continuation rounds until the goal is complete, blocked, paused or out of rounds. Not for routine single-turn work. Rejected during continuation rounds and while another goal is active or paused.',
      parameters: {
        type: 'object',
        properties: {
          objective: {
            type: 'string',
            minLength: 1,
            description: 'The concrete completion objective inferred from the user request.',
          },
          max_goal_rounds: maxRoundsField,
        },
        required: ['objective'],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          requireHuman('create_goal');
          const created = create(
            agent,
            String(args.objective ?? ''),
            validMaxRounds(args.max_goal_rounds),
          );
          return result(`Goal created.\n${formatGoal(created)}`, created);
        } catch (error) {
          return result((error as Error).message, goal, true);
        }
      },
    },
    {
      name: 'get_goal',
      description:
        'Read the session goal: id, revision, objective, phase, continuation rounds, round limit, blocked/paused reason, and whether continuation is armed. Call before update_goal.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return result(describe(goal), goal);
      },
    },
    {
      name: 'update_goal',
      description:
        'Update the goal at its exact current revision (from get_goal or the continuation message). edit, pause and resume need a direct user request; resume also rearms a goal restored after a restart. complete and blocked are also allowed during continuation rounds. Mark complete only when the objective is actually achieved. blocked is rejected before the configured minimum round count and needs blocked_reason naming the concrete condition that persisted across those rounds.',
      parameters: {
        type: 'object',
        properties: {
          goal_id: { type: 'string', description: 'Exact id from get_goal.' },
          revision: { type: 'integer', description: 'Exact revision from get_goal.' },
          action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
          objective: { type: 'string', description: 'Replacement objective (edit only).' },
          max_goal_rounds: { ...maxRoundsField, description: 'Replacement cap (edit only).' },
          blocked_reason: {
            type: 'string',
            description: 'Concrete blocking condition (blocked only).',
          },
        },
        required: ['goal_id', 'revision', 'action'],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          const action = args.action as GoalAction;
          if (!['edit', 'pause', 'resume', 'complete', 'blocked'].includes(action))
            throw new Error(`Unknown action ${String(args.action)}`);
          if (!goal) throw new Error('There is no goal.');
          if (args.goal_id !== goal.id || args.revision !== goal.revision)
            throw new Error(
              `Stale goal reference: the current goal is ${goal.id} at revision ${goal.revision}. Call get_goal and retry.`,
            );
          if (action === 'edit' || action === 'pause' || action === 'resume')
            requireHuman(`update_goal ${action}`);
          if (
            action !== 'edit' &&
            (args.objective !== undefined || args.max_goal_rounds !== undefined)
          )
            throw new Error('objective and max_goal_rounds are only valid with edit');
          if (action !== 'blocked' && args.blocked_reason !== undefined)
            throw new Error('blocked_reason is only valid with blocked');
          const updated = update(agent, action, {
            ...(args.objective === undefined ? {} : { objective: String(args.objective) }),
            ...(args.max_goal_rounds === undefined
              ? {}
              : { maxRounds: validMaxRounds(args.max_goal_rounds)! }),
            ...(args.blocked_reason === undefined
              ? {}
              : { blockedReason: String(args.blocked_reason) }),
          });
          return result(`Goal updated (${action}).\n${describe(updated)}`, updated);
        } catch (error) {
          return result((error as Error).message, goal, true);
        }
      },
    },
  ];

  return {
    name: 'goal',
    tools: (agent) => (enabled(agent) ? tools(agent) : []),
    init(agent) {
      if (!enabled(agent)) return;
      read(agent);
      armed = false;
      needsSnapshot = goal !== null;
      paint(agent);
    },
    userInput() {
      // A steer joins the current run; a prompt starts the next one.
      human = true;
      humanPending = true;
    },
    willContinue(agent) {
      return enabled(agent) && goal?.phase === 'active' && armed && !atLimit(goal);
    },
    async beforeAgentStart() {
      human = humanPending;
      humanPending = false;
      cleanEnd = false;
      if (!needsSnapshot) return;
      needsSnapshot = false;
      return { messages: [snapshotMessage()] };
    },
    turnEnd() {
      // A turn after an earlier clean agentEnd (follow-ups) may still fail.
      cleanEnd = false;
    },
    agentEnd(_agent, messages) {
      const last = messages.at(-1);
      cleanEnd = last?.role === 'assistant' && last.stopReason === 'stop';
    },
    agentSettled(agent) {
      // Another feature (e.g. a background notice) already started the next run.
      if (agent.isRunning) return;
      humanPending = false;
      if (!enabled(agent) || goal?.phase !== 'active' || !armed) return;
      if (!cleanEnd) {
        save(agent, autoPause(goal, 'The last run was interrupted or failed.'));
        needsSnapshot = true;
        agent.ui.notify('Goal paused: the last run was interrupted or failed.', 'warning');
        return;
      }
      schedule(agent);
    },
    afterCompact(agent) {
      if (!enabled(agent)) return;
      read(agent);
      needsSnapshot = goal !== null;
      paint(agent);
    },
    shutdown(agent) {
      closed = true;
      if (agent.hasUI) agent.ui.setWidget(GOAL_WIDGET, undefined);
    },
    commands: {
      goal: {
        description: 'Session goal (/goal help)',
        async run(agent, args) {
          if (!enabled(agent))
            throw new Error(
              child
                ? 'Goals are not available to team members'
                : 'Goals are disabled (features.goal.enabled)',
            );
          const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
          const command = match?.[1] ?? 'show';
          const rest = (match?.[2] ?? '').trim();
          if (command === 'help') return agent.ui.notify(HELP, 'info');
          if (command === 'show') return agent.ui.notify(describe(goal), 'info');
          let message: string;
          if (command === 'set') {
            if (!rest) throw new Error('Usage: /goal set <objective>');
            if (isOpen(goal)) {
              const replace = await agent.ui.confirm(
                'Replace goal',
                `Replace the ${goal.phase} goal "${goal.objective.slice(0, 200)}"?`,
              );
              if (!replace) return;
              save(agent, null);
            }
            create(agent, rest, undefined);
            message = 'Goal created.';
          } else if (command === 'edit') {
            if (!rest) throw new Error('Usage: /goal edit <objective>');
            update(agent, 'edit', { objective: rest });
            message = 'Goal updated.';
          } else if (command === 'rounds') {
            if (!/^[1-9]\d*$/.test(rest)) throw new Error('Usage: /goal rounds <n>');
            update(agent, 'edit', { maxRounds: validMaxRounds(Number(rest))! });
            message = `Goal round limit set to ${rest}.`;
          } else if (command === 'pause' || command === 'resume') {
            if (rest) throw new Error(`Usage: /goal ${command}`);
            update(agent, command, {});
            message = command === 'pause' ? 'Goal paused.' : 'Goal resumed.';
          } else if (command === 'clear') {
            if (!goal) return agent.ui.notify('No goal.', 'info');
            if (!(await agent.ui.confirm('Clear goal', 'Remove the session goal?'))) return;
            save(agent, null);
            message = 'Goal cleared.';
          } else throw new Error('Unknown command (/goal help)');
          needsSnapshot = true;
          agent.ui.notify(message, 'info');
          // Idle: start working now. Running: the current run settles first.
          if (!agent.isRunning) schedule(agent);
        },
      },
    },
  };
}
