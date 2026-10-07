import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { CgroupWindow } from './ptc-m1/resources.js';
import { stopUnit } from './ptc-m1/unit-lifecycle.js';

/** Kernel-accounting proof only: no model, credentials, or benchmark task. */
test.skipIf(process.env.PTC_TEST_CGROUP !== '1')(
  'cgroup contains detached descendants, counts exited work, excludes controller and drains on stop',
  async () => {
    const root = await mkdtemp('/tmp/ptc-cg-');
    const unit = `ptc-m1-${randomUUID()}.service`;
    const helper = `${root}/helper.ts`;
    // Root waits for controller admission; child allocates and touches memory, creates a
    // nested short-lived process, then remains alive independently of its process group.
    await writeFile(
      helper,
      `
import { spawn } from 'node:child_process';
const root = ${JSON.stringify(root)};
if (process.argv[2] === 'child') {
  const memory = Buffer.alloc(64 * 1024 * 1024, 7);
  const child = spawn(process.execPath, ['-e', 'const until=Date.now()+120; while(Date.now()<until) Math.sqrt(Math.random());'], { stdio: 'ignore', detached: true });
  await new Promise(resolve => child.once('exit', resolve));
  await Bun.write(root + '/done', String(process.pid));
  setInterval(() => { if (memory[0] !== 7) process.exit(2); }, 1000);
} else {
  await Bun.write(root + '/root', String(process.pid));
  while (!await Bun.file(root + '/go').exists()) await Bun.sleep(10);
  spawn(process.execPath, [import.meta.path, 'child'], { stdio: 'ignore', detached: true });
  setInterval(() => {}, 1000);
}
`,
    );
    const wrapper = spawn(
      'systemd-run',
      [
        '--user',
        '--quiet',
        '--pipe',
        '--wait',
        '--collect',
        `--unit=${unit}`,
        '--property=MemoryAccounting=yes',
        '--property=CPUAccounting=yes',
        '--property=KillMode=control-group',
        process.execPath,
        helper,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    let exited = false;
    wrapper.once('exit', () => {
      exited = true;
    });
    const waitFile = async (name: string) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          return Number(await readFile(`${root}/${name}`, 'utf8'));
        } catch {
          /* not yet */
        }
        if (exited) throw new Error('Synthetic cgroup unit exited');
        await Bun.sleep(20);
      }
      throw new Error('Synthetic cgroup readiness timeout');
    };
    let collector: CgroupWindow | undefined;
    let childPid: number | undefined;
    let stopped = false;
    try {
      const rootPid = await waitFile('root');
      await expect(CgroupWindow.attach(rootPid, `ptc-m1-${randomUUID()}.service`)).rejects.toThrow(
        'Unexpected',
      );
      collector = await CgroupWindow.attach(rootPid, unit);
      expect(await collector.verifyMember(rootPid)).toBe(true);
      expect(await collector.verifyMember(process.pid)).toBe(false);
      await collector.begin();
      await writeFile(`${root}/go`, '');
      childPid = await waitFile('done');
      expect(await collector.verifyMember(childPid)).toBe(true);
      const measured = await collector.end();
      expect(measured.cpuMs).toBeGreaterThan(75);
      expect(measured.cgroupMemoryPeakBytes).toBeGreaterThan(64 * 1024 * 1024);
      await stopUnit(unit);
      stopped = true;
      expect(await collector.empty()).toBe(true);
      expect(await Bun.file(`/proc/${childPid}/cgroup`).exists()).toBe(false);
    } finally {
      try {
        if (!stopped) await stopUnit(unit);
      } finally {
        wrapper.kill('SIGKILL');
        await collector?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  30000,
);
