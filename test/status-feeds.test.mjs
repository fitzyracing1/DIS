import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkStatus, evalStatuspage, evalGoogle, evalApple, parseFeedBody, clearFeedCache } from '../lib/status-feeds.mjs';
import { runCheck, targetLabel } from '../lib/checks.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { serve } from './helpers.mjs';

const NOW = Date.parse('2026-10-17T21:00:00Z');
const H = 3600_000;

const sp = (indicator, description) => ({ page: { id: 'x', name: 'Acme' }, status: { indicator, description } });
const summary = { ...sp('minor', 'Partially Degraded Service'), components: [
  { id: 'abc123', name: 'PROGRAMMABLE MESSAGING', status: 'operational' },
  { id: 'def456', name: 'CARRIER NETWORK', status: 'degraded_performance' },
  { id: 'ghi789', name: 'Voice', status: 'under_maintenance' },
] };
const gIncident = (o) => ({ id: o.id || 'i1', begin: new Date(NOW - 2 * H).toISOString(), end: null, status_impact: 'SERVICE_DISRUPTION',
  external_desc: '**Summary:**\nMessages delayed', affected_products: [{ title: 'Cloud Messaging', id: 'fcm1' }], ...o });
const apple = (events) => ({ drMessage: null, services: [
  { serviceName: 'Siri', redirectUrl: null, events },
  { serviceName: 'Find My', redirectUrl: null, events: [] },
] });
const appleEvent = (o) => ({ messageId: '1', statusType: 'Outage', message: 'Some users are affected', epochStartDate: NOW - H, epochEndDate: null, eventStatus: 'ongoing', ...o });

test('parseFeedBody: plain JSON and a jsonCallback(...) wrapper', () => {
  assert.deepEqual(parseFeedBody('{"a":1}'), { a: 1 });
  assert.deepEqual(parseFeedBody('jsonCallback({"a":[1,2]});\n'), { a: [1, 2] });
  assert.deepEqual(parseFeedBody('\uFEFF  [1]  '), [1]);
  assert.throws(() => parseFeedBody('<html>'));
});

test('statuspage: indicator none is lit, anything else is dark; litIndicators widens it', () => {
  assert.equal(evalStatuspage(sp('none', 'All Systems Operational'), {}).ok, true);
  for (const i of ['minor', 'major', 'critical', 'maintenance']) assert.equal(evalStatuspage(sp(i, 'x'), {}).ok, false, i);
  assert.equal(evalStatuspage(sp('minor', 'x'), { litIndicators: ['none', 'minor'] }).ok, true);
  assert.match(evalStatuspage(sp('major', 'Partial System Outage'), {}).detail, /Partial System Outage \(indicator major\)/);
  assert.equal(evalStatuspage({ page: {} }, {}).ok, false);
});

test('statuspage: component by name (case-insensitive) or id; missing component is dark', () => {
  assert.equal(evalStatuspage(summary, { component: 'programmable messaging' }).ok, true);
  assert.equal(evalStatuspage(summary, { component: 'def456' }).ok, false);
  assert.match(evalStatuspage(summary, { component: 'CARRIER NETWORK' }).detail, /degraded_performance/);
  assert.equal(evalStatuspage(summary, { component: 'Voice' }).ok, false);
  assert.equal(evalStatuspage(summary, { component: 'Voice', litComponentStatuses: ['operational', 'under_maintenance'] }).ok, true);
  assert.match(evalStatuspage(summary, { component: 'Nope' }).detail, /not found/);
  assert.match(evalStatuspage(sp('none', 'ok'), { component: 'X' }).detail, /summary\.json/);
});

