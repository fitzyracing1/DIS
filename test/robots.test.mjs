import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, RobotsCache } from '../lib/robots.mjs';
import { makeGuard } from '../lib/net-guard.mjs';
import { serve } from './helpers.mjs';

test('star group, longest match, Allow wins ties', () => {
  const g = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/health\nDisallow: /*.json$\n');
  assert.equal(isAllowed(g, '/'), true);
  assert.equal(isAllowed(g, '/private/x'), false);
  assert.equal(isAllowed(g, '/private/health'), true);
  assert.equal(isAllowed(g, '/status.json'), false);
  assert.equal(isAllowed(g, '/status.json?x=1'), true);
});

test('a DIS-specific group overrides *', () => {
  const g = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: DIS\nAllow: /\n');
  assert.equal(isAllowed(g, '/health'), true);
  const g2 = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: GoogleBot\nUser-agent: DIS\nDisallow: /\n');
  assert.equal(isAllowed(g2, '/health'), false, 'grouped user-agent lines share rules');
});

test('empty Disallow allows everything; comments ignored', () => {
  assert.equal(isAllowed(parseRobots('User-agent: * # all\nDisallow:\n'), '/x'), true);
  assert.equal(isAllowed(parseRobots(''), '/x'), true);
});

const loop = makeGuard({ allowCidrs: ['127.0.0.0/8'] });
let mode = 'rules';
const site = await serve((req, res) => {
  if (req.url !== '/robots.txt') { res.writeHead(200); return res.end('ok'); }
  if (mode === 'rules') { res.writeHead(200); return res.end('User-agent: *\nDisallow: /admin\n'); }
  if (mode === '404') { res.writeHead(404); return res.end(); }
  res.writeHead(503); res.end();
});
after(() => site.close());

test('RobotsCache: 2xx rules, 4xx open, 5xx = not allowed for now; cached per origin', async () => {
  let now = 0;
  const rc = new RobotsCache({ guard: loop, now: () => now });
  assert.equal((await rc.check(`${site.url}/health`)).allowed, true);
  assert.equal((await rc.check(`${site.url}/admin/x`)).allowed, false);
  const fetched = site.requests.filter((r) => r.url === '/robots.txt').length;
  await rc.check(`${site.url}/other`);
  assert.equal(site.requests.filter((r) => r.url === '/robots.txt').length, fetched, 'cached');
  mode = '404'; now += 25 * 3600e3;
  assert.equal((await rc.check(`${site.url}/admin`)).allowed, true);
  mode = '503'; now += 25 * 3600e3;
  const r = await rc.check(`${site.url}/health`);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /503/);
  assert.equal(site.requests.at(-1).headers['user-agent'].startsWith('DIS/'), true);
});
