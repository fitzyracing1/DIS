import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCheckRequest, runSafeCheck, createCheckApi, checkApiOptions } from '../lib/check-api.mjs';
import { RateLimiter, clientIp } from '../lib/rate-limit.mjs';
import { makeGuard } from '../lib/net-guard.mjs';
import { createServer } from '../lib/server.mjs';
import { serve } from './helpers.mjs';

const loop = makeGuard({ allowCidrs: ['127.0.0.0/8'] }); // tests run against 127.0.0.1 on purpose
const site = await serve((req, res) => {
  if (req.url === '/ok') { res.writeHead(200); return res.end('hello lit'); }
  if (req.url === '/503') { res.writeHead(503); return res.end('down'); }
  if (req.url === '/slow') return setTimeout(() => { res.writeHead(200); res.end('x'); }, 300);
  if (req.url === '/to-meta') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return res.end(); }
  res.writeHead(404); res.end();
});
after(() => site.close());
const fakeMonitor = { snapshot: () => ({ light: 'lit', counts: { lit: 0, dark: 0, total: 0 }, targets: [], title: 't', generatedAt: '' }) };

async function withServer(apiOpts, fn) {
  const srv = createServer(fakeMonitor, { checkApi: createCheckApi(apiOpts) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
}
const post = (base, body, headers = {}) => fetch(`${base}/check`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('parseCheckRequest: defaults, caps and validation', () => {
  const s = parseCheckRequest({ url: 'https://example.com' });
  assert.deepEqual([s.type, s.maxMs, s.expect, s.method], ['http', 5000, '200-399', 'GET']);
  assert.equal(parseCheckRequest({ url: 'https://example.com', maxMs: 999999 }).maxMs, 10000, 'maxMs is capped');
  assert.deepEqual(parseCheckRequest({ type: 'tcp', url: 'tcp://example.com:443' }), { type: 'tcp', maxMs: 5000, host: 'example.com', port: 443 });
  assert.equal(parseCheckRequest({ type: 'dns', url: 'https://example.com/x' }).host, 'example.com');
  assert.deepEqual(parseCheckRequest({ url: 'https://e.com', expect: '200,204' }).expect, ['200', '204']);
  for (const [input, re] of [
    [{}, /url is required/], [{ url: 'file:///etc/passwd' }, /http and https/], [{ url: 'gopher://x' }, /http and https/],
    [{ url: 'http://a:b@e.com' }, /credentials/], [{ url: 'https://e.com', type: 'icmp' }, /type/],
    [{ url: 'https://e.com', expect: 'ok' }, /expect/], [{ type: 'tcp', url: 'e.com' }, /host:port/],
    [{ type: 'tcp', host: 'e.com', port: 0 }, /port/], [{ url: 'https://e.com', method: 'POST' }, /GET or HEAD/],
    [{ type: 'dns', host: 'e.com', recordType: 'ANY' }, /recordType/],
  ]) assert.throws(() => parseCheckRequest(input), re, JSON.stringify(input));
});

test('runSafeCheck http: lit, dark on status, slow, keyword', async () => {
  const ok = await runSafeCheck(parseCheckRequest({ url: `${site.url}/ok`, keyword: 'lit' }), { guard: loop });
  assert.equal(ok.state, 'lit');
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.ms, 'number');
  assert.equal((await runSafeCheck(parseCheckRequest({ url: `${site.url}/503` }), { guard: loop })).state, 'dark');
  assert.equal((await runSafeCheck(parseCheckRequest({ url: `${site.url}/503`, expect: 503 }), { guard: loop })).state, 'lit');
  const slow = await runSafeCheck(parseCheckRequest({ url: `${site.url}/slow`, maxMs: 100 }), { guard: loop });
  assert.equal(slow.state, 'dark');
  assert.match(slow.detail, /too slow|timeout/);
  assert.match((await runSafeCheck(parseCheckRequest({ url: `${site.url}/ok`, keyword: 'nope' }), { guard: loop })).detail, /keyword/);
});

test('runSafeCheck: SSRF targets are dark with "blocked", nothing is fetched', async () => {
  const before = site.requests.length;
  for (const url of [`${site.url}/ok`, `http://localhost:${site.port}/ok`, 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/', 'http://0.0.0.0/']) {
    const r = await runSafeCheck(parseCheckRequest({ url }));
    assert.equal(r.state, 'dark', url);
    assert.match(r.detail, /blocked/, url);
  }
  assert.equal(site.requests.length, before);
  const viaRedirect = await runSafeCheck(parseCheckRequest({ url: `${site.url}/to-meta` }), { guard: loop });
  assert.match(viaRedirect.detail, /blocked/);
});

test('runSafeCheck tcp: guarded', async () => {
  const s = net.createServer((c) => c.end());
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  try {
    assert.equal((await runSafeCheck(parseCheckRequest({ type: 'tcp', host: '127.0.0.1', port }), { guard: loop })).state, 'lit');
    const blocked = await runSafeCheck(parseCheckRequest({ type: 'tcp', host: '127.0.0.1', port }));
    assert.match(blocked.detail, /blocked/);
  } finally { await new Promise((r) => s.close(r)); }
});

test('runSafeCheck dns: private answers are hidden', async () => {
  const resolver = { resolve: async (h) => (h === 'internal.test' ? ['10.1.2.3'] : ['93.184.216.34']) };
  const priv = await runSafeCheck(parseCheckRequest({ type: 'dns', host: 'internal.test' }), { resolver });
  assert.equal(priv.state, 'dark');
  assert.doesNotMatch(JSON.stringify(priv), /10\.1\.2\.3/);
  const pub = await runSafeCheck(parseCheckRequest({ type: 'dns', host: 'public.test', expect: '93.184' }), { resolver });
  assert.equal(pub.state, 'lit');
});

test('API is off by default (404) and settings come from env', async () => {
  assert.equal(createCheckApi().enabled, false);
  assert.equal(createCheckApi(checkApiOptions({ DIS_PUBLIC_CHECK: '1' })).enabled, true);
  assert.equal(createCheckApi(checkApiOptions({ DIS_API_KEY: 'k' })).enabled, true);
  await withServer({}, async (base) => {
    const r = await post(base, { url: 'https://example.com' });
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /off/);
  });
});

test('API public mode: POST and GET forms return {state, status, ms, detail}', async () => {
  await withServer({ public: true, guard: loop }, async (base) => {
    const p = await (await post(base, { url: `${site.url}/ok`, type: 'http', expect: 200, maxMs: 2000 })).json();
    assert.equal(p.state, 'lit');
    assert.equal(p.status, 200);
    assert.ok('ms' in p && 'detail' in p);
    const g = await (await fetch(`${base}/check?url=${encodeURIComponent(`${site.url}/503`)}`)).json();
    assert.equal(g.state, 'dark');
    assert.equal(g.status, 503);
    assert.equal((await post(base, { url: 'ftp://x' })).status, 400);
    const big = await fetch(`${base}/check`, { method: 'POST', body: 'x'.repeat(5000) });
    assert.equal(big.status, 400);
  });
});

test('API key: required when set (Bearer or X-API-Key)', async () => {
  await withServer({ apiKey: 's3cret', public: true, guard: loop }, async (base) => {
    assert.equal((await post(base, { url: `${site.url}/ok` })).status, 401, 'public flag does not bypass a key');
    assert.equal((await post(base, { url: `${site.url}/ok` }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(base, { url: `${site.url}/ok` }, { authorization: 'Bearer s3cret' })).status, 200);
    assert.equal((await post(base, { url: `${site.url}/ok` }, { 'x-api-key': 's3cret' })).status, 200);
  });
});

test('API rate limit per IP → 429 with Retry-After', async () => {
  await withServer({ public: true, guard: loop, ratePerMinute: 2 }, async (base) => {
    assert.equal((await post(base, { url: `${site.url}/ok` })).status, 200);
    assert.equal((await post(base, { url: `${site.url}/ok` })).status, 200);
    const r = await post(base, { url: `${site.url}/ok` });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });
});

test('RateLimiter windows and clientIp proxy handling', () => {
  let now = 0;
  const rl = new RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
  assert.equal(rl.take('a').ok, true);
  assert.equal(rl.take('a').ok, false);
  assert.equal(rl.take('b').ok, true);
  now = 1000;
  assert.equal(rl.take('a').ok, true);
  const req = { headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: { remoteAddress: '10.0.0.9' } };
  assert.equal(clientIp(req, false), '10.0.0.9');
  assert.equal(clientIp(req, true), '1.2.3.4', 'last hop (added by the proxy), not the spoofable first entry');
});

test('CLI: dis check exit codes', async () => {
  const bin = fileURLToPath(new URL('../bin/dis.mjs', import.meta.url));
  const run = (args, env = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.on('close', (status) => resolve({ status, stdout }));
  });
  const lit = await run(['check', `${site.url}/ok`, '--json'], { DIS_CHECK_ALLOW_CIDRS: '127.0.0.0/8' });
  assert.equal(lit.status, 0);
  assert.equal(JSON.parse(lit.stdout).state, 'lit');
  assert.equal((await run(['check', `${site.url}/503`, '--allow-private'])).status, 1);
  const blocked = await run(['check', `${site.url}/ok`]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /blocked/);
  assert.equal((await run(['check', 'file:///etc/passwd'])).status, 2);
  assert.equal((await run(['check'])).status, 2);
});
