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
import { QUESTION_RESULT } from '../ask-question.js';
import { arr, bool, fields, int, nullable, obj, record, str } from '../../tools/result-schema.js';

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

/** A team event (message, question, reply, post, task change …); kinds add their own fields. */
const EVENT = record(
  {
    id: str(),
    time: str(),
    kind: str('message, question, reply, post, task, result, …'),
    from: str(),
    to: str(),
    body: str(),
    truncated: bool('body is cut; read the event with agent_inbox event_id'),
  },
  ['from', 'to', 'body', 'truncated'],
);
const PAGE = fields({
  items: arr(EVENT),
  next: nullable(str('Cursor for after')),
  more: bool(),
  archive: str('Path of the full event log'),
});
const AGENT = record(
  {
    name: str(),
    kind: str(),
    mode: str('team or subagent'),
    status: str(),
    cwd: str(),
    model: str(),
    thinking: str(),
    task: str(),
    background: bool(),
    lastError: str(),
    activity: str('What it is doing now'),
  },
  ['kind', 'mode', 'cwd', 'model', 'thinking', 'task', 'background', 'lastError', 'activity'],
);
const TASK = record(
  {
    id: str(),
    subject: str(),
    description: str(),
    status: str('pending, in_progress or completed'),
    owner: str(),
    blockedBy: arr(str()),
    revision: int('Pass as expected_revision to task_update'),
    blocked: bool(),
    ready: bool('pending, unowned and unblocked'),
  },
  ['owner'],
);
const SUBAGENT_OUTCOME = fields(
  {
    name: str(),
    status: { type: 'string', enum: ['done', 'failed', 'stopped'] },
    result: str(),
    error: str(),
    event_id: str('Read the whole result with agent_inbox event_id'),
  },
  ['result', 'error', 'event_id'],
);
const PENDING_QUESTION = fields({
  id: str(),
  question_id: str(),
  from: str(),
  to: { const: 'user' },
  status: { const: 'pending', description: 'The answer arrives later as a team event' },
});

/** Result contracts of the team capabilities. */
const TEAM_RESULTS = {
  agent_list: fields({
    directory: str(),
    roles: arr(record({ name: str(), description: str() }, ['description'])),
    agents: arr(AGENT),
  }),
  agent_wait: fields(
    {
      agent: str(),
      reason: str('Why the wait ended: a status, question, cancelled, timeout, …'),
      status: str(),
      question_id: str(),
      question_to: str(),
      sessionFile: str(),
    },
    ['question_id', 'question_to', 'sessionFile'],
  ),
  agent_send: EVENT,
  agent_ask: { oneOf: [EVENT, PENDING_QUESTION, QUESTION_RESULT] },
  agent_reply: EVENT,
  agent_inbox: {
    oneOf: [
      PAGE,
      fields({
        event: record({
          id: str(),
          body: str(),
          offset: int(),
          total_chars: int(),
          next_offset: nullable(int()),
        }),
      }),
    ],
  },
  board_post: EVENT,
  board_read: PAGE,
  task_create: TASK,
  task_list: fields({ tasks: arr(TASK) }),
  task_get: TASK,
  task_update: { oneOf: [TASK, fields({ deleted: str() })] },
  agent_stop: fields({ stopped: str() }),
  agent_spawn: AGENT,
  subagent: {
    oneOf: [SUBAGENT_OUTCOME, record({ name: str(), status: str(), note: str() })],
  },
} satisfies Record<string, Record<string, unknown>>;

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
  data: JSON.parse(JSON.stringify(data ?? {})) as Record<string, unknown>,
});

/**
 * Events an `agent_inbox` result returned whole (addressed to the parent):
 * a single event read in one piece, or untruncated page entries.
 */
function fullEvents(output: string): Array<{ id: string; body: string }> {
  let page: Json;
  try {
    page = JSON.parse(output);
  } catch {
    return []; // Hook output may include non-JSON text.
  }
  const out: Array<{ id: string; body: string }> = [];
  const body = (entry: Json) => (typeof entry.body === 'string' ? entry.body : '');
  const event = page?.event;
  if (
    event &&
    event.offset === 0 &&
    event.next_offset === null &&
    event.to === 'parent' &&
    typeof event.id === 'string'
  )
    out.push({ id: event.id, body: body(event) });
  if (Array.isArray(page?.items))
    for (const entry of page.items as Json[])
      if (!entry.truncated && entry.to === 'parent' && typeof entry.id === 'string')
        out.push({ id: entry.id, body: body(entry) });
  return out;
}

export function teamFeature(): Feature {
  const childName = teamChildName();
  const childMode = teamChildMode();
  let team: Team | undefined;
  let lifetime = new AbortController();
  let suspended = false;
  const delivered = new Set<string>();
  const deferred = new Map<string, Json>();
  /** Events `agent_inbox` operations returned whole, by the `ptc` call they ran in. */
  const inboxReads = new Map<string, Array<{ id: string; body: string }>>();
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
    resultSchema: TEAM_RESULTS.subagent,
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
        data: JSON.parse(JSON.stringify(report)) as Record<string, unknown>,
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
      resultSchema: TEAM_RESULTS[name as keyof typeof TEAM_RESULTS],
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
        resultSchema: TEAM_RESULTS.agent_spawn,
        async execute(args, ctx) {
          const signal = AbortSignal.any([ctx.signal, lifetime.signal]);
          return result(await manager(agent).spawn(args, defaults(agent, ctx.cwd), signal));
        },
      },
      {
        name: 'agent_stop',
        description: toolPrompt('agent_stop'),
        parameters: object({ agent: { type: 'string' } }, ['agent']),
        resultSchema: TEAM_RESULTS.agent_stop,
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
        // Inspect actual model-visible output, not hidden details: calling
        // inbox alone does not mean its result was read.
        for (const part of message.content)
          if (part.type === 'text')
            acknowledge(
              agent,
              fullEvents(part.text).map(({ id }) => id),
            );
      } else if (message.role === 'toolResult' && message.toolName === 'ptc') {
        // A ptc script read the inbox: an event counts as read only when the
        // script handed the model both its id and its whole body (a short body
        // alone, like "ok", could appear by chance). Otherwise it is delivered.
        const read = inboxReads.get(message.toolCallId);
        inboxReads.delete(message.toolCallId);
        if (!read?.length) return;
        const visible = message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('');
        acknowledge(
          agent,
          read
            .filter(
              ({ id, body }) =>
                body.length > 0 &&
                visible.includes(id) &&
                (visible.includes(body) || visible.includes(JSON.stringify(body).slice(1, -1))),
            )
            .map(({ id }) => id),
        );
      }
    },
    operationRecorded(_agent, entry) {
      if (childName || entry.toolName !== 'agent_inbox' || entry.isError) return;
      const events = entry.content.flatMap((part) =>
        part.type === 'text' ? fullEvents(part.text) : [],
      );
      if (!events.length) return;
      // Bounded: results of ptc calls that never got recorded are dropped.
      if (!inboxReads.has(entry.parentToolCallId) && inboxReads.size >= 50)
        inboxReads.delete(inboxReads.keys().next().value!);
      inboxReads.set(entry.parentToolCallId, [
        ...(inboxReads.get(entry.parentToolCallId) ?? []),
        ...events,
      ]);
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
