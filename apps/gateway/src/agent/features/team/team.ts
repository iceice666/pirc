/**
 * Parent-side team broker (port of Pi's agent-team `Team`). Children are
 * `pirc agent --headless` subprocesses; they reach the broker through
 * `team_call` lines on their stdout instead of a localhost HTTP server.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { thinkingLevels } from '../../config.js';
import { killGroup } from '../../tools/bash.js';
import type { Question, QuestionResult } from '../ask-question.js';

type Json = Record<string, any>;
const THINKING = new Set<string>([...thinkingLevels, 'max']);
const KIND_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const RESULT_NOTICE_LIMIT = 2000;
export const DEFAULT_KINDS: Record<string, { model?: string; thinking?: string }> = {
  general: {},
};

export function validateKinds(
  value: unknown,
): Record<string, { model?: string; thinking?: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Agent kinds must be an object');
  const result: Record<string, { model?: string; thinking?: string }> = {};
  for (const [kind, preset] of Object.entries(value as Json)) {
    if (!KIND_NAME.test(kind) || ['parent', 'user'].includes(kind))
      throw new Error(`Invalid agent kind: ${kind}`);
    if (!preset || typeof preset !== 'object' || Array.isArray(preset))
      throw new Error(`Invalid agent kind preset: ${kind}`);
    const unknown = Object.keys(preset).filter((key) => !['model', 'thinking'].includes(key));
    if (unknown.length)
      throw new Error(`Unknown agent kind fields for ${kind}: ${unknown.join(', ')}`);
    const { model, thinking } = preset as Json;
    if (
      model !== undefined &&
      (typeof model !== 'string' || !model.includes('/') || model.length > 200)
    )
      throw new Error(`Invalid model for agent kind: ${kind}`);
    if (thinking !== undefined && !THINKING.has(thinking))
      throw new Error(`Invalid thinking level for agent kind: ${kind}`);
    result[kind] = {
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
    };
  }
  return result;
}

export function text(value: unknown, label = 'text', max = 12000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label} must contain 1–${max} characters`);
  return value;
}

/** Copy only validated question fields (children bypass tool schemas). */
export function userQuestion(args: Json): Question {
  const question: Question = { question: text(args.question, 'question') };
  if (args.header !== undefined) {
    if (typeof args.header !== 'string' || args.header.length > 120)
      throw new Error('Invalid question header');
    question.header = args.header;
  }
  if (args.multiSelect !== undefined) {
    if (typeof args.multiSelect !== 'boolean') throw new Error('multiSelect must be boolean');
    question.multiSelect = args.multiSelect;
  }
  if (args.options !== undefined) {
    if (!Array.isArray(args.options) || args.options.length > 12)
      throw new Error('options must be an array of at most 12 options');
    question.options = args.options.map((option: Json) => {
      if (!option || typeof option !== 'object' || Array.isArray(option))
        throw new Error('Invalid option');
      const result: { label: string; description?: string } = {
        label: text(option.label, 'option label', 1000),
      };
      if (option.description !== undefined) {
        if (typeof option.description !== 'string' || option.description.length > 4000)
          throw new Error('Invalid option description');
        result.description = option.description;
      }
      return result;
    });
    if (new Set(question.options!.map((o) => o.label)).size !== question.options!.length)
      throw new Error('Option labels must be unique');
  }
  if (JSON.stringify({ questions: [question] }).length > 24000)
    throw new Error('Questionnaire exceeds 24000 characters');
  const unsafe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  if (
    [
      question.question,
      question.header,
      ...(question.options ?? []).flatMap((o) => [o.label, o.description]),
    ].some((value) => value && unsafe.test(value))
  )
    throw new Error('Question text must not contain terminal control characters');
  return question;
}

function compactResult(entry: Json): Json {
  const body = typeof entry.body === 'string' ? entry.body : String(entry.body ?? '');
  const normalized = body
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const clipped = normalized.length > RESULT_NOTICE_LIMIT;
  return {
    ...entry,
    body: `${normalized.slice(0, RESULT_NOTICE_LIMIT)}${clipped ? '\n[Preview truncated]' : ''}\nFull result: agent_inbox event ${entry.id}`,
    ...(clipped ? { truncated: true } : {}),
  };
}

