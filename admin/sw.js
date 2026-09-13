// Slocabaia dashboard as an app. Network first, so an update lands straight away; the cache is
// only the offline fallback for the shell. API answers are never cached: they hold messages and
// member data.
const CACHE = 'sloca-dashboard-v1';
const SHELL = ['/admin/', '/admin/manifest.webmanifest', '/admin/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/admin/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !url.search) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('/admin/'))),
  );
});

/* ---------- notifications ---------- */

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Slocabaia', {
      body: d.body || '',
      icon: '/admin/icons/icon-192.png',
      badge: '/admin/icons/badge-96.png',
      tag: d.tag || undefined,
      lang: 'nl',
      data: { url: typeof d.url === 'string' && d.url.startsWith('/admin/') ? d.url : '/admin/' },
    }),
  );
});

// A tap reuses an open dashboard window and sends it to the message; otherwise it opens one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/admin/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => new URL(c.url).pathname.startsWith('/admin/'));
      if (!win) return self.clients.openWindow(target);
      win.postMessage({ open: target });
      return win.focus();
    }),
  );
});
