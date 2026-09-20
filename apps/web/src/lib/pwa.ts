export type PwaUpdateHandler = (registration: ServiceWorkerRegistration) => void;

export function registerPwa(onUpdate: PwaUpdateHandler): () => void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return () => undefined;
  let registration: ServiceWorkerRegistration | undefined;
  let refreshing = false;

  const onControllerChange = () => {
    if (refreshing) return;
    refreshing = true;
    // Deliberately do not reload. The user may have an unsent draft.
  };

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
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
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    void registration;
  };
}

export function activateUpdate(registration: ServiceWorkerRegistration): void {
  registration.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' });
}