/** JSONL RPC client for one child agent process. */
export class ChildProcess {
  readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly exited: Promise<number>;
  stderr = '';
  private readonly pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private stopping?: Promise<void>;

  constructor(
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
    private readonly onEvent: (event: Json) => void,
  ) {
    this.proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    this.exited = this.proc.exited;
    void this.readStdout();
    const stderr = this.proc.stderr;
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stderr)
        this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-8192);
    })();
    void this.exited.then((code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Agent exited'));
      }
      this.pending.clear();
      this.onEvent({
        type: 'team_exit',
        code,
        signal: this.proc.signalCode,
        stderr: this.stderr.trim().slice(-2000),
      });
    });
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 16 * 1024 * 1024) {
        void this.stop();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let event: Json;
        try {
          event = JSON.parse(line);
        } catch {
          void this.stop();
          return;
        }
        if (event.type === 'response') {
          const pending = this.pending.get(event.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(event.id);
          if (event.success) pending.resolve(event.data);
          else pending.reject(new Error(event.error || 'RPC failed'));
        } else if (
          event.type === 'extension_ui_request' &&
          ['confirm', 'select', 'input', 'editor'].includes(event.method)
        ) {
          // Never auto-approve a child dialog, and never leave it hanging.
          this.write({ type: 'extension_ui_response', id: event.id, cancelled: true });
          this.onEvent({ type: 'team_dialog_cancelled', title: event.title });
        } else this.onEvent(event);
      }
    }
  }

  write(value: unknown): void {
    try {
      this.proc.stdin.write(`${JSON.stringify(value)}\n`);
      this.proc.stdin.flush();
    } catch {
      /* exiting */
    }
  }

  request(type: string, data: Json = {}, timeout = 30000): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...data, type, id });
    });
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      try {
        this.proc.stdin.end();
      } catch {
        /* closed */
      }
      killGroup(this.proc.pid, 'SIGTERM');
      const timer = setTimeout(() => killGroup(this.proc.pid, 'SIGKILL'), 1500);
      await this.exited;
      clearTimeout(timer);
      // The agent may exit before a descendant that ignored SIGTERM.
      killGroup(this.proc.pid, 'SIGKILL');
    })();
    return this.stopping;
  }
}

interface Member {
  name: string;
  kind: string;
  cwd: string;
  model: string;
  thinking: string;
  task: string;
  status: string;
  activity: string;
  startedAt: string;
  lastActivity: string;
  sessionFile?: string;
  lastError?: string;
  pid?: number;
  stateRevision: number;
  rpc?: ChildProcess;
  inflight: Map<string, AbortController>;
}
interface Waiter {
  who: string;
  agent: string;
  check(): void;
}

const live = (member: { status: string }) => !['stopped', 'failed'].includes(member.status);

export interface TeamOptions {
  directory: string;
  /** Command prefix that runs `pirc` (e.g. `[execPath]` or `[bun, cli.ts]`). */
  command: string[];
  deliverParent(entry: Json): void;
  askUser(question: Question, signal: AbortSignal, from: string): Promise<QuestionResult>;
  onChange?(state: ReturnType<Team['list']>): void;
  kinds?: Record<string, { model?: string; thinking?: string }>;
  limit?: number;
  env?: Record<string, string | undefined>;
}

