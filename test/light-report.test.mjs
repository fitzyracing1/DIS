import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { LightReporter, lightName, tokenEnvKey } from '../lib/light-report.mjs';
import { Store } from '../lib/store.mjs';
import { serve, quiet } from './helpers.mjs';

// A fake light-report that behaves like the real POST /lights/:name:
// first report → 201 + token; later reports need "Authorization: Bearer <token>" or 401.
const lights = new Map();
const fake = await serve((req, res, body) => {
  const m = req.url.match(/^\/lights\/([^/]+)$/);
  if (req.method !== 'POST' || !m) { res.writeHead(404); return res.end('{}'); }
  const name = decodeURIComponent(m[1]);
  const b = JSON.parse(body);
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  const existing = lights.get(name);
  res.setHeader('content-type', 'application/json');
  if (existing && existing.token !== auth) { res.writeHead(401); return res.end('{"error":"write token missing or wrong for this light"}'); }
  const token = existing ? existing.token : `lr_${name}`;
  lights.set(name, { token, light: b.state, source: b.source, detail: b.detail });
  res.writeHead(existing ? 200 : 201);
  res.end(JSON.stringify({ name, light: b.state, ...(existing ? {} : { token }) }));
});
after(() => fake.close());

const target = { name: 'site', type: 'http', url: 'https://x.y' };
const state = (light) => ({ light, lastCheck: { detail: 'HTTP 200 in 12ms' }, lastReportedAt: null });

test('names and env keys follow light-run conventions', () => {
  assert.equal(lightName('net-', 'site'), 'net-site');
  assert.equal(tokenEnvKey('net-site.v2'), 'LIGHT_TOKEN_NET_SITE_V2');
});

test('first report claims the light and saves the token; later reports use it', async () => {
  const store = new Store(null);
  const r = new LightReporter({ url: fake.url, prefix: 'net-', heartbeatMinutes: 15 }, store, { env: {}, log: quiet });
  const s = state('lit');
  assert.equal((await r.maybeReport(target, s, { changed: true })).status, 201);
  assert.equal(store.data.lightReportTokens['net-site'], 'lr_net-site');
  assert.deepEqual(lights.get('net-site'), { token: 'lr_net-site', light: 'lit', source: 'dis', detail: 'HTTP 200 in 12ms' });
  assert.equal(await r.maybeReport(target, s), null, 'no change and heartbeat not due → no POST');
  s.light = 'dark';
  assert.equal((await r.maybeReport(target, s, { changed: true })).status, 200);
  assert.equal(lights.get('net-site').light, 'dark');
});

test('heartbeat re-reports after heartbeatMinutes', async () => {
  const store = new Store(null);
  store.data.lightReportTokens['net-site'] = 'lr_net-site';
  const r = new LightReporter({ url: fake.url, prefix: 'net-', heartbeatMinutes: 1 }, store, { env: {}, log: quiet });
  const s = { ...state('lit'), lastReportedAt: new Date(Date.now() - 61000).toISOString() };
  assert.equal((await r.maybeReport(target, s)).ok, true);
});

test('pending is never reported; wrong token → 401 with a warning, no throw', async () => {
  const errors = [];
  const r = new LightReporter({ url: fake.url, prefix: 'net-', tokens: { site: 'wrong' } }, new Store(null), { env: {}, log: { log() {}, error: (m) => errors.push(m) } });
  assert.equal(await r.maybeReport(target, state('pending'), { force: true }), null);
  const out = await r.maybeReport(target, state('lit'), { force: true });
  assert.equal(out.status, 401);
  assert.match(errors[0], /LIGHT_TOKEN_NET_SITE/);
});

test('token from env LIGHT_TOKEN_<NAME>', async () => {
  const r = new LightReporter({ url: fake.url, prefix: 'net-' }, new Store(null), { env: { LIGHT_TOKEN_NET_SITE: 'lr_net-site' }, log: quiet });
  assert.equal((await r.report(target, state('lit'))).status, 200);
});

test('never prints the token in CI logs', async () => {
  const lines = [];
  const r = new LightReporter({ url: fake.url, prefix: 'ci-' }, new Store(null), { env: { CI: 'true' }, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } });
  assert.equal((await r.report(target, state('lit'))).status, 201);
  assert.match(lines.join('\n'), /claimed light "ci-site"/);
  assert.doesNotMatch(lines.join('\n'), /lr_ci-site/);
});
