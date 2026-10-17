// The "status" check type: read a provider's PUBLIC official status feed and turn it into lit/dark.
// Three feed formats are understood; all are plain GETs of public JSON, polled no faster than you configure.
//
//   statuspage  Atlassian Statuspage API (status.<company>.com/api/v2/...). Documented for programmatic use.
//               /api/v2/status.json  → lit when status.indicator is in litIndicators (default ["none"]).
//               /api/v2/summary.json + component → lit when that component's status is in litComponentStatuses
//               (default ["operational"]).
//   google      Google's status dashboards (Google Cloud, Firebase, Google Workspace) incidents.json.
//               Dark when an incident is still open (no end, or end in the future) with status_impact in darkOn
//               (default SERVICE_DISRUPTION, SERVICE_OUTAGE), optionally only for one product (title or id).
//               Open SERVICE_INFORMATION incidents stay lit but show in the detail.
//   apple       Apple System Status / Developer System Status data feed (system_status_<locale>.js; the
//               developer feed is wrapped in jsonCallback(...), which is stripped). Dark when the named service has
//               an event that is in progress (not resolved/completed/cancelled and not scheduled for later).

export const FORMATS = ['statuspage', 'google', 'apple'];
const VERSION = '0.1.0';
const MAX_BYTES = 5 * 1024 * 1024;

const lc = (s) => String(s ?? '').trim().toLowerCase();

