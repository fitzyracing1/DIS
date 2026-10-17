// SSRF guard + a small, safe HTTP client for URLs that come from outside (API callers, discovery).
//
//  - Only http: and https: URLs; no user:pass@ credentials.
//  - Every hostname is resolved by our own lookup, and the request connects to exactly the addresses
//    we checked (no DNS-rebinding window). If ANY resolved address is private, loopback, link-local,
//    cloud metadata, multicast or otherwise reserved, the request is refused.
//  - Literal IPs in the URL are checked too (Node skips lookup for them).
//  - Redirects are followed by hand (default max 3) and every hop is checked again.
//  - One overall deadline for the whole chain, and the response body is capped (default 256 KB).
//
// Operator-chosen targets in status.config.json do NOT go through this guard: you may watch your
// own internal services. It only protects the paths where a stranger chooses the URL.
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

export const VERSION = '0.1.0';
export const USER_AGENT = `DIS/${VERSION} (+https://github.com/fitzyracing1/DIS)`;

const V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// IPv4-mapped (::ffff:0:0/96) is handled through embeddedV4(); listing it here would make BlockList
// match every IPv4 address.
const V6 = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

function buildList() {
  const b = new net.BlockList();
  for (const [a, p] of V4) b.addSubnet(a, p, 'ipv4');
  for (const [a, p] of V6) b.addSubnet(a, p, 'ipv6');
  return b;
}

function parseCidrs(list) {
  return (list || []).map((s) => String(s).trim()).filter(Boolean).map((s) => {
    const [addr, bits] = s.split('/');
    const fam = net.isIP(addr);
    if (!fam) throw new Error(`bad CIDR in allow list: ${s}`);
    return [addr, bits === undefined ? (fam === 4 ? 32 : 128) : Number(bits), fam === 4 ? 'ipv4' : 'ipv6'];
  });
}

/** Pull an embedded IPv4 out of IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16). */
export function embeddedV4(ip) {
  const s = ip.toLowerCase();
  let m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || s.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  const hex = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2), 16)];
  m = s.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) return [...hex(m[1].padStart(4, '0')), ...hex(m[2].padStart(4, '0'))].join('.');
  m = s.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (m) return [...hex(m[1].padStart(4, '0')), ...hex(m[2].padStart(4, '0'))].join('.');
  return null;
}

/**
 * makeGuard({ allowCidrs }) → { isBlocked(ip), lookup, checkHost(hostname) }
 * allowCidrs: operator escape hatch (env DIS_CHECK_ALLOW_CIDRS), e.g. for an intranet deployment.
 */
export function makeGuard({ allowCidrs = [] } = {}) {
  const block = buildList();
  const allow = new net.BlockList();
  for (const [a, p, f] of parseCidrs(allowCidrs)) allow.addSubnet(a, p, f);

  function isBlocked(ip) {
    const fam = net.isIP(ip);
    if (!fam) return true;
    const type = fam === 4 ? 'ipv4' : 'ipv6';
    if (allow.check(ip, type)) return false;
    if (fam === 6) {
      const v4 = embeddedV4(ip);
      if (v4 && !allow.check(v4, 'ipv4') && block.check(v4, 'ipv4')) return true;
    }
    return block.check(ip, type);
  }

  // Signature-compatible with dns.lookup, used as the `lookup` option for http/https/net.
  function lookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    dns.lookup(hostname, { all: true, verbatim: true, family: options.family || 0 }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs.length) return cb(Object.assign(new Error(`no addresses for ${hostname}`), { code: 'ENOTFOUND' }));
      const bad = addrs.find((a) => isBlocked(a.address));
      if (bad) return cb(Object.assign(new Error(`${hostname} resolves to a blocked address (private, loopback, link-local, metadata or reserved)`), { code: 'EBLOCKED' }));
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  }

  /** Resolve + validate a hostname (or literal IP) up front. Resolves to the address list or throws EBLOCKED. */
  function checkHost(hostname) {
    const h = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(h)) {
      if (isBlocked(h)) return Promise.reject(Object.assign(new Error(`${h} is a blocked address (private, loopback, link-local, metadata or reserved)`), { code: 'EBLOCKED' }));
      return Promise.resolve([{ address: h, family: net.isIP(h) }]);
    }
    return new Promise((resolve, reject) => lookup(h, { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
  }

  return { isBlocked, lookup, checkHost };
}

/** Validate a URL string from outside. Returns a URL or throws with code EBADURL. */
export function parsePublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw Object.assign(new Error('url must be a valid absolute URL'), { code: 'EBADURL' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw Object.assign(new Error('only http and https URLs are allowed'), { code: 'EBADURL' });
  if (u.username || u.password) throw Object.assign(new Error('URLs with credentials are not allowed'), { code: 'EBADURL' });
  if (!u.hostname) throw Object.assign(new Error('url has no host'), { code: 'EBADURL' });
  return u;
}

/**
 * safeFetch(url, opts) → { status, headers, body, bytes, truncated, url, redirects, ms }
 * Throws (code EBLOCKED | EBADURL | ETIMEDOUT | ETOOMANYREDIRECTS | network codes).
 * opts: guard, method (GET|HEAD), headers, timeoutMs (8000), maxBytes (262144), maxRedirects (3), sameHost (false)
 */
export async function safeFetch(raw, opts = {}) {
  const guard = opts.guard || makeGuard();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const method = opts.method || 'GET';
  const start = performance.now();
  const deadline = Date.now() + timeoutMs;
  let url = parsePublicUrl(raw);
  const firstHost = url.hostname;

  for (let hop = 0; ; hop++) {
    if (opts.sameHost && url.hostname !== firstHost) throw Object.assign(new Error(`redirect to another host (${url.hostname}) refused`), { code: 'EBLOCKED' });
    await guard.checkHost(url.hostname); // literal IPs + early, readable error; the lookup below re-checks at connect time
    const left = deadline - Date.now();
    if (left <= 0) throw Object.assign(new Error(`timeout after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
    const res = await requestOnce(url, { method, headers: opts.headers, lookup: guard.lookup, timeoutMs: left, maxBytes });
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc && opts.followRedirects !== false) {
      if (hop >= maxRedirects) throw Object.assign(new Error(`more than ${maxRedirects} redirects`), { code: 'ETOOMANYREDIRECTS' });
      url = parsePublicUrl(new URL(loc, url).toString());
      continue;
    }
    return { ...res, url: url.toString(), redirects: hop, ms: Math.round(performance.now() - start) };
  }
}

function requestOnce(url, { method, headers, lookup, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method,
      lookup,
      agent: false,
      headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', accept: '*/*', ...(headers || {}) },
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`timeout after ${Math.round(timeoutMs)}ms`), { code: 'ETIMEDOUT' })), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('response', (res) => {
      const chunks = [];
      let bytes = 0;
      let truncated = false;
      const done = () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), bytes, truncated });
      };
      res.on('data', (c) => {
        if (truncated) return;
        const room = maxBytes - bytes;
        if (c.length > room) { chunks.push(c.subarray(0, room)); bytes += room; truncated = true; res.destroy(); done(); return; }
        chunks.push(c); bytes += c.length;
      });
      res.on('end', () => { if (!truncated) done(); });
      res.on('error', (e) => { if (!truncated) { clearTimeout(timer); reject(e); } });
    });
    req.end();
  });
}

/** Parse DIS_CHECK_ALLOW_CIDRS-style env into an array. */
export const cidrsFromEnv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
