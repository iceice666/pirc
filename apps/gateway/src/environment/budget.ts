/** Node-local monotonic lifetime. Human waits never extend the absolute lease. */
export class ExecutionBudget {
  readonly controller = new AbortController();
  private activeRemaining: number;
  private lastActive = performance.now();
  private waits = 0;
  private closed = false;
  private activeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly absoluteTimer: ReturnType<typeof setTimeout>;
  readonly absoluteDeadline: number;
  constructor(activeMs: number, humanMs = 30 * 60_000) {
    this.activeRemaining = activeMs;
    this.absoluteDeadline = this.lastActive + activeMs + humanMs;
    this.absoluteTimer = setTimeout(
      () => this.controller.abort(new Error('Absolute execution deadline expired')),
      activeMs + humanMs,
    );
    this.arm();
  }
  private arm(): void {
    this.lastActive = performance.now();
    this.activeTimer = setTimeout(
      () => this.controller.abort(new Error('Active execution deadline expired')),
      Math.max(0, this.activeRemaining),
    );
  }
  beginHumanWait(): void {
    this.controller.signal.throwIfAborted();
    if (this.waits++ === 0) {
      this.activeRemaining -= performance.now() - this.lastActive;
      clearTimeout(this.activeTimer);
      if (this.activeRemaining <= 0)
        this.controller.abort(new Error('Active execution deadline expired'));
    }
  }
  endHumanWait(): void {
    if (!this.waits) throw new Error('Unbalanced human wait');
    if (--this.waits === 0 && !this.controller.signal.aborted && !this.closed) this.arm();
  }
  async humanWait<T>(work: Promise<T>): Promise<T> {
    this.beginHumanWait();
    try {
      return await work;
    } finally {
      this.endHumanWait();
    }
  }
  remainingAbsolute(): number {
    return Math.max(0, this.absoluteDeadline - performance.now());
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.activeTimer);
    clearTimeout(this.absoluteTimer);
  }
}
