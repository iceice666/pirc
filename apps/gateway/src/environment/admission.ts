import { REQUEST_BYTES } from './protocol.js';

interface Admission {
  id: string;
  node: string;
  session: string;
  bytes: number;
  deadline: number;
  ready(): boolean;
  start(): Promise<void>;
  expire(): void;
}
/** Shared supervisor coordinator: four/node, one/session, 32/node and 128 global queued. */
export class EnvironmentAdmission {
  private queues = new Map<string, Admission[]>();
  private active = new Map<string, Admission>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pumping = false;
  reserve(item: Admission): void {
    const queued = [...this.queues.values()].flat();
    if (this.active.has(item.id) || queued.some((entry) => entry.id === item.id))
      throw new Error('Execution ID admission conflict');
    if (
      queued.length >= 128 ||
      queued.filter((entry) => entry.node === item.node).length >= 32 ||
      queued.reduce((sum, entry) => sum + entry.bytes, 0) + item.bytes > REQUEST_BYTES * 4
    )
      throw new Error('Environment admission quota exceeded');
    const bucket = this.queues.get(item.session) ?? [];
    bucket.push(item);
    this.queues.set(item.session, bucket);
  }
  remove(id: string): void {
    for (const [session, items] of this.queues) {
      const remaining = items.filter((item) => item.id !== id);
      if (remaining.length) this.queues.set(session, remaining);
      else this.queues.delete(session);
    }
    this.wake();
  }
  wake(): void {
    if (this.pumping) return;
    this.pumping = true;
    clearTimeout(this.timer);
    try {
      for (const [session, original] of [...this.queues]) {
        const items = original.filter((entry) => {
          if (performance.now() < entry.deadline) return true;
          entry.expire();
          return false;
        });
        if (!items.length) {
          this.queues.delete(session);
          continue;
        }
        this.queues.set(session, items);
        const item = items[0]!;
        if (
          !item.ready() ||
          [...this.active.values()].some((entry) => entry.session === session) ||
          [...this.active.values()].filter((entry) => entry.node === item.node).length >= 4
        )
          continue;
        items.shift();
        this.queues.delete(session);
        if (items.length) this.queues.set(session, items); // Move serviced session to the tail.
        this.active.set(item.id, item);
        void item.start().finally(() => {
          this.active.delete(item.id);
          this.wake();
        });
      }
    } finally {
      this.pumping = false;
      if (this.queues.size) {
        const deadline = Math.min(...[...this.queues.values()].flat().map((item) => item.deadline));
        this.timer = setTimeout(() => this.wake(), Math.max(1, deadline - performance.now()));
      }
    }
  }
}
