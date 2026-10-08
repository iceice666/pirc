import { mkdirSync, readFileSync, rmdirSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Optional actual Linux aggregate containment, provisioned only by the trusted supervisor. */
export class EnvironmentCgroup {
  private readonly directory: string;
  constructor(delegatedDirectory: string) {
    if (process.platform !== 'linux') throw new Error('Linux cgroup fencing unavailable');
    const root = realpathSync(delegatedDirectory);
    if (!root.startsWith('/sys/fs/cgroup/')) throw new Error('Not a delegated cgroup directory');
    this.directory = path.join(root, `pirc-environment-${randomUUID()}`);
    mkdirSync(this.directory, { mode: 0o700 });
    if (!readFileSync(path.join(this.directory, 'cgroup.events'), 'utf8').includes('populated 0'))
      throw new Error('Cgroup is not empty');
  }
  /** The shipped bootstrap SIGSTOPs before exec; move only this supervisor-spawned host PID. */
  async admitStopped(pid: number, alive: () => boolean): Promise<void> {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (!alive()) throw new Error('Executor bootstrap exited before admission');
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (/\) [Tt] /.test(stat)) {
        if (!alive()) throw new Error('Executor bootstrap no longer owned');
        writeFileSync(path.join(this.directory, 'cgroup.procs'), String(pid));
        process.kill(pid, 'SIGCONT');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Executor bootstrap did not stop for cgroup admission');
  }
  async fence(): Promise<void> {
    writeFileSync(path.join(this.directory, 'cgroup.kill'), '1');
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (
        readFileSync(path.join(this.directory, 'cgroup.events'), 'utf8').includes('populated 0')
      ) {
        rmdirSync(this.directory);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Executor aggregate cgroup fencing unverified');
  }
}
