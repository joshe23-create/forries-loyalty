// App-shell cache so the card opens instantly (and offline shows the last-loaded shell).
const CACHE = 'rewards-v6';
const SHELL = ['/', '/styles.css', '/member.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/logo-white.svg', '/vendor/qrcode-generator.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/staff')) return;
  // Network-first for the shell, fall back to cache when offline.
  e.respondWith(fetch(e.request).then((r) => (r.ok && caches.open(CACHE).then((c) => c.put(e.request, r.clone())), r)).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});

// Push notifications: stamps, rewards, birthdays and (opt-in) specials.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Rewards', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: d.tag,
      renotify: !!d.tag,
      data: { url: d.url || '/' },
    })
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      return open ? open.navigate(target).then((c) => (c || open).focus()) : self.clients.openWindow(target);
    })
  );
});
