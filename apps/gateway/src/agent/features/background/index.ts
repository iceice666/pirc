import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Agent } from '../../agent.js';
import { offInChat, type Feature } from '../../feature.js';
import { truncateOutput } from '../../sandbox.js';
import type { Tool } from '../../tools/types.js';
import { TaskManager, MATCH_LIMIT, type TaskInfo, type WaitResult } from './manager.js';
import { toolPrompt } from '../../prompts/tools.js';
import {
  bool,
  byAction,
  int,
  nullable,
  obj,
  oneOfStrings,
  str,
} from '../../tools/result-schema.js';

const TASK = obj(
  {
    id: str(),
    command: str('Cut at 2000 characters'),
    cwd: str(),
    status: str('running, stopping, completed, failed, stopped or timed_out'),
    pid: int(),
    exitCode: nullable(int()),
    signal: nullable(str()),
    logPath: str(),
    tty: bool(),
    notifyOn: str(),
    matches: int(),
    startedAt: str(),
    endedAt: str(),
    error: str(),
  },
  ['pid', 'exitCode', 'signal', 'tty', 'notifyOn', 'matches', 'endedAt', 'error'],
);
const OUTPUT = {
  output: str('The latest output lines (terminal control characters removed)'),
  truncated: bool('Display cut; the whole log is at task.logPath'),
};
const BACKGROUND_RESULT = byAction({
  start: { properties: { task: TASK } },
  list: { properties: { tasks: { type: 'array', items: TASK } } },
  output: { properties: { task: TASK, ...OUTPUT } },
  wait: {
    properties: {
      outcome: oneOfStrings(['finished', 'timed_out', 'aborted'], 'timed_out: the job still runs'),
      task: TASK,
      ...OUTPUT,
    },
  },
  write: { properties: { task: TASK, sent: int('Characters sent'), ...OUTPUT } },
  monitor: { properties: { task: TASK } },
  stop: { properties: { task: TASK } },
});

/** A task as the typed result shows it (only documented fields). */
function taskData(task: TaskInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: task.id,
    command: clean(task.command).slice(0, 2000),
    cwd: task.cwd,
    status: task.status,
    logPath: task.logPath,
    startedAt: task.startedAt,
  };
  if (typeof task.pid === 'number') out.pid = task.pid;
  if (task.exitCode !== undefined) out.exitCode = task.exitCode;
  if (task.signal !== undefined) out.signal = task.signal;
  if (task.tty !== undefined) out.tty = task.tty;
  if (task.notifyOn !== undefined) out.notifyOn = task.notifyOn;
  if (task.matches !== undefined) out.matches = task.matches;
  if (task.endedAt !== undefined) out.endedAt = task.endedAt;
  if (task.error !== undefined) out.error = task.error;
  return out;
}

const HELP = `/bg or /bg list — List tasks
/bg start <shell command> — Run in the background
/bg tty <shell command> — Run on a pseudo-terminal (accepts input)
/bg write <id> <text> — Send a line of input to a tty task
/bg output <id> [lines] — Show recent output (default: 200 lines)
/bg stop <id> — Stop the process group
/bg stop-all — Stop all tasks
Aborting a run does not stop background tasks; closing the session does.
Tasks run with the current user's permissions, not in a sandbox.`;
const clean = (text: string) =>
  stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const summary = (task: TaskInfo) =>
  `${task.id} · ${task.status}${task.exitCode != null ? ` (exit ${task.exitCode})` : ''}${task.tty ? ' · tty' : ''}${task.notifyOn ? ` · notify_on /${task.notifyOn}/ (${task.matches ?? 0} matches)` : ''} · ${clean(task.command).replace(/\s+/g, ' ').slice(0, 180)}`;
const tailLines = (text: string, lines: number) => text.split('\n').slice(-lines).join('\n');
/** Matched lines kept per task between wakeups. */
const PENDING_MATCHES = 20;
const MATCH_CHARS = 500;
const unescapeInput = (value: string) =>
  value.replace(/\\(n|r|t|e|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|\\)/g, (_m, code: string) => {
    if (code === 'n') return '\n';
    if (code === 'r') return '\r';
    if (code === 't') return '\t';
    if (code === 'e') return '\x1b';
    if (code === '\\') return '\\';
    return String.fromCharCode(parseInt(code.slice(1), 16));
  });

