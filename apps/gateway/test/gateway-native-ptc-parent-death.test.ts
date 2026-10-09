import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
const executable = process.env.PIRC_TEST_NATIVE_PTC;
const nativeTest = executable ? test : test.skip;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};
nativeTest(
  'actual native PTC dies when disposable supervisor is SIGKILLed',
  async () => {
    let child: ChildProcessWithoutNullStreams | undefined,
      exited: Promise<void> | undefined,
      workerPid: number | undefined,
      workerIdentity: string | undefined;
    const identity = (pid: number): string | undefined => {
      try {
        if (process.platform === 'linux')
          return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19];
        const result = Bun.spawnSync([
          '/bin/ps',
          '-p',
          String(pid),
          '-o',
          'lstart=',
          '-o',
          'command=',
        ]);
        const text = result.stdout.toString().trim();
        return result.exitCode === 0 && text.endsWith(executable!) ? text : undefined;
      } catch {
        return undefined;
      }
    };
    try {
      child = spawn(
        process.execPath,
        [
          path.join(import.meta.dir, 'fixtures/gateway-native-ptc-lifecycle-supervisor.ts'),
          executable!,
        ],
        {
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ...(process.env.PIRC_GATEWAY_BWRAP
              ? { PIRC_GATEWAY_BWRAP: process.env.PIRC_GATEWAY_BWRAP }
              : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const supervisor = child;
      // exit, not close: an orphaned hostile guest may retain inherited pipes.
      exited = new Promise((resolve) => supervisor.once('exit', () => resolve()));
      const identities = await new Promise<{ wrapperPid: number; workerPid: number }>(
        (resolve, reject) => {
          let output = '',
            diagnostics = '';
          const timer = setTimeout(
            () => reject(Error('Native parent-death fixture admission timeout')),
            10000,
          );
          supervisor.stderr.on('data', (chunk: Buffer) => {
            if (diagnostics.length < 4096) diagnostics += chunk.toString();
          });
          supervisor.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          supervisor.once('close', () => {
            clearTimeout(timer);
            reject(Error('Fixture exited before admission: ' + diagnostics));
          });
          supervisor.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            if (output.length > 1024) {
              clearTimeout(timer);
              reject(Error('Fixture output quota'));
              return;
            }
            if (output.includes('\n')) {
              clearTimeout(timer);
              try {
                resolve(JSON.parse(output.split('\n')[0]!));
              } catch (error) {
                reject(error);
              }
            }
          });
        },
      );
      expect(Number.isSafeInteger(identities.wrapperPid)).toBe(true);
      expect(Number.isSafeInteger(identities.workerPid)).toBe(true);
      expect(identities.workerPid).toBeGreaterThan(1);
      if (process.platform === 'darwin') workerPid = identities.workerPid;
      // Linux guest PID is namespace-local. Resolve the actual host guest PID only
      // within this fixture wrapper's process subtree, before killing its supervisor.
      let hostPid = identities.workerPid;
      if (process.platform === 'linux') {
        const descendants = (pid: number): number[] => {
          // Some Linux kernels omit CONFIG_CHECKPOINT_RESTORE's children file.
          // Kernel PPid records prove the same subtree without trusting guest PIDs.
          let children: number[];
          try {
            children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .map(Number);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            children = readdirSync('/proc')
              .filter((name) => /^\d+$/.test(name))
              .flatMap((name) => {
                try {
                  const status = readFileSync(`/proc/${name}/status`, 'utf8');
                  return Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) === pid ? [Number(name)] : [];
                } catch {
                  return [];
                } // A concurrently exited process is not a live descendant.
              });
          }
          return children.flatMap((child) => [child, ...descendants(child)]);
        };
        const native = descendants(identities.wrapperPid).find((pid) => {
          try {
            const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
            return command.split('\0')[0] === '/runtime/worker';
          } catch {
            return false;
          }
        });
        expect(native).toBeDefined();
        hostPid = native!;
        workerPid = hostPid;
      }
      workerIdentity = identity(hostPid);
      expect(workerIdentity).toBeDefined();
      expect(alive(hostPid)).toBe(true);
      expect(supervisor.kill('SIGKILL')).toBe(true);
      await exited;
      const end = Date.now() + 5000;
      while (Date.now() < end && alive(hostPid)) await Bun.sleep(25);
      // Require actual guest disappearance, not merely a killed-but-unreaped process.
      expect(alive(hostPid)).toBe(false);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (workerPid && workerIdentity && alive(workerPid) && identity(workerPid) === workerIdentity)
        process.kill(workerPid, 'SIGKILL');
      child?.stdout.destroy();
      child?.stderr.destroy();
      child?.stdin.destroy();
      await Promise.race([exited, Bun.sleep(2000)]);
    }
  },
  20000,
);
