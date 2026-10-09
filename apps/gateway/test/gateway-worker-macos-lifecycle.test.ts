import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { GatewayWorkerProcess } from '../src/gateway-runtime/worker-process.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

test.skipIf(process.platform !== 'darwin' || !process.env.PIRC_TEST_GATEWAY_MACOS_STALL)(
  'real macOS watchdog handles close before native readiness without a startup hang',
  async () => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const worker = new GatewayWorkerProcess({
        executable: process.env.PIRC_TEST_GATEWAY_MACOS_STALL!,
      });
      const internal = worker as unknown as { child: ChildProcessWithoutNullStreams };
      const wrapperPid = internal.child.pid!;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          worker.close(),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              // A second SIGTERM is safe for the trusted wrapper and cleans a
              // missed-first-signal regression without orphaning its guest.
              internal.child.kill('SIGTERM');
              reject(new Error('Native immediate-close deadline exceeded'));
            }, 2000);
          }),
        ]);
        expect(alive(wrapperPid)).toBe(false);
      } finally {
        clearTimeout(deadline);
        internal.child.kill('SIGTERM');
        await worker.close();
      }
    }
  },
  15_000,
);

// Actual Darwin opt-in. Compile fixtures/gateway-worker-macos-stall.c and place
// production bootstrap/inspection/watchdog assets beside it. The hostile native
// worker pauses forever and does not cooperate with shutdown or stdin EOF.
test.skipIf(process.platform !== 'darwin' || !process.env.PIRC_TEST_GATEWAY_MACOS_STALL)(
  'real macOS native watchdog reaps hostile worker after fixture gateway SIGKILL',
  async () => {
    let supervisor: ChildProcessWithoutNullStreams | undefined;
    let identities: { wrapperPid: number; workerPid: number } | undefined;
    let exited: Promise<void> | undefined;
    try {
      supervisor = spawn(
        process.execPath,
        [
          path.join(import.meta.dir, 'fixtures/gateway-worker-macos-lifecycle-supervisor.ts'),
          process.env.PIRC_TEST_GATEWAY_MACOS_STALL!,
        ],
        { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const child = supervisor;
      exited = new Promise((resolve) => child.once('close', () => resolve()));
      let diagnostics = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (diagnostics.length < 4096) diagnostics += chunk.toString();
      });
      identities = await new Promise<{ wrapperPid: number; workerPid: number }>(
        (resolve, reject) => {
          let output = '';
          const deadline = setTimeout(
            () => reject(new Error('Fixture worker admission timeout')),
            7000,
          );
          child.once('error', reject);
          child.once('close', () => {
            clearTimeout(deadline);
            reject(new Error(`Fixture supervisor exited before readiness: ${diagnostics}`));
          });
          child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            if (output.length > 1024) {
              clearTimeout(deadline);
              reject(new Error('Fixture supervisor readiness quota exceeded'));
              return;
            }
            const newline = output.indexOf('\n');
            if (newline < 0) return;
            clearTimeout(deadline);
            try {
              resolve(JSON.parse(output.slice(0, newline)));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      expect(Number.isSafeInteger(identities.wrapperPid)).toBe(true);
      expect(Number.isSafeInteger(identities.workerPid)).toBe(true);
      expect(identities.wrapperPid).toBeGreaterThan(1);
      expect(identities.workerPid).toBeGreaterThan(1);
      expect(identities.wrapperPid).not.toBe(identities.workerPid);
      expect(alive(identities.wrapperPid)).toBe(true);
      expect(alive(identities.workerPid)).toBe(true);
      expect(child.kill('SIGKILL')).toBe(true);
      await exited;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && alive(identities.workerPid)) await Bun.sleep(25);
      // The watchdog must waitpid the hostile child, not just orphan/zombify it.
      expect(alive(identities.workerPid)).toBe(false);
    } finally {
      // Terminate only fixture-owned processes; no broad process-name cleanup.
      if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null)
        supervisor.kill('SIGKILL');
      if (identities && alive(identities.workerPid)) process.kill(identities.workerPid, 'SIGKILL');
      if (identities && alive(identities.wrapperPid))
        process.kill(identities.wrapperPid, 'SIGTERM');
      await exited;
    }
  },
  15_000,
);