export function backgroundFeature(): Feature {
  let agentRef: Agent | undefined;
  let closed = false;
  let noticePending = false;
  const completed: TaskInfo[] = [];
  /** Monitor matches awaiting a wakeup, by task. */
  const matched = new Map<string, { task: TaskInfo; lines: string[]; dropped: number }>();

  const refresh = () => {
    if (!agentRef || closed) return;
    agentRef.panelChanged('background');
    if (!agentRef.hasUI) return;
    const running = manager.list().filter((t) => t.status === 'running' || t.status === 'stopping');
    agentRef.ui.setStatus('background-task', running.length ? `BG ${running.length}` : undefined);
  };
  /** Coalesce finished tasks and monitor matches into one wake-up while idle. */
  const flush = () => {
    const agent = agentRef;
    if (!agent || closed || noticePending || agent.isRunning) return;
    if (!completed.length && !matched.size) return;
    const tasks = completed.splice(0);
    const matches = [...matched.values()];
    matched.clear();
    noticePending = true;
    const parts: string[] = [];
    if (matches.length)
      parts.push(
        `Background output matched (notify_on):\n${matches
          .map(
            (m) =>
              `${m.task.id} /${m.task.notifyOn ?? ''}/:\n${m.lines.map((line) => `  ${line}`).join('\n')}${m.dropped ? `\n  [${m.dropped} more matching line${m.dropped === 1 ? '' : 's'}; use output]` : ''}${(m.task.matches ?? 0) >= MATCH_LIMIT ? `\n  [Monitor switched off after ${MATCH_LIMIT} matches]` : ''}`,
          )
          .join('\n')}`,
      );
    if (tasks.length)
      parts.push(
        `${tasks.length} background task${tasks.length === 1 ? '' : 's'} finished:\n${tasks
          .map((t) => `${t.id} · ${t.status}${t.exitCode != null ? ` (exit ${t.exitCode})` : ''}`)
          .join('\n')}`,
      );
    parts.push('Use background_task list/output to inspect results.');
    agent.deliver(
      {
        customType: tasks.length ? 'background-task-finished' : 'background-task-output',
        display: true,
        content: parts.join('\n'),
        details: {
          status: tasks.length === 1 ? tasks[0]!.status : tasks.length ? 'completed' : 'matched',
          tasks,
          matches: matches.map((m) => ({ id: m.task.id, lines: m.lines, dropped: m.dropped })),
        },
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
    {
      onMatch(task, line) {
        if (closed) return;
        const entry = matched.get(task.id) ?? { task, lines: [], dropped: 0 };
        entry.task = task;
        if (entry.lines.length < PENDING_MATCHES)
          entry.lines.push(clean(line).slice(0, MATCH_CHARS));
        else entry.dropped++;
        matched.set(task.id, entry);
        refresh();
        flush();
      },
    },
  );
  /** A task's latest output: the text for the model and the typed fields. */
  const outputOf = (id: string, lines = 200) => {
    if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
      throw new Error('lines must be an integer from 1 to 2000.');
    const task = manager.get(id);
    const raw = clean(manager.output(id, lines));
    const markers = raw
      .split('\n')
      .filter((line) => /^\[(Output|Log) truncated:/.test(line))
      .join('\n');
    const tail = truncateOutput(tailLines(raw, lines), 48 * 1024);
    return {
      text: `${summary(task)}\ncwd: ${task.cwd}\nLog (capped at 10 MiB): ${task.logPath}\n${tail.truncated ? `[Display truncated]\n${markers ? `${markers}\n` : ''}` : ''}${tail.text}`,
      fields: { task: taskData(task), output: tail.text, truncated: tail.truncated },
    };
  };
  const output = (id: string, lines = 200) => outputOf(id, lines).text;
  const requireOpen = () => {
    if (closed) throw new Error('Background task runtime has shut down.');
  };

  const tool = (agent: Agent): Tool => ({
    name: 'background_task',
    ptc: true,
    description: toolPrompt('background_task'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'list', 'output', 'wait', 'write', 'monitor', 'stop'],
        },
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
        tty: {
          type: 'boolean',
          description: 'start: run on a pseudo-terminal that accepts input via write',
        },
        notify_on: {
          type: 'string',
          maxLength: 500,
          description:
            'start/monitor: regular expression; matching output lines wake you. monitor without it clears the monitor',
        },
        input: {
          type: 'string',
          maxLength: 65536,
          description: 'write: raw text sent to the terminal; include \\n to press Enter',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    resultSchema: BACKGROUND_RESULT,
    async execute(params, ctx) {
      ctx.signal.throwIfAborted();
      requireOpen();
      agentRef = agent;
      let text: string;
      let data: Record<string, unknown>;
      let wait: WaitResult | undefined;
      if (params.action === 'start') {
        if (!params.command?.trim()) throw new Error('command is required for start.');
        const cwd = resolve(ctx.cwd, String(params.cwd ?? '.').replace(/^@/, ''));
        const task = manager.start({
          command: params.command,
          cwd,
          timeout: params.timeout,
          tty: params.tty === true,
          notifyOn: params.notify_on,
        });
        text = `${summary(task)}\nLog: ${task.logPath}\nStarted in background; this is not a completion result.`;
        data = { task: taskData(task) };
      } else if (params.action === 'list') {
        text = manager.list().map(summary).join('\n') || 'No background tasks.';
        data = { tasks: manager.list().map(taskData) };
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
          const shown = outputOf(params.id, params.lines);
          text = `${notice}\n${shown.text}`;
          data = { outcome: wait.outcome, ...shown.fields };
          // The model saw the result; do not also wake it for this task.
          if (wait.outcome === 'finished') {
            const index = completed.findIndex((task) => task.id === params.id);
            if (index !== -1) completed.splice(index, 1);
          }
        } else if (params.action === 'write') {
          if (typeof params.input !== 'string' || !params.input)
            throw new Error('input is required for write.');
          const task = manager.write(params.id, params.input);
          // Give the program a moment to react so the reply includes its response.
          await Bun.sleep(300);
          const shown = outputOf(task.id, params.lines ?? 40);
          text = `Sent ${params.input.length} characters.\n${shown.text}`;
          data = { sent: params.input.length, ...shown.fields };
        } else if (params.action === 'monitor') {
          const task = manager.monitor(params.id, params.notify_on);
          matched.delete(task.id);
          text = task.notifyOn
            ? `${summary(task)}\nMonitoring output for /${task.notifyOn}/.`
            : `${summary(task)}\nMonitor cleared.`;
          data = { task: taskData(task) };
        } else if (params.action === 'stop') {
          const task = await manager.stop(params.id);
          text = summary(task);
          data = { task: taskData(task) };
        } else if (params.action === 'output') {
          const shown = outputOf(params.id, params.lines);
          text = shown.text;
          data = shown.fields;
        } else throw new Error(`Unknown action ${params.action}`);
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
        data: { action: params.action, ...data },
      };
    },
  });

  return {
    name: 'background-task',
    tools: (agent) => (offInChat(agent, 'background') ? [] : [tool(agent)]),
    init(agent) {
      agentRef = agent;
      refresh();
    },
    agentSettled() {
      noticePending = false;
      flush();
    },
    panel() {
      return {
        backgroundTasks: manager.list().map(({ logPath: _log, ...task }) => ({
          ...task,
          command: clean(task.command).slice(0, 2000),
        })),
      };
    },
    rpc: {
      async background_output(_agent, command) {
        const id = String(command.taskId ?? '');
        const lines = Number(command.lines ?? 400);
        const task = manager.get(id);
        if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
          throw new Error('lines must be an integer from 1 to 2000.');
        const tail = truncateOutput(tailLines(clean(manager.output(id, lines)), lines), 64 * 1024);
        const { logPath: _log, ...info } = task;
        return { task: { ...info, command: clean(task.command) }, output: tail.text };
      },
      /**
       * Stop requested from the web UI. Returns at once (status `stopping`);
       * the finish flows through the usual completion notice, so the model
       * learns the task was stopped.
       */
      async background_stop(agent, command) {
        agentRef = agent;
        requireOpen();
        const id = String(command.taskId ?? '');
        const before = manager.get(id);
        if (before.status === 'running') {
          void manager.stop(id).then(refresh, () => undefined);
          refresh();
        }
        const { logPath: _log, ...info } = manager.get(id);
        return { task: { ...info, command: clean(info.command) } };
      },
    },
    async shutdown(agent) {
      closed = true;
      if (agent.hasUI) agent.ui.setStatus('background-task', undefined);
      await manager.shutdown();
    },
    commands: {
      bg: {
        description: 'Background tasks: list / start / tty / write / output / stop / stop-all',
        async run(agent, args) {
          agentRef = agent;
          requireOpen();
          const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
          const action = match?.[1] ?? 'list';
          const rest = match?.[2] ?? '';
          let text: string;
          if (action === 'start' || action === 'tty') {
            const task = manager.start({
              command: rest,
              cwd: agent.config.workspace,
              tty: action === 'tty',
            });
            text = `${summary(task)}\nLog: ${task.logPath}`;
          } else if (action === 'write') {
            const [, id, input] = /^(\S+)\s+([\s\S]+)$/.exec(rest) ?? [];
            if (!id || !input) throw new Error('Usage: /bg write <id> <text>');
            text = summary(manager.write(id, `${unescapeInput(input)}\n`));
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