export class Team {
  readonly directory: string;
  readonly kinds: Record<string, { model?: string; thinking?: string }>;
  readonly agents = new Map<string, Member>();
  readonly records: Json[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly userQuestions = new Map<
    string,
    { from: string; controller: AbortController; task?: Promise<void> }
  >();
  private closing = false;

  constructor(private readonly options: TeamOptions) {
    this.directory = options.directory;
    this.kinds = { ...DEFAULT_KINDS, ...(options.kinds ? validateKinds(options.kinds) : {}) };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private get limit() {
    return this.options.limit ?? 4;
  }

  record(kind: string, data: Json): Json {
    const entry = { id: randomUUID(), time: new Date().toISOString(), kind, ...data };
    appendFileSync(join(this.directory, 'events.jsonl'), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
    this.records.push(entry);
    this.notifyWaiters();
    return entry;
  }

  list() {
    return {
      directory: this.directory,
      kinds: Object.keys(this.kinds),
      agents: [...this.agents.values()].map(
        ({
          name,
          kind,
          status,
          cwd,
          model,
          thinking,
          sessionFile,
          lastError,
          task,
          pid,
          startedAt,
          lastActivity,
          activity,
        }) => ({
          name,
          kind,
          status,
          cwd,
          model,
          thinking,
          sessionFile,
          lastError,
          task,
          pid,
          startedAt,
          lastActivity,
          activity,
        }),
      ),
    };
  }

  private change(member: Member, status: string): void {
    member.status = status;
    member.activity = status;
    member.lastActivity = new Date().toISOString();
    member.stateRevision++;
    this.notifyWaiters();
    this.options.onChange?.(this.list());
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.check();
  }

  private answered(questionId: string): boolean {
    return this.records.some(
      (r) =>
        r.kind === 'reply' &&
        r.question_id === questionId &&
        !this.records.some((f) => f.kind === 'delivery_failed' && f.message_id === r.id),
    );
  }

  wait(who: string, args: Json, signal?: AbortSignal): Promise<Json> {
    const name = text(args.agent, 'agent', 40);
    if (name === who) throw new Error('Cannot wait for yourself');
    const member = this.agents.get(name);
    if (!member) throw new Error(`Unknown worker agent: ${name}; parent cannot be waited on`);
    const timeout = args.timeout ?? 60;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 86400)
      throw new Error('timeout must be seconds greater than 0 and at most 86400');
    // Parallel waits are allowed; follow every edge to reject cycles.
    const reaches = (from: string, seen = new Set<string>()): boolean => {
      if (from === who) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return [...this.waiters].some((w) => w.who === from && reaches(w.agent, seen));
    };
    if (reaches(name)) throw new Error('Wait would create a dependency cycle');
    return new Promise((resolvePromise) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (reason: string, question?: Json) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(waiter);
        resolvePromise({
          agent: name,
          reason,
          status: member.status,
          question_id: question?.id,
          question_to: question?.to,
          sessionFile: member.sessionFile,
        });
      };
      const abort = () => finish('cancelled');
      const waiter: Waiter = {
        who,
        agent: name,
        check: () => {
          if (signal?.aborted) return finish('cancelled');
          if (this.closing) return finish('closed');
          if (who !== 'parent' && !live(this.agents.get(who) ?? { status: 'stopped' }))
            return finish('caller_stopped');
          if (!live(member)) return finish(member.status);
          const question = this.records.find(
            (q) =>
              q.kind === 'question' &&
              (q.to === who || q.from === name) &&
              (q.from === 'parent' || live(this.agents.get(q.from) ?? { status: 'stopped' })) &&
              !this.answered(q.id),
          );
          if (question) return finish('question', question);
          if (member.status === 'waiting') return finish('blocked');
          if (member.status === 'idle') return finish('idle');
        },
      };
      this.waiters.add(waiter);
      timer = setTimeout(() => finish('timeout'), timeout * 1000);
      signal?.addEventListener('abort', abort, { once: true });
      waiter.check();
    });
  }

