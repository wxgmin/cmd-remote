// Service worker: cache static assets for PWA installability.
// Never cache HTML or auth-gated pages — always network-first for those.
const CACHE = 'cmd-remote-v2';
// Immutable-ish static assets only (no HTML, no API).
const SHELL = ['/manifest.json', '/icon.svg', '/icon-192.png', '/icon-512.png', '/xterm.css', '/xterm.js', '/fit.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Never intercept API, WebSocket, or navigation (HTML) requests.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  if (e.request.mode === 'navigate') return;
  // Static assets: cache-first with network fallback.
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => cached))
  );
});
