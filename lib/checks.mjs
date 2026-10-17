// The check types (http, tcp, dns, and status for provider status feeds; see status-feeds.mjs). Each returns { ok, light, ms, detail, status? } and never throws.
// lit = up and healthy; dark = down, erroring, or slower than maxLatencyMs.
import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { safeFetch, makeGuard, cidrsFromEnv } from './net-guard.mjs';
import { checkStatus, statusLabel } from './status-feeds.mjs';

const VERSION = '0.1.0';

/** Build a predicate from expectStatus: 200 | "200-299" | "2xx" | [200, "3xx"]. Returns null if invalid. */
export function statusMatcher(spec) {
  const parts = Array.isArray(spec) ? spec : [spec];
  const preds = [];
  for (const p of parts) {
    const s = String(p).trim().toLowerCase();
    let m;
    if (/^\d{3}$/.test(s)) { const n = Number(s); preds.push((c) => c === n); }
    else if ((m = s.match(/^(\d{3})\s*-\s*(\d{3})$/))) { const a = +m[1], b = +m[2]; preds.push((c) => c >= a && c <= b); }
    else if ((m = s.match(/^([1-5])xx$/))) { const d = +m[1]; preds.push((c) => Math.floor(c / 100) === d); }
    else return null;
  }
  return preds.length ? (c) => preds.some((f) => f(c)) : null;
}

function result(ok, ms, detail, extra = {}) {
  return { ok, light: ok ? 'lit' : 'dark', ms: Math.round(ms), detail, ...extra };
}

function slow(t, ms) {
  return ms > t.maxLatencyMs ? `too slow: ${Math.round(ms)}ms > ${t.maxLatencyMs}ms` : null;
}

export async function checkHttp(t, { fetchImpl = globalThis.fetch } = {}) {
  const start = performance.now();
  try {
    const res = await fetchImpl(t.url, {
      method: t.method || 'GET',
      headers: { 'user-agent': `DIS/${VERSION} (+https://github.com/fitzyracing1/DIS)`, ...(t.headers || {}) },
      redirect: t.followRedirects === false ? 'manual' : 'follow',
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    // Read the body (needed for keyword, and so latency covers the full response).
    const body = await res.text();
    const ms = performance.now() - start;
    const match = statusMatcher(t.expectStatus ?? '200-399');
    if (!match(res.status)) return result(false, ms, `HTTP ${res.status}, expected ${JSON.stringify(t.expectStatus ?? '200-399')}`, { status: res.status });
    if (t.keyword && !body.includes(t.keyword)) return result(false, ms, `HTTP ${res.status} but keyword ${JSON.stringify(t.keyword)} not found`, { status: res.status });
    const s = slow(t, ms);
    if (s) return result(false, ms, `HTTP ${res.status}, ${s}`, { status: res.status });
    return result(true, ms, `HTTP ${res.status} in ${Math.round(ms)}ms`, { status: res.status });
  } catch (e) {
    const ms = performance.now() - start;
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `timeout after ${t.timeoutMs}ms` : (e?.cause?.code || e?.cause?.message || e?.message || String(e));
    return result(false, ms, `request failed: ${why}`);
  }
}

export function checkTcp(t) {
  const start = performance.now();
  return new Promise((resolve) => {
    const sock = net.connect({ host: t.host, port: t.port });
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(t.timeoutMs, () => finish(result(false, performance.now() - start, `timeout after ${t.timeoutMs}ms connecting to ${t.host}:${t.port}`)));
    sock.once('connect', () => {
      const ms = performance.now() - start;
      const s = slow(t, ms);
      finish(result(!s, ms, s ? `port ${t.port} open, ${s}` : `port ${t.port} open in ${Math.round(ms)}ms`));
    });
    sock.once('error', (e) => finish(result(false, performance.now() - start, `connect ${t.host}:${t.port} failed: ${e.code || e.message}`)));
  });
}

export async function checkDns(t, { resolver } = {}) {
  const start = performance.now();
  const r = resolver || new Resolver({ timeout: t.timeoutMs, tries: 1 });
  if (!resolver && t.server) r.setServers([t.server]);
  try {
    const answers = await r.resolve(t.host, t.recordType || 'A');
    const ms = performance.now() - start;
    const flat = answers.map((a) => (typeof a === 'string' ? a : Array.isArray(a) ? a.join('') : a.exchange || JSON.stringify(a)));
    if (!flat.length) return result(false, ms, `no ${t.recordType} records for ${t.host}`);
    if (t.expect && !flat.some((v) => v.includes(t.expect))) return result(false, ms, `${t.recordType} ${t.host} → ${flat.join(', ')} (expected ${t.expect})`);
    const s = slow(t, ms);
    return result(!s, ms, `${t.recordType} ${t.host} → ${flat.slice(0, 4).join(', ')}${s ? `, ${s}` : ''}`);
  } catch (e) {
    return result(false, performance.now() - start, `resolve ${t.recordType} ${t.host} failed: ${e.code || e.message}`);
  }
}

let defaultGuard;
/**
 * HTTP check for targets DIS did not get from its operator (discovered / registered): goes through the
 * SSRF guard, one GET, capped body, no retries.
 */
export async function checkHttpGuarded(t, { guard } = {}) {
  guard ||= defaultGuard ||= makeGuard({ allowCidrs: cidrsFromEnv(process.env.DIS_CHECK_ALLOW_CIDRS) });
  const start = performance.now();
  try {
    const r = await safeFetch(t.url, { guard, timeoutMs: t.timeoutMs, maxBytes: 64 * 1024, maxRedirects: 3 });
    const match = statusMatcher(t.expectStatus ?? '200-399');
    if (!match(r.status)) return result(false, r.ms, `HTTP ${r.status}, expected ${JSON.stringify(t.expectStatus ?? '200-399')}`, { status: r.status });
    const s = slow(t, r.ms);
    return result(!s, r.ms, s ? `HTTP ${r.status}, ${s}` : `HTTP ${r.status} in ${r.ms}ms`, { status: r.status });
  } catch (e) {
    return result(false, performance.now() - start, e.code === 'EBLOCKED' ? `blocked: ${e.message}` : `request failed: ${e.code || e.message}`);
  }
}

export async function runCheck(t, deps = {}) {
  if (t.type === 'http' && t.guarded) return checkHttpGuarded(t, deps);
  if (t.type === 'http') return checkHttp(t, deps);
  if (t.type === 'tcp') return checkTcp(t, deps);
  if (t.type === 'dns') return checkDns(t, deps);
  if (t.type === 'status') return checkStatus(t, deps);
  return result(false, 0, `unknown check type ${t.type}`);
}

/** One-line description of what a target checks (used on the page, in JSON and by `dis validate`). */
export function targetLabel(t) {
  if (t.type === 'http') return t.url;
  if (t.type === 'tcp') return `${t.host}:${t.port}`;
  if (t.type === 'status') return statusLabel(t);
  return `${t.recordType} ${t.host}`;
}
