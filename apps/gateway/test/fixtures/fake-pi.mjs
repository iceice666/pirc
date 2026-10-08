#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

// Like `pirc agent`, messages live in `<session-dir>/session.jsonl` (the node
// reads history from it) and each is written before its message_end.
const dirFlag = process.argv.indexOf('--session-dir');
const sessionDir = dirFlag === -1 ? null : process.argv[dirFlag + 1];
const sessionFile = sessionDir ? path.join(sessionDir, 'session.jsonl') : null;
let lastEntry = null;
let nextEntry = 0;
const persist = (message) => {
  if (!sessionFile) return;
  const id = `fake-${process.pid}-${++nextEntry}`;
  appendFileSync(
    sessionFile,
    `${JSON.stringify({ type: 'message', id, parentId: lastEntry, timestamp: Date.now(), message })}\n`,
  );
  lastEntry = id;
};

// While a deliberately split line is half written, other output waits so it
// cannot land in the middle of it (e.g. a get_state reply during a snapshot).
let held = null;
const line = (value) => {
  const text = `${JSON.stringify(value)}\n`;
  if (held) held.push(text);
  else process.stdout.write(text);
};
const writeSplit = (bytes, splitAt, delayMs, after) => {
  process.stdout.write(bytes.subarray(0, splitAt));
  held = [];
  setTimeout(() => {
    process.stdout.write(bytes.subarray(splitAt));
    const pending = held;
    held = null;
    for (const text of pending) process.stdout.write(text);
    after();
  }, delayMs);
};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let messages = [];
if (sessionFile && existsSync(sessionFile))
  for (const text of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (!text.trim()) continue;
    const entry = JSON.parse(text);
    lastEntry = entry.id;
    if (entry.type === 'message') messages.push(entry.message);
  }
else if (sessionDir) mkdirSync(sessionDir, { recursive: true });
let queue = { steering: [], followUp: [] };
const agentSettings = { thinkingLevel: 'medium', model: null };

