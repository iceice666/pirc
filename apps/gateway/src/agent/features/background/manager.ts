/** Port of the Pi background-task TaskManager on Bun.spawn. */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Subprocess } from 'bun';
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
  child: Subprocess<'ignore', 'pipe', 'pipe'>;
  fd: number | undefined;
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

export class TaskManager {
  private records = new Map<string, RecordState>();
  private directory?: string;
  private closing = false;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly onFinish?: (task: TaskInfo) => void,
    private readonly env: () => Record<string, string | undefined> = () => process.env,
  ) {}

  start(options: { command: string; cwd: string; timeout?: number | undefined }): TaskInfo {
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
    let child: Subprocess<'ignore', 'pipe', 'pipe'>;
    try {
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
      throw error;
    }
    let resolve!: () => void;
    const done = new Promise<void>((complete) => {
      resolve = complete;
    });
    const record: RecordState = {
      info: {
        id,
        command: options.command,
        cwd: options.cwd,
        status: 'running',
        pid: child.pid,
        logPath,
        startedAt: new Date().toISOString(),
      },
      child,
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
    this.records.set(id, record);
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      record.readers.push(reader);
      try {
        while (true) {
          const { value, done: ended } = await reader.read();
          if (ended) break;
          this.append(record, Buffer.from(value));
        }
      } catch {
        /* cancelled */
      }
    };
    const pipes = Promise.all([pump(child.stdout), pump(child.stderr)]);
    void child.exited.then((code) => {
      clearTimeout(record.timeout);
      record.info.exitCode = child.signalCode ? null : code;
      record.info.signal = child.signalCode ?? null;
      // The shell exited; kill leftovers that still hold the pipes.
      if (!record.reason) {
        killGroup(child.pid, 'SIGKILL');
        record.killTimer = setTimeout(() => this.disconnectAndFinish(record), 500);
      }
      void pipes.then(() => {
        if (!record.reason || !record.killTimer) this.finish(record);
      });
    });
    if (options.timeout !== undefined)
      record.timeout = setTimeout(
        () => this.requestStop(record, 'timed_out'),
        options.timeout * 1000,
      );
    return { ...record.info };
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

  private append(record: RecordState, data: Buffer): void {
    if (record.finished) return;
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
    record.finished = true;
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
