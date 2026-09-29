/**
 * Scheduled runs (plans/cron.md): the gateway keeps the user's schedules and
 * starts each run in a new session. The `schedule` tool lists them and
 * proposes new ones or changes, which the user approves in the chat; pausing
 * and deleting take effect at once. `/cron` gives the user the same
 * without the model. Only a node's main agent has a gateway (gateway.ts).
 */
import type { Agent } from '../agent.js';
import type { Feature } from '../feature.js';
import { GatewayError, processGateway, type NodeGateway } from '../gateway.js';
import { text, type Tool, type ToolResult } from '../tools/types.js';

export const SCHEDULE_TOOL = 'schedule';

interface Brief {
  id: string;
  title: string;
  workspace: string;
  when: string;
  status: string;
  nextRun?: string;
  model?: string;
  thinking?: string;
  notify?: string;
  prompt: string;
  lastRun?: { id: string; status: string; due: string; result?: string };
}

function enabled(agent: Agent): boolean {
  const config = agent.config.features.schedules as { enabled?: unknown } | undefined;
  return config?.enabled !== false;
}

const unreachable = (error: GatewayError) =>
  ['gateway_offline', 'gateway_timeout', 'gateway_closed'].includes(error.code);

function failure(error: unknown): ToolResult {
  if (!(error instanceof GatewayError)) throw error;
  return text(
    unreachable(error)
      ? 'Schedules are unavailable right now: the gateway cannot be reached. Nothing changed.'
      : error.message,
    { code: error.code },
    true,
  );
}

/** One line per schedule, then its prompt and last run. */
export function formatSchedules(schedules: Brief[], timezone: string): string {
  if (!schedules.length) return `No schedules. Default time zone: ${timezone}.`;
  return [
    `Schedules (default time zone ${timezone}):`,
    ...schedules.map((item) =>
      [
        `- ${item.id} “${item.title}” [${item.status}] in ${item.workspace}: ${item.when}${item.nextRun ? `; next ${item.nextRun}` : ''}${item.model ? `; model ${item.model}` : ''}${item.thinking ? `; thinking ${item.thinking}` : ''}${item.notify ? `; notifications: ${item.notify}` : ''}`,
        `  prompt: ${item.prompt.replace(/\s+/g, ' ')}`,
        ...(item.lastRun
          ? [
              `  last run ${item.lastRun.id} (${item.lastRun.due}): ${item.lastRun.status}${item.lastRun.result ? ` — ${item.lastRun.result.replace(/\s+/g, ' ')}` : ''}`,
            ]
          : []),
      ].join('\n'),
    ),
  ].join('\n');
}

const str = (description: string) => ({ type: 'string', description });

