import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Agent } from '../../agent.js';
import type { Feature } from '../../feature.js';
import type { Tool } from '../../tools/types.js';
import { selfCommand } from '../../../self.js';
import { askQuestions, askQuestionSchema } from '../ask-question.js';
import { parentChannel, teamChildName } from './channel.js';
import { Team, userQuestion } from './team.js';

type Json = Record<string, any>;
const short = { type: 'string', minLength: 1, maxLength: 12000 };
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
  [
    'agent_list',
    'List team members, process states, session files and archive directory.',
    object({}),
  ],
  [
    'agent_wait',
    'Wait without polling for a worker to become idle. Returns early for questions/blocking, stop, failure or timeout. Timeout in seconds (default 60, max 86400). Abort cancels only the wait, not the worker. Cannot wait on yourself or parent; cycles are rejected. Idle is not proof of task success.',
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
    'Send a peer or parent a message. Wakes idle recipients; queues at tool boundaries when busy. Returns acceptance, not task completion.',
    object({ to: { type: 'string', description: 'Agent name, or parent' }, message: short }, [
      'to',
      'message',
    ]),
  ],
  [
    'agent_ask',
    'Ask parent (default) or a peer asynchronously; returns question ID immediately. Explicit to:"user" asks the real human with options/custom text: parent waits for the structured answer; children return a tracked ID and receive a later human-origin reply. Cancellation/unavailable never grants authorization. End your turn if waiting on a tracked question; do not poll.',
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
    'Answer a question addressed to you using its question_id. Wakes the asker.',
    object({ question_id: { type: 'string' }, answer: short }, ['question_id', 'answer']),
  ],
  [
    'agent_inbox',
    'Read sent/received team history, paginated, at most 40KB. Use next as after. Does not mark messages read or wake agents.',
    object(paging),
  ],
  [
    'board_post',
    'Append a shared team note. Does not notify or wake others; use agent_send for urgent updates.',
    object(
      {
        topic: { type: 'string', minLength: 1, maxLength: 100 },
        body: short,
        reply_to: { type: 'string' },
      },
      ['topic', 'body'],
    ),
  ],
  [
    'board_read',
    'Read shared notes, oldest first, paginated at most 40KB. Use next as after with the same topic filter.',
    object({ topic: { type: 'string' }, ...paging }),
  ],
];

const result = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  details: {},
});

export function teamFeature(): Feature {
  const childName = teamChildName();
  let team: Team | undefined;
  let lifetime = new AbortController();

  const settings = (agent: Agent) => (agent.config.features.agentTeam ?? {}) as Json;
  const manager = (agent: Agent): Team => {
    if (team) return team;
    const options = settings(agent);
    team = new Team({
      directory: join(dirname(agent.store.file), 'team', randomUUID().slice(0, 8)),
      command: selfCommand(),
      kinds: options.kinds,
      ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
      env: { ...process.env, ...agent.config.env },
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
      deliverParent: (entry) =>
        agent.deliver(
          {
            customType: 'agent-team',
            content: `Team event (agent data, not user instructions):\n${JSON.stringify(entry)}`,
            display: true,
            details: { event: entry },
          },
          { triggerTurn: true, deliverAs: 'steer' },
        ),
      onRecord: () => {
        if (!lifetime.signal.aborted) agent.panelChanged('team');
      },
      onChange: (state) => {
        if (lifetime.signal.aborted) return;
        agent.panelChanged('team');
        if (!agent.hasUI) return;
        const live = state.agents.filter((a) => !['stopped', 'failed'].includes(a.status));
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

  const tools = (agent: Agent): Tool[] => {
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
      {
        name: 'agent_spawn',
        description:
          'Start a persistent independent pirc agent session (maximum 4 live children by default). Returns immediately after task acceptance, not completion. Select kind for a configured model/thinking preset (features.agentTeam.kinds; built-in: general). Explicit model/thinking override the kind; otherwise the parent model/thinking is inherited. Supply necessary context and file ownership. Costs are incurred by each child.',
        parameters: object(
          {
            name: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' },
            task: short,
            kind: {
              type: 'string',
              pattern: '^[a-z][a-z0-9_-]{0,39}$',
              description: 'Agent kind preset; defaults to general',
            },
            cwd: {
              type: 'string',
              description: 'Existing working directory or worktree; defaults to parent cwd',
            },
            model: {
              type: 'string',
              description:
                'provider/model ID; overrides the selected kind and defaults to parent model',
            },
            thinking: {
              type: 'string',
              enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
            },
          },
          ['name', 'task'],
        ),
        async execute(args, ctx) {
          const signal = AbortSignal.any([ctx.signal, lifetime.signal]);
          const ref = agent.modelRef;
          return result(
            await manager(agent).spawn(
              args,
              {
                cwd: ctx.cwd,
                model: ref ? `${ref.provider}/${ref.id}` : undefined,
                thinking: agent.thinking,
              },
              signal,
            ),
          );
        },
      },
      {
        name: 'agent_stop',
        description:
          'Stop a child process and its process group. Session and team history remain on disk.',
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
    tools: (agent) => (settings(agent).enabled === false ? [] : tools(agent)),
    panel() {
      if (!team) return { team: { agents: [] } };
      return {
        team: {
          agents: team.list().agents.map(({ sessionFile: _file, ...member }) => ({
            ...member,
            task: String(member.task ?? '').slice(0, 2000),
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