  async spawn(
    args: Json,
    defaults: { cwd: string; model?: string | undefined; thinking?: string | undefined },
    signal?: AbortSignal,
  ): Promise<Json> {
    if (this.closing) throw new Error('Team shutting down');
    const name = text(args.name, 'name', 40);
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || ['parent', 'user'].includes(name))
      throw new Error('Use a lowercase agent name; parent and user are reserved');
    if (this.agents.has(name)) throw new Error('Name already used in this team');
    if ([...this.agents.values()].filter(live).length >= this.limit)
      throw new Error(`Limit of ${this.limit} live agents reached`);
    const task = text(args.task, 'task');
    const cwd = resolve(defaults.cwd, args.cwd ?? '.');
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      throw new Error('cwd must be a directory');
    const kind = args.kind ?? 'general';
    const preset = typeof kind === 'string' ? this.kinds[kind] : undefined;
    if (!preset) throw new Error(`Unknown agent kind: ${kind}`);
    const model = args.model ?? preset.model ?? defaults.model;
    if (!model) throw new Error('Select a parent model or provide provider/model');
    const thinking = args.thinking ?? preset.thinking ?? defaults.thinking ?? 'off';
    if (!THINKING.has(thinking)) throw new Error('Invalid thinking level');
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const member: Member = {
      name,
      kind,
      cwd,
      model,
      thinking,
      task,
      startedAt,
      lastActivity: startedAt,
      activity: 'starting',
      status: 'starting',
      stateRevision: 0,
      inflight: new Map(),
    };
    // Reserve before awaiting so parallel spawns respect the limit.
    this.agents.set(name, member);
    const dir = join(this.directory, name);
    mkdirSync(dir, { mode: 0o700 });
    const abort = () => {
      if (member.rpc) void this.stop(name);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.change(member, 'starting');
      member.rpc = new ChildProcess(
        [
          ...this.options.command,
          'agent',
          '--headless',
          '--session-dir',
          dir,
          '--model',
          model,
          '--thinking',
          thinking === 'max' ? 'xhigh' : thinking,
          '--name',
          `team:${name}`,
        ],
        {
          cwd,
          env: {
            ...(this.options.env ?? process.env),
            PIRC_TEAM_AGENT: name,
            PIRC_TEAM_PARENT_PID: String(process.pid),
          },
        },
        (event) => this.event(member, event),
      );
      member.pid = member.rpc.proc.pid;
      const state = await member.rpc.request('get_state');
      if (this.closing || member.status === 'stopped')
        throw new Error('Agent stopped during startup');
      member.sessionFile = state.sessionFile;
      this.record('spawn', { name, cwd, model, thinking, sessionFile: member.sessionFile });
      this.change(member, 'running');
      await this.send('parent', name, task, 'task');
      signal?.throwIfAborted();
      return this.list().agents.find((item) => item.name === name)!;
    } catch (error) {
      member.lastError = (error as Error).message;
      this.change(member, 'failed');
      if (member.rpc) await member.rpc.stop();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private event(member: Member, event: Json): void {
    member.lastActivity = new Date().toISOString();
    if (event.type === 'team_call') return void this.childCall(member, event);
    if (event.type === 'team_cancel') {
      member.inflight.get(event.id)?.abort();
      return;
    }
    if (this.closing || member.status === 'stopped') return;
    if (event.type === 'message_update')
      member.activity = event.assistantMessageEvent?.type?.startsWith('thinking')
        ? 'thinking'
        : 'responding';
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update')
      member.activity = `tool: ${String(event.toolName ?? 'tool').slice(0, 120)}`;
    if (event.type === 'tool_execution_end') member.activity = 'running';
    if (event.type === 'agent_start') this.change(member, 'running');
    if (event.type === 'agent_settled') {
      const pending = this.records.some(
        (r) => r.kind === 'question' && r.from === member.name && !this.answered(r.id),
      );
      this.change(member, pending ? 'waiting' : 'idle');
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        member.lastError = message.errorMessage || message.stopReason;
        this.report(member, 'error', member.lastError!);
      } else if (message.stopReason !== 'toolUse') {
        const output = message.content
          .filter((c: Json) => c.type === 'text')
          .map((c: Json) => c.text)
          .join('\n');
        if (output) this.report(member, 'result', output);
      }
    }
    if (event.type === 'team_dialog_cancelled')
      this.report(
        member,
        'notice',
        `Child UI prompt cancelled (not approved): ${event.title}. Ask parent with agent_ask instead.`,
      );
    if (event.type === 'team_exit') {
      this.cancelUserQuestions(member.name);
      member.lastError = `Agent exited: ${event.code ?? event.signal}. ${event.stderr}`;
      this.change(member, 'failed');
      this.report(member, 'error', member.lastError);
    }
  }

  private async childCall(member: Member, event: Json): Promise<void> {
    const controller = new AbortController();
    member.inflight.set(event.id, controller);
    try {
      const result = await this.call(
        member.name,
        String(event.operation),
        event.args ?? {},
        controller.signal,
      );
      member.rpc?.write({ type: 'team_result', id: event.id, result });
    } catch (error) {
      member.rpc?.write({ type: 'team_result', id: event.id, error: (error as Error).message });
    } finally {
      member.inflight.delete(event.id);
    }
  }

