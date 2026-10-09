import { afterEach, expect, test } from 'bun:test';
import { openSync, closeSync, mkdtempSync, writeFileSync, rmSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GatewayWorkerProcess } from '../src/gateway-runtime/worker-process.js';
import { workerSeccomp } from '../src/gateway-runtime/seccomp.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('worker launcher refuses unavailable sandboxes and unsupported architectures without fallback', async () => {
  expect(() => workerSeccomp('unsupported')).toThrow('Unsupported');
  if (process.platform !== 'linux') {
    expect(() => new GatewayWorkerProcess({ executable: '/missing' })).toThrow('unsupported');
    return;
  }
  const executable = process.env.PIRC_TEST_GATEWAY_WORKER;
  if (!executable) return;
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

test.skipIf(!process.env.PIRC_TEST_GATEWAY_PROBE)(
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
      ['BUN_JSC_forceRAMSize', 'HOME', 'PWD', 'TMPDIR'].sort(),
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
