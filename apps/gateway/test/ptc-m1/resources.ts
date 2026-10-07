/** Linux cgroup-v2 collector. memory.peak is charged cgroup memory, NOT RSS. */
import { open, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export function parseCpuUsec(text: string): number {
  const matches = text.split('\n').filter((line) => line.startsWith('usage_usec '));
  if (matches.length !== 1 || !/^usage_usec \d+$/.test(matches[0]!))
    throw new Error('Invalid cgroup CPU evidence');
  const value = Number(matches[0]!.slice(11));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid cgroup CPU evidence');
  return value;
}
export function parseMemoryBytes(text: string): number {
  if (!/^\d+\n?$/.test(text)) throw new Error('Invalid cgroup memory evidence');
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid cgroup memory evidence');
  return value;
}
export function unifiedCgroup(text: string): string {
  const lines = text.trim().split('\n');
  if (lines.length !== 1 || !lines[0]!.startsWith('0::/'))
    throw new Error('Expected unified cgroup v2');
  const group = lines[0]!.slice(3);
  if (group === '/' || group.includes('..') || group.includes('\0'))
    throw new Error('Unsafe measurement cgroup');
  return group;
}

export class CgroupWindow {
  private baseline: number | null = null;
  private peak: FileHandle | null = null;
  private finished = false;
  private startSampleAt = 0;
  private constructor(
    private readonly directory: string,
    private readonly group: string,
  ) {}

  /** Run the agent under a dedicated systemd user unit BEFORE any of its descendants start. */
  static async attach(pid: number, expectedUnit: string): Promise<CgroupWindow> {
    if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Linux cgroup collector required');
    const group = unifiedCgroup(await readFile(`/proc/${pid}/cgroup`, 'utf8'));
    if (!/^ptc-m1-[a-f0-9-]+\.service$/.test(expectedUnit) || path.basename(group) !== expectedUnit)
      throw new Error('Unexpected measurement unit');
    const own = unifiedCgroup(await readFile('/proc/self/cgroup', 'utf8'));
    if (own === group || own.startsWith(`${group}/`))
      throw new Error('Controller inside measured cgroup');
    const directory = path.join('/sys/fs/cgroup', group);
    if (!(await readFile(path.join(directory, 'cgroup.type'), 'utf8')).startsWith('domain'))
      throw new Error('Non-domain measurement cgroup');
    await readFile(path.join(directory, 'memory.peak'), 'utf8');
    await readFile(path.join(directory, 'cpu.stat'), 'utf8');
    return new CgroupWindow(directory, group);
  }

  /** CPU window begins at dispatch; memory peak covers the dedicated unit's whole lifetime.
   * Do not delegate writable cgroup controls to the measured agent merely to reset peak memory.
   */
  async begin(): Promise<void> {
    if (this.peak || this.finished) throw new Error('Resource window already started');
    const peak = await open(path.join(this.directory, 'memory.peak'), 'r');
    try {
      this.baseline = parseCpuUsec(await readFile(path.join(this.directory, 'cpu.stat'), 'utf8'));
      this.startSampleAt = performance.now();
      this.peak = peak;
    } catch {
      await peak.close();
      throw new Error('Cgroup resource window unavailable');
    }
  }

  async end(): Promise<{
    cpuMs: number;
    cgroupMemoryPeakBytes: number;
    startSampleAt: number;
    endSampleAt: number;
  }> {
    if (!this.peak || this.baseline === null || this.finished)
      throw new Error('Resource window not active');
    this.finished = true;
    try {
      const current = parseCpuUsec(await readFile(path.join(this.directory, 'cpu.stat'), 'utf8'));
      const buffer = Buffer.alloc(128);
      const { bytesRead } = await this.peak.read(buffer, 0, buffer.length, 0);
      if (current < this.baseline) throw new Error('Cgroup CPU counter decreased');
      return {
        cpuMs: (current - this.baseline) / 1000,
        startSampleAt: this.startSampleAt,
        endSampleAt: performance.now(),
        cgroupMemoryPeakBytes: parseMemoryBytes(buffer.subarray(0, bytesRead).toString()),
      };
    } finally {
      await this.peak.close();
      this.peak = null;
    }
  }

  async verifyMember(pid: number): Promise<boolean> {
    const group = unifiedCgroup(await readFile(`/proc/${pid}/cgroup`, 'utf8'));
    return group === this.group || group.startsWith(`${this.group}/`);
  }

  async empty(): Promise<boolean> {
    try {
      return /^populated 0$/m.test(
        await readFile(path.join(this.directory, 'cgroup.events'), 'utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw new Error('Cgroup cleanup unverified');
    }
  }

  async close(): Promise<void> {
    await this.peak?.close();
    this.peak = null;
    this.finished = true;
  }
}
