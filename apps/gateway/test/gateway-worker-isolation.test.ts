import { afterEach, expect, test } from 'bun:test';
import {
  openSync,
  closeSync,
  copyFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GatewayWorkerProcess } from '../src/gateway-runtime/worker-process.js';
import { workerSeccomp } from '../src/gateway-runtime/seccomp.js';
import {
  macosWorkerInspectionLibrary,
  macosWorkerProfile,
} from '../src/gateway-runtime/macos-worker.js';
import { dlopen, FFIType } from 'bun:ffi';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('macOS profile is deny-default with no exec/fork/network/write exception', () => {
  const profile = macosWorkerProfile('/trusted/worker', '/trusted/inspection.dylib');
  expect(profile).toContain('(deny default)');
  expect(profile).toContain('(disable-syscall-inference)');
  expect(profile).toContain('(syscall-number 202) (syscall-number 538) (syscall-number 539)');
  expect(profile).not.toContain('(allow syscall-mach)');
  expect(profile).not.toMatch(/\(allow syscall-(?:unix|mig) \(require-not/);
  expect(() => macosWorkerProfile('/invalid\npath', '/inspection')).toThrow('asset path');
  expect(profile).not.toMatch(
    /\(allow (?:process-exec|process-fork|network|file-write|mach-lookup)/,
  );
  expect(profile).toContain('(literal "/trusted/worker")');
  expect(profile).not.toContain('(subpath "/Users")');
  expect(profile).not.toMatch(/\(allow sysctl-read\s*\)/);
  expect(profile).not.toContain('(subpath "/usr/lib")');
  expect(profile).not.toContain('(subpath "/System/Library")');
  expect(profile).toContain('(deny process-info* (target others))');
  expect(profile).toContain('(deny iokit* nvram*)');
  expect(profile).toContain('(deny mach-task-special-port-get mach-task-special-port-set)');
  expect(profile).toContain('(kernel-mig-routine task_get_special_port_from_user)');
  expect(profile).toContain('(kernel-mig-routine task_set_special_port)');
});

test('worker launcher refuses unavailable sandboxes and unsupported architectures without fallback', async () => {
  expect(() => workerSeccomp('unsupported')).toThrow('Unsupported');
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    expect(() => new GatewayWorkerProcess({ executable: '/missing' })).toThrow('unsupported');
    return;
  }
  const executable = process.env.PIRC_TEST_GATEWAY_WORKER;
  if (!executable) return;
  if (process.platform === 'darwin') {
    expect(
      () => new GatewayWorkerProcess({ executable, macosBootstrap: '/missing-bootstrap' }),
    ).toThrow('unavailable');
    return;
  }
  expect(() => new GatewayWorkerProcess({ executable, bubblewrap: '/missing-bwrap' })).toThrow(
    'unavailable',
  );
  const worker = new GatewayWorkerProcess({ executable, bubblewrap: '/bin/false' });
  cleanups.push(() => worker.close());
  let invoked = false;
  await expect(
    worker.drive(async () => {
      invoked = true;
      return 'done';
    }, AbortSignal.timeout(5000)),
  ).rejects.toThrow('unavailable');
  expect(invoked).toBe(false);
});

test.skipIf(process.platform !== 'linux' || !process.env.PIRC_TEST_GATEWAY_PROBE)(
  'real Linux worker denies host files, inherited secrets/FDs, network, native subprocesses and asset writes',
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-host-private-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'credential-canary');
    writeFileSync(file, 'private host canary');
    const fd = openSync(file, 'r');
    cleanups.push(() => closeSync(fd));
    const previous = process.env.PIRC_WORKER_SECRET_CANARY;
    process.env.PIRC_WORKER_SECRET_CANARY = 'must-not-inherit';
    cleanups.push(() => {
      if (previous === undefined) delete process.env.PIRC_WORKER_SECRET_CANARY;
      else process.env.PIRC_WORKER_SECRET_CANARY = previous;
    });
    const worker = new GatewayWorkerProcess({ executable: process.env.PIRC_TEST_GATEWAY_PROBE! });
    cleanups.push(() => worker.close());
    // Test-only observation of the same bounded stderr pipe, not extra worker authority.
    const child = (worker as unknown as { child: ChildProcessWithoutNullStreams }).child;
    let evidence = '';
    child.stderr.on('data', (chunk: Buffer) => {
      evidence += chunk.toString();
    });
    await worker.drive(async () => 'done', AbortSignal.timeout(5000));
    const probe = JSON.parse(evidence);
    expect(probe.uid).toBe(65534);
    expect(probe.status).toContain('NoNewPrivs:\t1');
    expect(probe.status).toContain('Seccomp:\t2');
    expect(probe.status).toContain('CapEff:\t0000000000000000');
    expect(probe.hostEtc).toBe(false);
    expect(probe.hostWorkspace).toBe(false);
    expect(probe.hostHome).toBe(false);
    expect(probe.environment.sort()).toEqual(
      ['BUN_JSC_forceRAMSize', 'HOME', 'LD_LIBRARY_PATH', 'PWD', 'TMPDIR'].sort(),
    );
    expect(probe.networkError).not.toBe('connected');
    expect(probe.socketResult).toBe(-1);
    expect(probe.socketErrno).toBe(1);
    expect(probe.denied).toEqual({
      mount: { result: -1, errno: 1 },
      ptrace: { result: -1, errno: 1 },
      unshare: { result: -1, errno: 1 },
      execve: { result: -1, errno: 1 },
      memfd: { result: -1, errno: 1 },
    });
    expect(probe.subprocess).toBe(false);
    expect(probe.writable).toBe(false);
    expect(
      probe.descriptors.some(
        (target: string) => target.includes('credential-canary') || target.includes('seccomp'),
      ),
    ).toBe(false);
    for (const name of ['mnt', 'pid', 'net', 'user'])
      expect(probe.namespaces[name]).not.toBe(readlinkSync(`/proc/self/ns/${name}`));
  },
  15_000,
);

