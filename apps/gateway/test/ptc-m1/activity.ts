/** Bounded event-driven quiescence, not proof that an agent cannot start future work. */
export class ProviderActivity {
  private active = 0;
  private generation = 0;
  private listeners = new Set<() => void>();
  private closed = false;

  begin(): () => void {
    if (this.closed) throw new Error('Provider activity closed');
    this.active++;
    this.changed();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.active--;
      this.changed();
    };
  }

  private changed(): void {
    this.generation++;
    for (const listener of [...this.listeners]) listener();
  }

  close(): void {
    this.closed = true;
    this.changed();
  }

  /** Keep agent and inference alive while waiting; never poll the model for idleness. */
  waitForQuiet(options: {
    quietMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ waitMs: number; observedChanges: number }> {
    const { quietMs, timeoutMs, signal } = options;
    if (
      !Number.isSafeInteger(quietMs) ||
      quietMs < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= quietMs ||
      timeoutMs > 600000
    )
      return Promise.reject(new Error('Invalid quiescence deadline'));
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const generation = this.generation;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(quiet);
        clearTimeout(deadline);
        this.listeners.delete(update);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(new Error(error));
        else
          resolve({
            waitMs: performance.now() - start,
            observedChanges: this.generation - generation,
          });
      };
      const cancel = () => finish('Provider quiescence cancelled');
      const update = () => {
        clearTimeout(quiet);
        if (this.closed) return finish('Provider closed before quiescence');
        if (signal?.aborted) return cancel();
        if (this.active === 0) quiet = setTimeout(() => finish(), quietMs);
      };
      this.listeners.add(update);
      signal?.addEventListener('abort', cancel, { once: true });
      deadline = setTimeout(() => finish('Provider quiescence timeout'), timeoutMs);
      update();
    });
  }
}
