/* Star Focus service worker.
   Network-first so an online refresh picks up updates, with a cached copy for offline use.
   Paths are relative to the registration scope so a GitHub Pages subpath works. */
const CACHE = 'star-focus-v1';

function assetUrls() {
  const scope = self.registration.scope;
  return [
    '',
    'index.html',
    'styles.css',
    'app.js',
    'manifest.json',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/apple-touch-icon.png',
    'icons/favicon-32.png',
    'favicon.ico',
    'fonts/nunito-700.woff2',
    'fonts/nunito-800.woff2',
  ].map((path) => new URL(path, scope).href);
}

async function store(cache, url, response) {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  const saved = new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: headers,
  });
  await cache.put(url, saved);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = assetUrls();
    await Promise.all(urls.map(async (url) => {
      const response = await fetch(url, { cache: 'reload' });
      if (!response.ok) throw new Error('Failed to cache ' + url);
      await store(cache, url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      try {
        await store(cache, request, response.clone());
      } catch (err) {
        /* A redirected response can refuse to be stored. The network result still stands. */
      }
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match(new URL('index.html', self.registration.scope).href);
      if (fallback) return fallback;
    }
    return new Response('Star Focus is offline and this file is not saved yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
