import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { alertPayload, shouldAlert, sendAlerts } from '../lib/alerts.mjs';
import { serve, quiet } from './helpers.mjs';

const ev = { name: 'api', type: 'http', target: 'https://api.test', from: 'lit', to: 'dark', detail: 'HTTP 503', at: '2026-10-17T14:00:00.000Z' };

test('discord payload has content + embed', () => {
  const p = alertPayload('discord', ev, 'my status');
  assert.match(p.content, /○ api went dark/);
  assert.equal(p.embeds[0].title, 'api: dark');
  assert.equal(p.username, 'my status');
});

test('slack payload is {text}', () => {
  assert.deepEqual(Object.keys(alertPayload('slack', ev)), ['text']);
  assert.match(alertPayload('slack', { ...ev, from: 'dark', to: 'lit' }).text, /● api is lit again/);
});

test('generic json payload carries light and bit', () => {
  const p = alertPayload('json', ev);
  assert.equal(p.event, 'state_change');
  assert.equal(p.light, 'dark');
  assert.equal(p.bit, 1);
  assert.equal(p.from, 'lit');
});

test('shouldAlert: skips first-boot lit, honours "on" filter', () => {
  assert.equal(shouldAlert({}, { ...ev, from: 'pending', to: 'lit' }), false);
  assert.equal(shouldAlert({}, { ...ev, from: 'pending', to: 'dark' }), true);
  assert.equal(shouldAlert({ on: ['dark'] }, { ...ev, from: 'dark', to: 'lit' }), false);
});

test('sendAlerts posts JSON to every webhook and survives a failing one', async () => {
  const hook = await serve((req, res) => { res.writeHead(req.url === '/fail' ? 500 : 204); res.end(); });
  after(() => hook.close());
  const out = await sendAlerts([
    { type: 'discord', url: hook.url + '/d' },
    { type: 'slack', url: hook.url + '/s' },
    { type: 'json', url: hook.url + '/fail', headers: { 'x-key': 'k' } },
    { type: 'json', url: 'http://127.0.0.1:1/nope' },
  ], ev, { log: quiet });
  assert.deepEqual(out.map((o) => o.ok), [true, true, false, false]);
  assert.equal(hook.requests.length, 3);
  assert.equal(hook.requests[2].headers['x-key'], 'k');
  assert.equal(JSON.parse(hook.requests[1].body).text.startsWith('○ api'), true);
});
