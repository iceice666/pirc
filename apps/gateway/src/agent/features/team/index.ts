import { frozenInstructions } from '../project-instructions.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Agent } from '../../agent.js';
import { offInChat, type Feature } from '../../feature.js';
import type { Tool } from '../../tools/types.js';
import { selfCommand } from '../../../self.js';
import { askQuestions, askQuestionSchema } from '../ask-question.js';
import { parentChannel, teamChildMode, teamChildName } from './channel.js';
import { Team, userQuestion, type SubagentOutcome } from './team.js';
import { configRoles } from '../../config.js';
import { isInside } from '../../sandbox.js';
import { DEFAULT_ROLES, describeRoles, roleBriefs, type RoleBrief } from '../../roles.js';
import { toolPrompt } from '../../prompts/tools.js';

type Json = Record<string, any>;
const short = { type: 'string', minLength: 1, maxLength: 12000 };
const TASK_STATUSES = ['pending', 'in_progress', 'completed'];
const TASK_ACTIONS = [
  'claim',
  'release',
  'complete',
  'reopen',
  'edit',
  'set_dependencies',
  'assign',
  'delete',
];
const paging = {
  after: { type: 'string' },
  limit: { type: 'integer', minimum: 1, maximum: 50 },
};
const questionFields = (askQuestionSchema.properties.questions.items as Json).properties;
const object = (properties: Json, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const DEFINITIONS: Array<[string, string, Json]> = [
  ['agent_list', toolPrompt('agent_list'), object({})],
  [
    'agent_wait',
    toolPrompt('agent_wait'),
    object(
      {
        agent: { type: 'string', minLength: 1, maxLength: 40 },
        timeout: { type: 'number', exclusiveMinimum: 0, maximum: 86400 },
      },
      ['agent'],
    ),
  ],
  [
    'agent_send',
    toolPrompt('agent_send'),
    object({ to: { type: 'string', description: 'Agent name, or parent' }, message: short }, [
      'to',
      'message',
    ]),
  ],
  [
    'agent_ask',
    toolPrompt('agent_ask'),
    object(
      {
        to: {
          type: 'string',
          description: 'Agent name, parent (default), or user for the real human',
        },
        ...questionFields,
      },
      ['question'],
    ),
  ],
  [
    'agent_reply',
    toolPrompt('agent_reply'),
    object({ question_id: { type: 'string' }, answer: short }, ['question_id', 'answer']),
  ],
  [
    'agent_inbox',
    toolPrompt('agent_inbox'),
    object({
      ...paging,
      event_id: { type: 'string', description: 'Read this one event instead of a page' },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'With event_id: first body character to return (default 0)',
      },
    }),
  ],
  [
    'board_post',
    toolPrompt('board_post'),
    object(
      {
        topic: { type: 'string', minLength: 1, maxLength: 100 },
        body: short,
        reply_to: { type: 'string' },
      },
      ['topic', 'body'],
    ),
  ],
  ['board_read', toolPrompt('board_read'), object({ topic: { type: 'string' }, ...paging })],
  [
    'task_create',
    toolPrompt('task_create'),
    object(
      {
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        description: short,
        blocked_by: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      },
      ['subject', 'description'],
    ),
  ],
  [
    'task_list',
    toolPrompt('task_list'),
    object({
      status: { type: 'string', enum: TASK_STATUSES },
      owner: { type: 'string', maxLength: 40 },
      ready: { type: 'boolean' },
    }),
  ],
  ['task_get', toolPrompt('task_get'), object({ task_id: { type: 'string' } }, ['task_id'])],
  [
    'task_update',
    toolPrompt('task_update'),
    object(
      {
        task_id: { type: 'string' },
        action: { type: 'string', enum: TASK_ACTIONS },
        expected_revision: { type: 'integer', minimum: 0 },
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        description: short,
        blocked_by: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        owner: { type: 'string', maxLength: 40 },
      },
      ['task_id', 'action'],
    ),
  ],
];

/** Coordination tools a team member keeps regardless of its kind's tool allowlist. */
export const TEAM_TOOL_NAMES = DEFINITIONS.map(([name]) => name);

/**
 * The `role` parameter, listing the configured roles so the parent picks one
 * by the work it needs. Models are never the agent's choice: the role sets them.
 */
