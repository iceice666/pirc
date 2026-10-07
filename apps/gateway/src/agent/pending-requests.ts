import { randomUUID } from 'node:crypto';

type Pending<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

/** Only request lifetimes live here; framing, response decoding and errors belong to callers. */
export class PendingRequests<T = unknown> {
  private readonly pending = new Map<string, Pending<T>>();

  request(options: {
    send: (id: string) => void;
    signal?: AbortSignal | undefined;
    abortError: () => Error;
    cancel?: (id: string) => void;
    timeout?: { ms: number; error: () => Error };
  }): Promise<T> {
    const { send, signal, abortError, cancel, timeout } = options;
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        return true;
      };
      const onAbort = () => {
        if (!settle()) return;
        reject(abortError());
        // Cancellation is best effort: a broken writer must not strand the wait
        // or throw from an abort event listener after the request has ended.
        try {
          cancel?.(id);
        } catch {}
      };
      const pending: Pending<T> = {
        resolve: (value) => {
          if (settle()) resolve(value);
        },
        reject: (error) => {
          if (settle()) reject(error);
        },
      };
      this.pending.set(id, pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeout) timer = setTimeout(() => pending.reject(timeout.error()), timeout.ms);
      try {
        send(id);
      } catch (error) {
        pending.reject(error);
      }
    });
  }

  get(id: string): Pending<T> | undefined {
    return this.pending.get(id);
  }

  closeAll(error: () => Error): void {
    for (const pending of [...this.pending.values()]) pending.reject(error());
  }
}
