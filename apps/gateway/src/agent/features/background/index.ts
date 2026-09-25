import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Agent } from '../../agent.js';
import type { Feature } from '../../feature.js';
import { truncateOutput } from '../../sandbox.js';
import type { Tool } from '../../tools/types.js';
import { TaskManager, type TaskInfo, type WaitResult } from './manager.js';

const HELP = `/bg or /bg list — List tasks
/bg start <shell command> — Run in the background
/bg output <id> [lines] — Show recent output (default: 200 lines)
/bg stop <id> — Stop the process group
/bg stop-all — Stop all tasks
Aborting a run does not stop background tasks; closing the session does.
Tasks run with the current user's permissions, not in a sandbox.`;
const clean = (text: string) =>
  stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const summary = (task: TaskInfo) =>
  `${task.id} · ${task.status}${task.exitCode != null ? ` (exit ${task.exitCode})` : ''} · ${clean(task.command).replace(/\s+/g, ' ').slice(0, 180)}`;
const tailLines = (text: string, lines: number) => text.split('\n').slice(-lines).join('\n');

export function backgroundFeature(): Feature {
  let agentRef: Agent | undefined;
  let closed = false;
  let noticePending = false;
  const completed: TaskInfo[] = [];

  const refresh = () => {
    if (!agentRef?.hasUI || closed) return;
    const running = manager.list().filter((t) => t.status === 'running' || t.status === 'stopping');
    agentRef.ui.setStatus('background-task', running.length ? `BG ${running.length}` : undefined);
  };
  /** Coalesce finished tasks into one wake-up while idle. */
  const flush = () => {
    const agent = agentRef;
    if (!agent || closed || noticePending || !completed.length || agent.isRunning) return;
    const tasks = completed.splice(0);
    noticePending = true;
    agent.deliver(
      {
        customType: 'background-task-finished',
        display: true,
        content: `${tasks.length} background task${tasks.length === 1 ? '' : 's'} finished:\n${tasks
          .map((t) => `${t.id} · ${t.status}${t.exitCode != null ? ` (exit ${t.exitCode})` : ''}`)
          .join('\n')}\nUse background_task list/output to inspect results.`,
        details: { status: tasks.length === 1 ? tasks[0]!.status : 'completed', tasks },
      },
      { triggerTurn: true, deliverAs: 'steer' },
    );
  };
  const manager = new TaskManager(
    (task) => {
      if (closed) return;
      refresh();
      completed.push(task);
      agentRef?.ui.notify(
        `Background task: ${summary(task)}`,
        task.status === 'failed' || task.status === 'timed_out' ? 'warning' : 'info',
      );
      flush();
    },
    () => ({ ...process.env, ...(agentRef?.config.env ?? {}) }),
  );
  const output = (id: string, lines = 200) => {
    if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
      throw new Error('lines must be an integer from 1 to 2000.');
    const task = manager.get(id);
    const raw = clean(manager.output(id, lines));
    const markers = raw
      .split('\n')
      .filter((line) => /^\[(Output|Log) truncated:/.test(line))
      .join('\n');
    const tail = truncateOutput(tailLines(raw, lines), 48 * 1024);
    return `${summary(task)}\ncwd: ${task.cwd}\nLog (capped at 10 MiB): ${task.logPath}\n${tail.truncated ? `[Display truncated]\n${markers ? `${markers}\n` : ''}` : ''}${tail.text}`;
  };
  const requireOpen = () => {
    if (closed) throw new Error('Background task runtime has shut down.');
  };

  const tool = (agent: Agent): Tool => ({
    name: 'background_task',
    ptc: true,
    description:
      'Start/list/output/wait/stop background Bash jobs. Start returns immediately. Wait blocks until a job finishes or its wait timeout expires (default 60 seconds); timeout or abort cancels only the wait, not the job. Session-local; aborting does not stop jobs, session shutdown does. Maximum 8 active jobs. Output is a bounded tail (up to 2000 lines/48 KiB); log files cap at 10 MiB. No stdin/PTY. Not sandboxed; same permissions as Bash. Completions are coalesced into one short wakeup while the agent is idle; inspect task output explicitly with list/output. Use for long-running tests, builds or development servers. Do not busy-poll; continue other work, use wait when completion is needed. Stop servers explicitly when finished.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'list', 'output', 'wait', 'stop'] },
        command: { type: 'string', minLength: 1, maxLength: 16000 },
        cwd: {
          type: 'string',
          description: 'Working directory, relative to session cwd or absolute',
        },
        timeout: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 86400,
          description:
            'Seconds: start job deadline (default unlimited), or wait deadline (default 60); wait timeout does not stop the job',
        },
        id: { type: 'string' },
        lines: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(params, ctx) {
      ctx.signal.throwIfAborted();
      requireOpen();
      agentRef = agent;
      let text: string;
      let wait: WaitResult | undefined;
      if (params.action === 'start') {
        if (!params.command?.trim()) throw new Error('command is required for start.');
        const cwd = resolve(ctx.cwd, String(params.cwd ?? '.').replace(/^@/, ''));
        const task = manager.start({ command: params.command, cwd, timeout: params.timeout });
        text = `${summary(task)}\nLog: ${task.logPath}\nStarted in background; this is not a completion result.`;
      } else if (params.action === 'list') {
        text = manager.list().map(summary).join('\n') || 'No background tasks.';
      } else {
        if (!params.id) throw new Error('id is required.');
        if (params.action === 'wait') {
          wait = await manager.wait(params.id, { timeout: params.timeout, signal: ctx.signal });
          const notice =
            wait.outcome === 'finished'
              ? 'Wait finished; check task status and exit code.'
              : wait.outcome === 'timed_out'
                ? 'Wait timed out; the job was not stopped.'
                : 'Wait cancelled; the job was not stopped.';
          text = `${notice}\n${output(params.id, params.lines)}`;
          // The model saw the result; do not also wake it for this task.
          if (wait.outcome === 'finished') {
            const index = completed.findIndex((task) => task.id === params.id);
            if (index !== -1) completed.splice(index, 1);
          }
        } else if (params.action === 'stop') text = summary(await manager.stop(params.id));
        else if (params.action === 'output') text = output(params.id, params.lines);
        else throw new Error(`Unknown action ${params.action}`);
      }
      refresh();
      return {
        content: [{ type: 'text', text }],
        details: {
          ...(wait
            ? {
                wait: {
                  outcome: wait.outcome,
                  task: { ...wait.task, command: wait.task.command.slice(0, 180) },
                },
              }
            : {}),
          tasks: manager.list().map((task) => ({ ...task, command: task.command.slice(0, 180) })),
        },
      };
    },
  });

  return {
    name: 'background-task',
    tools: (agent) => [tool(agent)],
    init(agent) {
      agentRef = agent;
      refresh();
    },
    agentSettled() {
      noticePending = false;
      flush();
    },
    async shutdown(agent) {
      closed = true;
      if (agent.hasUI) agent.ui.setStatus('background-task', undefined);
      await manager.shutdown();
    },
    commands: {
      bg: {
        description: 'Background tasks: list / start / output / stop / stop-all',
        async run(agent, args) {
          agentRef = agent;
          requireOpen();
          const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
          const action = match?.[1] ?? 'list';
          const rest = match?.[2] ?? '';
          let text: string;
          if (action === 'start') {
            const task = manager.start({ command: rest, cwd: agent.config.workspace });
            text = `${summary(task)}\nLog: ${task.logPath}`;
          } else if (action === 'list')
            text = manager.list().map(summary).join('\n') || 'No background tasks.';
          else if (action === 'output') {
            const [id, lines, extra] = rest.split(/\s+/);
            if (!id || extra) throw new Error('Usage: /bg output <id> [lines]');
            text = output(id, lines === undefined ? 200 : Number(lines));
          } else if (action === 'stop') text = summary(await manager.stop(rest.trim()));
          else if (action === 'stop-all') {
            await Promise.all(
              manager
                .list()
                .filter((t) => t.status === 'running' || t.status === 'stopping')
                .map((t) => manager.stop(t.id)),
            );
            text = 'All background tasks stopped.';
          } else text = HELP;
          refresh();
          // Recorded for the model, without triggering a turn.
          agent.deliver(
            { customType: 'background-task-command', content: text, display: true },
            { triggerTurn: false },
          );
        },
      },
    },
  };
}
