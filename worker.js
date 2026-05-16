// =============================================================================
// TTT Price Alert Worker — Cloudflare Worker with Web Push
// =============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/subscribe" && request.method === "POST") {
        const sub = await request.json();
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return json({ error: "Invalid subscription" }, 400, cors);
        }
        await env.TTT_KV.put("push:sub", JSON.stringify(sub));
        return json({ ok: true, message: "Subscription stored" }, 200, cors);
      }

      if (url.pathname === "/triggers" && request.method === "POST") {
        const data = await request.json();
        if (!data?.stocks) return json({ error: "Missing stocks array" }, 400, cors);
        await env.TTT_KV.put("triggers:config", JSON.stringify(data.stocks));
        const signals = {};
        data.stocks.forEach(s => { signals[s.ticker] = s.signals || { mos: false, tenCap: false, pbt: false }; });
        await env.TTT_KV.put("signals:state", JSON.stringify(signals));
        if (data.workerUrl) await env.TTT_KV.put("settings:worker", data.workerUrl);
        return json({ ok: true, count: data.stocks.length }, 200, cors);
      }

      if (url.pathname === "/status") {
        const sub = await env.TTT_KV.get("push:sub");
        const config = await env.TTT_KV.get("triggers:config");
        return json({
          hasSubscription: !!sub,
          triggerCount: config ? JSON.parse(config).length : 0,
          vapidOk: !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY && !!env.VAPID_SUBJECT,
          timestamp: new Date().toISOString(),
        }, 200, cors);
      }

      if (url.pathname === "/test" && request.method === "POST") {
        const sub = await env.TTT_KV.get("push:sub", { type: "json" });
        if (!sub) return json({ ok: false, error: "No subscription — reconnect from TTT" }, 400, cors);
        if (!env.VAPID_PRIVATE_KEY) return json({ ok: false, error: "VAPID_PRIVATE_KEY not set" }, 400, cors);
        if (!env.VAPID_PUBLIC_KEY) return json({ ok: false, error: "VAPID_PUBLIC_KEY not set" }, 400, cors);
        const payload = JSON.stringify({
          title: "🎯 TTT Push Test",
          body: "If you see this, push notifications are working!",
          tag: "ttt-push-test",
        });
        const result = await sendPush(env, sub, payload);
        return json(result, result.ok ? 200 : 502, cors);
      }

      if (url.pathname === "/check" && request.method === "POST") {
        const result = await priceCheck(env);
        return json(result, 200, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ ok: false, error: e.message, stack: e.stack?.split("\n").slice(0, 5) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    if (!isAnyMarketOpenUTC()) return;
    ctx.waitUntil(priceCheck(env));
  },
};

// =============================================================================
// Price check — fetches directly from Yahoo Finance (no proxy needed)
// =============================================================================
async function priceCheck(env) {
  const configRaw = await env.TTT_KV.get("triggers:config");
  if (!configRaw) return { skipped: true, reason: "no trigger config" };
  const stocks = JSON.parse(configRaw);
  const stateRaw = await env.TTT_KV.get("signals:state");
  const prevSignals = stateRaw ? JSON.parse(stateRaw) : {};

  const symbols = stocks.filter(s => s.symbol).map(s => s.symbol);
  if (!symbols.length) return { skipped: true, reason: "no symbols" };

  // Fetch prices directly from Yahoo Finance (server-side = no CORS issues)
  let prices = {};
  try {
    prices = await fetchYahooPrices(symbols);
  } catch (e) { return { error: "Price fetch failed: " + e.message }; }

  const fires = [];
  const newSignals = { ...prevSignals };
  stocks.forEach(s => {
    if (!s.symbol) return;
    const q = prices[s.symbol];
    if (!q?.price) return;
    const price = q.price * (s.priceMult || 1);
    const prev = prevSignals[s.ticker] || { mos: false, tenCap: false, pbt: false };
    // Per-signal ownership snapshot from the client. When a tranche is already bought, suppress
    // the corresponding push notification so the user isn't pinged about an action already taken.
    // Fallback to all-false if an older client hasn't sent the field — safe default (alerts as before).
    const owned = s.owned || { mos: false, tenCap: false, pbt: false };
    // Sticker Ceiling: tenCap/pbt triggers only valid if trigger price < sticker (mos×2).
    // High-Growth category: DMOS (stored in pbt column) is mathematically < sticker by
    // construction (= sticker × 0.45), so it's never muted — skip the ceiling check.
    const sticker = s.sticker || (s.triggers.mos ? s.triggers.mos * 2 : null);
    const hg = s.category === "highgr";
    const now = {
      pbt: s.triggers.pbt ? price <= s.triggers.pbt && (hg || !sticker || s.triggers.pbt < sticker) : false,
      tenCap: s.triggers.tenCap ? price <= s.triggers.tenCap && (!sticker || s.triggers.tenCap < sticker) : false,
      mos: s.triggers.mos ? price <= s.triggers.mos : false,
    };
    // Notification labels — High-Growth tenCap is "20Cap", High-Growth pbt is "DMOS"
    const pbtLabel = hg ? "DMOS" : "PBT";
    const tenCapLabel = hg ? "20Cap" : "Ten Cap";
    if (now.pbt && !prev.pbt && !owned.pbt) fires.push({ ticker: s.ticker, signal: pbtLabel, price, currency: s.currency });
    if (now.tenCap && !prev.tenCap && !owned.tenCap) fires.push({ ticker: s.ticker, signal: tenCapLabel, price, currency: s.currency });
    if (now.mos && !prev.mos && !owned.mos) fires.push({ ticker: s.ticker, signal: "MOS", price, currency: s.currency });
    newSignals[s.ticker] = now;
  });
  await env.TTT_KV.put("signals:state", JSON.stringify(newSignals));

  if (fires.length) {
    const sub = await env.TTT_KV.get("push:sub", { type: "json" });
    if (sub) {
      for (const f of fires) {
        const payload = JSON.stringify({
          title: `🎯 ${f.ticker} hit ${f.signal}`,
          body: `Price: ${f.price.toFixed(2)} ${f.currency} — open TTT to deploy capital`,
          tag: `ttt-${f.ticker}-${f.signal}`,
        });
        await sendPush(env, sub, payload);
      }
    }
  }
  return { checked: symbols.length, fires: fires.length, details: fires, timestamp: new Date().toISOString() };
}

