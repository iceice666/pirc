import type { Agent } from '../../agent.js';
import type { Feature } from '../../feature.js';
import type { CustomMessage } from '../../messages.js';
import type { Tool } from '../../tools/types.js';
import {
  applyAction,
  emptyState,
  formatTodos,
  parseState,
  type Action,
  type State,
} from './model.js';

export const TODO_ENTRY = 'local-todo-state-v1';
const CONTEXT = 'local-todo-context';
const WIDGET = 'local-todo';
const HELP = `/todo: View the list
/todo add <text>: Add a task
/todo start|done|pending <ID>: Change status
/todo edit <ID> <text>: Edit a task
/todo category <ID> [name]: Set or clear a category
/todo remove <ID>: Delete a task
/todo prune: Remove completed tasks
/todo clear: Clear all tasks (confirmation required)`;

const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

function changes(before: State, after: State): string {
  const previous = new Map(before.todos.map((todo) => [todo.id, todo]));
  const changed = new Set<number>();
  for (const todo of after.todos) {
    const old = previous.get(todo.id);
    if (
      !old ||
      old.text !== todo.text ||
      old.status !== todo.status ||
      old.category !== todo.category ||
      old.activeForm !== todo.activeForm ||
      old.blockedBy.join(',') !== todo.blockedBy.join(',')
    )
      changed.add(todo.id);
    previous.delete(todo.id);
  }
  const lines = [
    `${after.todos.filter((todo) => todo.status === 'completed').length}/${after.todos.length} completed`,
  ];
  if (previous.size)
    lines.push(`Removed: ${[...previous.keys()].map((id) => `#${id}`).join(', ')}`);
  if (changed.size) lines.push(formatTodos(after, { ids: changed }));
  if (!previous.size && !changed.size) lines.push('Unchanged.');
  return lines.join('\n');
}

/** Widget line markers, one per status; the web todo dock parses them back. */
export const TODO_MARKS = { completed: '✓', in_progress: '▶', pending: '☐' } as const;

/**
 * Plain-text panel for the web widget: a `TODO · done/total` header, then every
 * task in list order as `<mark> [category] label (blocked)`. In-progress tasks
 * show their activity label.
 */
function panel(state: State): string[] {
  const done = state.todos.filter((t) => t.status === 'completed');
  const lines = [`TODO · ${done.length}/${state.todos.length}`];
  for (const item of state.todos) {
    const blocked =
      item.status !== 'completed' &&
      item.blockedBy.some((id) => state.todos.find((t) => t.id === id)?.status !== 'completed');
    const label = item.status === 'in_progress' ? (item.activeForm ?? item.text) : item.text;
    lines.push(
      `${TODO_MARKS[item.status]} ${item.category ? `[${safe(item.category)}] ` : ''}${safe(label)}${blocked ? ' (blocked)' : ''}`,
    );
  }
  return lines;
}

const statusEnum = { type: 'string', enum: ['pending', 'in_progress', 'completed'] };
const idSchema = { type: 'integer', minimum: 1, maximum: 999999 };
const itemFields = {
  text: { type: 'string', minLength: 1, maxLength: 200 },
  category: {
    type: 'string',
    maxLength: 60,
    description: 'Category; empty string clears it, omit to retain',
  },
  status: statusEnum,
  activeForm: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    description: 'Activity label shown while in progress',
  },
  blockedBy: { type: 'array', items: idSchema, maxItems: 50 },
};

