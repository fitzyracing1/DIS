// Discovery sources. Official APIs and feeds only, plain GETs, a DIS User-Agent, and each
// service's rate limits respected. Every source returns candidates:
//   { id, source, name, title, description, project, publishedAt, endpoint, endpointKind, noEndpointReason, expectStatus }
// `endpoint` is ONLY a URL the bot published itself (repo homepage, package homepage, registry remote,
// directory website). If there is none, endpoint is null and the bot is recorded as "no endpoint".
import { USER_AGENT } from './net-guard.mjs';

export const DEFAULT_KEYWORDS = ['bot', 'discord-bot', 'telegram-bot', 'slack-bot', 'mcp-server', 'ai-agent'];

// Homepages on these hosts are code, package or social pages, not the bot's own service.
const NOT_AN_ENDPOINT = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sourceforge\.net|npmjs\.com|npmjs\.org|pypi\.org|discord\.gg|discord\.com|discordapp\.com|t\.me|telegram\.me|x\.com|twitter\.com|youtube\.com|linkedin\.com|top\.gg)$/i;

/** Decide whether a published URL is a health-checkable endpoint. */
export function publishedEndpoint(raw) {
  if (!raw || typeof raw !== 'string') return { endpoint: null, reason: 'none published' };
  let u;
  try { u = new URL(raw.trim()); } catch { return { endpoint: null, reason: 'published URL is not valid' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { endpoint: null, reason: `published URL is ${u.protocol}` };
  if (u.username || u.password) return { endpoint: null, reason: 'published URL has credentials' };
  if (NOT_AN_ENDPOINT.test(u.hostname)) return { endpoint: null, reason: `homepage is a ${u.hostname} page, not a service` };
  u.hash = '';
  return { endpoint: u.toString(), reason: null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(url, { fetchImpl = globalThis.fetch, headers = {}, timeoutMs = 15000, as = 'json' } = {}) {
  const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: as === 'json' ? 'application/json' : '*/*', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  const body = as === 'json' ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, headers: res.headers, body };
}

function candidate(source, key, fields, published) {
  const { endpoint, reason } = publishedEndpoint(published);
  return {
    id: `${source}:${key}`,
    source,
    endpoint,
    endpointKind: endpoint ? fields.endpointKind || 'homepage' : null,
    noEndpointReason: endpoint ? null : reason,
    expectStatus: fields.expectStatus || '200-399',
    ...fields,
    description: String(fields.description || '').slice(0, 200),
  };
}

/** GitHub: public repos with one of the topics, created since `since`. Uses GITHUB_TOKEN only if provided. */
export async function fromGitHub({ since, limit, keywords, token, fetchImpl, delayMs = 1500, log }) {
  const out = [];
  const notes = [];
  const day = since.toISOString().slice(0, 10);
  for (const topic of keywords) {
    if (out.length >= limit) break;
    const q = `topic:${topic} created:>=${day} is:public archived:false`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${Math.min(50, limit)}`;
    const r = await apiGet(url, { fetchImpl, headers: { 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
      notes.push(`github: rate limited, stopping until ${reset ? new Date(reset).toISOString() : 'later'}`);
      break;
    }
    if (r.status !== 200 || !r.body) { notes.push(`github: topic ${topic} → HTTP ${r.status}`); continue; }
    for (const repo of r.body.items || []) {
      if (repo.fork || repo.archived || new Date(repo.created_at) < since) continue;
      out.push(candidate('github', repo.full_name.toLowerCase(), {
        name: repo.full_name, title: repo.name, description: repo.description, project: repo.html_url,
        publishedAt: repo.created_at, matched: topic,
      }, repo.homepage));
    }
    if (r.headers.get('x-ratelimit-remaining') === '0') { notes.push('github: rate limit reached for this window'); break; }
    await sleep(delayMs); // unauthenticated search allows 10 requests/min
  }
  return { items: dedupe(out).slice(0, limit), notes };
}

/** npm: registry search API, by keyword; keeps packages published since `since`. */
export async function fromNpm({ since, limit, keywords, fetchImpl, delayMs = 1000 }) {
  const out = [];
  const notes = [];
  for (const kw of keywords) {
    if (out.length >= limit) break;
    const r = await apiGet(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`keywords:${kw}`)}&size=100`, { fetchImpl });
    if (r.status === 429) { notes.push('npm: rate limited, stopping'); break; }
    if (r.status !== 200 || !r.body) { notes.push(`npm: keyword ${kw} → HTTP ${r.status}`); continue; }
    for (const o of r.body.objects || []) {
      const p = o.package || {};
      if (!p.date || new Date(p.date) < since) continue;
      out.push(candidate('npm', p.name, {
        name: p.name, title: p.name, description: p.description, project: p.links?.npm || `https://www.npmjs.com/package/${p.name}`,
        publishedAt: p.date, matched: kw,
      }, p.links?.homepage));
    }
    await sleep(delayMs);
  }
  notes.push('npm: the search API ranks by relevance, so "new" means published since the window among the top 100 per keyword');
  return { items: dedupe(out).slice(0, limit), notes };
}

function rssItems(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => (m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1]?.trim() || '';
    items.push({ title: get('title'), link: get('link'), description: get('description'), pubDate: get('pubDate') });
  }
  return items;
}

/** Word-ish keyword match: "discord-bot" matches "my discord bot", "bot" does not match "robot". */
export function matchesKeyword(text, keywords) {
  const words = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return keywords.find((k) => words.includes(` ${k.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `)) || null;
}

/** PyPI: official "newest packages" RSS feed (latest ~40), then the JSON API for matches. */
export async function fromPyPI({ since, limit, keywords, fetchImpl, delayMs = 500 }) {
  const out = [];
  const notes = ['pypi: has no search API; uses the official newest-packages RSS feed (only the latest ~40 packages)'];
  const r = await apiGet('https://pypi.org/rss/packages.xml', { fetchImpl, as: 'text' });
  if (r.status !== 200) return { items: [], notes: [...notes, `pypi: RSS → HTTP ${r.status}`] };
  for (const it of rssItems(r.body)) {
    if (out.length >= limit) break;
    const name = it.title.replace(/ added to PyPI$/, '');
    if (it.pubDate && new Date(it.pubDate) < since) continue;
    const hit = matchesKeyword(`${name} ${it.description}`, keywords);
    if (!hit) continue;
    const j = await apiGet(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { fetchImpl });
    await sleep(delayMs);
    if (j.status !== 200 || !j.body?.info) continue;
    const info = j.body.info;
    const urls = info.project_urls || {};
    const home = info.home_page || urls.Homepage || urls.homepage || urls.Home || urls.Website || null;
    out.push(candidate('pypi', name.toLowerCase(), {
      name, title: name, description: info.summary || it.description, project: info.package_url || it.link,
      publishedAt: it.pubDate ? new Date(it.pubDate).toISOString() : null, matched: hit,
    }, home));
  }
  return { items: out.slice(0, limit), notes };
}

/** Official MCP registry: servers first published since `since`; endpoint = the server's own remote URL. */
export async function fromMcpRegistry({ since, limit, fetchImpl, base = 'https://registry.modelcontextprotocol.io', maxPages = 5 }) {
  const out = [];
  const notes = [];
  let cursor = '';
  for (let page = 0; page < maxPages && out.length < limit; page++) {
    const url = `${base}/v0.1/servers?limit=100&updated_since=${encodeURIComponent(since.toISOString())}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await apiGet(url, { fetchImpl });
    if (r.status !== 200 || !r.body) { notes.push(`mcp: HTTP ${r.status}`); break; }
    for (const entry of r.body.servers || []) {
      const s = entry.server || {};
      const meta = entry._meta?.['io.modelcontextprotocol.registry/official'] || {};
      if (meta.status && meta.status !== 'active') continue;
      if (meta.isLatest === false) continue;
      // "new" = the server's first publication is in the window (registry publishedAt is per version,
      // so we use it as an approximation and dedupe by server name).
      if (meta.publishedAt && new Date(meta.publishedAt) < since) continue;
      const remote = (s.remotes || []).find((x) => x.type === 'streamable-http') || (s.remotes || [])[0];
      out.push(candidate('mcp', s.name, {
        name: s.name, title: s.title || s.name, description: s.description,
        project: s.repository?.url || s.websiteUrl || `${base}/v0.1/servers/${encodeURIComponent(s.name)}/versions/latest`,
        publishedAt: meta.publishedAt || null, matched: 'mcp-registry',
        endpointKind: 'mcp-remote',
        // MCP endpoints expect POST; a GET answered with 2xx-4xx (often 401/405/406) means it is up.
        // 404 is excluded: the published remote path is gone.
        expectStatus: ['200-403', '405-499'],
      }, remote?.url || null));
    }
    cursor = r.body.metadata?.nextCursor;
    if (!cursor) break;
  }
  return { items: dedupe(out).slice(0, limit), notes };
}

/**
 * top.gg (optional): documented v0 API GET https://top.gg/api/bots (needs a top.gg token, 60 req/min).
 * Only used when TOPGG_TOKEN is set. Endpoint = the bot's own "website" field.
 */
export async function fromTopGG({ since, limit, token, fetchImpl }) {
  if (!token) return { items: [], notes: ['topgg: skipped (set TOPGG_TOKEN to enable; it is a documented API that needs a token)'] };
  const r = await apiGet(`https://top.gg/api/bots?limit=${Math.min(100, limit * 3)}&sort=-date&fields=id,username,shortdesc,website,date`, { fetchImpl, headers: { authorization: token } });
  if (r.status !== 200 || !r.body) return { items: [], notes: [`topgg: HTTP ${r.status}`] };
  const out = [];
  for (const b of r.body.results || []) {
    if (b.date && new Date(b.date) < since) continue;
    out.push(candidate('topgg', String(b.id), {
      name: b.username, title: b.username, description: b.shortdesc, project: `https://top.gg/bot/${b.id}`,
      publishedAt: b.date || null, matched: 'top.gg', endpointKind: 'website',
    }, b.website));
  }
  return { items: out.slice(0, limit), notes: [] };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
}

export const SOURCES = { github: fromGitHub, npm: fromNpm, pypi: fromPyPI, mcp: fromMcpRegistry, topgg: fromTopGG };
