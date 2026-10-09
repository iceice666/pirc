import { expect, test } from 'bun:test';
import { dlopen, FFIType } from 'bun:ffi';
import path from 'node:path';
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { GatewayWorkerProcess } from '../src/gateway-runtime/worker-process.js';

// Actual Darwin opt-in only. A synthetic profile string is not inheritance evidence.
// Build the native executable and helper from fixtures/gateway-worker-macos-ports.c.
// Put production bootstrap/inspection dylibs beside the executable and set
// PIRC_TEST_GATEWAY_MACOS_PORTS to it. The helper is supervisor-only authority.
test.skipIf(process.platform !== 'darwin' || !process.env.PIRC_TEST_GATEWAY_MACOS_PORTS)(
  'real macOS launch revokes inherited Mach registered/exception and cached namespace rights',
  async () => {
    const executable = process.env.PIRC_TEST_GATEWAY_MACOS_PORTS!;
    const helper = dlopen(
      process.env.PIRC_TEST_GATEWAY_MACOS_PORTS_HELPER ??
        path.join(path.dirname(executable), 'pirc-worker-ports-helper.dylib'),
      {
        pirc_ports_prepare: { args: [], returns: FFIType.i32 },
        pirc_ports_restore: { args: [], returns: FFIType.i32 },
        pirc_ports_arm_exceptions: { args: [], returns: FFIType.i32 },
        pirc_ports_control: { args: [], returns: FFIType.i32 },
        pirc_ports_receive: { args: [], returns: FFIType.i32 },
        pirc_ports_cleanup: { args: [], returns: FFIType.void },
      },
    );
    let worker: GatewayWorkerProcess | undefined;
    try {
      expect(helper.symbols.pirc_ports_prepare()).toBe(0);
      // Positive control: a live canary send right really reaches the receiver.
      expect(helper.symbols.pirc_ports_control()).toBe(0);
      expect(helper.symbols.pirc_ports_receive()).toBe(1);
      expect(helper.symbols.pirc_ports_receive()).toBe(0);
      // The native test-only binary receives no credentials or inherited host
      // FDs. This unsandboxed control establishes that THIS spawn path really
      // transfers the registered canary, rather than vacuously testing absence.
      const control = spawnSync(executable, ['--inheritance-control'], {
        env: {},
        timeout: 3000,
        maxBuffer: 4096,
        encoding: 'utf8',
      });
      if (control.status !== 0)
        throw new Error(
          `Native inheritance control failed: status=${control.status} signal=${control.signal} error=${control.error?.message ?? ''} stdout=${control.stdout.slice(0, 1024)} stderr=${control.stderr.slice(0, 1024)}`,
        );
      const baseline = JSON.parse(control.stderr);
      expect(baseline.registeredLive).toBeGreaterThan(0);
      // Same hand-built MIG request must work before sealing, proving a
      // later denial is not malformed-message or user-space interpose error.
      expect(baseline.rawAccessResult).toBe(0);
      expect(baseline.rawAccessPort).toBeGreaterThan(0);
      expect(baseline.rawHostResult).toBe(0);
      expect(baseline.rawHostPort).toBeGreaterThan(0);
      expect(helper.symbols.pirc_ports_receive()).toBe(1);
      let drained = false;
      for (let count = 0; count < 256; count++) {
        const message = helper.symbols.pirc_ports_receive();
        expect(message).toBeGreaterThanOrEqual(0);
        if (message === 0) {
          drained = true;
          break;
        }
      }
      expect(drained).toBe(true);
      expect(helper.symbols.pirc_ports_arm_exceptions()).toBe(0);
      try {
        worker = new GatewayWorkerProcess({ executable });
      } finally {
        // Do not retain altered supervisor task/thread state during async work.
        expect(helper.symbols.pirc_ports_restore()).toBe(0);
      }
      const child = (worker as unknown as { child: ChildProcessWithoutNullStreams }).child;
      let evidence = '';
      child.stderr.on('data', (chunk: Buffer) => {
        evidence += chunk.toString();
      });
      await worker.drive(async () => 'done', AbortSignal.timeout(5000));
      const probe = JSON.parse(evidence);
      expect(probe.registeredResult).toBe(0);
      expect(probe.registeredLive).toBe(0);
      expect(probe.taskResult).toBe(0);
      expect(probe.taskLive).toBe(0);
      expect(probe.threadResult).toBe(0);
      expect(probe.threadLive).toBe(0);
      expect(probe.bootstrapResult).not.toBe(0);
      expect(probe.bootstrap).toBe(0);
      expect(probe.accessResult).not.toBe(0);
      expect(probe.access).toBe(0);
      expect(probe.hostResult).not.toBe(0);
      expect(probe.host).toBe(0);
      expect(probe.namesResult).toBe(0);
      expect(probe.rawAccessDenied).toBe(true);
      expect(probe.rawAccessPort).toBe(0);
      expect(probe.rawHostDenied).toBe(true);
      expect(probe.rawHostPort).toBe(0);
      // Probe attempts every non-task/thread send right, including handles
      // materialized by dyld before arrays are cleared. None may reach canary.
      expect(helper.symbols.pirc_ports_receive()).toBe(0);
    } finally {
      await worker?.close();
      helper.symbols.pirc_ports_cleanup();
      helper.close();
    }
  },
  10_000,
);
