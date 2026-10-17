// robots.txt (RFC 9309) for discovered hosts. DIS identifies as product token "DIS".
//  - 2xx: parse and obey (group for "DIS" if present, else "*"); longest match wins, Allow wins ties.
//  - 4xx (incl. 404): no restrictions.
//  - 5xx / unreachable: treat as "disallow everything" for now and try again later.
import { safeFetch } from './net-guard.mjs';

export const ROBOTS_TOKEN = 'dis';

/** Parse robots.txt into groups: [{ agents: [...], rules: [{ allow, path }] }]. */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (cur) cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function toRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

/** Is `path` (pathname + search) allowed for our token? */
export function isAllowed(groups, path, token = ROBOTS_TOKEN) {
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && token.startsWith(a.split('/')[0])));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.path !== '' || !r.allow);
  let best = null;
  for (const r of rules) {
    if (r.path === '') continue; // "Disallow:" (empty) means allow all
    let p = r.path;
    try { p = decodeURI(p); } catch {}
    if (!toRegex(p).test(path)) continue;
    const len = p.replace(/\*|\$$/g, '').length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

/** Fetches and caches robots.txt per origin. check(url) → { allowed, reason } */
export class RobotsCache {
  constructor({ guard, ttlMs = 24 * 3600e3, fetchImpl = safeFetch, now = () => Date.now() } = {}) {
    this.guard = guard;
    this.ttlMs = ttlMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = new Map();
  }

  async load(origin) {
    const hit = this.cache.get(origin);
    if (hit && hit.until > this.now()) return hit;
    let entry;
    try {
      const r = await this.fetch(`${origin}/robots.txt`, { guard: this.guard, timeoutMs: 8000, maxBytes: 512 * 1024, maxRedirects: 5 });
      if (r.status >= 200 && r.status < 300) entry = { kind: 'rules', groups: parseRobots(r.body) };
      else if (r.status >= 400 && r.status < 500) entry = { kind: 'open' };
      else entry = { kind: 'unavailable', reason: `robots.txt HTTP ${r.status}` };
    } catch (e) {
      entry = { kind: 'unavailable', reason: `robots.txt ${e.code === 'EBLOCKED' ? 'blocked' : 'unreachable'}: ${e.message}` };
    }
    // Retry an unavailable robots.txt sooner (1 h) than a good one (24 h).
    entry.until = this.now() + (entry.kind === 'unavailable' ? 3600e3 : this.ttlMs);
    this.cache.set(origin, entry);
    return entry;
  }

  async check(rawUrl) {
    const u = new URL(rawUrl);
    const e = await this.load(u.origin);
    if (e.kind === 'open') return { allowed: true, reason: 'no robots.txt' };
    if (e.kind === 'unavailable') return { allowed: false, reason: e.reason };
    const ok = isAllowed(e.groups, u.pathname + u.search);
    return { allowed: ok, reason: ok ? 'allowed by robots.txt' : 'disallowed by robots.txt' };
  }
}
