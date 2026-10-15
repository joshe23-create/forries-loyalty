// App-shell cache so the card opens instantly (and offline shows the last-loaded shell).
const CACHE = 'rewards-v1';
const SHELL = ['/', '/styles.css', '/member.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/m/qr.svg')) {
    // QR never changes for a member: cache-first so it shows even with bad signal at the bar.
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => (r.ok && c.put(e.request, r.clone()), r))));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/staff')) return;
  // Network-first for the shell, fall back to cache when offline.
  e.respondWith(fetch(e.request).then((r) => (r.ok && caches.open(CACHE).then((c) => c.put(e.request, r.clone())), r)).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
