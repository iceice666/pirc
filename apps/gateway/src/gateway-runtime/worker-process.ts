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
import {
  macosWorkerBootstrap,
  macosWorkerInspectionLibrary,
  macosWorkerProfile,
  macosWorkerWatchdog,
  MacosWorkerInspection,
} from './macos-worker.js';

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
  private readonly macos: MacosWorkerInspection | undefined;
  private readonly maxRssBytes: number;
  private rssFailureSince: number | undefined;

  constructor(options: {
    executable: string;
    bubblewrap?: string;
    macosBootstrap?: string;
    maxRssBytes?: number;
  }) {
    if (process.platform !== 'linux' && process.platform !== 'darwin')
      throw new Error(
        'Gateway runtime isolation unsupported on this platform; no unsandboxed fallback',
      );
    this.maxRssBytes = options.maxRssBytes ?? 512 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.maxRssBytes) ||
      this.maxRssBytes <= 0 ||
      this.maxRssBytes > 512 * 1024 * 1024
    )
      throw new Error('Invalid gateway worker memory limit');
    const executable = realpathSync(options.executable);
    if (process.platform === 'darwin') {
      this.root = mkdtempSync(path.join(os.tmpdir(), 'pirc-gateway-worker-'));
      try {
        if (process.arch !== 'arm64' && process.arch !== 'x64')
          throw new Error('Unsupported gateway worker architecture');
        const bootstrap = macosWorkerBootstrap(executable, options.macosBootstrap);
        const watchdog = macosWorkerWatchdog(executable);
        const inspection = macosWorkerInspectionLibrary(executable);
        this.macos = new MacosWorkerInspection(inspection);
        const profile = path.join(this.root, 'profile');
        writeFileSync(profile, macosWorkerProfile(executable, inspection), { mode: 0o600 });
        const fd = openSync(profile, 'r');
        try {
          this.child = spawn(watchdog, [String(process.pid), executable, bootstrap], {
            cwd: '/',
            env: {},
            stdio: ['pipe', 'pipe', 'pipe', fd, 'pipe', 'pipe', 'pipe'],
          }) as ChildProcessWithoutNullStreams;
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        this.macos?.close();
        rmSync(this.root, { recursive: true, force: true });
        throw error;
      }
    } else {
      const bubblewrap = Bun.which(options.bubblewrap ?? process.env.PIRC_GATEWAY_BWRAP ?? 'bwrap');
      if (!bubblewrap) throw new Error('Gateway worker sandbox unavailable');
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
      // ldd can resolve a newer Nix closure than the executable's baked-in
      // RUNPATH. Mount only those resolved files, and give the loader the exact
      // bounded directory set; no host library directory is exposed.
      args.push(
        '--setenv',
        'LD_LIBRARY_PATH',
        [...new Set(assets.map((asset) => path.dirname(asset.target)))].join(':'),
      );
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
    }
    const fail = (error: Error) => {
      this.failure ??= error;
      this.failed.abort(this.failure);
      this.child.kill(this.macos ? 'SIGTERM' : 'SIGKILL');
      this.wake?.();
    };
    const parser = new JsonlParser(WORKER_FRAME_BYTES, (value) => {
      const request = requestSchema.parse(value);
      if (request.seq !== this.expectedSeq++ || this.requests.length >= 1)
        throw new Error('Worker IPC sequence/queue violation');
      this.requests.push(request);
      this.wake?.();
    });
    // Trusted bwrap/native launcher status, never the worker action stream.
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
    let nativePid: number | undefined;
    let nativeSealed = false;
    const admitMacos = () => {
      if (!this.macos || !nativeSealed || !nativePid || this.sandboxPid || this.failure) return;
      try {
        this.macos.verify(nativePid, executable);
        if (this.macos.rss(nativePid) + this.macos.rss(this.child.pid!) > this.maxRssBytes) {
          fail(new Error('Gateway worker memory/process quota exceeded'));
          return;
        }
        this.sandboxPid = nativePid;
        const gate = (this.child.stdio as Array<unknown>)[5] as NodeJS.WritableStream;
        gate.on('error', () => fail(new Error('Gateway worker native admission gate unavailable')));
        gate.end('1');
        this.wake?.();
      } catch {
        fail(new Error('Gateway worker kernel isolation verification unavailable'));
      }
    };
    if (this.macos) {
      const nativeStatus = new JsonlParser(WORKER_FRAME_BYTES, (value) => {
        const status = z.object({ 'child-pid': z.number().int().positive() }).strict().parse(value);
        if (nativePid) throw new Error('Duplicate native process identity');
        nativePid = status['child-pid'];
      });
      const pipe = (this.child.stdio as Array<unknown>)[6] as NodeJS.ReadableStream;
      pipe.on('data', (chunk: Buffer) => {
        try {
          nativeStatus.push(chunk);
        } catch {
          fail(new Error('Gateway worker trusted process identity unavailable'));
        }
      });
      pipe.on('end', () => {
        try {
          nativeStatus.end();
          if (!nativePid) throw new Error('Missing trusted process identity');
          admitMacos();
        } catch {
          fail(new Error('Gateway worker trusted process identity unavailable'));
        }
      });
    }
    const statusPipe = this.child.stdio[4] as NodeJS.ReadableStream;
    let sealEvidence = '';
    statusPipe.on('data', (chunk: Buffer) => {
      try {
        if (this.macos) {
          sealEvidence += chunk.toString('ascii');
          if (sealEvidence.length > 7 || (sealEvidence.length === 7 && sealEvidence !== 'sealed\n'))
            throw new Error('Invalid native sandbox readiness');
        } else statusParser.push(chunk);
      } catch {
        fail(new Error('Gateway worker resource supervision unavailable'));
      }
    });
    statusPipe.on('end', () => {
      if (!this.macos) return;
      try {
        if (sealEvidence !== 'sealed\n' || !this.child.pid)
          throw new Error('Missing native sandbox readiness');
        nativeSealed = true;
        admitMacos();
      } catch {
        fail(new Error('Gateway worker kernel isolation verification unavailable'));
      }
    });
    // A missing hook or stalled bootstrap cannot wait indefinitely for admission.
    const readiness = setTimeout(() => {
      if (!this.sandboxPid) fail(new Error('Gateway worker sandbox readiness deadline exceeded'));
    }, 5000);
    this.child.on('close', () => clearTimeout(readiness));
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
        if (this.ended) return;
        // Neither platform accepts worker-reported PID or memory accounting.
        let rss = 0;
        if (this.macos) {
          rss = this.macos.rss(this.child.pid!);
          if (nativePid) rss += this.macos.rss(nativePid);
        } else {
          const pids = [this.child.pid!, ...(this.sandboxPid ? [this.sandboxPid] : [])];
          for (const pid of pids) {
            const status = readFileSync(`/proc/${pid}/status`, 'utf8');
            rss += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
          }
        }
        this.rssFailureSince = undefined;
        if (rss > this.maxRssBytes) fail(new Error('Gateway worker memory/process quota exceeded'));
      } catch (error) {
        // The trusted native wrapper may be reaping an exited guest while the
        // host still awaits its close event. Allow one bounded post-admission
        // grace, never an indefinite exemption for unavailable inspection.
        if (this.macos && this.sandboxPid && !this.ended) {
          this.rssFailureSince ??= performance.now();
          if (performance.now() - this.rssFailureSince < 500) return;
        }
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
      this.child.kill(this.macos ? 'SIGTERM' : 'SIGKILL');
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
    if (!this.ended) this.child.kill(this.macos ? 'SIGTERM' : 'SIGKILL');
    await this.exited;
    // close() is idempotent; dlclose must only happen once.
    if (!this.resourcesClosed) {
      this.resourcesClosed = true;
      this.macos?.close();
      rmSync(this.root, { recursive: true, force: true });
    }
  }
  private resourcesClosed = false;
}
