const CACHE_NAME = 'ttt-v1.76';
const ASSETS = ['./', './index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'ttt-alerts').map(k => caches.delete(k)))
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

// ============ LAYER 2: periodicSync price alert ============
// Market hours check (UTC): LSE 08:00-16:30, Euronext 09:00-17:30, NYSE 14:30-21:00
function swMarketOpen(ccy) {
  const now = new Date();
  const d = now.getUTCDay();
  if (d === 0 || d === 6) return false;
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (ccy === 'GBp') return hm >= 480 && hm <= 990;
  if (ccy === 'EUR') return hm >= 540 && hm <= 1050;
  return hm >= 870 && hm <= 1260;
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'price-alert') {
    e.waitUntil(swPriceCheck());
  }
});

async function swPriceCheck() {
  try {
    // Read alert config from cache
    const cache = await caches.open('ttt-alerts');
    const resp = await cache.match('/alert-config');
    if (!resp) return;
    const config = await resp.json();
    if (!config.workerUrl || !config.stocks?.length) return;

    // Filter to stocks whose markets are open
    const openStocks = config.stocks.filter(s => swMarketOpen(s.currency));
    if (!openStocks.length) return;

    // Fetch prices via Yahoo worker (same as main app)
    const symbols = openStocks.filter(s => s.symbol).map(s => s.symbol).join(',');
    if (!symbols) return;
    const r = await fetch(`${config.workerUrl}/?action=quote&symbols=${encodeURIComponent(symbols)}`);
    const data = await r.json();

    // Compare prices to triggers, find new fires
    const fires = [];
    openStocks.forEach(s => {
      if (!s.symbol) return;
      const q = data[s.symbol];
      if (!q || !q.price) return;
      const price = q.price * (s.priceMult || 1);
      const prev = s.signals || {};
      if (s.triggers.pbt && price <= s.triggers.pbt && !prev.pbt) fires.push({ ticker: s.ticker, signal: 'PBT', price });
      if (s.triggers.tenCap && price <= s.triggers.tenCap && !prev.tenCap) fires.push({ ticker: s.ticker, signal: 'Ten Cap', price });
      if (s.triggers.mos && price <= s.triggers.mos && !prev.mos) fires.push({ ticker: s.ticker, signal: 'MOS', price });
    });

    // Send notifications
    for (const f of fires) {
      await self.registration.showNotification(`🎯 ${f.ticker} hit ${f.signal}`, {
        body: `Price: ${f.price.toFixed(2)} — open TTT to review`,
        tag: `ttt-${f.ticker}-${f.signal}`,
        renotify: true
      });
    }

    // Update signals in cache so we don't re-fire
    if (fires.length) {
      fires.forEach(f => {
        const s = config.stocks.find(x => x.ticker === f.ticker);
        if (s) {
          if (f.signal === 'MOS') s.signals.mos = true;
          if (f.signal === 'Ten Cap') s.signals.tenCap = true;
          if (f.signal === 'PBT') s.signals.pbt = true;
        }
      });
      await cache.put('/alert-config', new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } }));
    }
  } catch (e) { /* silent fail — next sync will retry */ }
}

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
