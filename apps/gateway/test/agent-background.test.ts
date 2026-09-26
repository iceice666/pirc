import { afterEach, describe, expect, it } from 'bun:test';
import { TaskManager } from '../src/agent/features/background/manager.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
const managers: TaskManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.shutdown()));
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

describe('TaskManager', () => {
  it('captures output, exit codes and wait outcomes', async () => {
    const finished: string[] = [];
    const manager = new TaskManager((task) => finished.push(`${task.id}:${task.status}`));
    managers.push(manager);
    const ok = manager.start({ command: 'echo hello; echo err >&2', cwd: '/tmp' });
    const bad = manager.start({ command: 'exit 3', cwd: '/tmp' });
    expect((await manager.wait(ok.id)).task.status).toBe('completed');
    expect(manager.output(ok.id)).toContain('hello');
    expect(manager.output(ok.id)).toContain('err');
    const failed = await manager.wait(bad.id);
    expect(failed.task.status).toBe('failed');
    expect(failed.task.exitCode).toBe(3);
    const slow = manager.start({ command: 'sleep 5', cwd: '/tmp' });
    expect((await manager.wait(slow.id, { timeout: 0.1 })).outcome).toBe('timed_out');
    expect(manager.get(slow.id).status).toBe('running');
    expect(finished).toHaveLength(2);
  });

  it('stops process groups, enforces timeouts and the active limit', async () => {
    const manager = new TaskManager();
    managers.push(manager);
    const started = Date.now();
    const tree = manager.start({ command: 'sleep 30 & sleep 30; wait', cwd: '/tmp' });
    const stopped = await manager.stop(tree.id);
    expect(stopped.status).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(2000);
    const timed = manager.start({ command: 'sleep 30', cwd: '/tmp', timeout: 0.2 });
    expect((await manager.wait(timed.id)).task.status).toBe('timed_out');
    for (let i = 0; i < 8; i++) manager.start({ command: 'sleep 30', cwd: '/tmp' });
    expect(() => manager.start({ command: 'true', cwd: '/tmp' })).toThrow(/At most 8/);
    // A shell that exits while a child keeps the pipes open still finishes.
    await manager.shutdown();
    const other = new TaskManager();
    managers.push(other);
    const orphan = other.start({ command: '(sleep 30 &) ; echo done', cwd: '/tmp' });
    const result = await other.wait(orphan.id, { timeout: 5 });
    expect(result.outcome).toBe('finished');
    expect(result.task.status).toBe('completed');
  });
});

describe('TaskManager terminals and monitors', () => {
  it('runs a task on a PTY that accepts input', async () => {
    const manager = new TaskManager();
    managers.push(manager);
    const task = manager.start({
      command: 'read -p "name? " n; echo "hi $n"; [ -t 0 ] && echo tty-ok',
      cwd: '/tmp',
      tty: true,
    });
    expect(task.tty).toBe(true);
    await Bun.sleep(200);
    manager.write(task.id, 'bob\n');
    const result = await manager.wait(task.id, { timeout: 5 });
    expect(result.task.status).toBe('completed');
    expect(manager.output(task.id)).toContain('hi bob');
    expect(manager.output(task.id)).toContain('tty-ok');
    expect(() => manager.write(task.id, 'x')).toThrow(/not running/);
    const piped = manager.start({ command: 'sleep 5', cwd: '/tmp' });
    expect(() => manager.write(piped.id, 'x')).toThrow(/no terminal/);
  });

  it('reports output lines that match the monitor pattern', async () => {
    const lines: string[] = [];
    const manager = new TaskManager(undefined, undefined, {
      onMatch: (_task, line) => lines.push(line),
    });
    managers.push(manager);
    expect(() => manager.start({ command: 'true', cwd: '/tmp', notifyOn: '(' })).toThrow(
      /Invalid notify_on/,
    );
    const task = manager.start({
      command:
        'echo ok; echo "ERROR one"; printf "\\033[31mERROR two\\033[0m\\n"; printf "ERROR tail"',
      cwd: '/tmp',
      notifyOn: 'ERROR',
    });
    await manager.wait(task.id, { timeout: 5 });
    expect(lines).toEqual(['ERROR one', 'ERROR two', 'ERROR tail']);
    expect(manager.get(task.id).matches).toBe(3);
    const other = manager.start({ command: 'sleep 0.2; echo late-match', cwd: '/tmp' });
    manager.monitor(other.id, 'late');
    await manager.wait(other.id, { timeout: 5 });
    expect(lines.at(-1)).toBe('late-match');
  });
});

