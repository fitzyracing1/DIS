import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyResult, uptime, view } from '../lib/state.mjs';
import { emptyTargetState, Store } from '../lib/store.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const t = { name: 'a', type: 'http', url: 'https://x.y', failThreshold: 2, recoverThreshold: 1, intervalSeconds: 60 };
const ok = { ok: true, light: 'lit', ms: 10, detail: 'HTTP 200' };
const bad = { ok: false, light: 'dark', ms: 10, detail: 'HTTP 500' };

test('pending → lit on first success', () => {
  const s = emptyTargetState();
  assert.deepEqual(applyResult(s, ok, t), { from: 'pending', to: 'lit' });
  assert.equal(applyResult(s, ok, t), null);
});

test('debounce: one failure stays lit, the second goes dark, recovery goes lit', () => {
  const s = emptyTargetState();
  applyResult(s, ok, t);
  assert.equal(applyResult(s, bad, t), null);
  assert.equal(s.light, 'lit');
  assert.deepEqual(applyResult(s, bad, t), { from: 'lit', to: 'dark' });
  assert.equal(applyResult(s, bad, t), null, 'no repeat alert while still dark');
  assert.deepEqual(applyResult(s, ok, t), { from: 'dark', to: 'lit' });
});

test('a blip between successes never changes state', () => {
  const s = emptyTargetState();
  applyResult(s, ok, t);
  for (const r of [bad, ok, bad, ok]) assert.equal(applyResult(s, r, t), null);
  assert.equal(s.light, 'lit');
});

test('recoverThreshold 2 needs two successes', () => {
  const t2 = { ...t, recoverThreshold: 2 };
  const s = emptyTargetState();
  applyResult(s, bad, t2); applyResult(s, bad, t2);
  assert.equal(s.light, 'dark');
  assert.equal(applyResult(s, ok, t2), null);
  assert.deepEqual(applyResult(s, ok, t2), { from: 'dark', to: 'lit' });
});

test('uptime: all-time and windowed', () => {
  const s = emptyTargetState();
  const now = Date.now();
  applyResult(s, ok, t, now - 2 * 864e5); // outside 24h
  applyResult(s, bad, t, now - 1000);
  applyResult(s, ok, t, now - 500);
  applyResult(s, ok, t, now);
  assert.equal(uptime(s), 75);
  assert.equal(Math.round(uptime(s, 864e5, now)), 67);
  const v = view(t, s, now);
  assert.equal(v.uptime.all, 75);
  assert.equal(v.light, 'lit');
  assert.equal(v.bit, 0);
});

test('Store persists to disk and reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dis-'));
  const p = join(dir, 'sub', 'state.json');
  const a = new Store(p);
  applyResult(a.target('x'), ok, t);
  a.save();
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).targets.x.light, 'lit');
  const b = new Store(p);
  assert.equal(b.target('x').light, 'lit');
  assert.equal(b.target('x').checks, 1);
  b.prune([]);
  assert.deepEqual(b.data.targets, {});
});
