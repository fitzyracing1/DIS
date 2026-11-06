// Discovery: find newly published bots from opt-in / official sources and watch the ONE endpoint
// each bot published itself. Rules:
//  - official APIs and feeds only (lib/sources.mjs), plain GETs, DIS User-Agent;
//  - no endpoint published → recorded as "no-endpoint", nothing is probed;
//  - every endpoint passes the SSRF guard and robots.txt before it is watched (robots re-checked daily);
//  - GitHub / npm homepages (configurable: requireOwnership) must also list the project in the host's
//    /.well-known/dis.txt, so nobody can point DIS at a site they don't control (re-checked daily);
//  - caps: maxTargets watched, perHostMax per host, maxRecords remembered; interval ≥ 300 s;
//  - discovered bots never trigger alerts and never affect the overall light or cron exit code.
import { createHash } from 'node:crypto';
import { makeGuard, cidrsFromEnv } from './net-guard.mjs';
import { RobotsCache } from './robots.mjs';
import { SOURCES } from './sources.mjs';
import { tokenPresent } from './register.mjs';

const DAY = 24 * 3600e3;

/**
 * Lines a project owner can put in https://<homepage host>/.well-known/dis.txt to prove the homepage is theirs.
 *   GitHub repo owner/name → "github:owner/name"  or  "https://github.com/owner/name"
 *   npm package name       → "npm:name"            or  "https://www.npmjs.com/package/name"
 * Matching is case-insensitive. Returns [] for sources without an ownership format.
 */
export function ownershipLines(b) {
  const key = b.id.slice(b.id.indexOf(':') + 1);
  if (b.source === 'github') return [`github:${key}`, `https://github.com/${key}`];
  if (b.source === 'npm') return [`npm:${key}`, `https://www.npmjs.com/package/${key}`];
  return [];
}

export function targetNameFor(id) {
  const slug = id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'bot';
  return `${slug}-${createHash('sha1').update(id).digest('hex').slice(0, 6)}`;
}

export class Discovery {
  constructor(cfg, store, monitor, { guard, robots, fetchImpl = globalThis.fetch, env = process.env, log = console, now = () => Date.now(), sources = SOURCES, ownershipFetch } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.monitor = monitor;
    this.guard = guard || makeGuard({ allowCidrs: cidrsFromEnv(env.DIS_CHECK_ALLOW_CIDRS) });
    this.robots = robots || new RobotsCache({ guard: this.guard, now });
    this.fetch = fetchImpl;
    this.log = log;
    this.now = now;
    this.sources = sources;
    this.ownershipFetch = ownershipFetch; // undefined → safeFetch (tests may inject)
    this.timer = null;
    store.data.discovery ||= { bots: {}, runs: [] };
    store.data.discovery.bots ||= {};
    store.data.discovery.runs ||= [];
    if (monitor) {
      monitor.discoveryView = () => this.list();
      for (const b of Object.values(this.bots)) if (b.status === 'watching') monitor.addDiscovered(this.targetFor(b));
    }
  }

  get bots() { return this.store.data.discovery.bots; }

  targetFor(b) {
    return {
      name: b.targetName, type: 'http', url: b.endpoint, expectStatus: b.expectStatus || '200-399',
      intervalSeconds: Math.max(300, this.cfg.intervalSeconds || 300), timeoutMs: 10000, maxLatencyMs: 10000,
      failThreshold: 2, recoverThreshold: 1, guarded: true, discovered: b.id,
    };
  }

  watchedCount() { return Object.values(this.bots).filter((b) => b.status === 'watching').length; }

  hostCount(host) { return Object.values(this.bots).filter((b) => b.status === 'watching' && b.host === host).length; }

