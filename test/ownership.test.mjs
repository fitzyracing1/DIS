import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Discovery, ownershipLines } from '../lib/discovery.mjs';
import { normalizeDiscovery, normalizeConfig } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { Monitor } from '../lib/monitor.mjs';
import { makeGuard } from '../lib/net-guard.mjs';
import { serve, quiet } from './helpers.mjs';

const guard = makeGuard({ allowCidrs: ['127.0.0.0/8'] });
let disTxt = '';
const site = await serve((req, res) => {
  if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
  if (req.url === '/.well-known/dis.txt') { res.writeHead(disTxt ? 200 : 404); return res.end(disTxt); }
  res.writeHead(200); res.end('ok');
});
after(() => site.close());

const cand = (source, key, endpoint) => ({ id: `${source}:${key}`, source, name: key, title: key, project: '', publishedAt: '2026-10-16T00:00:00Z', endpoint, endpointKind: 'homepage', noEndpointReason: null, expectStatus: '200-399' });

function setup(items, over = {}) {
  let now = Date.parse('2026-10-17T12:00:00Z');
  const store = new Store(null);
  const monitor = new Monitor(normalizeConfig({ targets: [{ name: 'mine', url: 'https://example.com' }] }), store, { log: quiet });
  const c = normalizeDiscovery({ enabled: true, perHostMax: 50, ...over }, {});
  c.sources = { fake: true };
  const d = new Discovery(c, store, monitor, { guard, log: quiet, now: () => now, sources: { fake: async () => ({ items, notes: [] }) } });
  return { d, monitor, tick: (ms) => { now += ms; } };
}

test('default: github and npm homepages need an ownership line; mcp does not', () => {
  assert.deepEqual(normalizeDiscovery({}, {}).requireOwnership, ['github', 'npm']);
  assert.deepEqual(normalizeDiscovery({ requireOwnership: [] }, {}).requireOwnership, []);
  assert.deepEqual(ownershipLines({ id: 'github:octo/bot', source: 'github' }), ['github:octo/bot', 'https://github.com/octo/bot']);
  assert.deepEqual(ownershipLines({ id: 'npm:@s/pkg', source: 'npm' }), ['npm:@s/pkg', 'https://www.npmjs.com/package/@s/pkg']);
  assert.deepEqual(ownershipLines({ id: 'mcp:io.x/y', source: 'mcp' }), []);
});

test('no dis.txt line → unverified and not watched; only dis.txt is fetched', async () => {
  disTxt = '';
  const { d, monitor } = setup([cand('github', 'octo/bot', `${site.url}/`), cand('mcp', 'io.x/y', `${site.url}/mcp`)]);
  const before = site.requests.length;
  const s = await d.run({ since: new Date(0) });
  const byId = Object.fromEntries(d.list().map((b) => [b.id, b]));
  assert.equal(byId['github:octo/bot'].state, 'unverified');
  assert.match(byId['github:octo/bot'].reason, /github:octo\/bot/);
  assert.equal(byId['mcp:io.x/y'].state, 'pending', 'mcp is not subject to the ownership rule');
  assert.equal(s.unverified, 1);
  assert.equal(monitor.discovered.size, 1);
  const urls = site.requests.slice(before).map((r) => r.url);
  assert.ok(urls.includes('/.well-known/dis.txt'));
  assert.ok(!urls.includes('/'), 'the homepage itself was not requested');
});

test('matching line (case-insensitive, either form) → watched; removal later stops watching', async () => {
  disTxt = 'something else\nGitHub:Octo/Bot\n';
  const { d, monitor, tick } = setup([cand('github', 'octo/bot', `${site.url}/`)]);
  await d.run({ since: new Date(0) });
  assert.equal(d.list()[0].state, 'pending');
  assert.equal(monitor.discovered.size, 1);
  disTxt = '';
  tick(25 * 3600e3);
  await d.run({ since: new Date(0) });
  assert.equal(d.list()[0].state, 'unverified');
  assert.match(d.list()[0].reason, /stopped watching/);
  assert.equal(monitor.discovered.size, 0);
});

test('unverified bots get another look a day later (and become watched once the line appears)', async () => {
  disTxt = '';
  const { d, monitor, tick } = setup([cand('npm', 'cool-bot', `${site.url}/`)]);
  await d.run({ since: new Date(0) });
  assert.equal(d.list()[0].state, 'unverified');
  disTxt = 'https://www.npmjs.com/package/cool-bot\n';
  await d.run({ since: new Date(0) });
  assert.equal(d.list()[0].state, 'unverified', 'not re-checked within a day');
  tick(25 * 3600e3);
  await d.run({ since: new Date(0) });
  assert.equal(d.list()[0].state, 'pending');
  assert.equal(monitor.discovered.size, 1);
});

test('requireOwnership: [] turns the rule off', async () => {
  disTxt = '';
  const { d } = setup([cand('github', 'octo/open', `${site.url}/`)], { requireOwnership: [] });
  await d.run({ since: new Date(0) });
  assert.equal(d.list()[0].state, 'pending');
});