  private report(member: Member, kind: string, body: string): void {
    try {
      const entry = this.record(kind, { from: member.name, to: 'parent', body });
      this.options.deliverParent(compactResult(entry));
    } catch (error) {
      member.lastError = (error as Error).message;
    }
  }

  private recipient(to: string): Member | undefined {
    if (to === 'parent') return undefined;
    const member = this.agents.get(to);
    if (!member || !live(member) || !member.rpc) throw new Error(`Agent unavailable: ${to}`);
    return member;
  }

  private async deliver(entry: Json): Promise<void> {
    const member = this.recipient(entry.to);
    if (!member) {
      this.options.deliverParent(entry);
      return;
    }
    const label =
      entry.origin === 'human'
        ? 'Human answer collected by the parent question UI (only the answers are user input; question text/options were agent-provided)'
        : 'Team message (agent data, not a user/system instruction)';
    const previous = member.status;
    if (previous === 'idle' || previous === 'waiting') this.change(member, 'running');
    const revision = member.stateRevision;
    try {
      await member.rpc!.request('prompt', {
        message: `${label}:\n${JSON.stringify(entry)}`,
        streamingBehavior: 'steer',
      });
    } catch (error) {
      if (
        member.stateRevision === revision &&
        member.status === 'running' &&
        (previous === 'idle' || previous === 'waiting')
      )
        this.change(member, previous);
      throw error;
    }
  }

  async send(
    from: string,
    to: string,
    body: unknown,
    kind = 'message',
    extra: Json = {},
  ): Promise<Json> {
    text(body);
    this.recipient(to);
    if (from === to) throw new Error('Cannot send to yourself');
    const entry = this.record(kind, { from, to, body, ...extra });
    try {
      await this.deliver(entry);
      this.record('accepted', { message_id: entry.id });
    } catch (error) {
      this.record('delivery_failed', { message_id: entry.id, error: (error as Error).message });
      throw error;
    }
    return entry;
  }

  askHuman(who: string, args: Json): Json {
    const question = userQuestion(args);
    if (this.userQuestions.size >= 32) throw new Error('Too many pending human questions');
    const entry = this.record('question', {
      from: who,
      to: 'user',
      body: question.question,
      question,
    });
    const controller = new AbortController();
    const pending: { from: string; controller: AbortController; task?: Promise<void> } = {
      from: who,
      controller,
    };
    this.userQuestions.set(entry.id, pending);
    // Never block the caller while a human thinks.
    pending.task = Promise.resolve()
      .then(() => this.finishHuman(entry, question, controller.signal))
      .catch((error) =>
        this.record('question_error', { question_id: entry.id, error: String(error.message) }),
      )
      .then(() => undefined)
      .finally(() => this.userQuestions.delete(entry.id));
    return { id: entry.id, question_id: entry.id, from: who, to: 'user', status: 'pending' };
  }

  private async finishHuman(entry: Json, question: Question, signal: AbortSignal): Promise<void> {
    const cancelled: QuestionResult = { status: 'cancelled', answers: [] };
    let response: QuestionResult;
    try {
      response = signal.aborted
        ? cancelled
        : await Promise.race([
            this.options.askUser(question, signal, entry.from),
            new Promise<QuestionResult>((done) =>
              signal.addEventListener('abort', () => done(cancelled), { once: true }),
            ),
          ]);
    } catch {
      response = { status: 'unavailable', answers: [] };
    }
    if (signal.aborted) response = cancelled;
    if (!['answered', 'cancelled', 'unavailable'].includes(response?.status))
      response = { status: 'unavailable', answers: [] };
    if (response.status !== 'answered') response = { status: response.status, answers: [] };
    const answered = response.status === 'answered';
    const reply = this.record('reply', {
      from: answered ? 'user' : 'team',
      to: entry.from,
      origin: answered ? 'human' : 'team',
      question_id: entry.id,
      status: response.status,
      answers: response.answers,
      body: answered
        ? 'Human response received; see answers.'
        : `Human question ${response.status}; no authorization granted.`,
    });
    if (
      this.closing ||
      (entry.from !== 'parent' && !live(this.agents.get(entry.from) ?? { status: 'stopped' }))
    )
      return;
    try {
      await this.deliver(reply);
      this.record('accepted', { message_id: reply.id });
    } catch (error) {
      this.record('delivery_failed', { message_id: reply.id, error: (error as Error).message });
    }
  }

