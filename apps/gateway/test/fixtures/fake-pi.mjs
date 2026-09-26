#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

let configured = false;

rl.on('line', (raw) => {
  const command = JSON.parse(raw);
  // Like `pirc agent`, the node's first line carries the gateway's providers.
  if (!configured) {
    if (command.type !== 'configure') process.exit(3);
    configured = true;
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
      thinkingLevel: 'medium',
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
  if (
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
  if (command.type === 'follow_up') {
    queue.followUp.push(command.message);
    line({ type: 'queue_update', ...queue });
    return response();
  }
  if (command.type === 'prompt') {
    response();
    if (command.message === 'crash') return process.exit(17);
    line({ type: 'agent_start' });
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
  if (command.type === 'extension_ui_response') return;
  response(false, undefined, 'unsupported');
});