let configured = false;
// The project instructions the node sent on the configure line.
let projectInstructions = '';
// `write <path>` / `hold <path>` prompts ask the node's write broker for a
// lease, like a file tool would; `hold` keeps the run open until abort.
const leases = new Map();
// Dialogs a delivered task opened, answered by `extension_ui_response`.
const dialogs = new Map();
let dialogCount = 0;
// `gateway <op> [json args]` asks the gateway through the node, like a feature would.
const gatewayCalls = new Map();
let gatewayCount = 0;
// `sandbox <op> <json args>` asks the node's sandbox (network approval, unsandboxed exec).
const sandboxCalls = new Map();
let sandboxCount = 0;
const reply = (text) =>
  settle({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
const settle = (message) => {
  messages.push(message);
  persist(message);
  line({ type: 'message_end', message });
  line({ type: 'agent_end', willRetry: false });
  line({ type: 'agent_settled' });
};

rl.on('line', (raw) => {
  const command = JSON.parse(raw);
  // Like `pirc agent`, the node's first line carries the gateway's providers.
  if (!configured) {
    if (command.type !== 'configure') process.exit(3);
    configured = true;
    projectInstructions = typeof command.instructions === 'string' ? command.instructions : '';
    return;
  }
  if (command.type === 'sandbox_response') {
    sandboxCalls.get(command.id)?.(command);
    sandboxCalls.delete(command.id);
    return;
  }
  const response = (success = true, data, error) =>
    line({
      id: command.id,
      type: 'response',
      command: command.type,
      success,
      ...(data === undefined ? {} : { data }),
      ...(error ? { error } : {}),
    });
  if (command.type === 'get_state')
    return response(true, {
      sessionId: 'fake-session',
      thinkingLevel: agentSettings.thinkingLevel,
      ...(agentSettings.model ? { model: agentSettings.model } : {}),
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      autoCompactionEnabled: true,
      messageCount: messages.length,
      pendingMessageCount: 0,
    });
  if (command.type === 'get_messages') return response(true, { messages });
  if (command.type === 'get_available_models')
    return response(true, { models: [{ provider: 'fake', id: 'fake-model', name: 'Fake' }] });
  // Model and thinking changes show in get_state (a scheduled run picks its own).
  if (command.type === 'set_model')
    agentSettings.model = { provider: command.provider, id: command.modelId };
  if (command.type === 'set_thinking_level') agentSettings.thinkingLevel = command.level;
  // A delegated session's role (the real agent applies it; see Agent.setRole).
  if (command.type === 'set_role') agentSettings.role = command.role;
  if (
    command.type === 'set_role' ||
    command.type === 'set_session_name' ||
    command.type === 'set_model' ||
    command.type === 'set_thinking_level'
  )
    return response();
  if (command.type === 'clear_queue') {
    const old = queue;
    queue = { steering: [], followUp: [] };
    line({ type: 'queue_update', ...queue });
    return response(true, old);
  }
  if (command.type === 'abort') {
    line({ type: 'agent_settled' });
    return response();
  }
  if (command.type === 'steer') {
    queue.steering.push(command.message);
    line({ type: 'queue_update', ...queue });
    return response();
  }
  if (command.type === 'send_now') {
    const list = queue[command.queue];
    if (!list || list[command.index] !== command.message)
      return response(false, undefined, 'That message is no longer queued');
    list.splice(command.index, 1);
    line({ type: 'queue_update', ...queue });
    return response();
  }
  if (command.type === 'follow_up') {
    queue.followUp.push(command.message);
    line({ type: 'queue_update', ...queue });
    return response();
  }
  if (command.type === 'prompt') {
    response();
    if (command.message === 'crash') return process.exit(17);
    // Crash with a process left in the agent's group (like a busy ptc script process).
    const orphan = /^crash leaving (.+)$/.exec(command.message);
    if (orphan) {
      const child = spawn('sleep', ['60'], { stdio: 'ignore' });
      writeFileSync(orphan[1], String(child.pid));
      return process.exit(17);
    }
    line({ type: 'agent_start' });
    const lease = /^(write|hold) (.+)$/.exec(command.message);
    if (lease) {
      const id = `lease-${leases.size + 1}`;
      leases.set(id, (reply) => {
        const text = reply.granted ? 'lease:granted' : `lease:refused ${reply.error}`;
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text }],
          stopReason: 'stop',
        };
        if (lease[1] === 'write' || !reply.granted) settle(message);
        else line({ type: 'message_end', message });
      });
      line({ type: 'write_lease_request', id, path: lease[2] });
      return;
    }
    const gateway = /^gateway (\S+)(?: (.+))?$/s.exec(command.message);
    if (gateway) {
      const id = `gateway-${++gatewayCount}`;
      gatewayCalls.set(id, (answer) =>
        reply(
          answer.ok
            ? `gateway:ok ${JSON.stringify(answer.result)}`
            : `gateway:error ${JSON.stringify(answer.error)}`,
        ),
      );
      line({
        type: 'gateway_request',
        id,
        op: gateway[1],
        args: gateway[2] ? JSON.parse(gateway[2]) : {},
      });
      return;
    }
    const sandbox = /^sandbox (\S+) (.+)$/s.exec(command.message);
    if (sandbox) {
      const id = `sandbox-${++sandboxCount}`;
      sandboxCalls.set(id, (answer) =>
        reply(
          answer.ok
            ? `sandbox:ok ${JSON.stringify(answer.result)}`
            : `sandbox:error ${JSON.stringify(answer.error)}`,
        ),
      );
      line({ type: 'sandbox_request', id, op: sandbox[1], args: JSON.parse(sandbox[2]) });
      return;
    }
    // `forge` tries to open and cancel dialogs in the node's own namespace.
    if (command.message === 'forge') {
      line({
        type: 'extension_ui_request',
        id: 'node-sandbox-forged',
        method: 'confirm',
        title: 'Harmless?',
        message: 'Approve',
      });
      line({ type: 'extension_ui_request', method: 'cancel', targetId: 'node-sandbox-anything' });
      return reply('forged');
    }
    // `cwd` reports the directory the node started this agent in.
    if (command.message === 'cwd') return reply(`cwd:${process.cwd()}`);
    if (command.message === 'instructions') return reply(`instructions:${projectInstructions}`);
    // `env <NAME>` reports what the node put in this agent's environment.
    const env = /^env (\S+)$/.exec(command.message);
    if (env) {
      const value = process.env[env[1]];
      return reply(value === undefined ? `env:${env[1]} unset` : `env:${env[1]}=${value}`);
    }
    line({ type: 'message_start', message: { role: 'assistant', content: [] } });
    const utf8 = Buffer.from(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'snowman ☃' },
      }) + '\n',
    );
    const message = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: command.images?.length
            ? `echo:${command.message} images:${command.images.map((image) => image.mimeType).join(',')}`
            : `echo:${command.message}`,
        },
      ],
      stopReason: 'stop',
    };
    messages.push(message);
    writeSplit(utf8, utf8.length - 3, 5, () => {
      if (command.message === 'ask')
        line({
          type: 'extension_ui_request',
          id: 'question-1',
          method: 'confirm',
          title: 'Continue?',
          message: 'Confirm',
          timeout: 5000,
        });
    });
    setTimeout(() => {
      persist(message);
      line({ type: 'message_end', message });
      line({ type: 'agent_end', willRetry: false });
      line({ type: 'agent_settled' });
    }, 10);
    return;
  }
  if (command.type === 'deliver') {
    // A gateway push (a delegated task, news of one): recorded like the real
    // agent does, then answered with `done:<delegation>:<type>`. A task that
    // says "ask the user" first waits for an answer in a dialog.
    response();
    const pushed = command.message ?? {};
    const custom = {
      role: 'custom',
      customType: pushed.customType,
      content: pushed.content,
      display: true,
      ...(pushed.details ? { details: pushed.details } : {}),
      timestamp: Date.now(),
    };
    messages.push(custom);
    persist(custom);
    line({ type: 'agent_start' });
    // "crash the loop": the agent loop fails before any answer, as with no model.
    if (/crash the loop/i.test(String(pushed.content))) {
      line({ type: 'agent_error', error: 'Agent loop crashed: No model configured' });
      line({ type: 'agent_settled' });
      return;
    }
    // Keep a scheduled run active until deletion aborts the runner.
    if (pushed.customType === 'scheduled-run' && /hold scheduled run/i.test(String(pushed.content)))
      return;
    const done = () =>
      reply(
        `done:${pushed.details?.delegationId ?? pushed.details?.runId ?? ''}:${pushed.customType}`,
      );
    if (
      !['assistant-delegation', 'scheduled-run'].includes(pushed.customType) ||
      !/ask the user/i.test(String(pushed.content))
    )
      return done();
    const id = `dialog-${++dialogCount}`;
    dialogs.set(id, done);
    line({
      type: 'extension_ui_request',
      id,
      method: 'confirm',
      title: 'May I go on?',
      message: 'The task asked to check with the user first.',
      timeout: 60_000,
    });
    return;
  }
  if (command.type === 'extension_ui_response') {
    const done = dialogs.get(command.id);
    dialogs.delete(command.id);
    return done?.();
  }
  if (command.type === 'write_lease_response') return leases.get(command.id)?.(command);
  if (command.type === 'gateway_response') {
    const done = gatewayCalls.get(command.id);
    gatewayCalls.delete(command.id);
    return done?.(command);
  }
  response(false, undefined, 'unsupported');
});
