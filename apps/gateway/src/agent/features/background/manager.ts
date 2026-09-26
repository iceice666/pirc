/**
 * Port of the Pi background-task TaskManager on Bun.spawn. Tasks run with
 * pipes (no stdin) or, with `tty`, on a PTY that accepts input; either can
 * watch its output for a pattern and report matching lines.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Subprocess, Terminal } from 'bun';
import { killGroup } from '../../tools/bash.js';

export type TaskStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'timed_out';
export interface TaskInfo {
  id: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  logPath: string;
  /** Runs on a pseudo-terminal and accepts input. */
  tty?: boolean;
  /** Output lines matching this pattern are reported (monitor mode). */
  notifyOn?: string;
  /** Monitor matches so far. */
  matches?: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
}
export interface WaitResult {
  outcome: 'finished' | 'timed_out' | 'aborted';
  task: TaskInfo;
}
interface RecordState {
  info: TaskInfo;
  child: Subprocess;
  terminal?: Terminal;
  fd: number | undefined;
  monitor?: { pattern: RegExp; decoder: TextDecoder; partial: string } | undefined;
  tail: Buffer;
  bytes: number;
  tailTruncated: boolean;
  logTruncated: boolean;
  timeout?: ReturnType<typeof setTimeout> | undefined;
  killTimer?: ReturnType<typeof setTimeout> | undefined;
  reason?: 'stopped' | 'timed_out';
  finished: boolean;
  done: Promise<void>;
  resolve: () => void;
  waiters: Set<() => void>;
  readers: Array<{ cancel(): Promise<void> }>;
}
const TAIL_LIMIT = 1024 * 1024;
const LOG_LIMIT = 10 * 1024 * 1024;
export const ACTIVE_LIMIT = 8;
const HISTORY_LIMIT = 100;
const LINE_LIMIT = 4096;
const INPUT_LIMIT = 64 * 1024;
/** Monitor matches reported per task before the monitor switches itself off. */
export const MATCH_LIMIT = 200;
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function compileMonitor(pattern: unknown): RegExp {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 500)
    throw new Error('notify_on must be a regular expression of 1–500 characters');
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`Invalid notify_on pattern: ${(error as Error).message}`);
  }
}

export interface TaskManagerHooks {
  /** A monitored task printed a line that matches its pattern. */
  onMatch?(task: TaskInfo, line: string): void;
}

