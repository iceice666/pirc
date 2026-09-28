import { errorMessage } from './errors';
import { isAbort } from './http';
import { panelApi, type BackgroundTask, type PanelState } from './panel-api';

/**
 * `/panel/state` of the open session, shared by the jobs menu, the Memory and
 * Tasks tabs and the side-panel badges, so they never fetch it separately.
 */
export class PanelStateResource {
  value = $state.raw<PanelState>();
  error = $state('');
  #sessionId = '';
  #demo = false;
  #inflight: Promise<void> | undefined;
  #again = false;
  #controller: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** Switch to another session (or the demo's static state); drops anything in flight. */
  reset(sessionId: string, demo?: PanelState): void {
    this.#controller?.abort();
    this.#controller = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#inflight = undefined;
    this.#again = false;
    this.#sessionId = sessionId;
    this.#demo = !!demo;
    this.value = demo;
    this.error = '';
  }

  /**
   * Load now. Callers that only need recent data share a request in flight;
   * `fresh` callers (reacting to a change) get one follow-up request after it.
   */
  refresh(options: { fresh?: boolean } = {}): Promise<void> {
    if (this.#demo || !this.#sessionId) return Promise.resolve();
    if (this.#inflight) {
      if (options.fresh) this.#again = true;
      return this.#inflight;
    }
    const sessionId = this.#sessionId;
    const controller = new AbortController();
    this.#controller = controller;
    const run = async () => {
      try {
        const next = await panelApi.state(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        this.value = next;
        this.error = '';
      } catch (cause) {
        if (controller.signal.aborted || isAbort(cause)) return;
        this.error = errorMessage(cause, 'Unable to load panel state.');
      } finally {
        if (this.#controller === controller) {
          this.#controller = undefined;
          this.#inflight = undefined;
          if (this.#again) {
            this.#again = false;
            void this.refresh();
          }
        }
      }
    };
    this.#inflight = run();
    return this.#inflight;
  }

  /** Coalesce bursts of change events (memory reports progress every turn). */
  schedule(delay = 400): void {
    if (this.#timer || this.#demo) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refresh({ fresh: true });
    }, delay);
  }

  /** Apply a task returned by an action (e.g. stop) without refetching. */
  updateTask(task: BackgroundTask): void {
    const value = this.value;
    if (value)
      this.value = {
        ...value,
        backgroundTasks: value.backgroundTasks.map((item) => (item.id === task.id ? task : item)),
      };
  }
}