// =============================================================================
// Direct Yahoo Finance price fetch (no proxy needed server-side)
// Returns {symbol: {price: number}} for each symbol
// =============================================================================
async function fetchYahooPrices(symbols) {
  const results = {};
  // Fetch in parallel, batches of 5 to be polite
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5);
    const fetches = batch.map(async (sym) => {
      try {
        const resp = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
          { headers: { "User-Agent": "Mozilla/5.0" } }
        );
        if (!resp.ok) return;
        const data = await resp.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          results[sym] = { price: meta.regularMarketPrice };
        }
      } catch (e) { /* skip this symbol */ }
    });
    await Promise.all(fetches);
  }
  return results;
}

function isAnyMarketOpenUTC() {
  const now = new Date();
  const d = now.getUTCDay();
  if (d === 0 || d === 6) return false;
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
  return hm >= 480 && hm <= 1260;
}

// =============================================================================
// Base64url helpers
// =============================================================================
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
function concat(...bufs) {
  const total = bufs.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { out.set(new Uint8Array(b), off); off += b.byteLength; }
  return out;
}

// =============================================================================
// HKDF-SHA-256 (RFC 5869)
// Extract: PRK = HMAC-SHA-256(key=salt, message=IKM)
// Expand:  OKM = HMAC-SHA-256(key=PRK, message=info || 0x01)[0..length]
// =============================================================================
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, ikm));
}
async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(await crypto.subtle.sign("HMAC", key, concat(info, new Uint8Array([1]))));
  return out.slice(0, length);
}
async function hkdf(salt, ikm, info, length) {
  const prk = await hkdfExtract(salt, ikm);
  return hkdfExpand(prk, info, length);
}

// =============================================================================
// VAPID JWT (RFC 8292) — uses JWK import (raw import not supported for ECDSA)
// =============================================================================
async function createVapidJWT(env, audience) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    aud: audience, exp: now + 43200, sub: env.VAPID_SUBJECT,
  })));
  const unsigned = `${header}.${payload}`;

  // Build JWK from the raw public key (x,y) and private key (d)
  const pubRaw = b64urlDecode(env.VAPID_PUBLIC_KEY); // 65 bytes: 0x04 || x[32] || y[32]
  const jwk = {
    kty: "EC", crv: "P-256",
    x: b64url(pubRaw.slice(1, 33)),
    y: b64url(pubRaw.slice(33, 65)),
    d: env.VAPID_PRIVATE_KEY, // already base64url 32 bytes
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

// =============================================================================
// Web Push payload encryption (RFC 8291 / aes128gcm)
// =============================================================================
async function encryptPayload(sub, payload) {
  const payloadBytes = new TextEncoder().encode(payload);
  const clientPubRaw = b64urlDecode(sub.keys.p256dh); // 65 bytes
  const authSecret = b64urlDecode(sub.keys.auth);     // 16 bytes

  // Ephemeral ECDH key pair for this message
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  // ECDH shared secret
  const clientPub = await crypto.subtle.importKey("raw", clientPubRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientPub }, ephemeral.privateKey, 256));

  // Derive IKM: HKDF(salt=authSecret, ikm=sharedSecret, info="WebPush: info\0" || clientPub || serverPub, 32)
  const ikm = await hkdf(authSecret, sharedSecret, concat(new TextEncoder().encode("WebPush: info\0"), clientPubRaw, ephPubRaw), 32);

  // Random salt for this message
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive CEK (16 bytes) and nonce (12 bytes) from salt + IKM
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  // Pad: payload || 0x02 (single-record delimiter)
  const padded = concat(payloadBytes, new Uint8Array([2]));

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  // aes128gcm header: salt(16) || recordSize(4) || idLen(1) || keyId(65) || ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([ephPubRaw.length]), ephPubRaw, encrypted);
}

// =============================================================================
// Send push notification
// =============================================================================
async function sendPush(env, sub, payload) {
  try {
    const endpoint = sub.endpoint;
    const audience = new URL(endpoint);
    const aud = `${audience.protocol}//${audience.host}`;

    const jwt = await createVapidJWT(env, aud);
    const body = await encryptPayload(sub, payload);

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
      },
      body,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, error: `Push service: ${resp.status} ${errBody.slice(0, 200)}` };
    }
    return { ok: true, status: resp.status };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack?.split("\n").slice(0, 3) };
  }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...extra },
  });
}
