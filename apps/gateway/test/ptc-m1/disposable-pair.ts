/** Controller-owned same-path prime/measured setup. No caller-chosen deletion paths. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
const owned = new WeakSet<DisposablePair>();
export class DisposablePair {
  private busy = false;
  private closed = false;
  private generation = 0;
  private constructor(private readonly base: string) {
    owned.add(this);
  }
  static async create(): Promise<DisposablePair> {
    return new DisposablePair(await mkdtemp('/tmp/ptc-pair-'));
  }
  invalidate(): void {
    this.closed = true;
  }
  async acquire(): Promise<{ root: string; release: () => Promise<void> }> {
    if (!owned.has(this) || this.closed || this.busy || this.generation >= 2)
      throw new Error('Disposable pair unavailable');
    this.busy = true;
    const root = path.join(this.base, 'run');
    try {
      await mkdir(root, { mode: 0o700 });
    } catch {
      this.busy = false;
      throw new Error('Disposable pair not clean');
    }
    this.generation++;
    let released = false;
    return {
      root,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await rm(root, { recursive: true, force: true });
        } catch {
          this.closed = true;
          throw new Error('Disposable pair cleanup failed');
        } finally {
          this.busy = false;
        }
      },
    };
  }
  async close(): Promise<void> {
    if (this.busy) throw new Error('Cannot remove an active disposable pair');
    this.closed = true;
    await rm(this.base, { recursive: true, force: true });
  }
}
