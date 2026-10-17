// On-demand check API: other bots ask DIS "is this URL lit or dark?".
//   POST /check  {"url": "...", "type": "http|tcp|dns", "expect": ..., "maxMs": ..., "keyword": ...}
//   GET  /check?url=...&type=...&expect=...&maxMs=...
// Off by default. On when DIS_PUBLIC_CHECK=1 (anyone may call) or DIS_API_KEY is set (callers must send
// "Authorization: Bearer <key>" or "X-API-Key: <key>"; when a key is set it is always required).
// Every check goes through the SSRF guard (lib/net-guard.mjs), with short timeouts and a capped body.
import net from 'node:net';
import { timingSafeEqual, createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { makeGuard, safeFetch, parsePublicUrl, cidrsFromEnv } from './net-guard.mjs';
import { statusMatcher } from './checks.mjs';
import { RateLimiter, clientIp } from './rate-limit.mjs';

export const LIMITS = Object.freeze({ maxMsCap: 10000, defaultMaxMs: 5000, maxBytes: 256 * 1024, maxRedirects: 3 });
const TYPES = ['http', 'tcp', 'dns'];
const RECORDS = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];

const bad = (msg) => Object.assign(new Error(msg), { code: 'EBADREQ' });

/** Normalize a request body / query into a check spec. Throws EBADREQ with a readable message. */
export function parseCheckRequest(input = {}) {
  const type = String(input.type || 'http').toLowerCase();
  if (!TYPES.includes(type)) throw bad(`type must be one of ${TYPES.join(', ')}`);
  let maxMs = input.maxMs == null || input.maxMs === '' ? LIMITS.defaultMaxMs : Number(input.maxMs);
  if (!Number.isFinite(maxMs) || maxMs <= 0) throw bad('maxMs must be a positive number');
  maxMs = Math.min(maxMs, LIMITS.maxMsCap);
  const spec = { type, maxMs };

  if (type === 'http') {
    if (!input.url) throw bad('url is required');
    try { spec.url = parsePublicUrl(input.url).toString(); } catch (e) { throw bad(e.message); }
    spec.expect = input.expect ?? '200-399';
    if (typeof spec.expect === 'string' && spec.expect.includes(',')) spec.expect = spec.expect.split(',');
    if (!statusMatcher(spec.expect)) throw bad('expect must be a status code (200), range ("200-299"), class ("2xx") or a list');
    if (input.keyword != null) {
      if (typeof input.keyword !== 'string' || input.keyword.length > 200) throw bad('keyword must be a string of at most 200 chars');
      spec.keyword = input.keyword;
    }
    if (input.method && !['GET', 'HEAD'].includes(String(input.method).toUpperCase())) throw bad('method must be GET or HEAD');
    spec.method = String(input.method || 'GET').toUpperCase();
  } else if (type === 'tcp') {
    let host = input.host;
    let port = input.port;
    if (!host && input.url) {
      const s = String(input.url).replace(/^tcp:\/\//, '');
      const m = s.match(/^\[([^\]]+)\]:(\d+)$/) || s.match(/^([^:/]+):(\d+)$/);
      if (!m) throw bad('tcp url must look like host:port or tcp://host:port');
      [, host, port] = m;
    }
    if (!host) throw bad('host (or url host:port) is required');
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('port must be 1-65535');
    if (!/^[A-Za-z0-9.:-]{1,253}$/.test(String(host))) throw bad('host is not a valid hostname or IP');
    Object.assign(spec, { host: String(host), port });
  } else {
    let host = input.host || input.url;
    if (!host) throw bad('host (or url) is required');
    host = String(host).replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw bad('host is not a valid hostname');
    spec.host = host;
    spec.recordType = String(input.recordType || 'A').toUpperCase();
    if (!RECORDS.includes(spec.recordType)) throw bad(`recordType must be one of ${RECORDS.join(', ')}`);
    if (input.expect != null) spec.expect = String(input.expect).slice(0, 200);
  }
  return spec;
}

const out = (spec, ok, ms, detail, extra = {}) => ({
  state: ok ? 'lit' : 'dark',
  bit: ok ? 0 : 1,
  type: spec.type,
  target: spec.type === 'http' ? spec.url : spec.type === 'tcp' ? `${spec.host}:${spec.port}` : `${spec.recordType} ${spec.host}`,
  status: null,
  ms: Math.round(ms),
  detail,
  checkedAt: new Date().toISOString(),
  ...extra,
});

const why = (e) => (e?.code === 'EBLOCKED' ? `blocked: ${e.message}` : e?.code === 'ETIMEDOUT' ? e.message : `${e?.code || 'error'}: ${e?.message || e}`);

