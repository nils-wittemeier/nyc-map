/* NYC Neighborhood Tracker — service worker
 * Caches the app shell for offline use, and stale-while-revalidates
 * map tiles into a separate bounded-by-quota cache.
 *
 * Bump SHELL_CACHE when shipping a new version of the app — old caches are
 * pruned on activate.
 */

const SHELL_CACHE = 'nyc-tracker-shell-v3';
const TILES_CACHE = 'nyc-tracker-tiles-v1';

const LOCAL_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './data/neighborhoods.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const CDN_SHELL = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(LOCAL_SHELL);
    // CDN entries: cache opportunistically, ignore individual failures
    await Promise.all(CDN_SHELL.map(async (url) => {
      try { await cache.add(url); } catch (err) { /* offline-first OK to skip */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, TILES_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // CARTO map tiles → stale-while-revalidate, separate cache
  if (url.hostname.endsWith('basemaps.cartocdn.com')) {
    e.respondWith(staleWhileRevalidate(e.request, TILES_CACHE));
    return;
  }

  // Everything else (app shell + CDN deps) → cache-first, fall through to network
  e.respondWith(cacheFirst(e.request, SHELL_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    // Last resort: maybe a navigation request — serve cached index.html
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch(() => cached);
  return cached || networkPromise;
}
