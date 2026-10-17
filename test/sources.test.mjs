import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishedEndpoint, matchesKeyword, fromGitHub, fromNpm, fromPyPI, fromMcpRegistry, fromTopGG } from '../lib/sources.mjs';
import { USER_AGENT } from '../lib/net-guard.mjs';

/** Fake fetch: routes by URL prefix, records every request. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) return new Response('not found', { status: 404 });
    const v = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    const body = typeof v.body === 'string' ? v.body : JSON.stringify(v.body);
    return new Response(body, { status: v.status || 200, headers: v.headers || {} });
  };
  f.calls = calls;
  return f;
}
const since = new Date('2026-10-16T00:00:00Z');

test('publishedEndpoint: only real service URLs count', () => {
  assert.equal(publishedEndpoint('https://mybot.example/health#x').endpoint, 'https://mybot.example/health');
  for (const u of ['https://github.com/a/b#readme', 'https://www.npmjs.com/package/x', 'https://pypi.org/project/x', 'https://discord.gg/abc', 'https://t.me/bot', 'ftp://x.y', 'not a url', '', null]) {
    assert.equal(publishedEndpoint(u).endpoint, null, String(u));
  }
  assert.match(publishedEndpoint('https://github.com/a/b').reason, /github\.com page/);
  assert.ok(publishedEndpoint('https://someone.github.io/bot').endpoint, 'GitHub Pages sites are real sites');
});

test('matchesKeyword is word-based', () => {
  const kw = ['bot', 'discord-bot', 'mcp-server'];
  assert.equal(matchesKeyword('my-discord-bot', kw), 'bot');
  assert.equal(matchesKeyword('a robot arm', kw), null);
  assert.equal(matchesKeyword('Simple MCP server for X', kw), 'mcp-server');
});

test('GitHub: topic search since date, homepage as endpoint, DIS UA, token only if given', async () => {
  const f = fakeFetch({
    'https://api.github.com/search/repositories': { body: { items: [
      { full_name: 'a/bot1', name: 'bot1', html_url: 'https://github.com/a/bot1', homepage: 'https://bot1.example', created_at: '2026-10-16T05:00:00Z' },
      { full_name: 'b/bot2', name: 'bot2', html_url: 'https://github.com/b/bot2', homepage: '', created_at: '2026-10-16T06:00:00Z' },
      { full_name: 'c/old', name: 'old', html_url: 'https://github.com/c/old', homepage: 'https://old.example', created_at: '2026-01-01T00:00:00Z' },
      { full_name: 'd/fork', fork: true, html_url: 'https://github.com/d/fork', created_at: '2026-10-16T06:00:00Z' },
    ] }, headers: { 'x-ratelimit-remaining': '9' } },
  });
  const r = await fromGitHub({ since, limit: 10, keywords: ['discord-bot', 'bot'], fetchImpl: f, delayMs: 0 });
  assert.deepEqual(r.items.map((i) => [i.id, i.endpoint]), [['github:a/bot1', 'https://bot1.example/'], ['github:b/bot2', null]]);
  assert.equal(r.items[1].noEndpointReason, 'none published');
  assert.match(decodeURIComponent(f.calls[0].url), /topic:discord-bot created:>=2026-10-16 is:public/);
  assert.equal(f.calls[0].headers['user-agent'], USER_AGENT);
  assert.equal(f.calls[0].headers.authorization, undefined, 'no token unless provided');
  const f2 = fakeFetch({ 'https://api.github.com/': { body: { items: [] } } });
  await fromGitHub({ since, limit: 10, keywords: ['bot'], token: 'ghp_x', fetchImpl: f2, delayMs: 0 });
  assert.equal(f2.calls[0].headers.authorization, 'Bearer ghp_x');
});

test('GitHub: stops on rate limit', async () => {
  const f = fakeFetch({ 'https://api.github.com/': { status: 403, body: { message: 'rate limit' }, headers: { 'x-ratelimit-reset': '1792247877' } } });
  const r = await fromGitHub({ since, limit: 10, keywords: ['a', 'b', 'c'], fetchImpl: f, delayMs: 0 });
  assert.equal(f.calls.length, 1);
  assert.match(r.notes[0], /rate limited/);
});

test('npm: keyword search, keeps packages published in the window', async () => {
  const f = fakeFetch({ 'https://registry.npmjs.org/-/v1/search': { body: { objects: [
    { package: { name: 'new-bot', date: '2026-10-16T10:00:00Z', links: { homepage: 'https://newbot.example', npm: 'https://www.npmjs.com/package/new-bot' } } },
    { package: { name: 'gh-bot', date: '2026-10-16T10:00:00Z', links: { homepage: 'https://github.com/x/gh-bot#readme' } } },
    { package: { name: 'old-bot', date: '2025-01-01T00:00:00Z', links: { homepage: 'https://old.example' } } },
  ] } } });
  const r = await fromNpm({ since, limit: 10, keywords: ['discord-bot'], fetchImpl: f, delayMs: 0 });
  assert.deepEqual(r.items.map((i) => [i.name, i.endpoint]), [['new-bot', 'https://newbot.example/'], ['gh-bot', null]]);
  assert.match(f.calls[0].url, /text=keywords%3Adiscord-bot/);
});

test('PyPI: RSS newest packages, JSON only for keyword matches', async () => {
  const rss = `<rss><channel>
    <item><title>cool-discord-bot added to PyPI</title><link>https://pypi.org/project/cool-discord-bot/</link><description>A discord bot</description><pubDate>Fri, 16 Oct 2026 12:00:00 GMT</pubDate></item>
    <item><title>numpy-thing added to PyPI</title><link>https://pypi.org/project/numpy-thing/</link><description>math</description><pubDate>Fri, 16 Oct 2026 12:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const f = fakeFetch({
    'https://pypi.org/rss/packages.xml': { body: rss },
    'https://pypi.org/pypi/cool-discord-bot/json': { body: { info: { summary: 'bot', project_urls: { Homepage: 'https://cool.example' }, package_url: 'https://pypi.org/project/cool-discord-bot/' } } },
  });
  const r = await fromPyPI({ since, limit: 10, keywords: ['discord-bot'], fetchImpl: f, delayMs: 0 });
  assert.deepEqual(r.items.map((i) => [i.name, i.endpoint]), [['cool-discord-bot', 'https://cool.example/']]);
  assert.equal(f.calls.length, 2, 'no JSON request for non-matching packages');
});

test('MCP registry: updated_since, active latest only, remote URL as endpoint, 404 is not "up"', async () => {
  const f = fakeFetch({ 'https://registry.modelcontextprotocol.io/v0.1/servers': (url) => ({ body: url.includes('cursor=')
    ? { servers: [], metadata: {} }
    : { servers: [
      { server: { name: 'io.x/remote', remotes: [{ type: 'sse', url: 'https://x.example/sse' }, { type: 'streamable-http', url: 'https://x.example/mcp' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, publishedAt: '2026-10-16T08:00:00Z' } } },
      { server: { name: 'io.y/local-only', packages: [{ registryType: 'npm' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, publishedAt: '2026-10-16T08:00:00Z' } } },
      { server: { name: 'io.z/deleted', remotes: [{ url: 'https://z.example' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted', publishedAt: '2026-10-16T08:00:00Z' } } },
      { server: { name: 'io.w/oldver', remotes: [{ url: 'https://w.example' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: false, publishedAt: '2026-10-16T08:00:00Z' } } },
    ], metadata: { nextCursor: 'io.w/oldver:1' } } }) });
  const r = await fromMcpRegistry({ since, limit: 10, fetchImpl: f });
  assert.deepEqual(r.items.map((i) => [i.name, i.endpoint]), [['io.x/remote', 'https://x.example/mcp'], ['io.y/local-only', null]]);
  assert.match(f.calls[0].url, /updated_since=2026-10-16T00%3A00%3A00\.000Z/);
  assert.equal(f.calls.length, 2, 'follows nextCursor');
  const { statusMatcher } = await import('../lib/checks.mjs');
  const m = statusMatcher(r.items[0].expectStatus);
  assert.ok(m(401) && m(405) && m(200));
  assert.ok(!m(404) && !m(502));
});

test('top.gg is skipped without a token and sends the raw token when given', async () => {
  assert.equal((await fromTopGG({ since, limit: 5 })).items.length, 0);
  const f = fakeFetch({ 'https://top.gg/api/bots': { body: { results: [{ id: '1', username: 'B', website: 'https://b.example', date: '2026-10-16T09:00:00Z' }, { id: '2', username: 'C', date: '2026-10-16T09:00:00Z' }] } } });
  const r = await fromTopGG({ since, limit: 5, token: 'tg', fetchImpl: f });
  assert.equal(f.calls[0].headers.authorization, 'tg');
  assert.deepEqual(r.items.map((i) => [i.id, i.endpoint]), [['topgg:1', 'https://b.example/'], ['topgg:2', null]]);
});
