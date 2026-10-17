import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './helpers.mjs';

const site = await serve((req, res) => { res.writeHead(req.url === '/down' ? 500 : 200); res.end('ok'); });
after(() => site.close());
const dir = mkdtempSync(join(tmpdir(), 'dis-cli-'));
const bin = fileURLToPath(new URL('../bin/dis.mjs', import.meta.url));

function cfgFile(paths) {
  const p = join(dir, `c${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ targets: paths.map((x, i) => ({ name: `t${i}`, url: site.url + x })) }));
  return p;
}
// Async spawn: the fake site lives in this process, so we must not block its event loop.
const run = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => (stdout += d));
  c.stderr.on('data', (d) => (stderr += d));
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('once: exit 0 when all lit', async () => {
  const r = await run(['once', '--config', cfgFile(['/a', '/b']), '--no-state', '--retry-delay', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /● lit — 2\/2 lit/);
});

test('once: exit 1 when anything is dark, writes GitHub step summary', async () => {
  const summary = join(dir, 'summary.md');
  const r = await run(['once', '--config', cfgFile(['/a', '/down']), '--no-state', '--retry-delay', '10'], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /○ dark  t1/);
  assert.match(readFileSync(summary, 'utf8'), /○ 1 dark/);
});

test('once --json prints clean JSON on stdout', async () => {
  const r = await run(['once', '--json', '--config', cfgFile(['/a']), '--no-state']);
  assert.equal(JSON.parse(r.stdout).targets[0].light, 'lit');
});

test('config error: exit 2; DIS_CONFIG_JSON works', async () => {
  assert.equal((await run(['once', '--config', join(dir, 'missing.json')])).status, 2);
  const r = await run(['once', '--no-state'], { DIS_CONFIG_JSON: JSON.stringify({ targets: [{ name: 'x', url: site.url }] }) });
  assert.equal(r.status, 0, r.stderr);
});

test('serve: listens on PORT and serves status.json', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [bin, 'serve', '--config', cfgFile(['/a']), '--no-state'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' } });
  try {
    let snap;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { snap = await (await fetch(`http://127.0.0.1:${port}/status.json`)).json(); if (snap.light === 'lit') break; } catch {}
    }
    assert.equal(snap?.light, 'lit');
  } finally {
    child.kill('SIGTERM');
  }
});
