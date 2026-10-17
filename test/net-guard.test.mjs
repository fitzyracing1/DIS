import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeGuard, embeddedV4, parsePublicUrl, safeFetch, USER_AGENT } from '../lib/net-guard.mjs';
import { serve } from './helpers.mjs';

const guard = makeGuard();

test('blocks private, loopback, link-local, metadata and reserved addresses', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '255.255.255.255', '192.0.2.10',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', '2002:7f00:0001::1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(guard.isBlocked(ip), true, ip);
  }
});

test('allows public addresses', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
    assert.equal(guard.isBlocked(ip), false, ip);
  }
});

test('embeddedV4 decodes mapped, NAT64 and 6to4 forms', () => {
  assert.equal(embeddedV4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(embeddedV4('64:ff9b::a9fe:a9fe'), '169.254.169.254');
  assert.equal(embeddedV4('2002:c0a8:0101::1'), '192.168.1.1');
  assert.equal(embeddedV4('2606:4700::1'), null);
});

test('operator allow list (DIS_CHECK_ALLOW_CIDRS) can open a range on purpose', () => {
  const g = makeGuard({ allowCidrs: ['10.1.0.0/16'] });
  assert.equal(g.isBlocked('10.1.2.3'), false);
  assert.equal(g.isBlocked('10.2.0.1'), true);
  assert.throws(() => makeGuard({ allowCidrs: ['nope/8'] }), /bad CIDR/);
});

test('parsePublicUrl: only http(s), no credentials', () => {
  assert.equal(parsePublicUrl('https://example.com/x').hostname, 'example.com');
  for (const u of ['ftp://example.com', 'file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'http://user:pw@example.com', 'not a url']) {
    assert.throws(() => parsePublicUrl(u), { code: 'EBADURL' }, u);
  }
});

test('checkHost: literal private IPs and localhost names are refused', async () => {
  await assert.rejects(guard.checkHost('127.0.0.1'), { code: 'EBLOCKED' });
  await assert.rejects(guard.checkHost('[::1]'), { code: 'EBLOCKED' });
  await assert.rejects(guard.checkHost('169.254.169.254'), { code: 'EBLOCKED' });
  await assert.rejects(guard.checkHost('localhost'), { code: 'EBLOCKED' });
});

// A local server is on 127.0.0.1, so it is blocked by default. Tests open 127.0.0.0/8 explicitly
// to exercise the client, and separately prove that the default guard refuses it.
const loop = makeGuard({ allowCidrs: ['127.0.0.0/8'] });
const big = 'x'.repeat(100000);
const srv = await serve((req, res) => {
  if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('hello'); }
  if (req.url === '/big') { res.writeHead(200); return res.end(big); }
  if (req.url === '/slow') return setTimeout(() => { res.writeHead(200); res.end('late'); }, 500);
  if (req.url === '/to-ok') { res.writeHead(302, { location: '/ok' }); return res.end(); }
  if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
  if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
  if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
  res.writeHead(404); res.end();
});
after(() => srv.close());

test('default guard refuses a loopback URL before connecting', async () => {
  const before = srv.requests.length;
  await assert.rejects(safeFetch(`${srv.url}/ok`), { code: 'EBLOCKED' });
  await assert.rejects(safeFetch(`http://localhost:${srv.port}/ok`), { code: 'EBLOCKED' });
  assert.equal(srv.requests.length, before, 'no request reached the server');
});

test('safeFetch: GET with the DIS user agent', async () => {
  const r = await safeFetch(`${srv.url}/ok`, { guard: loop });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'hello');
  assert.equal(srv.requests.at(-1).headers['user-agent'], USER_AGENT);
  assert.match(USER_AGENT, /github\.com\/fitzyracing1\/DIS/);
});

test('safeFetch: follows redirects and re-checks every hop', async () => {
  assert.equal((await safeFetch(`${srv.url}/to-ok`, { guard: loop })).body, 'hello');
  await assert.rejects(safeFetch(`${srv.url}/to-metadata`, { guard: loop }), { code: 'EBLOCKED' });
  await assert.rejects(safeFetch(`${srv.url}/to-file`, { guard: loop }), { code: 'EBADURL' });
  await assert.rejects(safeFetch(`${srv.url}/loop`, { guard: loop, maxRedirects: 2 }), { code: 'ETOOMANYREDIRECTS' });
});

test('safeFetch: response size is capped', async () => {
  const r = await safeFetch(`${srv.url}/big`, { guard: loop, maxBytes: 1000 });
  assert.equal(r.truncated, true);
  assert.equal(r.bytes, 1000);
  assert.equal(r.body.length, 1000);
});

test('safeFetch: overall timeout', async () => {
  await assert.rejects(safeFetch(`${srv.url}/slow`, { guard: loop, timeoutMs: 100 }), { code: 'ETIMEDOUT' });
});

test('safeFetch: sameHost refuses cross-host redirects', async () => {
  const s2 = await serve((req, res) => { res.writeHead(302, { location: `http://127.0.0.2:${srv.port}/ok` }); res.end(); });
  try {
    await assert.rejects(safeFetch(`${s2.url}/`, { guard: loop, sameHost: true }), /another host/);
  } finally { await s2.close(); }
});
