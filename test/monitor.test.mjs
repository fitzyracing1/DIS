import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { Monitor } from '../lib/monitor.mjs';
import { createServer } from '../lib/server.mjs';
import { serve, quiet } from './helpers.mjs';

let healthy = true;
const site = await serve((req, res) => { res.writeHead(healthy ? 200 : 503); res.end(healthy ? 'all good' : 'down'); });
const hook = await serve((req, res) => { res.writeHead(204); res.end(); });
after(async () => { await site.close(); await hook.close(); });

const cfg = () => normalizeConfig({
  title: 'test status',
  targets: [{ name: 'site', url: site.url, keyword: 'good', timeoutMs: 2000 }],
  alerts: [{ type: 'json', url: hook.url }],
});

test('alerts fire once per state change, state survives a restart', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'dis-')), 'state.json');
  const c = cfg();
  const t = c.targets[0];
  let m = new Monitor(c, new Store(statePath), { log: quiet });
  healthy = true;
  assert.deepEqual((await m.checkTarget(t)).transition, { from: 'pending', to: 'lit' });
  assert.equal(hook.requests.length, 0, 'first-boot lit does not alert');
  healthy = false;
  assert.equal((await m.checkTarget(t)).transition, null, 'first failure is debounced');

  // restart: new Monitor + Store from the same file keeps the failure count
  m = new Monitor(c, new Store(statePath), { log: quiet });
  assert.deepEqual((await m.checkTarget(t)).transition, { from: 'lit', to: 'dark' });
  await m.checkTarget(t);
  assert.equal(hook.requests.length, 1, 'still dark → no second alert');
  assert.equal(JSON.parse(hook.requests[0].body).to, 'dark');
  healthy = true;
  assert.deepEqual((await m.checkTarget(t)).transition, { from: 'dark', to: 'lit' });
  assert.equal(hook.requests.length, 2);
  const snap = m.snapshot();
  assert.equal(snap.light, 'lit');
  assert.equal(snap.targets[0].checks, 5);
  assert.equal(snap.targets[0].uptime.all, 40);
});

test('runOnce retries a failing target up to failThreshold and reports dark', async () => {
  healthy = false;
  site.requests.length = 0;
  const m = new Monitor(cfg(), new Store(null), { log: quiet });
  const snap = await m.runOnce({ retryDelayMs: 10 });
  assert.equal(snap.light, 'dark');
  assert.equal(site.requests.length, 2);
  healthy = true;
  assert.equal((await m.runOnce({ retryDelayMs: 10 })).light, 'lit');
});

test('web page and JSON endpoints', async () => {
  healthy = true;
  const m = new Monitor(cfg(), new Store(null), { log: quiet });
  await m.runOnce({ retryDelayMs: 10 });
  const srv = createServer(m);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /test status/);
    assert.match(html, /All lit/);
    assert.match(html, /DIS/);
    const json = await (await fetch(base + '/status.json')).json();
    assert.equal(json.light, 'lit');
    assert.equal(json.targets[0].name, 'site');
    assert.equal(json.targets[0].uptime.all, 100);
    assert.ok(json.targets[0].lastCheck.at);
    assert.equal((await (await fetch(base + '/api/status')).json()).light, 'lit');
    assert.equal(await (await fetch(base + '/LIGHT')).text(), 'lit\n');
    assert.equal(await (await fetch(base + '/lights/site/LIGHT')).text(), 'lit\n');
    assert.equal((await fetch(base + '/lights/nope')).status, 404);
    assert.equal(await (await fetch(base + '/healthz')).text(), 'ok\n');
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});