describe('background_task tool', () => {
  it('wakes the agent with matched output and supports write', async () => {
    const agent = await startAgent();
    agents.push(agent);
    agent.llm.push(
      {
        tool: {
          id: 'b1',
          name: 'background_task',
          args: {
            action: 'start',
            tty: true,
            notify_on: 'READY',
            command: 'sleep 0.2; echo READY; read line; echo "got $line"; sleep 30',
          },
        },
      },
      { text: 'Waiting for the server.' },
      {
        dynamic: (body) => {
          const last = JSON.stringify(body.messages.at(-1).content);
          const id = /([0-9a-f]{8}) \//.exec(last)![1]!;
          return {
            tool: {
              id: 'w1',
              name: 'background_task',
              args: { action: 'write', id, input: 'ping\n' },
            },
          };
        },
      },
      { text: 'Sent input.' },
    );
    await agent.send({ type: 'prompt', message: 'start server' });
    const wake = await agent.waitFor(
      (e) =>
        e.type === 'message_end' &&
        e.message.role === 'custom' &&
        e.message.customType === 'background-task-output',
    );
    expect(wake.message.content).toContain('READY');
    await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.content?.[0]?.text === 'Sent input.',
    );
    const end = agent.events.findLast((e) => e.type === 'tool_execution_end');
    expect(end!.isError).toBeFalsy();
    expect(end!.result.content[0].text).toContain('got ping');
  });

  it('wakes the idle agent once when background work finishes', async () => {
    const agent = await startAgent();
    agents.push(agent);
    agent.llm.push(
      {
        tool: {
          id: 'b1',
          name: 'background_task',
          args: { action: 'start', command: 'sleep 0.3; echo built' },
        },
      },
      { text: 'Started the build; I will check when it finishes.' },
      { text: 'The build finished.' },
    );
    await agent.send({ type: 'prompt', message: 'build in background' });
    const wake = await agent.waitFor(
      (e) =>
        e.type === 'message_end' &&
        e.message.role === 'custom' &&
        e.message.customType === 'background-task-finished',
    );
    expect(wake.message.content).toContain('1 background task finished');
    await agent.waitFor(
      (e) =>
        e.type === 'message_end' &&
        e.message.role === 'assistant' &&
        e.message.content[0]?.text === 'The build finished.',
    );
    expect(agent.llm.requests).toHaveLength(3);
    const status = agent.events.filter(
      (e) => e.type === 'extension_ui_request' && e.method === 'setStatus',
    );
    expect(status.some((e) => e.statusText === 'BG 1')).toBe(true);
  });

  it('does not wake the agent for tasks it already waited on', async () => {
    const agent = await startAgent();
    agents.push(agent);
    agent.llm.push(
      {
        dynamic: () => ({
          tool: {
            id: 's',
            name: 'background_task',
            args: { action: 'start', command: 'echo quick' },
          },
        }),
      },
      {
        dynamic: (body) => {
          const started = body.messages.at(-1).content as string;
          const id = started.split(' ')[0];
          return { tool: { id: 'w', name: 'background_task', args: { action: 'wait', id } } };
        },
      },
      { text: 'done' },
    );
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'quick task' });
    await settledAfter(agent, from);
    const waited = agent.events.findLast((e) => e.type === 'tool_execution_end');
    expect(waited!.result.content[0].text).toContain('Wait finished');
    expect(waited!.result.content[0].text).toContain('quick');
    await Bun.sleep(300);
    expect(agent.llm.requests).toHaveLength(3);
  });

  it('stops background tasks when the agent shuts down', async () => {
    const agent = await startAgent();
    agents.push(agent);
    await agent.send({ type: 'prompt', message: '/bg start sleep 60' });
    const listed = await agent.waitFor(
      (e) => e.type === 'message_end' && e.message.customType === 'background-task-command',
    );
    const pidMatch = /^(\w+)/.exec(listed.message.content)!;
    expect(pidMatch).toBeTruthy();
    const pgrep = () => Bun.spawnSync(['pgrep', '-f', 'sleep 60']).stdout.toString().trim();
    expect(pgrep()).not.toBe('');
    await agent.close();
    agents.splice(0);
    await Bun.sleep(200);
    expect(pgrep()).toBe('');
  });

  it('reports tasks and output to the side panel', async () => {
    const agent = await startAgent();
    agents.push(agent);
    await agent.send({ type: 'prompt', message: '/bg start echo panel-output; sleep 60' });
    await agent.waitFor((e) => e.type === 'panel_changed' && e.sections.includes('background'));
    const state = await agent.send({ type: 'get_panel_state' });
    expect(state.success).toBe(true);
    const [task] = state.data.backgroundTasks;
    expect(task.status).toBe('running');
    expect(task.logPath).toBeUndefined();
    expect(state.data.memoryRuntime).toMatchObject({ phase: null, autoCompacting: false });
    await Bun.sleep(100);
    const output = await agent.send({ type: 'background_output', taskId: task.id });
    expect(output.data.output).toContain('panel-output');
    const missing = await agent.send({ type: 'background_output', taskId: 'nope' });
    expect(missing.success).toBe(false);
  });
});