function scheduleTool(gateway: NodeGateway): Tool {
  return {
    name: SCHEDULE_TOOL,
    description: `Run a task later, or repeatedly, as a new agent session: the user's scheduled tasks (cron). Each run starts fresh in the chosen workspace with only the prompt, so write the prompt to stand on its own. Nobody watches a run live; the user reads its final message in the schedule's history.

Actions:
- list: the schedules you may manage, with ids and their last run.
- create: propose a schedule. It exists only once the user approves it in this chat. Give cron (5 fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5") for a repeating one, or at (e.g. "2026-10-01T09:00") for a single run.
- update: propose a change to one (id plus the fields to change); the user approves it too.
- pause / resume / delete: take effect at once (id).

Times are read in timezone (IANA, e.g. "Asia/Taipei"); it defaults to the gateway's. Today is ${new Date().toISOString().slice(0, 10)}.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'pause', 'resume', 'delete'] },
        id: str('The schedule (like s1a2b3c4d) for update, pause, resume and delete'),
        prompt: str('What the scheduled agent should do, standing on its own'),
        title: str('A short title; it names each run session'),
        cron: str('Repeat: 5-field cron expression'),
        at: str('Once: ISO 8601 time; without an offset it is read in timezone'),
        timezone: str('IANA time zone for cron and at'),
        workspace: str(
          'Where it runs (workspace id or name). Default: this workspace. Only the assistant may pick another one.',
        ),
        model: str('provider/model-id to run it on; default: the workspace default'),
        thinking: {
          type: 'string',
          enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
        notify: {
          type: 'string',
          enum: ['all', 'problems', 'none'],
          description:
            'Push notifications: every run (all, the default), only runs that fail, are missed or wait for the user (problems), or none. Pick problems for frequent schedules.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const action = typeof args.action === 'string' ? args.action : '';
      const field = (key: string) =>
        typeof args[key] === 'string' && args[key].trim() ? { [key]: args[key].trim() } : {};
      const spec = {
        ...field('title'),
        ...field('cron'),
        ...field('at'),
        ...field('timezone'),
        ...field('workspace'),
        ...field('model'),
        ...field('thinking'),
        ...field('notify'),
        ...(typeof args.prompt === 'string' && args.prompt.trim()
          ? { prompt: args.prompt.trim() }
          : {}),
      };
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      try {
        switch (action) {
          case 'list': {
            const result = (await gateway.request('schedule.list', {}, ctx.signal)) as {
              schedules: Brief[];
              timezone: string;
            };
            return text(formatSchedules(result.schedules, result.timezone), {
              ids: result.schedules.map((item) => item.id),
            });
          }
          case 'create': {
            if (!('prompt' in spec)) return text('prompt is required', undefined, true);
            const result = (await gateway.request('schedule.create', spec, ctx.signal)) as {
              proposalId: string;
              title: string;
            };
            return text(
              `Asked the user to approve the schedule “${result.title}”. It does not exist until they do; check with list afterwards.`,
              { proposalId: result.proposalId },
            );
          }
          case 'update': {
            if (!id) return text('id is required', undefined, true);
            const result = (await gateway.request(
              'schedule.update',
              { id, ...spec },
              ctx.signal,
            )) as { proposalId: string; title: string };
            return text(
              `Asked the user to approve the change to “${result.title}”. It keeps its current settings until they do.`,
              { proposalId: result.proposalId },
            );
          }
          case 'pause':
          case 'resume':
          case 'delete': {
            if (!id) return text('id is required', undefined, true);
            const result = (await gateway.request(`schedule.${action}`, { id }, ctx.signal)) as
              | Brief
              | { title: string };
            const done =
              action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Deleted';
            return text(
              `${done} “${result.title}”${'nextRun' in result && result.nextRun ? `; next run ${result.nextRun}` : ''}.`,
              { id },
            );
          }
          default:
            return text(
              'action is one of list, create, update, pause, resume, delete',
              undefined,
              true,
            );
        }
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const HELP = `/cron — list schedules
/cron pause <id> | resume <id> | delete <id> | run <id>
Ask the agent to create or change a schedule; you approve it in the chat.`;

async function cronCommand(agent: Agent, gateway: NodeGateway, args: string): Promise<void> {
  const [verb = 'list', id = ''] = args.trim().split(/\s+/).filter(Boolean);
  try {
    if (verb === 'list') {
      const result = (await gateway.request('schedule.list', {})) as {
        schedules: Brief[];
        timezone: string;
      };
      return agent.ui.notify(formatSchedules(result.schedules, result.timezone), 'info');
    }
    if (!['pause', 'resume', 'delete', 'run'].includes(verb)) return agent.ui.notify(HELP, 'info');
    if (!id) return agent.ui.notify(`Usage: /cron ${verb} <id>`, 'warning');
    const result = (await gateway.request(`schedule.${verb}`, { id })) as Record<string, any>;
    agent.ui.notify(
      verb === 'run'
        ? `Started run ${result.runId} of ${id} (${result.status}).`
        : `${verb === 'pause' ? 'Paused' : verb === 'resume' ? 'Resumed' : 'Deleted'} “${result.title}”.`,
      'info',
    );
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    agent.ui.notify(
      unreachable(error) ? 'The gateway cannot be reached right now.' : error.message,
      'error',
    );
  }
}

export function schedulesFeature(): Feature {
  let current: Agent | undefined;
  return {
    name: 'schedules',
    init(agent) {
      current = agent;
    },
    tools(agent) {
      const gateway = processGateway();
      // Rebuilt each time so the date in its description stays current.
      return gateway && enabled(agent) ? [scheduleTool(gateway)] : [];
    },
    get commands() {
      const gateway = processGateway();
      if (!gateway || (current && !enabled(current))) return {};
      return {
        cron: {
          description: 'Scheduled tasks: /cron [list | pause|resume|delete|run <id>]',
          run: (agent: Agent, args: string) => cronCommand(agent, gateway, args),
        },
      };
    },
  };
}