  /** Decide what to do with one bot that has an endpoint: guard → caps → robots.txt → watch. */
  async consider(b) {
    if (!b.endpoint) { b.status = 'no-endpoint'; return b; }
    const u = new URL(b.endpoint);
    b.host = u.hostname;
    try { await this.guard.checkHost(u.hostname); } catch (e) {
      b.status = 'skipped'; b.reason = e.code === 'EBLOCKED' ? 'endpoint resolves to a private/reserved address' : `endpoint host does not resolve (${e.code || e.message})`;
      return b;
    }
    if ((this.cfg.requireOwnership || []).includes(b.source)) {
      const lines = ownershipLines(b);
      const v = lines.length ? await tokenPresent(b.endpoint, lines, { guard: this.guard, fetchImpl: this.ownershipFetch }) : { ok: false, reason: 'no ownership format for this source' };
      b.ownershipCheckedAt = new Date(this.now()).toISOString();
      if (!v.ok) {
        b.status = 'unverified';
        b.reason = `homepage not verified: add the line "${lines[0]}" to ${b.endpoint ? new URL(b.endpoint).origin : ''}/.well-known/dis.txt (${v.reason})`;
        return b;
      }
      b.ownershipVerifiedAt = b.ownershipCheckedAt;
    }
    if (this.watchedCount() >= this.cfg.maxTargets) { b.status = 'skipped'; b.reason = `cap reached (${this.cfg.maxTargets} watched)`; return b; }
    if (this.hostCount(u.hostname) >= this.cfg.perHostMax) { b.status = 'skipped'; b.reason = `already watching ${this.cfg.perHostMax} on ${u.hostname}`; return b; }
    const rb = await this.robots.check(b.endpoint);
    b.robotsCheckedAt = new Date(this.now()).toISOString();
    if (!rb.allowed) { b.status = 'skipped'; b.reason = rb.reason; return b; }
    b.status = 'watching';
    b.reason = null;
    b.targetName ||= targetNameFor(b.id);
    this.monitor?.addDiscovered(this.targetFor(b));
    return b;
  }

  /** Remember a newly seen bot. Returns the record, or null if already known. */
  remember(c) {
    if (this.bots[c.id]) return null;
    const rec = {
      id: c.id, source: c.source, name: c.name, title: c.title, description: c.description, project: c.project,
      publishedAt: c.publishedAt, matched: c.matched, endpoint: c.endpoint, endpointKind: c.endpointKind,
      expectStatus: c.expectStatus, firstSeen: new Date(this.now()).toISOString(),
      status: c.endpoint ? 'new' : 'no-endpoint', reason: c.endpoint ? null : c.noEndpointReason,
    };
    this.bots[c.id] = rec;
    this.evict();
    return rec;
  }

  /** Keep at most maxRecords: drop oldest no-endpoint/skipped records first, never watched ones. */
  evict() {
    const all = Object.values(this.bots);
    let extra = all.length - this.cfg.maxRecords;
    if (extra <= 0) return;
    const victims = all.filter((b) => b.status !== 'watching').sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    for (const v of victims) { if (extra-- <= 0) break; delete this.bots[v.id]; }
  }

  forget(id) {
    const b = this.bots[id];
    if (!b) return;
    if (b.targetName) this.monitor?.removeDiscovered(b.targetName);
    delete this.bots[id];
  }

  /** One discovery pass over the enabled sources. Returns a summary. */
  async run({ since = new Date(this.now() - this.cfg.lookbackHours * 3600e3), limit = this.cfg.perRunLimit, only } = {}) {
    const summary = { at: new Date(this.now()).toISOString(), since: since.toISOString(), limit, found: 0, new: 0, watching: 0, noEndpoint: 0, unverified: 0, skipped: 0, notes: [], bySource: {} };
    const enabled = !this.cfg.enabled && !only ? [] // register-only mode: no source polling
      : Object.entries(this.cfg.sources).filter(([k, on]) => on && this.sources[k] && (!only || only.includes(k))).map(([k]) => k);
    for (const name of enabled) {
      let res;
      try {
        res = await this.sources[name]({ since, limit, keywords: this.cfg.keywords, token: name === 'github' ? this.cfg.githubToken : name === 'topgg' ? this.cfg.topggToken : undefined, fetchImpl: this.fetch, log: this.log });
      } catch (e) {
        summary.notes.push(`${name}: failed (${e.message})`);
        continue;
      }
      summary.notes.push(...res.notes);
      summary.bySource[name] = res.items.length;
      summary.found += res.items.length;
      for (const c of res.items) {
        const rec = this.remember(c);
        if (!rec) continue;
        summary.new += 1;
        await this.consider(rec);
      }
    }
    await this.recheckRobots();
    await this.recheckOwnership();
    if (this.registrar) await this.registrar.reverify();
    for (const b of Object.values(this.bots)) {
      if (b.firstSeen < summary.at) continue;
      if (b.status === 'watching') summary.watching += 1;
      else if (b.status === 'no-endpoint') summary.noEndpoint += 1;
      else if (b.status === 'unverified') summary.unverified += 1;
      else summary.skipped += 1;
    }
    this.store.data.discovery.runs = [summary, ...this.store.data.discovery.runs].slice(0, 20);
    this.monitor?.save();
    return summary;
  }

