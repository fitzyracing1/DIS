// Self-registration: a bot owner asks DIS to watch their endpoint, then proves they control the host.
//   POST /register        {"url": "https://my-bot.example/health", "name": "my-bot"}
//      → 202 {id, token, verifyUrl, ...}: put the token on its own line in https://my-bot.example/.well-known/dis.txt
//   POST /register/verify {"id": "..."}
//      → DIS GETs /.well-known/dis.txt on that host (same host only, SSRF-guarded, 16 KB cap); if the token is
//        there the endpoint goes through robots.txt + caps and is watched like any discovered bot.
//   GET  /register/:id    → status of a registration
// Ownership is re-checked daily; remove the token from dis.txt and DIS stops watching.
import { randomBytes } from 'node:crypto';
import { NAME_RE } from './config.mjs';
import { safeFetch, parsePublicUrl } from './net-guard.mjs';
import { RateLimiter, clientIp } from './rate-limit.mjs';
import { publishedEndpoint } from './sources.mjs';

const DAY = 24 * 3600e3;
const MAX_PENDING = 200;

export function wellKnownUrl(endpoint) {
  return `${new URL(endpoint).origin}/.well-known/dis.txt`;
}

export async function tokenPresent(endpoint, token, { guard, fetchImpl = safeFetch } = {}) {
  try {
    const r = await fetchImpl(wellKnownUrl(endpoint), { guard, timeoutMs: 8000, maxBytes: 16 * 1024, maxRedirects: 2, sameHost: true });
    if (r.status !== 200) return { ok: false, reason: `/.well-known/dis.txt → HTTP ${r.status}` };
    const found = r.body.split(/\r?\n/).some((l) => l.trim() === token);
    return { ok: found, reason: found ? 'token found' : 'token not found in /.well-known/dis.txt' };
  } catch (e) {
    return { ok: false, reason: `/.well-known/dis.txt unreachable: ${e.code === 'EBLOCKED' ? 'blocked address' : e.code || e.message}` };
  }
}

export class Registrar {
  constructor(discovery, { trustProxy = false, perHour = 10, now = () => Date.now(), fetchImpl } = {}) {
    this.d = discovery;
    this.now = now;
    this.fetch = fetchImpl;
    this.trustProxy = trustProxy;
    this.limiter = new RateLimiter({ limit: perHour, windowMs: 3600e3, now });
    discovery.store.data.registrations ||= {};
    discovery.registrar = this;
  }

  get pending() { return this.d.store.data.registrations; }

  sweep() {
    for (const [id, r] of Object.entries(this.pending)) if (this.now() - Date.parse(r.createdAt) > DAY) delete this.pending[id];
  }

  async readJson(req) {
    let s = '';
    for await (const c of req) { s += c; if (s.length > 4096) throw new Error('body too large (max 4 KB)'); }
    if (!s.trim()) return {};
    try { return JSON.parse(s); } catch { throw new Error('body must be JSON'); }
  }

  async handle(req, res, send, path) {
    const rl = this.limiter.take(clientIp(req, this.trustProxy));
    if (!rl.ok) { res.setHeader('retry-after', String(rl.retryAfterSec)); return send(429, { error: 'rate limited', retryAfterSec: rl.retryAfterSec }); }
    this.sweep();
    const m = path.match(/^\/register\/([a-f0-9]{16})$/);
    if (req.method === 'GET' && m) {
      const p = this.pending[m[1]];
      const bot = this.d.bots[`register:${m[1]}`];
      if (bot) return send(200, { id: m[1], status: bot.status, reason: bot.reason, endpoint: bot.endpoint });
      if (p) return send(200, { id: m[1], status: 'pending-verification', endpoint: p.url, verifyUrl: wellKnownUrl(p.url) });
      return send(404, { error: 'no such registration (pending ones expire after 24 h)' });
    }
    if (req.method !== 'POST') return send(405, { error: 'use POST' });
    let body;
    try { body = await this.readJson(req); } catch (e) { return send(400, { error: e.message }); }

    if (path === '/register') {
      let url;
      try { url = parsePublicUrl(body.url).toString(); } catch (e) { return send(400, { error: e.message }); }
      const ep = publishedEndpoint(url);
      if (!ep.endpoint) return send(400, { error: `not a health endpoint: ${ep.reason}` });
      const name = String(body.name || '').trim();
      if (!NAME_RE.test(name)) return send(400, { error: 'name: letters, digits, . _ - (max 64)' });
      if (Object.keys(this.pending).length >= MAX_PENDING) return send(503, { error: 'too many pending registrations, try later' });
      const id = randomBytes(8).toString('hex');
      const token = `dis-verify=${randomBytes(16).toString('hex')}`;
      this.pending[id] = { id, url: ep.endpoint, name, token, createdAt: new Date(this.now()).toISOString() };
      this.d.monitor?.save();
      return send(202, {
        id, name, url: ep.endpoint, token, verifyUrl: wellKnownUrl(ep.endpoint),
        next: `Put the token on its own line in ${wellKnownUrl(ep.endpoint)}, then POST /register/verify {"id":"${id}"} within 24 h.`,
      });
    }

    if (path === '/register/verify') {
      const p = this.pending[String(body.id || '')];
      if (!p) return send(404, { error: 'no such pending registration (they expire after 24 h)' });
      const v = await tokenPresent(p.url, p.token, { guard: this.d.guard, fetchImpl: this.fetch });
      if (!v.ok) return send(409, { error: 'not verified yet', reason: v.reason, verifyUrl: wellKnownUrl(p.url) });
      delete this.pending[p.id];
      const rec = this.d.remember({
        id: `register:${p.id}`, source: 'register', name: p.name, title: p.name, description: '', project: null,
        publishedAt: p.createdAt, matched: 'register', endpoint: p.url, endpointKind: 'registered', expectStatus: '200-399',
      }) || this.d.bots[`register:${p.id}`];
      rec.token = p.token;
      rec.verifiedAt = new Date(this.now()).toISOString();
      await this.d.consider(rec);
      this.d.monitor?.save();
      return send(200, { id: p.id, status: rec.status, reason: rec.reason, name: rec.name, endpoint: rec.endpoint });
    }
    return send(404, { error: 'not found' });
  }

  /** Daily ownership re-check: token gone → stop watching and forget the bot. */
  async reverify() {
    for (const b of Object.values(this.d.bots)) {
      if (b.source !== 'register' || !b.token) continue;
      if (b.verifiedAt && this.now() - Date.parse(b.verifiedAt) < DAY) continue;
      const v = await tokenPresent(b.endpoint, b.token, { guard: this.d.guard, fetchImpl: this.fetch });
      if (v.ok) b.verifiedAt = new Date(this.now()).toISOString();
      else this.d.forget(b.id);
    }
  }
}
