// Real-user monitoring from Roloe's phone pages, forwarded to Dash0 by the coordinator. The Dash0
// token never ships to a browser, and keys in URLs are stripped here even if a page missed one.
const SIGNALS = new Set(['traces', 'logs', 'metrics']);
const MAX = 512_000;

export function scrubRum(text) {
  return text
    .replace(/([?&]k=)[^&"\s\\]+/g, '$1-')            // meeting and stage keys
    .replace(/#rk_[A-Za-z0-9_-]+/g, '')               // a card key in a /me fragment
    .replace(/\b(?:sk|stk|rk)_[A-Za-z0-9_-]{16,}/g, '-');
}

export async function forwardRum(signal, body, contentType, { endpoint, headers, fetchImpl = fetch }) {
  if (!SIGNALS.has(signal)) return { status: 404 };
  if (!endpoint) return { status: 204 };
  if (!/json/i.test(contentType || '')) return { status: 415 };
  if (body.length > MAX) return { status: 413 };
  const base = endpoint.replace(/\/$/, '').replace(/\/v1\/traces$/, '');
  const res = await fetchImpl(`${base}/v1/${signal}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: scrubRum(body), signal: AbortSignal.timeout(10000) });
  return { status: res.ok ? 200 : 502 };
}

// Per-address sliding window. Only accepted hits are kept, so a flood costs nothing extra, and a
// full map drops its least recently seen address, so rotating addresses can't reset everyone.
export function rateLimiter({ limit = 120, windowMs = 60_000, maxAddresses = 5000 } = {}) {
  const hits = new Map();
  return (ip, now = Date.now()) => {
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    hits.delete(ip);
    if (recent.length >= limit) { hits.set(ip, recent); return false; }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > maxAddresses) hits.delete(hits.keys().next().value);
    return true;
  };
}