  /** Re-read robots.txt daily for watched bots; stop watching if we are no longer welcome. */
  async recheckRobots() {
    for (const b of Object.values(this.bots)) {
      if (b.status !== 'watching' || (b.robotsCheckedAt && this.now() - Date.parse(b.robotsCheckedAt) < DAY)) continue;
      const rb = await this.robots.check(b.endpoint);
      b.robotsCheckedAt = new Date(this.now()).toISOString();
      if (!rb.allowed) {
        this.monitor?.removeDiscovered(b.targetName);
        b.status = 'skipped';
        b.reason = `${rb.reason} (stopped watching)`;
      }
    }
  }

  /**
   * Daily: watched GitHub/npm bots must still list themselves in dis.txt (else stop watching), and
   * unverified ones get one more look (at most `perRunLimit` per run, so hosts are not hammered).
   */
  async recheckOwnership() {
    const req = this.cfg.requireOwnership || [];
    let budget = this.cfg.perRunLimit;
    for (const b of Object.values(this.bots)) {
      if (!req.includes(b.source) || !b.endpoint) continue;
      if (b.status !== 'watching' && b.status !== 'unverified') continue;
      if (b.ownershipCheckedAt && this.now() - Date.parse(b.ownershipCheckedAt) < DAY) continue;
      if (budget-- <= 0) break;
      if (b.status === 'unverified') { await this.consider(b); continue; }
      const v = await tokenPresent(b.endpoint, ownershipLines(b), { guard: this.guard, fetchImpl: this.ownershipFetch });
      b.ownershipCheckedAt = new Date(this.now()).toISOString();
      if (!v.ok) {
        this.monitor?.removeDiscovered(b.targetName);
        b.status = 'unverified';
        b.reason = `ownership line removed from /.well-known/dis.txt (stopped watching)`;
      }
    }
  }

  /** Background loop (serve mode). */
  start() {
    const tick = async () => {
      try {
        const s = await this.run();
        this.log.log(`[dis] discovery: ${s.new} new (${s.watching} watching, ${s.noEndpoint} no endpoint, ${s.unverified} unverified, ${s.skipped} skipped)`);
      } catch (e) { this.log.error(`[dis] discovery failed: ${e.message}`); }
      this.timer = setTimeout(tick, this.cfg.everyMinutes * 60000);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, 15000);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearTimeout(this.timer); }

  /** Rows for the status page / JSON. */
  list() {
    const targets = this.store.data.targets;
    return Object.values(this.bots)
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
      .map((b) => {
        const s = b.targetName && targets[b.targetName];
        const state = b.status === 'watching' ? (s?.light || 'pending') : ['no-endpoint', 'unverified'].includes(b.status) ? b.status : 'skipped';
        return {
          id: b.id, name: b.name, source: b.source, firstSeen: b.firstSeen, publishedAt: b.publishedAt,
          project: b.project, endpoint: b.endpoint, state, reason: b.reason || null,
          lastCheck: s?.lastCheck ? { at: s.lastCheck.at, detail: s.lastCheck.detail, status: s.lastCheck.status } : null,
        };
      });
  }
}