test('google: open disruption/outage for the product is dark; ended, future, other products and info notices are lit', () => {
  const t = { product: 'Cloud Messaging' };
  assert.equal(evalGoogle([], t, NOW).ok, true);
  assert.equal(evalGoogle([gIncident({})], t, NOW).ok, false);
  assert.equal(evalGoogle([gIncident({ status_impact: 'SERVICE_OUTAGE' })], t, NOW).ok, false);
  assert.match(evalGoogle([gIncident({})], t, NOW).detail, /SERVICE_DISRUPTION: Summary:/);
  assert.equal(evalGoogle([gIncident({ end: new Date(NOW - H).toISOString() })], t, NOW).ok, true, 'ended');
  assert.equal(evalGoogle([gIncident({ end: new Date(NOW + H).toISOString() })], t, NOW).ok, false, 'end in the future = still open');
  assert.equal(evalGoogle([gIncident({ begin: new Date(NOW + H).toISOString() })], t, NOW).ok, true, 'not started');
  assert.equal(evalGoogle([gIncident({ affected_products: [{ title: 'Hosting', id: 'h' }] })], t, NOW).ok, true, 'other product');
  assert.equal(evalGoogle([gIncident({})], { product: 'fcm1' }, NOW).ok, false, 'by id');
  const info = evalGoogle([gIncident({ status_impact: 'SERVICE_INFORMATION' })], t, NOW);
  assert.equal(info.ok, true);
  assert.match(info.detail, /informational/);
  assert.equal(evalGoogle([gIncident({ status_impact: 'SERVICE_INFORMATION' })], { ...t, darkOn: ['SERVICE_INFORMATION'] }, NOW).ok, false);
  assert.equal(evalGoogle([gIncident({ affected_products: [{ title: 'Hosting' }] })], {}, NOW).ok, false, 'no product = any product');
  assert.equal(evalGoogle({ nope: 1 }, t, NOW).ok, false);
});

test('apple: an in-progress event for the service is dark; resolved, scheduled and other services are lit', () => {
  const t = { service: 'siri' };
  assert.equal(evalApple(apple([]), t, NOW).ok, true);
  assert.equal(evalApple(apple([appleEvent({})]), t, NOW).ok, false);
  assert.match(evalApple(apple([appleEvent({})]), t, NOW).detail, /Siri: Outage ongoing/);
  assert.equal(evalApple(apple([appleEvent({ eventStatus: 'resolved', epochEndDate: NOW - 1000 })]), t, NOW).ok, true);
  assert.equal(evalApple(apple([appleEvent({ eventStatus: 'completed', statusType: 'Maintenance' })]), t, NOW).ok, true);
  assert.equal(evalApple(apple([appleEvent({ eventStatus: 'upcoming', epochStartDate: NOW + H })]), t, NOW).ok, true);
  assert.equal(evalApple(apple([appleEvent({ eventStatus: '', epochEndDate: NOW - 1000 })]), t, NOW).ok, true, 'ended, no status');
  assert.equal(evalApple(apple([appleEvent({})]), { service: 'Find My' }, NOW).ok, true);
  assert.match(evalApple(apple([]), { service: 'Nope' }, NOW).detail, /not found/);
});

const srv = await serve((req, res) => {
  const json = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (req.url === '/sp/ok') return json(200, sp('none', 'All Systems Operational'));
  if (req.url === '/sp/minor') return json(200, sp('minor', 'Partially Degraded Service'));
  if (req.url === '/sp/summary') return json(200, summary);
  if (req.url === '/apple.js') return json(200, `jsonCallback(${JSON.stringify(apple([appleEvent({ epochStartDate: Date.now() - H })]))});`, 'text/javascript');
  if (req.url === '/google') return json(200, [gIncident({ begin: new Date(Date.now() - H).toISOString() })]);
  if (req.url === '/html') return json(200, '<html>maintenance</html>', 'text/html');
  if (req.url === '/503') return json(503, sp('none', 'ok'));
  if (req.url === '/slow') return setTimeout(() => json(200, sp('none', 'ok')), 300);
  json(404, {});
});
after(() => srv.close());
beforeEach(() => clearFeedCache());

const base = { type: 'status', timeoutMs: 2000, maxLatencyMs: 5000 };

