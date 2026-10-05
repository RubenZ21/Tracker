const CACHE_NAME = 'ttt-v5.09';
const ASSETS = ['./', './index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'ttt-config').map(k => caches.delete(k)))
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
    // FIX v3.70: attach the deeplink so notificationclick can route on data.url (e.g. #capepen:us).
    // Without this, e.notification.data was undefined and targetUrl always fell back to './'.
    data: { url: data.url || '' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// v5.08: the browser rotated/expired the push subscription while the app was closed. Re-subscribe
// here and hand the new subscription to the Worker, so closed-app alerts keep arriving without the
// app having to be opened. Worker URL + VAPID key are left in the 'ttt-config' cache by the app.
function b64ToU8(s) {
  s = (s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s); const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const c = await caches.open('ttt-config');
    const r = await c.match('./__push-config');
    if (!r) return;
    const cfg = await r.json();
    const sub = e.newSubscription || await self.registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: b64ToU8(cfg.vapid),
    });
    await fetch(cfg.workerUrl + '/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()),
    });
  })().catch(() => {}));
});

// Open the app when tapping a notification.
// Notifications may attach data.url with a deeplink hash (e.g. #capepen:us) so the
// app can route directly to the relevant card. Pool 1 notifications carry no url and
// just focus the existing window.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length) {
        const c = clients[0];
        c.focus();
        // Pass the deeplink to the focused client; the app listens for it.
        if (targetUrl !== './') c.postMessage({ type: 'deeplink', url: targetUrl });
        return;
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
