import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, expandEnv, loadConfig } from '../lib/config.mjs';

test('the shipped status.config.json is valid and watches the three services', () => {
  const c = loadConfig('status.config.json', {});
  assert.deepEqual(c.targets.map((t) => t.url), [
    'https://light-report-production.up.railway.app',
    'https://light-report-production.up.railway.app/darks',
    'https://patch-cloud-production.up.railway.app',
  ]);
  assert.equal(c.alerts.length, 0, 'webhooks are disabled when their env vars are unset');
  assert.equal(c.lightReport, null, 'light-report adapter is off when LIGHT_REPORT_URL is unset');
});

test('defaults: 60s interval, 2-failure debounce, 2xx/3xx accepted', () => {
  const c = normalizeConfig({ targets: [{ name: 'a', url: 'https://example.com' }] });
  const t = c.targets[0];
  assert.equal(t.type, 'http');
  assert.equal(t.intervalSeconds, 60);
  assert.equal(t.failThreshold, 2);
  assert.equal(t.expectStatus, '200-399');
});

test('per-target values override defaults', () => {
  const c = normalizeConfig({ defaults: { intervalSeconds: 30 }, targets: [{ name: 'a', url: 'https://x.y', intervalSeconds: 5 }, { name: 'b', type: 'tcp', host: 'h', port: 22 }] });
  assert.equal(c.targets[0].intervalSeconds, 5);
  assert.equal(c.targets[1].intervalSeconds, 30);
});

test('${ENV} expansion and enabling adapters from env', () => {
  assert.equal(expandEnv('a-${X}-${MISSING}', { X: '1' }), 'a-1-');
  const c = normalizeConfig({
    targets: [{ name: 'a', url: 'https://x.y' }],
    alerts: [{ type: 'discord', url: '${HOOK}' }, { type: 'slack', url: '${NOPE}' }],
    lightReport: { url: '${LR}/' },
  }, { HOOK: 'https://discord.test/hook', LR: 'https://lr.test' });
  assert.deepEqual(c.alerts.map((a) => a.type), ['discord']);
  assert.equal(c.lightReport.url, 'https://lr.test');
  assert.equal(c.lightReport.prefix, 'net-');
  assert.equal(c.lightReport.source, 'dis');
});

test('rejects bad configs with readable errors', () => {
  const bad = (cfg, re) => assert.throws(() => normalizeConfig(cfg), re);
  bad({}, /targets/);
  bad({ targets: [{ name: 'a b', url: 'https://x.y' }] }, /name/);
  bad({ targets: [{ name: 'a', url: 'ftp://x.y' }] }, /http or https/);
  bad({ targets: [{ name: 'a', type: 'tcp', host: 'h', port: 70000 }] }, /port/);
  bad({ targets: [{ name: 'a', type: 'dns' }] }, /host/);
  bad({ targets: [{ name: 'a', type: 'ping', host: 'h' }] }, /type/);
  bad({ targets: [{ name: 'a', url: 'https://x.y' }, { name: 'a', url: 'https://x.y' }] }, /duplicate/);
  bad({ targets: [{ name: 'a', url: 'https://x.y', expectStatus: 'ok' }] }, /expectStatus/);
  bad({ targets: [{ name: 'a', url: 'https://x.y', intervalSeconds: 0 }] }, /intervalSeconds/);
  bad({ targets: [{ name: 'a', url: 'https://x.y' }], alerts: [{ type: 'teams', url: 'x' }] }, /alerts\[0\]/);
});
