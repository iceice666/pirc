import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { JsonlParser } from '../node/rpc-framing.js';
import { canonicalJson } from '../environment/json.js';
import { workerSeccomp } from './seccomp.js';
import { WORKER_FRAME_BYTES, type WorkerAction } from './worker.js';
import { untilCancelled } from './cancellation.js';

export interface RuntimeWorker {
  drive(step: (action: WorkerAction) => Promise<WorkerAction>, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

const requestSchema = z
  .object({ seq: z.number().int().positive(), action: z.enum(['model', 'tools', 'done']) })
  .strict();

/** No fallback. Only an operator-selected shipped executable is ever mounted. */
export class GatewayWorkerProcess implements RuntimeWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly requests: Array<z.infer<typeof requestSchema>> = [];
  private wake: (() => void) | undefined;
  private failure: Error | undefined;
  private readonly failed = new AbortController();
  private ended = false;
  private driving = false;
  private expectedSeq = 1;
  private sandboxPid: number | undefined;
  private readonly root: string;
  private readonly monitor: ReturnType<typeof setInterval>;

  constructor(options: { executable: string; bubblewrap?: string; maxRssBytes?: number }) {
    if (process.platform !== 'linux')
      throw new Error(
        'Gateway runtime isolation unsupported on this platform; no unsandboxed fallback',
      );
    const bubblewrap = Bun.which(options.bubblewrap ?? process.env.PIRC_GATEWAY_BWRAP ?? 'bwrap');
    if (!bubblewrap) throw new Error('Gateway worker sandbox unavailable');
    const executable = realpathSync(options.executable);
    // Resolve only the trusted runtime's dynamic loader/libraries, never a host directory.
    const ldd = Bun.which('ldd');
    if (!ldd) throw new Error('Cannot resolve worker runtime libraries');
    const dependencies = spawnSync(ldd, [executable], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65_536,
    });
    if (dependencies.status !== 0) throw new Error('Cannot resolve worker runtime libraries');
    const libraries = new Set(dependencies.stdout.match(/\/[^\s()]+/g) ?? []);
    if (!libraries.size || libraries.size > 64) throw new Error('Invalid worker library closure');
    const assets = [...libraries].map((library) => ({
      source: realpathSync(library),
      target: library,
    }));
    const seccomp = workerSeccomp(process.arch);
    this.root = mkdtempSync(path.join(os.tmpdir(), 'pirc-gateway-worker-'));
    const filter = path.join(this.root, 'seccomp');
    writeFileSync(filter, seccomp, { mode: 0o600 });
    const fd = openSync(filter, 'r');
    const args = [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--as-pid-1',
      '--uid',
      '65534',
      '--gid',
      '65534',
      '--cap-drop',
      'ALL',
      '--clearenv',
      '--setenv',
      'HOME',
      '/home/worker',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'BUN_JSC_forceRAMSize',
      '268435456',
      '--ro-bind',
      executable,
      '/runtime/worker',
    ];
    for (const asset of assets) args.push('--ro-bind', asset.source, asset.target);
    args.push(
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--size',
      String(1024 * 1024),
      '--tmpfs',
      '/dev/shm',
      '--size',
      String(16 * 1024 * 1024),
      '--tmpfs',
      '/tmp',
      '--size',
      String(1024 * 1024),
      '--tmpfs',
      '/home/worker',
      '--chdir',
      '/home/worker',
      '--seccomp',
      '3',
      '--json-status-fd',
      '4',
      '--',
      '/runtime/worker',
    );
    try {
      this.child = spawn(bubblewrap, args, {
        env: {},
        stdio: ['pipe', 'pipe', 'pipe', fd, 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      rmSync(this.root, { recursive: true, force: true });
      throw error;
    } finally {
      closeSync(fd);
    }
    const fail = (error: Error) => {
      this.failure ??= error;
      this.failed.abort(this.failure);
      this.child.kill('SIGKILL');
      this.wake?.();
    };
    const parser = new JsonlParser(WORKER_FRAME_BYTES, (value) => {
      const request = requestSchema.parse(value);
      if (request.seq !== this.expectedSeq++ || this.requests.length >= 1)
        throw new Error('Worker IPC sequence/queue violation');
      this.requests.push(request);
      this.wake?.();
    });
    // This pipe belongs to the trusted bwrap parent and is closed before worker exec.
    const statusParser = new JsonlParser(WORKER_FRAME_BYTES, (value) => {
      const status = value as Record<string, unknown>;
      if ('child-pid' in status) {
        if (
          this.sandboxPid ||
          !Number.isSafeInteger(status['child-pid']) ||
          Number(status['child-pid']) <= 0
        )
          throw new Error('Invalid sandbox process identity');
        this.sandboxPid = Number(status['child-pid']);
        this.wake?.();
      }
    });
    const statusPipe = this.child.stdio[4] as NodeJS.ReadableStream;
    statusPipe.on('data', (chunk: Buffer) => {
      try {
        statusParser.push(chunk);
      } catch {
        fail(new Error('Gateway worker resource supervision unavailable'));
      }
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        parser.push(chunk);
      } catch {
        fail(new Error('Invalid gateway worker IPC'));
      }
    });
    let diagnostics = 0;
    this.child.stderr.on('data', (chunk: Buffer) => {
      // Never forward worker text into user messages or logs.
      diagnostics += chunk.length;
      if (diagnostics > WORKER_FRAME_BYTES)
        fail(new Error('Gateway worker diagnostic quota exceeded'));
    });
    this.child.on('error', () => fail(new Error('Gateway worker sandbox unavailable')));
    this.child.stdin.on('error', () => fail(new Error('Gateway worker IPC closed')));
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code) => {
        this.ended = true;
        if (code !== 0)
          this.failure ??= new Error('Gateway worker interrupted or sandbox unavailable');
        try {
          parser.end();
        } catch {
          this.failure ??= new Error('Gateway worker truncated IPC');
        }
        this.wake?.();
        if (this.failure) this.failed.abort(this.failure);
        resolve();
      });
    });
    this.monitor = setInterval(() => {
      try {
        // bwrap is the trusted parent; do not accept PIDs supplied by the worker.
        const pids = [this.child.pid!, ...(this.sandboxPid ? [this.sandboxPid] : [])];
        let rss = 0;
        for (const pid of pids) {
          const status = readFileSync(`/proc/${pid}/status`, 'utf8');
          rss += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
        }
        if (rss > (options.maxRssBytes ?? 512 * 1024 * 1024))
          fail(new Error('Gateway worker memory/process quota exceeded'));
      } catch (error) {
        // Exit and /proc removal race; other monitoring failures refuse admission.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !this.ended)
          fail(new Error('Gateway worker resource supervision unavailable'));
      }
    }, 100);
  }

  async drive(step: (action: WorkerAction) => Promise<WorkerAction>, signal: AbortSignal) {
    if (this.driving) throw new Error('Gateway worker already active');
    this.driving = true;
    let expected: WorkerAction = 'model';
    const cancellation = AbortSignal.any([signal, this.failed.signal]);
    const abort = () => {
      this.failure ??= new Error('Gateway worker cancelled');
      this.child.kill('SIGKILL');
      this.wake?.();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      this.failure ??= new Error('Gateway worker deadline exceeded');
      abort();
    }, 60 * 60_000);
    try {
      for (;;) {
        while ((!this.requests.length || !this.sandboxPid) && !this.failure && !this.ended)
          await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = undefined;
        if (this.failure) throw this.failure;
        const request = this.requests.shift();
        if (!request || request.action !== expected)
          throw new Error('Gateway worker phase mismatch');
        const next: WorkerAction = await untilCancelled(step(request.action), cancellation);
        cancellation.throwIfAborted();
        const frame = canonicalJson({ seq: request.seq, next }, WORKER_FRAME_BYTES) + '\n';
        await new Promise<void>((resolve, reject) => {
          this.child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
        });
        if (request.action === 'done') {
          await this.exited;
          if (this.failure) throw this.failure;
          return;
        }
        expected = next;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      clearTimeout(timer);
      await this.close();
    }
  }

  async close(): Promise<void> {
    clearInterval(this.monitor);
    if (!this.ended) this.child.kill('SIGKILL');
    await this.exited;
    rmSync(this.root, { recursive: true, force: true });
  }
}
