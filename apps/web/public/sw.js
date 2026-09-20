const CACHE_VERSION = 'relay-static-v1';
const VERSIONED_ASSET = /^\/assets\/[\w.-]*-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg|webp)$/;

self.addEventListener('install', () => {
  // No shell precache: index.html and API data must always come from the network.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('relay-static-') && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !VERSIONED_ASSET.test(url.pathname)
  )
    return;

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
