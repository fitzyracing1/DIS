// Fixed-window per-key rate limiter (in memory). Small and good enough for one process.
export class RateLimiter {
  constructor({ limit = 30, windowMs = 60000, maxKeys = 10000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.hits = new Map();
  }

  /** Returns { ok, remaining, retryAfterSec }. */
  take(key) {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || t >= e.reset) {
      if (this.hits.size >= this.maxKeys) this.sweep(t);
      e = { count: 0, reset: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count += 1;
    const ok = e.count <= this.limit;
    return { ok, remaining: Math.max(0, this.limit - e.count), retryAfterSec: Math.ceil((e.reset - t) / 1000) };
  }

  sweep(t = this.now()) {
    for (const [k, e] of this.hits) if (t >= e.reset) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

/**
 * Client IP for rate limiting. Behind one reverse proxy (Railway, Fly, nginx) set DIS_TRUST_PROXY=1:
 * we then take the LAST X-Forwarded-For entry (the one the proxy added), which a client cannot forge.
 */
export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}
