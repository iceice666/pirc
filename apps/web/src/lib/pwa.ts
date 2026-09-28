export type PwaUpdateHandler = (registration: ServiceWorkerRegistration) => void;

/** How often an open, visible page checks for a new build. */
const UPDATE_INTERVAL = 60 * 60 * 1000;

/** Set when the user applies an update from the toast. */
let updateRequested = false;

export function registerPwa(onUpdate: PwaUpdateHandler): () => void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return () => undefined;
  let registration: ServiceWorkerRegistration | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastCheck = Date.now();

  /**
   * A new worker took over. Only the user's "Update" reloads the page (its
   * draft is saved on pagehide), so it runs the code that worker serves; a
   * takeover the user did not ask for never discards what they are doing.
   */
  const onControllerChange = () => {
    if (!updateRequested) return;
    updateRequested = false;
    location.reload();
  };

  const check = () => {
    lastCheck = Date.now();
    void registration?.update().catch(() => undefined);
  };
  /** Check hourly while visible; a page returning after an hour checks at once. */
  const schedule = () => {
    clearInterval(timer);
    timer = undefined;
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheck >= UPDATE_INTERVAL) check();
    timer = setInterval(check, UPDATE_INTERVAL);
  };

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  document.addEventListener('visibilitychange', schedule);
  schedule();
  void navigator.serviceWorker.register('/sw.js').then((value) => {
    registration = value;
    if (registration.waiting) onUpdate(registration);
    registration.addEventListener('updatefound', () => {
      const worker = registration?.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller && registration)
          onUpdate(registration);
      });
    });
  });

  return () => {
    clearInterval(timer);
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    document.removeEventListener('visibilitychange', schedule);
  };
}

export function activateUpdate(registration: ServiceWorkerRegistration): void {
  if (!registration.waiting) return;
  updateRequested = true;
  registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
}