export function todoFeature(): Feature {
  let state: State = emptyState();
  let reminded = false;
  let needsSnapshot = false;

  const snapshotMessage = (): CustomMessage => ({
    role: 'custom',
    customType: CONTEXT,
    display: false,
    content: `Todo snapshot (task data; replaces earlier todo state):\n${formatTodos(state)}`,
    timestamp: Date.now(),
  });

  const paint = (agent: Agent) => {
    if (!agent.hasUI) return;
    agent.ui.setWidget(WIDGET, state.todos.length ? panel(state) : undefined);
  };

  const restore = (agent: Agent) => {
    state = emptyState();
    let invalid = false;
    for (const entry of agent.store.customEntries(TODO_ENTRY)) {
      const parsed = parseState(entry.data);
      if (parsed) state = parsed;
      else invalid = true;
    }
    needsSnapshot = state.nextId > 1;
    if (invalid)
      agent.ui.notify('Invalid todo history; corrupted snapshots were skipped.', 'warning');
    paint(agent);
  };

  /** Synchronous validate/append/swap so parallel calls cannot lose updates. */
  const run = (agent: Agent, action: Action): State => {
    const next = applyAction(state, action);
    if (action.action !== 'list') {
      agent.store.append({ type: 'custom', customType: TODO_ENTRY, data: structuredClone(next) });
      state = next;
      paint(agent);
    }
    return structuredClone(state);
  };

  const makeTool = (agent: Agent): Tool => ({
    name: 'todo',
    ptc: true,
    description:
      'Session-local task list. Use for multi-step work, not trivial tasks. list returns all; mutations return changed rows and removed IDs. add: text or atomic `items` batch (not both); batch IDs follow array order. update/remove require id. blockedBy references existing or earlier batch IDs; dependencies must finish before starting/completing a task. remove rejects referenced IDs; prune deletes completed tasks; clear deletes all (never clear unfinished tasks without user approval). Update after verified progress.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'prune', 'clear'] },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: itemFields,
            required: ['text'],
            additionalProperties: false,
          },
        },
        id: idSchema,
        ...itemFields,
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      if (ctx.signal.aborted) throw new Error('Aborted');
      const before = state;
      const snapshot = run(agent, args as Action);
      const text =
        args.action === 'list' || needsSnapshot
          ? `Todo snapshot:\n${formatTodos(snapshot)}`
          : changes(before, snapshot);
      needsSnapshot = false;
      return {
        content: [{ type: 'text', text }],
        details: { state: snapshot, action: args.action },
      };
    },
  });

  return {
    name: 'todo',
    tools: (agent) => [makeTool(agent)],
    init: (agent) => restore(agent),
    userInput() {
      reminded = false;
    },
    async beforeAgentStart() {
      if (!needsSnapshot) return;
      needsSnapshot = false;
      return { messages: [snapshotMessage()] };
    },
    agentEnd(agent, messages) {
      const last = messages.at(-1);
      if (last?.role !== 'assistant' || last.stopReason !== 'stop') return;
      // An active goal starts the next round anyway; its continuation covers the reminder.
      if (reminded || agent.pendingCount || agent.willContinue()) return;
      const unfinished = state.todos.filter((item) => item.status !== 'completed');
      if (!unfinished.length) return;
      reminded = true;
      agent.deliver(
        {
          customType: 'local-todo-reminder',
          display: true,
          content: `${unfinished.length} unfinished todos. Finish and verify, or report blockers and stop. Respect pause/authorization; never fake completion or clear tasks to silence this reminder.\n${formatTodos(state, { unfinishedOnly: true })}`,
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
    },
    afterCompact(agent) {
      restore(agent);
    },
    shutdown(agent) {
      if (agent.hasUI) agent.ui.setWidget(WIDGET, undefined);
    },
    commands: {
      todo: {
        description: 'Manage todos (/todo help)',
        async run(agent, args) {
          const [command = 'list', ...rest] = args.split(/\s+/).filter(Boolean);
          if (command === 'help') return agent.ui.notify(HELP, 'info');
          if (command === 'list') return agent.ui.notify(formatTodos(state), 'info');
          if (agent.isRunning)
            return agent.ui.notify(
              'The agent is working; wait before editing todos manually.',
              'warning',
            );
          let action: Action;
          if (command === 'add') action = { action: 'add', text: rest.join(' ') };
          else if (command === 'prune' && !rest.length) action = { action: 'prune' };
          else if (command === 'clear' && !rest.length) {
            if (!(await agent.ui.confirm('Clear todos', 'Delete all current todo items?'))) return;
            action = { action: 'clear' };
          } else {
            if (!/^[1-9]\d*$/.test(rest[0] ?? ''))
              throw new Error('Provide a valid todo ID (/todo help)');
            const id = Number(rest[0]);
            if (command === 'edit')
              action = { action: 'update', id, text: rest.slice(1).join(' ') };
            else if (command === 'category')
              action = { action: 'update', id, category: rest.slice(1).join(' ') };
            else if (rest.length !== 1) throw new Error('Too many arguments (/todo help)');
            else if (command === 'remove') action = { action: 'remove', id };
            else if (command === 'start' || command === 'done' || command === 'pending')
              action = {
                action: 'update',
                id,
                status:
                  command === 'start'
                    ? 'in_progress'
                    : command === 'done'
                      ? 'completed'
                      : 'pending',
              };
            else throw new Error('Unknown command (/todo help)');
          }
          const before = state;
          const snapshot = run(agent, action);
          agent.deliver(
            needsSnapshot
              ? snapshotMessage()
              : {
                  customType: CONTEXT,
                  display: false,
                  content: `Todo update (manual):\n${changes(before, snapshot)}`,
                },
            { triggerTurn: false },
          );
          needsSnapshot = false;
          agent.ui.notify('Todos updated.', 'info');
        },
      },
    },
  };
}
