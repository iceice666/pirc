const CACHE_VERSION = 'relay-static-v1';
/** The last app shell (index.html) served by the network, for starting offline. */
const SHELL_CACHE = 'relay-shell-v1';
const SHELL_KEY = '/';
const VERSIONED_ASSET = /^\/assets\/[\w.-]*-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg|webp)$/;

/**
 * Only a real page is kept: not a login redirect or error page from the
 * authenticating proxy in front of the gateway.
 */
const cacheableShell = (response) =>
  response.ok &&
  response.type === 'basic' &&
  !response.redirected &&
  (response.headers.get('content-type') ?? '').includes('text/html');

self.addEventListener('install', (event) => {
  // Seed the shell so the app can start offline after its first visit. A
  // failure (offline, signed out) must not block installing the worker.
  event.waitUntil(
    fetch(new Request(SHELL_KEY, { cache: 'no-store' }))
      .then(async (response) => {
        if (cacheableShell(response))
          await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, response);
      })
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                (key.startsWith('relay-static-') && key !== CACHE_VERSION) ||
                (key.startsWith('relay-shell-') && key !== SHELL_CACHE),
            )
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

/**
 * Pages: network first, so an online start always gets the current build and
 * the proxy can still redirect to its login. Only when the network fails is
 * the last good shell served; its hashed assets are in the static cache from
 * that visit.
 */
async function navigate(event) {
  try {
    const response = await fetch(event.request);
    if (cacheableShell(response)) {
      const copy = response.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_KEY, copy)));
    }
    return response;
  } catch (error) {
    const cached = await caches.match(SHELL_KEY, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    // API data is never cached.
    if (!url.pathname.startsWith('/api/')) event.respondWith(navigate(event));
    return;
  }
  if (!VERSIONED_ASSET.test(url.pathname)) return;

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic')
        await cache.put(event.request, response.clone());
      return response;
    }),
  );
});
