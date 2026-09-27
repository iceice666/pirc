import { isAbort } from './http';

/**
 * One request slot with `loading` / `error` state. Starting a new request
 * aborts the previous one, so the slowest of two quick clicks can never win,
 * and `abort()` drops whatever is in flight (e.g. when the session changes).
 */
export class Loader {
  loading = $state(false);
  error = $state('');
  #controller: AbortController | undefined;

  /**
   * Run `task` with a fresh signal. Resolves to its result, or `undefined` when
   * it failed (see `error`) or was superseded / aborted (no state change).
   */
  async run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    failure: string | ((cause: unknown) => string) = 'Request failed.',
  ): Promise<T | undefined> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.loading = true;
    this.error = '';
    try {
      const result = await task(controller.signal);
      return controller.signal.aborted ? undefined : result;
    } catch (cause) {
      if (!controller.signal.aborted && !isAbort(cause))
        this.error =
          typeof failure === 'function'
            ? failure(cause)
            : cause instanceof Error
              ? cause.message
              : failure;
      return undefined;
    } finally {
      if (this.#controller === controller) {
        this.#controller = undefined;
        this.loading = false;
      }
    }
  }

  /** Abort the request in flight and clear the error. */
  abort(): void {
    this.#controller?.abort();
    this.#controller = undefined;
    this.loading = false;
    this.error = '';
  }
}