test.skipIf(!process.env.PIRC_TEST_GATEWAY_FORGED)(
  'real constrained worker cannot impersonate provider or binding through IPC',
  async () => {
    const worker = new GatewayWorkerProcess({ executable: process.env.PIRC_TEST_GATEWAY_FORGED! });
    cleanups.push(() => worker.close());
    let invoked = false;
    await expect(
      worker.drive(async () => {
        invoked = true;
        return 'done';
      }, AbortSignal.timeout(5000)),
    ).rejects.toThrow('IPC');
    expect(invoked).toBe(false);
  },
  10_000,
);

test.skipIf(!process.env.PIRC_TEST_GATEWAY_WORKER)(
  'real worker RSS supervision terminates a stalled worker and reports interruption',
  async () => {
    const worker = new GatewayWorkerProcess({
      executable: process.env.PIRC_TEST_GATEWAY_WORKER!,
      maxRssBytes: 1,
    });
    cleanups.push(() => worker.close());
    await expect(
      worker.drive(async () => new Promise(() => {}), AbortSignal.timeout(5000)),
    ).rejects.toThrow('quota');
  },
  10_000,
);

test.skipIf(process.platform !== 'darwin' || !process.env.PIRC_TEST_GATEWAY_MACOS_PROBE)(
  'real macOS launcher seals even an uncooperative worker before IPC and denies host authority',
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-host-private-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'credential-canary');
    writeFileSync(file, 'private host canary');
    const fd = openSync(file, 'r');
    cleanups.push(() => closeSync(fd));
    const previous = process.env.PIRC_WORKER_SECRET_CANARY;
    process.env.PIRC_WORKER_SECRET_CANARY = 'must-not-inherit';
    cleanups.push(() => {
      if (previous === undefined) delete process.env.PIRC_WORKER_SECRET_CANARY;
      else process.env.PIRC_WORKER_SECRET_CANARY = previous;
    });
    const executable = path.join(root, 'probe');
    copyFileSync(process.env.PIRC_TEST_GATEWAY_MACOS_PROBE!, executable);
    for (const kind of ['bootstrap', 'inspection'])
      copyFileSync(
        path.join(
          path.dirname(process.env.PIRC_TEST_GATEWAY_MACOS_PROBE!),
          `pirc-worker-${kind}.dylib`,
        ),
        path.join(root, `pirc-worker-${kind}.dylib`),
      );
    copyFileSync(
      path.join(path.dirname(process.env.PIRC_TEST_GATEWAY_MACOS_PROBE!), 'pirc-worker-watchdog'),
      path.join(root, 'pirc-worker-watchdog'),
    );
    writeFileSync(path.join(root, 'host-home'), 'private host canary');
    writeFileSync(path.join(root, 'host-workspace'), 'private host canary');
    symlinkSync(file, path.join(root, 'credential-alias'));
    const native = dlopen(macosWorkerInspectionLibrary(executable), {
      pirc_worker_fd_flags: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    cleanups.push(() => native.close());
    // Force canary FD to be inheritable; launcher/hook, not O_CLOEXEC alone,
    // must prevent a compromised worker from reading it with raw pread.
    const flags = native.symbols.pirc_worker_fd_flags(fd, -1);
    expect(flags).toBeGreaterThanOrEqual(0);
    expect(native.symbols.pirc_worker_fd_flags(fd, flags & ~1)).toBe(0);
    cleanups.push(() => {
      native.symbols.pirc_worker_fd_flags(fd, flags);
    });
    const worker = new GatewayWorkerProcess({
      executable,
    });
    cleanups.push(() => worker.close());
    const child = (worker as unknown as { child: ChildProcessWithoutNullStreams }).child;
    let evidence = '';
    child.stderr.on('data', (chunk: Buffer) => {
      evidence += chunk.toString();
    });
    await worker.drive(async () => 'done', AbortSignal.timeout(5000));
    const probe = JSON.parse(evidence);
    expect(probe.hostEtc).toBe(false);
    expect(probe.hostWorkspace).toBe(false);
    expect(probe.hostHome).toBe(false);
    expect(probe.hostCanary).toBe(false);
    expect(probe.hostAlias).toBe(false);
    expect(probe.descriptorSecret).toBe(false);
    expect(probe.environment.sort()).toEqual(['BUN_JSC_forceRAMSize', 'HOME', 'TMPDIR'].sort());
    expect(probe.execResult).toBe(-1);
    expect(probe.execErrno).toBe(1);
    expect(probe.procargsResult).toBe(-1);
    expect(probe.procargsErrno).toBe(1);
    expect(probe.rawProcargsResult).toBe(-1);
    expect(probe.rawProcargsErrno).toBe(1);
    expect(probe.privateSysctlResult).toBe(-1);
    expect(probe.privateSysctlErrno).toBe(1);
    expect(probe.procargsSecret).toBe(false);
    expect(probe.procargsCommand).toBe(false);
    expect(probe.subprocess).toBe(false);
    expect(probe.signalResult).toBe(-1);
    expect(probe.signalErrno).toBe(1);
    expect(probe.parentTaskResult).not.toBe(0);
    for (const task of probe.peerTasks) {
      expect(task.result).toBe(-1);
      expect(task.errno).toBe(1);
    }
    expect(probe.bootstrapResult).not.toBe(0);
    expect(probe.bootstrapPort).toBe(0);
    expect(probe.serviceAttempted).toBe(false);
    expect(probe.serviceResult).toBe(null);
    expect(probe.peerInfoBytes).toBe(0);
    for (const socket of probe.sockets) {
      expect(socket.result).toBe(-1);
      expect(socket.errno).toBe(1);
    }
    expect(probe.writable).toBe(false);
  },
  15_000,
);