test('checkStatus over HTTP: statuspage, apple JSONP, google incidents, through runCheck', async () => {
  let r = await runCheck({ ...base, format: 'statuspage', url: srv.url + '/sp/ok' });
  assert.equal(r.light, 'lit');
  assert.equal(r.status, 200);
  assert.match(srv.requests.at(-1).headers['user-agent'], /^DIS\/.*github\.com\/fitzyracing1\/DIS/);
  r = await checkStatus({ ...base, format: 'statuspage', url: srv.url + '/sp/minor' });
  assert.equal(r.light, 'dark');
  r = await checkStatus({ ...base, format: 'statuspage', url: srv.url + '/sp/summary', component: 'PROGRAMMABLE MESSAGING' });
  assert.equal(r.light, 'lit');
  r = await checkStatus({ ...base, format: 'apple', url: srv.url + '/apple.js', service: 'Siri' });
  assert.equal(r.light, 'dark');
  r = await checkStatus({ ...base, format: 'apple', url: srv.url + '/apple.js', service: 'Find My' });
  assert.equal(r.light, 'lit');
  r = await checkStatus({ ...base, format: 'google', url: srv.url + '/google', product: 'Cloud Messaging' });
  assert.equal(r.light, 'dark');
});

test('checkStatus: non-2xx, non-JSON, slow feed and network errors are dark', async () => {
  assert.match((await checkStatus({ ...base, format: 'statuspage', url: srv.url + '/503' })).detail, /HTTP 503/);
  assert.match((await checkStatus({ ...base, format: 'statuspage', url: srv.url + '/html' })).detail, /not valid JSON/);
  assert.match((await checkStatus({ ...base, format: 'statuspage', url: srv.url + '/slow', maxLatencyMs: 100 })).detail, /too slow/);
  clearFeedCache();
  assert.match((await checkStatus({ ...base, format: 'statuspage', url: srv.url + '/slow', timeoutMs: 50 })).detail, /timeout/);
  assert.match((await checkStatus({ ...base, format: 'statuspage', url: 'http://127.0.0.1:1/x' })).detail, /request failed/);
});

test('checkStatus: targets sharing one feed URL fetch it once per round', async () => {
  const before = srv.requests.length;
  const ts = ['Siri', 'Find My', 'Siri'].map((service) => ({ ...base, format: 'apple', url: srv.url + '/apple.js', service }));
  const rs = await Promise.all(ts.map((t) => checkStatus(t)));
  assert.deepEqual(rs.map((r) => r.light), ['dark', 'lit', 'dark']);
  await checkStatus(ts[1]);
  assert.equal(srv.requests.length - before, 1);
});

test('config: status targets are validated', () => {
  const cfg = (t) => normalizeConfig({ targets: [{ name: 'x', type: 'status', url: 'https://status.example.com/api/v2/status.json', format: 'statuspage', ...t }] });
  assert.equal(cfg({}).targets[0].type, 'status');
  assert.throws(() => cfg({ format: 'rss' }), /format must be one of statuspage, google, apple/);
  assert.throws(() => cfg({ url: 'ftp://x' }), /http or https/);
  assert.throws(() => cfg({ format: 'apple' }), /needs "service"/);
  assert.throws(() => cfg({ product: 'Gmail' }), /only applies to format google/);
  assert.throws(() => cfg({ format: 'google', component: 'X' }), /only applies to format statuspage/);
  assert.throws(() => cfg({ litIndicators: 'none' }), /array of strings/);
  assert.equal(targetLabel(cfg({ component: 'API' }).targets[0]), 'statuspage https://status.example.com/api/v2/status.json [API]');
});

test('examples/phone-providers.config.json is valid and only uses status feeds', async () => {
  const { readFileSync } = await import('node:fs');
  const c = normalizeConfig(JSON.parse(readFileSync(new URL('../examples/phone-providers.config.json', import.meta.url), 'utf8')), {});
  assert.ok(c.targets.length >= 10);
  assert.ok(c.targets.every((t) => t.type === 'status' && t.url.startsWith('https://') && t.intervalSeconds >= 300));
  assert.equal(c.alerts.length, 0, 'no webhooks without env vars');
});