  private cancelUserQuestions(who?: string): void {
    for (const pending of this.userQuestions.values())
      if (!who || pending.from === who) pending.controller.abort();
  }

  async call(
    who: string,
    operation: string,
    args: Json = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closing) throw new Error('Team shutting down');
    if (who !== 'parent' && !live(this.agents.get(who) ?? { status: 'stopped' }))
      throw new Error('Unknown sender');
    switch (operation) {
      case 'agent_list':
        return this.list();
      case 'agent_wait':
        return this.wait(who, args, signal);
      case 'agent_send':
        return this.send(who, args.to, args.message);
      case 'agent_ask':
        return args.to === 'user'
          ? this.askHuman(who, args)
          : this.send(who, args.to ?? 'parent', args.question, 'question');
      case 'agent_reply': {
        const q = this.records.find((r) => r.id === args.question_id && r.kind === 'question');
        if (!q || q.to === 'user' || q.to !== who)
          throw new Error('Question not found or not addressed to you');
        if (this.answered(q.id)) throw new Error('Question already answered');
        return this.send(who, q.from, args.answer, 'reply', { question_id: q.id });
      }
      case 'board_post': {
        text(args.topic, 'topic', 100);
        text(args.body);
        if (args.reply_to && !this.records.some((r) => r.kind === 'post' && r.id === args.reply_to))
          throw new Error('Post not found');
        return this.record('post', {
          from: who,
          topic: args.topic,
          body: args.body,
          reply_to: args.reply_to,
        });
      }
      case 'board_read':
        return this.page(
          this.records.filter((r) => r.kind === 'post' && (!args.topic || r.topic === args.topic)),
          args,
        );
      case 'agent_inbox':
        return this.page(
          this.records.filter((r) => r.to === who || r.from === who),
          args,
        );
      case 'agent_stop':
        if (who !== 'parent') throw new Error('Only parent can stop agents');
        await this.stop(text(args.agent, 'agent', 40));
        return { stopped: args.agent };
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  private page(records: Json[], args: Json): Json {
    const index = args.after ? records.findIndex((r) => r.id === args.after) : -1;
    if (args.after && index < 0) throw new Error('Cursor not found in this query');
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
    const items: Json[] = [];
    let size = 0;
    for (const r of records.slice(index + 1, index + 1 + limit)) {
      let entry =
        r.body?.length > 12000 ? { ...r, body: r.body.slice(0, 12000), truncated: true } : r;
      if (Buffer.byteLength(JSON.stringify(entry)) > 39000)
        entry = {
          id: r.id,
          time: r.time,
          kind: r.kind,
          from: r.from,
          to: r.to,
          question_id: r.question_id,
          status: r.status,
          origin: r.origin,
          truncated: true,
          body: 'Oversized entry; read full event in archive.',
        };
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (size + bytes > 40000 && items.length) break;
      items.push(entry);
      size += bytes;
    }
    return {
      items,
      next: items.at(-1)?.id ?? args.after ?? null,
      more: index + 1 + items.length < records.length,
      archive: join(this.directory, 'events.jsonl'),
    };
  }

  async stop(name: string): Promise<void> {
    const member = this.agents.get(name);
    if (!member) throw new Error('Unknown agent');
    this.cancelUserQuestions(name);
    for (const controller of member.inflight.values()) controller.abort();
    this.change(member, 'stopped');
    if (member.rpc) await member.rpc.stop();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.notifyWaiters();
    this.cancelUserQuestions();
    await Promise.all([...this.userQuestions.values()].map((p) => p.task));
    await Promise.all(
      [...this.agents.values()].map(async (member) => {
        member.status = 'stopped';
        await member.rpc?.stop();
      }),
    );
    writeFileSync(join(this.directory, 'team.json'), JSON.stringify(this.list(), null, 2), {
      mode: 0o600,
    });
  }
}