export class TaskManager {
  private records = new Map<string, RecordState>();
  private directory?: string;
  private closing = false;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly onFinish?: (task: TaskInfo) => void,
    private readonly env: () => Record<string, string | undefined> = () => process.env,
    private readonly hooks: TaskManagerHooks = {},
  ) {}

  start(options: {
    command: string;
    cwd: string;
    timeout?: number | undefined;
    tty?: boolean | undefined;
    notifyOn?: string | undefined;
  }): TaskInfo {
    if (this.closing) throw new Error('Task manager is shut down');
    if (process.platform === 'win32') throw new Error('Background tasks require macOS or Linux');
    if (
      typeof options.command !== 'string' ||
      !options.command.trim() ||
      options.command.length > 16000 ||
      options.command.includes('\0')
    )
      throw new Error(
        'command must be a nonempty string of at most 16000 characters without NUL characters',
      );
    if (
      !isAbsolute(options.cwd) ||
      !statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()
    )
      throw new Error('cwd must be an existing absolute directory');
    if (
      options.timeout !== undefined &&
      (typeof options.timeout !== 'number' ||
        !Number.isFinite(options.timeout) ||
        options.timeout <= 0 ||
        options.timeout * 1000 > 2_147_483_647)
    )
      throw new Error('timeout must be positive seconds, at most 2147483.647');
    const pattern = options.notifyOn === undefined ? undefined : compileMonitor(options.notifyOn);
    if ([...this.records.values()].filter((r) => !r.finished).length >= ACTIVE_LIMIT)
      throw new Error(`At most ${ACTIVE_LIMIT} background tasks may be active`);
    if (this.records.size >= HISTORY_LIMIT) {
      const oldest = [...this.records.values()].find((r) => r.finished);
      if (oldest) this.records.delete(oldest.info.id);
    }
    this.directory ??= mkdtempSync(join(tmpdir(), 'pirc-background-'));
    const id = randomUUID().slice(0, 8);
    const logPath = join(this.directory, `${id}.log`);
    const fd = openSync(logPath, 'wx', 0o600);
    let child: Subprocess;
    let terminal: Terminal | undefined;
    let record: RecordState | undefined;
    const buffered: Buffer[] = [];
    try {
      if (options.tty) {
        terminal = new Bun.Terminal({
          cols: 200,
          rows: 50,
          name: 'xterm-256color',
          data: (_terminal, data) => {
            const chunk = Buffer.from(data);
            if (record) this.append(record, chunk);
            else buffered.push(chunk);
          },
        });
        child = Bun.spawn(['bash', '-c', options.command], {
          cwd: options.cwd,
          env: { ...this.env(), TERM: 'xterm-256color' },
          terminal,
          detached: true,
        });
      } else
        child = Bun.spawn(['bash', '-c', options.command], {
          cwd: options.cwd,
          env: this.env(),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true,
        });
    } catch (error) {
      closeSync(fd);
      terminal?.close();
      throw error;
    }
    let resolve!: () => void;
    const done = new Promise<void>((complete) => {
      resolve = complete;
    });
    record = {
      info: {
        id,
        command: options.command,
        cwd: options.cwd,
        status: 'running',
        pid: child.pid,
        logPath,
        ...(options.tty ? { tty: true } : {}),
        ...(pattern ? { notifyOn: pattern.source, matches: 0 } : {}),
        startedAt: new Date().toISOString(),
      },
      child,
      ...(terminal ? { terminal } : {}),
      ...(pattern ? { monitor: { pattern, decoder: new TextDecoder(), partial: '' } } : {}),
      fd,
      tail: Buffer.alloc(0),
      bytes: 0,
      tailTruncated: false,
      logTruncated: false,
      finished: false,
      done,
      resolve,
      waiters: new Set(),
      readers: [],
    };
    const state = record;
    this.records.set(id, state);
    for (const chunk of buffered.splice(0)) this.append(state, chunk);
    if (terminal) {
      void child.exited.then((code) => {
        clearTimeout(state.timeout);
        state.info.exitCode = child.signalCode ? null : code;
        state.info.signal = child.signalCode ?? null;
        // Kill leftovers, let the PTY drain, then close it.
        if (!state.reason) killGroup(child.pid, 'SIGKILL');
        setTimeout(() => {
          try {
            terminal.close();
          } catch {
            /* closed */
          }
          this.finish(state);
        }, 50);
      });
      if (options.timeout !== undefined)
        state.timeout = setTimeout(
          () => this.requestStop(state, 'timed_out'),
          options.timeout * 1000,
        );
      return { ...state.info };
    }
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      state.readers.push(reader);
      try {
        while (true) {
          const { value, done: ended } = await reader.read();
          if (ended) break;
          this.append(state, Buffer.from(value));
        }
      } catch {
        /* cancelled */
      }
    };
    const piped = child as Subprocess<'ignore', 'pipe', 'pipe'>;
    const pipes = Promise.all([pump(piped.stdout), pump(piped.stderr)]);
    void child.exited.then((code) => {
      clearTimeout(state.timeout);
      state.info.exitCode = child.signalCode ? null : code;
      state.info.signal = child.signalCode ?? null;
      // The shell exited; kill leftovers that still hold the pipes.
      if (!state.reason) {
        killGroup(child.pid, 'SIGKILL');
        state.killTimer = setTimeout(() => this.disconnectAndFinish(state), 500);
      }
      void pipes.then(() => {
        if (!state.reason || !state.killTimer) this.finish(state);
      });
    });
    if (options.timeout !== undefined)
      state.timeout = setTimeout(
        () => this.requestStop(state, 'timed_out'),
        options.timeout * 1000,
      );
    return { ...state.info };
  }

  list(): TaskInfo[] {
    return [...this.records.values()].map((r) => ({ ...r.info }));
  }
  get(id: string): TaskInfo {
    return { ...this.lookup(id).info };
  }
  get activeCount(): number {
    return [...this.records.values()].filter((r) => !r.finished).length;
  }

  output(id: string, lines = 200): string {
    if (!Number.isSafeInteger(lines) || lines <= 0)
      throw new Error('lines must be a positive safe integer');
    const record = this.lookup(id);
    const parts = record.tail.toString('utf8').split('\n');
    if (parts.at(-1) === '') parts.pop();
    const notices: string[] = [];
    if (record.tailTruncated) notices.push('[Output truncated: showing the retained 1 MiB tail.]');
    if (record.logTruncated)
      notices.push('[Log truncated: the log file contains only the first 10 MiB.]');
    return [...notices, ...parts.slice(-lines)].join('\n');
  }

  wait(id: string, options: { timeout?: number | undefined; signal?: AbortSignal } = {}) {
    const record = this.lookup(id);
    const timeout = options.timeout ?? 60;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400)
      throw new Error('wait timeout must be positive seconds, at most 86400');
    const { signal } = options;
    if (signal?.aborted)
      return Promise.resolve<WaitResult>({ outcome: 'aborted', task: { ...record.info } });
    if (record.finished)
      return Promise.resolve<WaitResult>({ outcome: 'finished', task: { ...record.info } });
    return new Promise<WaitResult>((resolve) => {
      let settled = false;
      const settle = (outcome: WaitResult['outcome']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(onFinish);
        signal?.removeEventListener('abort', onAbort);
        resolve({ outcome, task: { ...record.info } });
      };
      const onFinish = () => settle('finished');
      const onAbort = () => settle('aborted');
      record.waiters.add(onFinish);
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => settle('timed_out'), timeout * 1000);
      if (signal?.aborted) onAbort();
      else if (record.finished) onFinish();
    });
  }

  /** Send input to a PTY task (keystrokes: \n for Enter, \u0003 for Ctrl-C, \u0004 for EOF). */
  write(id: string, input: string): TaskInfo {
    const record = this.lookup(id);
    if (typeof input !== 'string' || !input || input.length > INPUT_LIMIT)
      throw new Error(`input must be 1–${INPUT_LIMIT} characters`);
    if (!record.terminal) throw new Error(`Task ${id} has no terminal; start it with tty: true`);
    if (record.finished || record.reason || record.terminal.closed)
      throw new Error(`Task ${id} is not running`);
    record.terminal.write(input);
    return { ...record.info };
  }

  /** Start, replace or (with undefined) clear a task's output monitor. */
  monitor(id: string, pattern: string | undefined): TaskInfo {
    const record = this.lookup(id);
    if (record.finished) throw new Error(`Task ${id} has finished`);
    if (pattern === undefined) {
      record.monitor = undefined;
      delete record.info.notifyOn;
    } else {
      const compiled = compileMonitor(pattern);
      record.monitor = { pattern: compiled, decoder: new TextDecoder(), partial: '' };
      record.info.notifyOn = compiled.source;
      record.info.matches = 0;
    }
    return { ...record.info };
  }

  async stop(id: string): Promise<TaskInfo> {
    const record = this.lookup(id);
    this.requestStop(record, 'stopped');
    await record.done;
    return { ...record.info };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = (async () => {
      const records = [...this.records.values()];
      for (const record of records) this.requestStop(record, 'stopped');
      await Promise.all(records.map((r) => r.done));
    })();
    return this.shutdownPromise;
  }

  private lookup(id: string): RecordState {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown background task: ${id}`);
    return record;
  }

  private scan(record: RecordState, data: Buffer, flush = false): void {
    const monitor = record.monitor;
    if (!monitor) return;
    const text = monitor.partial + monitor.decoder.decode(data, { stream: !flush });
    const lines = text.split(/\r?\n|\r(?!\n)/);
    monitor.partial = flush ? '' : (lines.pop() ?? '');
    if (monitor.partial.length > LINE_LIMIT) {
      lines.push(monitor.partial);
      monitor.partial = '';
    }
    for (const raw of lines) {
      if (record.monitor !== monitor) return;
      const line = raw.replace(ANSI, '').slice(0, LINE_LIMIT);
      if (!line.trim()) continue;
      monitor.pattern.lastIndex = 0;
      if (!monitor.pattern.test(line)) continue;
      const matches = (record.info.matches ?? 0) + 1;
      record.info.matches = matches;
      if (matches >= MATCH_LIMIT) {
        // Too chatty for wakeups: switch the monitor off.
        record.monitor = undefined;
        delete record.info.notifyOn;
      }
      try {
        this.hooks.onMatch?.({ ...record.info }, line);
      } catch {
        /* consumer callbacks cannot break output capture */
      }
    }
  }

  private append(record: RecordState, data: Buffer): void {
    if (record.finished) return;
    this.scan(record, data);
    if (record.tail.length + data.length > TAIL_LIMIT) record.tailTruncated = true;
    record.tail =
      data.length >= TAIL_LIMIT
        ? Buffer.from(data.subarray(-TAIL_LIMIT))
        : Buffer.concat([
            record.tail.subarray(Math.max(0, record.tail.length + data.length - TAIL_LIMIT)),
            data,
          ]);
    if (record.bytes + data.length > LOG_LIMIT) record.logTruncated = true;
    const writable = Math.min(data.length, LOG_LIMIT - record.bytes);
    if (writable > 0 && record.fd !== undefined) {
      try {
        let offset = 0;
        while (offset < writable) offset += writeSync(record.fd, data, offset, writable - offset);
        record.bytes += writable;
      } catch (error) {
        record.info.error = `Cannot write task log: ${String(error)}`;
        closeSync(record.fd);
        record.fd = undefined;
        this.requestStop(record, 'stopped');
      }
    }
  }

  private requestStop(record: RecordState, reason: 'stopped' | 'timed_out'): void {
    if (record.finished || record.reason) return;
    record.reason = reason;
    record.info.status = 'stopping';
    clearTimeout(record.timeout);
    clearTimeout(record.killTimer);
    killGroup(record.child.pid, 'SIGTERM');
    record.killTimer = setTimeout(() => {
      killGroup(record.child.pid, 'SIGKILL');
      record.killTimer = undefined;
      this.disconnectAndFinish(record);
    }, 500);
  }

  private disconnectAndFinish(record: RecordState): void {
    for (const reader of record.readers) void reader.cancel().catch(() => {});
    this.finish(record);
  }

  private finish(record: RecordState): void {
    if (record.finished) return;
    this.scan(record, Buffer.alloc(0), true);
    record.finished = true;
    if (record.terminal && !record.terminal.closed)
      try {
        record.terminal.close();
      } catch {
        /* closed */
      }
    clearTimeout(record.timeout);
    clearTimeout(record.killTimer);
    if (record.fd !== undefined) {
      try {
        closeSync(record.fd);
      } catch {
        /* best effort */
      }
      record.fd = undefined;
    }
    record.info.status =
      record.reason ?? (record.info.exitCode === 0 && !record.info.error ? 'completed' : 'failed');
    record.info.endedAt = new Date().toISOString();
    record.resolve();
    for (const waiter of record.waiters) waiter();
    if (!this.closing) {
      try {
        this.onFinish?.({ ...record.info });
      } catch {
        /* consumer callbacks cannot break cleanup */
      }
    }
  }
}
