/**
 * Scheduled runs (plans/cron.md): the gateway keeps the user's schedules and
 * starts each run in a new session. The `schedule` tool lists them and
 * proposes new ones or changes, which the user approves in the chat; pausing
 * and deleting take effect at once. `/cron` gives the user the same
 * without the model. Only a node's main agent has a gateway (gateway.ts).
 */
import type { Agent } from '../agent.js';
import { capabilities } from '../capabilities.js';
import type { Feature } from '../feature.js';
import { GatewayError, processGateway, type NodeGateway } from '../gateway.js';
import { text, typed, type Tool, type ToolResult } from '../tools/types.js';
import { arr, byAction, int, nullable, obj, str } from '../tools/result-schema.js';
import { toolPrompt } from '../prompts/tools.js';

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
  lastRun?: { id: string; status: string; due: string; result?: string; resultChars?: number };
}

/** A run's result chunk (daemon/schedules.ts `runResult`). */
interface RunResult {
  id: string;
  schedule: string;
  status: string;
  session?: string;
  result: string;
  resultOffset: number;
  resultChars: number;
  nextOffset?: number;
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
              `  last run ${item.lastRun.id} (${item.lastRun.due}): ${item.lastRun.status}${item.lastRun.result ? ` — ${item.lastRun.result.replace(/\s+/g, ' ')}` : ''}${item.lastRun.resultChars ? ` [${item.lastRun.resultChars} characters; read it with action result id=${item.lastRun.id}]` : ''}`,
            ]
          : []),
      ].join('\n'),
    ),
  ].join('\n');
}

/** A run's result chunk, with where it stands and how to read on. */
export function formatRunResult(run: RunResult): string {
  const end = run.nextOffset ?? run.resultChars;
  const head = `Run ${run.id} of ${run.schedule} [${run.status}]${run.session ? ` (session “${run.session}”)` : ''}`;
  if (!run.resultChars) return `${head}: no result.`;
  const whole = run.resultOffset === 0 && run.nextOffset === undefined;
  const footer = whole
    ? ''
    : run.nextOffset === undefined
      ? `\n[Result characters ${run.resultOffset}–${end} of ${run.resultChars}; end of result]`
      : `\n[Result characters ${run.resultOffset}–${end} of ${run.resultChars}; continue with action result id=${run.id} offset=${end}]`;
  return `${head}:\n${run.result}${footer}`;
}

const param = (description: string) => ({ type: 'string', description });

const BRIEF = obj(
  {
    id: str(),
    title: str(),
    workspace: str(),
    when: str('The cron expression or one-off time, as text'),
    status: str(),
    nextRun: str(),
    model: str(),
    thinking: str(),
    notify: str(),
    prompt: str(),
    lastRun: obj({ id: str(), status: str(), due: str(), result: str(), resultChars: int() }, [
      'result',
      'resultChars',
    ]),
  },
  ['nextRun', 'model', 'thinking', 'notify', 'lastRun'],
);

/** Only the documented fields of a gateway record, so results match the contract. */
function pick(record: Record<string, any>, schema: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.properties as Record<string, any>)) {
    const value = record?.[key];
    if (value === undefined || value === null) continue;
    out[key] = field.type === 'object' ? pick(value, field) : value;
  }
  return out;
}

const SCHEDULE_RESULT = byAction({
  list: { properties: { timezone: str(), schedules: arr(BRIEF) } },
  create: {
    properties: {
      proposalId: str('The user approves it in the chat; it does not exist until then'),
      title: str(),
    },
  },
  update: { properties: { proposalId: str(), title: str() } },
  pause: { properties: { id: str(), title: str(), nextRun: str() }, optional: ['nextRun'] },
  resume: { properties: { id: str(), title: str(), nextRun: str() }, optional: ['nextRun'] },
  delete: { properties: { id: str(), title: str() } },
  result: {
    properties: {
      id: str('The run'),
      schedule: str(),
      status: str(),
      session: str(),
      result: str('This chunk of the result'),
      resultOffset: int(),
      resultChars: int(),
      nextOffset: nullable(int('Where the next chunk starts, or null at the end')),
    },
    optional: ['session'],
  },
});