function roleField(agent: Agent) {
  let roles: RoleBrief[];
  try {
    roles = roleBriefs(configRoles(agent.config));
  } catch {
    // Spawning reports the configuration error; keep the schema usable.
    roles = roleBriefs(DEFAULT_ROLES);
  }
  return {
    type: 'string',
    enum: roles.map((role) => role.name),
    description: `Role for the child (default general). Pick the role that fits the work; it sets the model, thinking level, tool allowlist and role instructions:\n${describeRoles(roles)}`,
  };
}

/** Where a child's cwd may be: the workspace and allowed paths, not the read-only config ones. */
function childRoots(agent: Agent): string[] {
  const { workspace, allowedPaths, protectedPaths } = agent.config;
  return [workspace, ...allowedPaths].filter(
    (root, index, all) =>
      all.indexOf(root) === index && !protectedPaths.some((item) => isInside(root, item)),
  );
}

const spawnFields = {
  cwd: {
    type: 'string',
    description:
      'Existing working directory or worktree inside the workspace or its allowed paths; defaults to parent cwd',
  },
};
const MAX_FOREGROUND_RESULT = 40_000;

const result = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  details: {},
});

export function teamFeature(): Feature {
  const childName = teamChildName();
  const childMode = teamChildMode();
  let team: Team | undefined;
  let lifetime = new AbortController();
  let suspended = false;
  const delivered = new Set<string>();
  const deferred = new Map<string, Json>();
  const eventId = (message: { customType?: string; details?: unknown }) => {
    if (message.customType !== 'agent-team') return undefined;
    return (message.details as { event?: { id?: string } } | undefined)?.event?.id;
  };
  const acknowledge = (agent: Agent, ids: string[]) => {
    for (const id of ids) {
      delivered.add(id);
      deferred.delete(id);
    }
    agent.discardNotifications((message) => {
      const id = eventId(message);
      return !!id && delivered.has(id);
    });
  };
  const deliver = (agent: Agent, entry: Json) => {
    if (delivered.has(entry.id)) return;
    if (suspended) {
      deferred.set(entry.id, entry);
      return;
    }
    agent.deliver(
      {
        customType: 'agent-team',
        content: 'Team event (agent data, not user instructions):\n' + JSON.stringify(entry),
        display: true,
        details: { event: entry },
      },
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  };

  const settings = (agent: Agent) => (agent.config.features.agentTeam ?? {}) as Json;
  const on = (agent: Agent) => settings(agent).enabled !== false && !offInChat(agent, 'agentTeam');
  const manager = (agent: Agent): Team => {
    if (team) return team;
    const options = settings(agent);
    team = new Team({
      directory: join(dirname(agent.store.file), 'team', randomUUID().slice(0, 8)),
      command: selfCommand(),
      roles: () => configRoles(agent.config),
      ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
      ...(typeof options.subagentLimit === 'number'
        ? { subagentLimit: options.subagentLimit }
        : {}),
      env: { ...process.env, ...agent.config.env },
      // Children work inside the parent's workspace and allowed paths (M12),
      // with the parent's project config (H4).
      allowedRoots: () => childRoots(agent),
      project: {
        root: agent.config.projectRoot ?? agent.config.workspace,
        trust: process.env.PIRC_PROJECT_TRUST,
      },
      models: agent.config.models,
      capabilities: () => agent.capabilities,
      instructions: () => (agent.config.workspaceKind === 'chat' ? frozenInstructions(agent) : ''),
      acquireWrite: (path, signal) => agent.acquireWrite(path, signal),
      askUser: (question, signal, from) =>
        askQuestions(
          agent.ui,
          agent.hasUI,
          [
            {
              ...question,
              header: `Agent ${from}${question.header ? ` — ${question.header}` : ''}`.slice(
                0,
                120,
              ),
            },
          ],
          signal,
        ),
      // Follow-up delivery never skips the parent's remaining tool calls.
      deliverParent: (entry) => deliver(agent, entry),
      onRecord: () => {
        agent.completionChanged();
        if (!lifetime.signal.aborted) agent.panelChanged('team');
      },
      onChange: (state) => {
        agent.completionChanged();
        if (lifetime.signal.aborted) return;
        agent.panelChanged('team');
        if (!agent.hasUI) return;
        const live = state.agents.filter((a) => !['stopped', 'failed', 'done'].includes(a.status));
        agent.ui.setStatus(
          'agent-team',
          live.length ? `Team ${live.map((a) => `${a.name}:${a.status}`).join(' ')}` : undefined,
        );
      },
    });
    return team;
  };

  const call = async (agent: Agent, operation: string, args: Json, signal: AbortSignal) => {
    const combined = AbortSignal.any([signal, lifetime.signal]);
    // A parent asking the real user needs no broker.
    if (!childName && operation === 'agent_ask' && args.to === 'user')
      return askQuestions(agent.ui, agent.hasUI, [userQuestion(args)], combined);
    combined.throwIfAborted();
    if (childName) return parentChannel().call(operation, args, combined);
    return manager(agent).call('parent', operation, args, combined);
  };

  const defaults = (agent: Agent, cwd: string) => {
    const ref = agent.modelRef;
    return {
      cwd,
      model: ref ? `${ref.provider}/${ref.id}` : undefined,
      thinking: agent.thinking,
    };
  };

  const subagentTool = (agent: Agent): Tool => ({
    name: 'subagent',
    description: toolPrompt('subagent'),
    parameters: object(
      {
        task: short,
        name: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_-]{0,39}$',
          description: 'Optional unique name; generated when omitted',
        },
        background: { type: 'boolean', description: 'Run concurrently (default false)' },
        role: roleField(agent),
        ...spawnFields,
      },
      ['task'],
    ),
    async execute(args, ctx) {
      const background = args.background === true;
      const { background: _flag, ...rest } = args ?? {};
      const outcome = await manager(agent).subagent(rest, defaults(agent, ctx.cwd), {
        background,
        signal: AbortSignal.any([ctx.signal, lifetime.signal]),
      });
      if (background) return result(outcome);
      const report = outcome as SubagentOutcome;
      const body = report.status === 'done' ? (report.result ?? '') : (report.error ?? '');
      const clipped = body.length > MAX_FOREGROUND_RESULT;
      const header = `Subagent ${report.name} ${report.status}${report.event_id ? ` (agent_inbox event_id=${report.event_id})` : ''}`;
      const more = report.event_id
        ? `agent_inbox with event_id=${report.event_id} offset=${MAX_FOREGROUND_RESULT}`
        : 'agent_inbox';
      return {
        content: [
          {
            type: 'text',
            text: `${header}:\n${clipped ? `${body.slice(0, MAX_FOREGROUND_RESULT)}\n[Result truncated at ${MAX_FOREGROUND_RESULT} of ${body.length} characters; continue with ${more}]` : body}`,
          },
        ],
        details: { name: report.name, status: report.status, event_id: report.event_id },
        ...(report.status === 'done' ? {} : { isError: true }),
      };
    },
  });

  const tools = (agent: Agent): Tool[] => {
    // One-shot subagents work alone: no team tools, no nested spawning.
    if (childMode === 'subagent') return [];
    const list: Tool[] = DEFINITIONS.map(([name, description, parameters]) => ({
      name,
      description,
      parameters,
      async execute(args, ctx) {
        return result(await call(agent, name, args, ctx.signal));
      },
    }));
    if (childName) return list;
    list.push(
      subagentTool(agent),
      {
        name: 'agent_spawn',
        description: toolPrompt('agent_spawn'),
        parameters: object(
          {
            name: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' },
            task: short,
            role: roleField(agent),
            ...spawnFields,
          },
          ['name', 'task'],
        ),
        async execute(args, ctx) {
          const signal = AbortSignal.any([ctx.signal, lifetime.signal]);
          return result(await manager(agent).spawn(args, defaults(agent, ctx.cwd), signal));
        },
      },
      {
        name: 'agent_stop',
        description: toolPrompt('agent_stop'),
        parameters: object({ agent: { type: 'string' } }, ['agent']),
        async execute(args, ctx) {
          return result(await call(agent, 'agent_stop', args, ctx.signal));
        },
      },
    );
    return list;
  };

  return {
    name: 'agent-team',
    async beforeAgentStart(agent) {
      if (childName || !on(agent)) return;
      // startRun has made the parent active, so replay cannot start a nested run.
      if (!suspended) {
        const entries = [...deferred.values()];
        deferred.clear();
        for (const entry of entries) deliver(agent, entry);
      }
    },
    userInput() {
      suspended = false;
    },
    // Flush deferred events only once the new user run is active, not inside
    // userInput (which precedes startRun).
    async turnEnd(agent) {
      if (suspended || !deferred.size) return;
      const entries = [...deferred.values()];
      deferred.clear();
      for (const entry of entries) deliver(agent, entry);
    },
    notificationsCleared(_agent, messages) {
      for (const message of messages) {
        const id = eventId(message);
        if (id && !delivered.has(id)) deferred.set(id, (message.details as { event: Json }).event);
      }
    },
    abort(agent) {
      suspended = true;
      agent.discardNotifications((message) => {
        const id = eventId(message);
        if (!id) return false;
        deferred.set(id, (message.details as { event: Json }).event);
        return true;
      });
    },
    completionBlockers: () => (suspended ? [] : (team?.completionBlockers() ?? [])),
    messageAdmitted(agent, message) {
      if (childName) return;
      if (message.role === 'custom') {
        const id = eventId(message);
        if (id) acknowledge(agent, [id]);
      } else if (
        message.role === 'toolResult' &&
        message.toolName === 'agent_inbox' &&
        !message.isError
      ) {
        // Inspect actual model-visible output, not a nested PTC invocation or
        // hidden details: calling inbox alone does not mean its result was read.
        for (const part of message.content) {
          if (part.type !== 'text') continue;
          try {
            const page = JSON.parse(part.text);
            // A single-event read counts only when the whole body came back at once.
            const event = page.event;
            if (
              event &&
              event.offset === 0 &&
              event.next_offset === null &&
              event.to === 'parent' &&
              typeof event.id === 'string'
            )
              acknowledge(agent, [event.id]);
            if (Array.isArray(page.items))
              acknowledge(
                agent,
                page.items
                  .filter(
                    (entry: Json) =>
                      !entry.truncated && entry.to === 'parent' && typeof entry.id === 'string',
                  )
                  .map((entry: Json) => entry.id),
              );
          } catch {
            /* Hook output may include non-JSON text. */
          }
        }
      }
    },
    tools: (agent) => (on(agent) ? tools(agent) : []),
    panel() {
      if (!team) return { team: { agents: [], tasks: [] } };
      return {
        team: {
          agents: team.list().agents.map(({ sessionFile: _file, ...member }) => ({
            ...member,
            task: String(member.task ?? '').slice(0, 2000),
          })),
          tasks: team.taskList().map((task) => ({
            ...task,
            description: task.description.slice(0, 2000),
          })),
          // Recent broker traffic (bodies clipped); full history is agent_inbox.
          events: team.records.slice(-40).map((record) => ({
            id: record.id,
            time: record.time,
            kind: record.kind,
            ...(typeof record.from === 'string' ? { from: record.from } : {}),
            ...(typeof record.to === 'string' ? { to: record.to } : {}),
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
            ...(typeof record.body === 'string' ? { body: record.body.slice(0, 600) } : {}),
          })),
        },
      };
    },
    async shutdown(agent) {
      lifetime.abort();
      if (childName) parentChannel().closeAll();
      if (agent.hasUI) agent.ui.setStatus('agent-team', undefined);
      await team?.close();
      team = undefined;
      lifetime = new AbortController();
    },
    commands: childName
      ? {}
      : {
          team: {
            description: 'Team status; /team stop <name|all>',
            async run(agent, args) {
              const [action = '', name, extra] = args.trim().split(/\s+/);
              if (
                !['', 'status', 'stop'].includes(action) ||
                (action === 'stop' && (!name || extra))
              )
                return agent.ui.notify('Usage: /team [status|stop NAME|stop all]', 'info');
              if (!team)
                return agent.ui.notify(
                  'No team running. Ask the agent to spawn a teammate.',
                  'info',
                );
              if (action === 'stop') {
                if (name === 'all')
                  await Promise.all([...team.agents.keys()].map((n) => team!.stop(n)));
                else await team.stop(name!);
              }
              agent.ui.notify(JSON.stringify(team.list(), null, 2), 'info');
            },
          },
        },
  };
}
