import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { statusMatcher, checkHttp, checkTcp, checkDns } from '../lib/checks.mjs';
import { serve } from './helpers.mjs';

const srv = await serve((req, res) => {
  if (req.url === '/ok') { res.writeHead(200); return res.end('hello lit world'); }
  if (req.url === '/500') { res.writeHead(500); return res.end('boom'); }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); return res.end(); }
  if (req.url === '/slow') return setTimeout(() => { res.writeHead(200); res.end('late'); }, 300);
  res.writeHead(404); res.end();
});
after(() => srv.close());

const http = (path, extra = {}) => checkHttp({ url: srv.url + path, timeoutMs: 2000, maxLatencyMs: 5000, expectStatus: '200-399', ...extra });

test('statusMatcher: codes, ranges, classes, arrays', () => {
  assert.ok(statusMatcher(200)(200));
  assert.ok(!statusMatcher(200)(201));
  assert.ok(statusMatcher('200-299')(204));
  assert.ok(statusMatcher('3xx')(301));
  assert.ok(statusMatcher([200, '4xx'])(404));
  assert.equal(statusMatcher('nope'), null);
});

test('http: 200 is lit and sends a DIS user-agent', async () => {
  const r = await http('/ok');
  assert.equal(r.light, 'lit');
  assert.equal(r.status, 200);
  assert.match(r.detail, /HTTP 200/);
  assert.match(srv.requests.at(-1).headers['user-agent'], /^DIS\//);
});

test('http: unexpected status is dark', async () => {
  const r = await http('/500');
  assert.equal(r.light, 'dark');
  assert.match(r.detail, /HTTP 500/);
});

test('http: expectStatus can require a non-2xx code', async () => {
  assert.equal((await http('/500', { expectStatus: 500 })).light, 'lit');
});

test('http: follows redirects', async () => {
  assert.equal((await http('/redirect', { expectStatus: 200 })).light, 'lit');
});

test('http: keyword present → lit, missing → dark', async () => {
  assert.equal((await http('/ok', { keyword: 'lit world' })).light, 'lit');
  const r = await http('/ok', { keyword: 'dark' });
  assert.equal(r.light, 'dark');
  assert.match(r.detail, /keyword/);
});

test('http: slower than maxLatencyMs is dark', async () => {
  const r = await http('/slow', { maxLatencyMs: 100 });
  assert.equal(r.light, 'dark');
  assert.match(r.detail, /too slow/);
});

test('http: timeout is dark', async () => {
  const r = await http('/slow', { timeoutMs: 50 });
  assert.equal(r.light, 'dark');
  assert.match(r.detail, /timeout/);
});

test('http: connection refused is dark', async () => {
  const r = await checkHttp({ url: 'http://127.0.0.1:1/', timeoutMs: 2000, maxLatencyMs: 5000 });
  assert.equal(r.light, 'dark');
  assert.match(r.detail, /ECONNREFUSED|failed/);
});

test('tcp: open port lit, closed port dark', async () => {
  const s = net.createServer((c) => c.end());
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  assert.equal((await checkTcp({ host: '127.0.0.1', port, timeoutMs: 2000, maxLatencyMs: 5000 })).light, 'lit');
  await new Promise((r) => s.close(r));
  const r = await checkTcp({ host: '127.0.0.1', port, timeoutMs: 2000, maxLatencyMs: 5000 });
  assert.equal(r.light, 'dark');
  assert.match(r.detail, /ECONNREFUSED/);
});

test('dns: resolves → lit, expect mismatch / NXDOMAIN → dark (fake resolver)', async () => {
  const resolver = { resolve: async (host) => { if (host === 'gone.test') throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); return ['10.0.0.1']; } };
  const base = { host: 'ok.test', recordType: 'A', timeoutMs: 1000, maxLatencyMs: 5000 };
  assert.equal((await checkDns(base, { resolver })).light, 'lit');
  assert.equal((await checkDns({ ...base, expect: '10.0.0.1' }, { resolver })).light, 'lit');
  assert.equal((await checkDns({ ...base, expect: '1.2.3.4' }, { resolver })).light, 'dark');
  const r = await checkDns({ ...base, host: 'gone.test' }, { resolver });
  assert.equal(r.light, 'dark');
  assert.match(r.detail, /ENOTFOUND/);
});