function scheduleTool(gateway: NodeGateway): Tool {
  return {
    name: SCHEDULE_TOOL,
    description: toolPrompt('schedule', { today: new Date().toISOString().slice(0, 10) }),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'pause', 'resume', 'delete', 'result'],
        },
        id: param(
          'The schedule (like s1a2b3c4d) for update, pause, resume and delete; the run (like r1a2b3c4d) for result',
        ),
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'With result: first result character to return (default 0)',
        },
        prompt: param('What the scheduled agent should do, standing on its own'),
        title: param('A short title; it names each run session'),
        cron: param('Repeat: 5-field cron expression'),
        at: param('Once: ISO 8601 time; without an offset it is read in timezone'),
        timezone: param('IANA time zone for cron and at'),
        workspace: param(
          'Where it runs (workspace id or name). Default: this workspace. Only the assistant may pick another one.',
        ),
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
    resultSchema: SCHEDULE_RESULT,
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
            return typed(
              formatSchedules(result.schedules, result.timezone),
              {
                action,
                timezone: result.timezone,
                schedules: result.schedules.map((item) => pick(item, BRIEF)),
              },
              { details: { ids: result.schedules.map((item) => item.id) } },
            );
          }
          case 'create': {
            if (!('prompt' in spec)) return text('prompt is required', undefined, true);
            const result = (await gateway.request('schedule.create', spec, ctx.signal)) as {
              proposalId: string;
              title: string;
            };
            return typed(
              `Asked the user to approve the schedule “${result.title}”. It does not exist until they do; check with list afterwards.`,
              { action, proposalId: result.proposalId, title: result.title },
              { details: { proposalId: result.proposalId } },
            );
          }
          case 'update': {
            if (!id) return text('id is required', undefined, true);
            const result = (await gateway.request(
              'schedule.update',
              { id, ...spec },
              ctx.signal,
            )) as { proposalId: string; title: string };
            return typed(
              `Asked the user to approve the change to “${result.title}”. It keeps its current settings until they do.`,
              { action, proposalId: result.proposalId, title: result.title },
              { details: { proposalId: result.proposalId } },
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
            const nextRun = 'nextRun' in result && result.nextRun ? result.nextRun : undefined;
            return typed(
              `${done} “${result.title}”${nextRun ? `; next run ${nextRun}` : ''}.`,
              {
                action,
                id,
                title: result.title,
                ...(nextRun && action !== 'delete' ? { nextRun } : {}),
              },
              { details: { id } },
            );
          }
          case 'result': {
            if (!id) return text('id is required', undefined, true);
            const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
            const run = (await gateway.request(
              'schedule.result',
              { id, ...(offset ? { offset } : {}) },
              ctx.signal,
            )) as RunResult;
            return typed(
              formatRunResult(run),
              {
                action,
                id: run.id,
                schedule: run.schedule,
                status: run.status,
                ...(run.session ? { session: run.session } : {}),
                result: run.result,
                resultOffset: run.resultOffset,
                resultChars: run.resultChars,
                nextOffset: run.nextOffset ?? null,
              },
              { details: { id: run.id, nextOffset: run.nextOffset ?? null } },
            );
          }
          default:
            return text(
              'action is one of list, create, update, pause, resume, delete, result',
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
    if (agent.config.workspaceKind === 'chat') {
      const context = (await gateway.request('assistant.context', {})) as {
        capabilities?: unknown;
      };
      agent.capabilities = capabilities(context.capabilities);
    }
    if (!agent.capabilities.schedules)
      return agent.ui.notify('The schedules capability is disabled for this workspace.', 'error');
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
