import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Discovery, targetNameFor } from '../lib/discovery.mjs';
import { Registrar } from '../lib/register.mjs';
import { normalizeDiscovery, normalizeConfig } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { Monitor } from '../lib/monitor.mjs';
import { createServer } from '../lib/server.mjs';
import { makeGuard, USER_AGENT } from '../lib/net-guard.mjs';
import { serve, quiet } from './helpers.mjs';

const guard = makeGuard({ allowCidrs: ['127.0.0.0/8'] }); // local test servers only
let robots = 'User-agent: *\nDisallow: /private\n';
let wellKnown = '';
const site = await serve((req, res) => {
  if (req.url === '/robots.txt') { res.writeHead(200); return res.end(robots); }
  if (req.url === '/.well-known/dis.txt') { res.writeHead(wellKnown ? 200 : 404); return res.end(wellKnown); }
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(404); res.end();
});
after(() => site.close());

const cfg = (over = {}) => ({ ...normalizeDiscovery({ enabled: true, perHostMax: 50, ...over }, {}) });
const fakeSource = (items) => async () => ({ items, notes: [] });
const cand = (id, endpoint, extra = {}) => ({ id: `fake:${id}`, source: 'fake', name: id, title: id, project: `https://example.com/${id}`, publishedAt: '2026-10-16T00:00:00Z', endpoint, endpointKind: endpoint ? 'homepage' : null, noEndpointReason: endpoint ? null : 'none published', expectStatus: '200-399', ...extra });

function setup(over = {}, items = []) {
  const store = new Store(null);
  const monitor = new Monitor(normalizeConfig({ targets: [{ name: 'mine', url: 'https://example.com' }] }), store, { log: quiet });
  const c = cfg({ sources: { github: false, npm: false, pypi: false, mcp: false, topgg: false }, ...over });
  c.sources.fake = true;
  const d = new Discovery(c, store, monitor, { guard, log: quiet, sources: { fake: fakeSource(items) } });
  return { store, monitor, d };
}

test('config: off by default, 5-minute floor on interval, keyword list configurable', () => {
  const d = normalizeDiscovery({}, {});
  assert.equal(d.enabled, false);
  assert.equal(d.register, false);
  assert.equal(normalizeDiscovery({ intervalSeconds: 10 }, {}).intervalSeconds, 300);
  assert.equal(normalizeDiscovery({}, { DIS_DISCOVERY: '1', DIS_REGISTER: 'true' }).enabled, true);
  assert.deepEqual(d.keywords, ['bot', 'discord-bot', 'telegram-bot', 'slack-bot', 'mcp-server', 'ai-agent']);
  assert.deepEqual(normalizeDiscovery({ keywords: ['x'] }, {}).keywords, ['x']);
});

