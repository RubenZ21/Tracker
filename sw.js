const CACHE_NAME = 'ttt-v2.02';
const ASSETS = ['./', './index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      fetch(e.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return response;
      }).catch(() => cached)
    )
  );
});

// ============ WEB PUSH: receive from Cloudflare Worker ============
self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { data = { title: '🎯 TTT Alert', body: e.data.text() }; }
  const title = data.title || '🎯 TTT Alert';
  const options = {
    body: data.body || '',
    tag: data.tag || 'ttt-push',
    renotify: true,
    requireInteraction: true, // keep notification visible until tapped
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Open the app when tapping a notification
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length) { clients[0].focus(); return; }
      return self.clients.openWindow('./');
    })
  );
});