/** Parse a JSON body, tolerating a JSONP wrapper such as jsonCallback({...}); */
export function parseFeedBody(text) {
  let s = String(text).trim().replace(/^\uFEFF/, '');
  const m = s.match(/^[A-Za-z_$][\w$.]*\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (m) s = m[1];
  return JSON.parse(s);
}

/** Statuspage: overall indicator, or one component from summary.json. */
export function evalStatuspage(doc, t) {
  if (t.component) {
    if (!Array.isArray(doc?.components)) return { ok: false, detail: 'no components in feed (use /api/v2/summary.json for component checks)' };
    const want = lc(t.component);
    const c = doc.components.find((x) => lc(x.name) === want || lc(x.id) === want);
    if (!c) return { ok: false, detail: `component ${JSON.stringify(t.component)} not found in feed` };
    const lit = (t.litComponentStatuses || ['operational']).map(lc);
    const ok = lit.includes(lc(c.status));
    return { ok, detail: `${c.name}: ${c.status}` };
  }
  const ind = doc?.status?.indicator;
  if (typeof ind !== 'string') return { ok: false, detail: 'feed has no status.indicator' };
  const lit = (t.litIndicators || ['none']).map(lc);
  return { ok: lit.includes(lc(ind)), detail: `${doc.status.description || ind} (indicator ${ind})` };
}

/** Google status dashboards: open incidents, optionally for one product. */
export function evalGoogle(doc, t, now = Date.now()) {
  if (!Array.isArray(doc)) return { ok: false, detail: 'feed is not an incidents array' };
  const want = t.product ? lc(t.product) : null;
  const darkOn = (t.darkOn || ['SERVICE_DISRUPTION', 'SERVICE_OUTAGE']).map((s) => String(s).toUpperCase());
  const open = doc.filter((i) => {
    const end = i?.end ? Date.parse(i.end) : NaN;
    const begin = i?.begin ? Date.parse(i.begin) : 0;
    if (Number.isFinite(end) && end <= now) return false;
    if (Number.isFinite(begin) && begin > now) return false;
    if (!want) return true;
    return (i.affected_products || []).some((p) => lc(p.title) === want || lc(p.id) === want || lc(p.current_title) === want);
  });
  const scope = t.product ? t.product : 'all products';
  if (!open.length) return { ok: true, detail: `no open incidents (${scope})` };
  const bad = open.filter((i) => darkOn.includes(String(i.status_impact || '').toUpperCase()));
  const describe = (i) => `${i.status_impact || 'incident'}: ${String(i.external_desc || i.service_name || i.id).split('\n')[0].replace(/\*+/g, '').slice(0, 120)}`;
  if (bad.length) return { ok: false, detail: `${bad.length} open incident(s) (${scope}); ${describe(bad[0])}` };
  return { ok: true, detail: `${open.length} open informational notice(s) (${scope}); ${describe(open[0])}` };
}

const DONE = ['resolved', 'completed', 'cancelled', 'canceled'];
const LATER = ['upcoming', 'scheduled'];

/** Apple system status feed: in-progress events for one service. */
export function evalApple(doc, t, now = Date.now()) {
  if (!Array.isArray(doc?.services)) return { ok: false, detail: 'feed has no services' };
  const want = lc(t.service);
  const s = doc.services.find((x) => lc(x.serviceName) === want);
  if (!s) return { ok: false, detail: `service ${JSON.stringify(t.service)} not found in feed` };
  const active = (s.events || []).filter((e) => {
    const st = lc(e.eventStatus);
    if (DONE.includes(st) || LATER.includes(st)) return false;
    if (Number(e.epochStartDate) > now) return false;
    if (e.epochEndDate && Number(e.epochEndDate) <= now && st !== 'ongoing') return false;
    return true;
  });
  if (!active.length) return { ok: true, detail: `${s.serviceName}: available` };
  const e = active[0];
  return { ok: false, detail: `${s.serviceName}: ${e.statusType || 'event'} ${e.eventStatus || 'ongoing'}: ${String(e.message || '').slice(0, 120)}` };
}

export function evalFeed(format, doc, t, now) {
  if (format === 'statuspage') return evalStatuspage(doc, t);
  if (format === 'google') return evalGoogle(doc, t, now);
  if (format === 'apple') return evalApple(doc, t, now);
  return { ok: false, detail: `unknown status format ${format}` };
}

/** Human label for a status target. */
export function statusLabel(t) {
  const what = t.component || t.product || t.service;
  return `${t.format} ${t.url}${what ? ` [${what}]` : ''}`;
}

async function readCapped(res, max) {
  if (!res.body?.getReader) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); throw new Error(`feed larger than ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// Several targets usually read the same feed (e.g. eight Apple services from one file). Responses are shared
// for FEED_CACHE_MS, and concurrent requests for one URL share a single fetch, so each feed is fetched once per round.
export const FEED_CACHE_MS = 30_000;
const feedCache = new Map();
export function clearFeedCache() { feedCache.clear(); }

function fetchFeed(t, fetchImpl) {
  const key = t.url;
  const hit = feedCache.get(key);
  if (hit && hit.fetchImpl === fetchImpl && Date.now() - hit.at < FEED_CACHE_MS) return hit.promise;
  const promise = (async () => {
    const res = await fetchImpl(t.url, {
      headers: { 'user-agent': `DIS/${VERSION} (+https://github.com/fitzyracing1/DIS)`, accept: 'application/json, text/javascript;q=0.9, */*;q=0.1', ...(t.headers || {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    return { status: res.status, text: await readCapped(res, MAX_BYTES) };
  })();
  feedCache.set(key, { at: Date.now(), promise, fetchImpl });
  promise.catch(() => { if (feedCache.get(key)?.promise === promise) feedCache.delete(key); });
  return promise;
}

export async function checkStatus(t, { fetchImpl = globalThis.fetch, now } = {}) {
  const start = performance.now();
  const done = (ok, detail, extra = {}) => {
    const ms = performance.now() - start;
    return { ok, light: ok ? 'lit' : 'dark', ms: Math.round(ms), detail, ...extra };
  };
  let res, text;
  try {
    res = await fetchFeed(t, fetchImpl);
    text = res.text;
  } catch (e) {
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `timeout after ${t.timeoutMs}ms` : (e?.cause?.code || e?.message || String(e));
    return done(false, `status feed request failed: ${why}`);
  }
  if (res.status < 200 || res.status > 299) return done(false, `status feed HTTP ${res.status}`, { status: res.status });
  let doc;
  try { doc = parseFeedBody(text); } catch { return done(false, 'status feed is not valid JSON', { status: res.status }); }
  const r = evalFeed(t.format, doc, t, now ?? Date.now());
  const ms = performance.now() - start;
  if (r.ok && ms > t.maxLatencyMs) return done(false, `${r.detail}; feed too slow: ${Math.round(ms)}ms > ${t.maxLatencyMs}ms`, { status: res.status });
  return done(r.ok, r.detail, { status: res.status });
}