test('targetNameFor is a valid, stable, unique target name', () => {
  const n = targetNameFor('npm:@scope/My Bot');
  assert.match(n, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.equal(n, targetNameFor('npm:@scope/My Bot'));
  assert.notEqual(n, targetNameFor('npm:@scope/my-bot'));
});

test('run: no endpoint is recorded, not probed; endpoint is watched after robots.txt; interval ≥ 300 s', async () => {
  const { d, monitor } = setup({}, [cand('a', `${site.url}/health`), cand('b', null)]);
  const before = site.requests.length;
  const s = await d.run({ since: new Date(0) });
  assert.equal(s.new, 2);
  assert.equal(s.watching, 1);
  assert.equal(s.noEndpoint, 1);
  assert.deepEqual(site.requests.slice(before).map((r) => r.url), ['/robots.txt'], 'only robots.txt was fetched');
  assert.equal(site.requests.at(-1).headers['user-agent'], USER_AGENT);
  const t = [...monitor.discovered.values()][0];
  assert.equal(t.intervalSeconds, 300);
  assert.equal(t.guarded, true);
  const list = d.list();
  assert.deepEqual(list.map((b) => [b.name, b.state]).sort(), [['a', 'pending'], ['b', 'no-endpoint']]);
  assert.ok(list[0].firstSeen);
  // a second run does not re-add known bots
  assert.equal((await d.run({ since: new Date(0) })).new, 0);
});

test('robots.txt disallow → skipped; private endpoint → skipped by the SSRF guard', async () => {
  const { d } = setup({}, [cand('p', `${site.url}/private/health`)]);
  await d.run({ since: new Date(0) });
  assert.equal(d.list()[0].state, 'skipped');
  assert.match(d.list()[0].reason, /robots/);
  const store = new Store(null);
  const strict = new Discovery({ ...cfg(), sources: { fake: true } }, store, null, { log: quiet, sources: { fake: fakeSource([cand('m', 'http://169.254.169.254/latest/')]) } });
  await strict.run({ since: new Date(0) });
  assert.match(strict.list()[0].reason, /private\/reserved/);
});

test('caps: maxTargets and perHostMax', async () => {
  const items = [1, 2, 3, 4].map((i) => cand(`c${i}`, `${site.url}/health?i=${i}`));
  const { d } = setup({ maxTargets: 2 }, items);
  await d.run({ since: new Date(0) });
  assert.equal(d.watchedCount(), 2);
  assert.match(d.list().find((b) => b.state === 'skipped').reason, /cap reached/);
  const h = setup({ perHostMax: 1 }, items);
  await h.d.run({ since: new Date(0) });
  assert.equal(h.d.watchedCount(), 1);
  assert.match(h.d.list().find((b) => b.state === 'skipped').reason, /already watching 1/);
});

test('discovered checks go through the guard, never alert, never change the overall light', async () => {
  const hook = await serve((req, res) => { res.writeHead(204); res.end(); });
  try {
    const store = new Store(null);
    const monitor = new Monitor(normalizeConfig({ targets: [{ name: 'mine', url: `${site.url}/health` }], alerts: [{ type: 'json', url: hook.url }] }), store, { log: quiet, check: async (t) => ({ ok: !t.discovered, light: t.discovered ? 'dark' : 'lit', ms: 1, detail: 'x' }) });
    const d = new Discovery({ ...cfg(), sources: { fake: true } }, store, monitor, { guard, log: quiet, sources: { fake: fakeSource([cand('z', `${site.url}/health`)]) } });
    await d.run({ since: new Date(0) });
    await monitor.checkTarget(monitor.config.targets[0]);
    const t = [...monitor.discovered.values()][0];
    await monitor.checkTarget(t); await monitor.checkTarget(t);
    assert.equal(d.list()[0].state, 'dark');
    const snap = monitor.snapshot();
    assert.equal(snap.light, 'lit', 'overall light only covers your own targets');
    assert.equal(snap.discovered.length, 1);
    assert.equal(hook.requests.length, 0, 'no alert for a discovered bot');
  } finally { await hook.close(); }
});

test('maxRecords evicts the oldest non-watched records first', async () => {
  const items = Array.from({ length: 15 }, (_, i) => cand(`n${i}`, null));
  const { d } = setup({ maxRecords: 10 }, items);
  await d.run({ since: new Date(0) });
  assert.equal(Object.keys(d.bots).length, 10);
});

test('register: token at /.well-known/dis.txt proves ownership; removal stops watching', async () => {
  let now = Date.parse('2026-10-17T12:00:00Z');
  const store = new Store(null);
  const monitor = new Monitor(normalizeConfig({ targets: [{ name: 'mine', url: 'https://example.com' }] }), store, { log: quiet });
  const d = new Discovery(normalizeDiscovery({ register: true }, {}), store, monitor, { guard, log: quiet, now: () => now });
  const reg = new Registrar(d, { now: () => now });
  const srv = createServer(monitor, { registrar: reg });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    assert.equal((await post('/register', { url: 'ftp://x', name: 'a' })).status, 400);
    assert.equal((await post('/register', { url: 'https://github.com/a/b', name: 'a' })).status, 400, 'code pages are not endpoints');
    assert.equal((await post('/register', { url: `${site.url}/health`, name: 'bad name!' })).status, 400);
    const r = await post('/register', { url: `${site.url}/health`, name: 'my-bot' });
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.match(body.token, /^dis-verify=[a-f0-9]{32}$/);
    assert.equal(body.verifyUrl, `${site.url}/.well-known/dis.txt`);
    assert.equal(monitor.discovered.size, 0, 'nothing is watched before verification');

    wellKnown = 'someone-else\n';
    const v1 = await post('/register/verify', { id: body.id });
    assert.equal(v1.status, 409);
    wellKnown = `other-line\n${body.token}\n`;
    const v2 = await (await post('/register/verify', { id: body.id })).json();
    assert.equal(v2.status, 'watching');
    assert.equal(monitor.discovered.size, 1);
    assert.equal((await (await fetch(`${base}/register/${body.id}`)).json()).status, 'watching');
    const list = await (await fetch(`${base}/discovered.json`)).json();
    assert.equal(list.discovered[0].source, 'register');
    assert.doesNotMatch(JSON.stringify(list), /dis-verify=/, 'token is not published');

    // a day later the owner removed the token → forgotten
    wellKnown = '';
    now += 25 * 3600e3;
    await reg.reverify();
    assert.equal(monitor.discovered.size, 0);
    assert.equal(d.list().length, 0);
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
});

test('register: off → 404; rate limited per IP', async () => {
  const store = new Store(null);
  const monitor = new Monitor(normalizeConfig({ targets: [{ name: 'mine', url: 'https://example.com' }] }), store, { log: quiet });
  const off = createServer(monitor);
  await new Promise((r) => off.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${off.address().port}/register`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 404);
  } finally { await new Promise((r) => off.close(r)); }
  const d = new Discovery(normalizeDiscovery({ register: true }, {}), store, monitor, { guard, log: quiet });
  const reg = new Registrar(d, { perHour: 2 });
  const on = createServer(monitor, { registrar: reg });
  await new Promise((r) => on.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${on.address().port}/register`;
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(url, { method: 'POST', body: JSON.stringify({ url: `${site.url}/health`, name: `b${i}` }) })).status);
    assert.deepEqual(codes, [202, 202, 429]);
  } finally { on.closeAllConnections?.(); await new Promise((r) => on.close(r)); }
});

test('status page lists discovered bots with source, first seen and state', async () => {
  const { monitor, d } = setup({}, [cand('pagebot', null)]);
  await d.run({ since: new Date(0) });
  const { renderPage } = await import('../lib/page.mjs');
  const html = renderPage(monitor.snapshot());
  assert.match(html, /Discovered bots/);
  assert.match(html, /pagebot/);
  assert.match(html, /no-endpoint/);
});