/** Run one guarded check. Never throws. */
export async function runSafeCheck(spec, { guard = makeGuard(), resolver } = {}) {
  const start = performance.now();
  const timeoutMs = Math.min(LIMITS.maxMsCap, spec.maxMs + 2000);
  if (spec.type === 'http') {
    try {
      const r = await safeFetch(spec.url, { guard, method: spec.method, timeoutMs, maxBytes: LIMITS.maxBytes, maxRedirects: LIMITS.maxRedirects });
      const extra = { status: r.status, redirects: r.redirects, bytes: r.bytes, truncated: r.truncated };
      if (!statusMatcher(spec.expect)(r.status)) return out(spec, false, r.ms, `HTTP ${r.status}, expected ${JSON.stringify(spec.expect)}`, extra);
      if (spec.keyword && !r.body.includes(spec.keyword)) return out(spec, false, r.ms, `HTTP ${r.status} but keyword not found${r.truncated ? ` in the first ${LIMITS.maxBytes} bytes` : ''}`, extra);
      if (r.ms > spec.maxMs) return out(spec, false, r.ms, `HTTP ${r.status}, too slow: ${r.ms}ms > ${spec.maxMs}ms`, extra);
      return out(spec, true, r.ms, `HTTP ${r.status} in ${r.ms}ms`, extra);
    } catch (e) {
      return out(spec, false, performance.now() - start, why(e));
    }
  }
  if (spec.type === 'tcp') {
    try {
      await guard.checkHost(spec.host);
    } catch (e) {
      return out(spec, false, performance.now() - start, why(e));
    }
    return new Promise((resolve) => {
      const sock = net.connect({ host: spec.host.replace(/^\[|\]$/g, ''), port: spec.port, lookup: guard.lookup });
      let done = false;
      const finish = (ok, detail) => { if (done) return; done = true; sock.destroy(); resolve(out(spec, ok, performance.now() - start, detail)); };
      sock.setTimeout(timeoutMs, () => finish(false, `timeout after ${timeoutMs}ms`));
      sock.once('connect', () => {
        const ms = performance.now() - start;
        finish(ms <= spec.maxMs, ms <= spec.maxMs ? `port ${spec.port} open in ${Math.round(ms)}ms` : `port ${spec.port} open, too slow: ${Math.round(ms)}ms > ${spec.maxMs}ms`);
      });
      sock.once('error', (e) => finish(false, why(e)));
    });
  }
  // dns: resolving a name sends nothing to the target itself. We never reveal private answers.
  try {
    const r = resolver || new Resolver({ timeout: timeoutMs, tries: 1 });
    const answers = await r.resolve(spec.host, spec.recordType);
    const ms = performance.now() - start;
    const flat = answers.map((a) => (typeof a === 'string' ? a : Array.isArray(a) ? a.join('') : a.exchange || JSON.stringify(a)));
    if (!flat.length) return out(spec, false, ms, `no ${spec.recordType} records`);
    if ((spec.recordType === 'A' || spec.recordType === 'AAAA') && flat.some((ip) => guard.isBlocked(ip))) {
      return out(spec, false, ms, 'resolves to a private or reserved address (hidden)');
    }
    if (spec.expect && !flat.some((v) => v.includes(spec.expect))) return out(spec, false, ms, `${spec.recordType} records do not contain ${JSON.stringify(spec.expect)}`, { answers: flat.slice(0, 10) });
    if (ms > spec.maxMs) return out(spec, false, ms, `resolved, too slow: ${Math.round(ms)}ms > ${spec.maxMs}ms`, { answers: flat.slice(0, 10) });
    return out(spec, true, ms, `${spec.recordType} → ${flat.slice(0, 4).join(', ')}`, { answers: flat.slice(0, 10) });
  } catch (e) {
    return out(spec, false, performance.now() - start, `resolve failed: ${e.code || e.message}`);
  }
}

function keyMatches(given, key) {
  if (!given) return false;
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(key)).digest();
  return timingSafeEqual(a, b);
}

/** Settings from env. */
export function checkApiOptions(env = process.env) {
  return {
    apiKey: env.DIS_API_KEY || '',
    public: env.DIS_PUBLIC_CHECK === '1' || env.DIS_PUBLIC_CHECK === 'true',
    ratePerMinute: Number(env.DIS_CHECK_RATE || 30),
    maxConcurrent: Number(env.DIS_CHECK_CONCURRENCY || 10),
    trustProxy: env.DIS_TRUST_PROXY === '1' || env.DIS_TRUST_PROXY === 'true',
    allowCidrs: cidrsFromEnv(env.DIS_CHECK_ALLOW_CIDRS),
  };
}

/** Build the HTTP handler. Returns null-able handle(req, res, send) → true if it handled the request. */
export function createCheckApi(opts = {}) {
  const o = { ...checkApiOptions({}), ...opts };
  const enabled = Boolean(o.apiKey) || o.public;
  const guard = o.guard || makeGuard({ allowCidrs: o.allowCidrs });
  const limiter = new RateLimiter({ limit: o.ratePerMinute, windowMs: 60000 });
  let inFlight = 0;

  async function readJson(req) {
    let s = '';
    for await (const c of req) { s += c; if (s.length > 4096) throw bad('body too large (max 4 KB)'); }
    if (!s.trim()) return {};
    try { return JSON.parse(s); } catch { throw bad('body must be JSON'); }
  }

  async function handle(req, res, send) {
    if (!enabled) return send(404, { error: 'check API is off; set DIS_API_KEY or DIS_PUBLIC_CHECK=1 to enable it' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(405, { error: 'use GET or POST' });
    if (o.apiKey) {
      const auth = String(req.headers.authorization || '');
      const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.headers['x-api-key'];
      if (!keyMatches(given, o.apiKey)) return send(401, { error: 'missing or wrong API key' });
    }
    const rl = limiter.take(clientIp(req, o.trustProxy));
    res.setHeader('x-ratelimit-limit', String(o.ratePerMinute));
    res.setHeader('x-ratelimit-remaining', String(rl.remaining));
    if (!rl.ok) { res.setHeader('retry-after', String(rl.retryAfterSec)); return send(429, { error: 'rate limited', retryAfterSec: rl.retryAfterSec }); }
    if (inFlight >= o.maxConcurrent) { res.setHeader('retry-after', '5'); return send(503, { error: 'too many checks in flight, retry shortly' }); }
    let spec;
    try {
      const input = req.method === 'POST' ? await readJson(req) : Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      spec = parseCheckRequest(input);
    } catch (e) {
      return send(400, { error: e.message });
    }
    inFlight += 1;
    try {
      return send(200, await runSafeCheck(spec, { guard, resolver: o.resolver }));
    } finally {
      inFlight -= 1;
    }
  }

  return { enabled, handle };
}