test.skipIf(
  process.platform !== 'darwin' ||
    !process.env.PIRC_TEST_GATEWAY_WORKER ||
    !process.env.PIRC_TEST_GATEWAY_FORGED_BOOTSTRAP,
)(
  'macOS supervisor rejects forged native readiness without kernel containment',
  async () => {
    const worker = new GatewayWorkerProcess({
      executable: process.env.PIRC_TEST_GATEWAY_WORKER!,
      macosBootstrap: process.env.PIRC_TEST_GATEWAY_FORGED_BOOTSTRAP!,
    });
    cleanups.push(() => worker.close());
    let invoked = false;
    await expect(
      worker.drive(async () => {
        invoked = true;
        return 'done';
      }, AbortSignal.timeout(5000)),
    ).rejects.toThrow('isolation verification');
    expect(invoked).toBe(false);
  },
  10_000,
);

test.skipIf(process.platform !== 'darwin' || !process.env.PIRC_TEST_GATEWAY_FORK_PROBE)(
  'macOS worker cannot fork even without Bun subprocess helpers',
  async () => {
    const worker = new GatewayWorkerProcess({
      executable: process.env.PIRC_TEST_GATEWAY_FORK_PROBE!,
    });
    cleanups.push(() => worker.close());
    const child = (worker as unknown as { child: ChildProcessWithoutNullStreams }).child;
    let evidence = '';
    child.stderr.on('data', (chunk: Buffer) => {
      evidence += chunk.toString();
    });
    await worker.drive(async () => 'done', AbortSignal.timeout(5000));
    expect(JSON.parse(evidence)).toEqual({ forkResult: -1, forkErrno: 1 });
  },
  10_000,
);

test.skipIf(!process.env.PIRC_TEST_GATEWAY_MEMORY_PROBE)(
  'trusted RSS monitor interrupts a post-admission allocation while a callback is stalled',
  async () => {
    const worker = new GatewayWorkerProcess({
      executable: process.env.PIRC_TEST_GATEWAY_MEMORY_PROBE!,
      maxRssBytes: 128 * 1024 * 1024,
    });
    cleanups.push(() => worker.close());
    let invoked = false;
    await expect(
      worker.drive(async () => {
        invoked = true;
        return new Promise(() => {});
      }, AbortSignal.timeout(5000)),
    ).rejects.toThrow('quota');
    expect(invoked).toBe(true);
  },
  10_000,
);
