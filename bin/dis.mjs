#!/usr/bin/env node
// DIS — lit/dark status bot.
//   dis serve      long-running: checks on intervals, web page + JSON on $PORT (default)
//   dis once       one-shot (cron / GitHub Actions): check everything, exit 0 all lit, 1 any dark
//   dis validate   check the config file and print the targets
//   dis check <url> one guarded lit/dark check of any URL (no config needed)
//   dis discover   one discovery pass (dry run by default): --since 24h --limit 20 --sources github,npm --check --json --save
// Options: --config <file>  --state <file>  --port <n>  --json  --retry-delay <ms>  --no-state
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, normalizeConfig } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { Monitor } from '../lib/monitor.mjs';
import { createServer } from '../lib/server.mjs';
import { createCheckApi, checkApiOptions, parseCheckRequest, runSafeCheck } from '../lib/check-api.mjs';
import { makeGuard, cidrsFromEnv } from '../lib/net-guard.mjs';
import { Discovery } from '../lib/discovery.mjs';
import { Registrar } from '../lib/register.mjs';
import { checkHttpGuarded } from '../lib/checks.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const VALUE_OPTS = ['--config', '--state', '--port', '--retry-delay', '--type', '--expect', '--max-ms', '--keyword', '--record', '--since', '--limit', '--sources'];
const positionals = argv.filter((a, i) => !a.startsWith('-') && !VALUE_OPTS.includes(argv[i - 1]));
const cmd = positionals[0] || 'serve';

if (flag('help') || flag('h') || cmd === 'help') {
  console.log(`dis — lit (up) / dark (down) checks for your sites

  dis serve      run forever; web page + JSON on $PORT (default 8080)
  dis once       check everything once; exit 0 = all lit, 1 = something dark, 2 = config error
  dis validate   check the config and list targets
  dis check <url> one lit/dark check of any URL; exit 0 = lit, 1 = dark, 2 = bad input
                  --type http|tcp|dns  --expect <status|record>  --max-ms <n>  --keyword <s>
                  --record A|AAAA|...  --json  --allow-private (skip the SSRF guard, local use only)
  dis discover   one discovery pass, printed (dry run: nothing saved unless --save)
                 --since 24h|7d  --limit 20  --sources github,npm,pypi,mcp,topgg  --check  --json  --save

  --config <file>       config file (default $DIS_CONFIG or ./status.config.json)
                        or put the whole JSON in $DIS_CONFIG_JSON
  --state <file>        state file (default $DIS_STATE or $DATA_DIR/state.json or ./data/state.json)
  --no-state            keep state in memory only
  --port <n>            port for serve (default $PORT or 8080)
  --json                once: print the JSON snapshot instead of a table
  --retry-delay <ms>    once: wait between retries of a failing target (default 5000)`);
  process.exit(0);
}

if (cmd === 'check') {
  const target = positionals[1];
  let spec;
  try {
    spec = parseCheckRequest({
      type: opt('type', 'http'),
      url: target,
      expect: opt('expect', undefined),
      maxMs: opt('max-ms', undefined),
      keyword: opt('keyword', undefined),
      recordType: opt('record', undefined),
    });
  } catch (e) {
    console.error(`dis check: ${e.message}\nusage: dis check <url> [--type http|tcp|dns] [--expect 200] [--max-ms 5000] [--json]`);
    process.exit(2);
  }
  // The CLI uses the same SSRF guard as the API, so a bot can shell out to it with untrusted URLs.
  // --allow-private opens every range for an operator checking their own internal hosts.
  const guard = makeGuard({ allowCidrs: flag('allow-private') ? ['0.0.0.0/0', '::/0'] : cidrsFromEnv(process.env.DIS_CHECK_ALLOW_CIDRS) });
  const r = await runSafeCheck(spec, { guard });
  if (flag('json')) console.log(JSON.stringify(r, null, 2));
  else console.log(`${r.state === 'lit' ? '● lit ' : '○ dark'} ${r.target}  ${r.detail}`);
  process.exit(r.state === 'lit' ? 0 : 1);
}

let config;
try {
  config = process.env.DIS_CONFIG_JSON
    ? normalizeConfig(JSON.parse(process.env.DIS_CONFIG_JSON))
    : loadConfig(opt('config', process.env.DIS_CONFIG || 'status.config.json'));
} catch (e) {
  console.error(`dis: ${e.message}`);
  process.exit(2);
}

const statePath = flag('no-state') ? null
  : opt('state', process.env.DIS_STATE || join(process.env.DATA_DIR || 'data', 'state.json'));

const describe = (t) => (t.type === 'http' ? t.url : t.type === 'tcp' ? `${t.host}:${t.port}` : `${t.recordType} ${t.host}`);

if (cmd === 'validate') {
  console.log(`config ok: ${config.targets.length} target(s), ${config.alerts.length} alert webhook(s) active, light-report ${config.lightReport ? `on → ${config.lightReport.url}` : 'off'}`);
  for (const t of config.targets) console.log(`  ${t.name.padEnd(24)} ${t.type.padEnd(4)} every ${t.intervalSeconds}s  ${describe(t)}`);
  const d = config.discovery;
  console.log(`discovery ${d.enabled ? `on: every ${d.everyMinutes} min, sources ${Object.keys(d.sources).filter((k) => d.sources[k]).join(',')}, max ${d.maxTargets} watched` : 'off'}; register ${d.register ? 'on' : 'off'}`);
  process.exit(0);
}

if (cmd === 'discover') {
  // Dry run by default: in-memory state, nothing written. --save merges into the state file.
  const sinceArg = opt('since', `${config.discovery.lookbackHours}h`);
  const m = String(sinceArg).match(/^(\d+)([hd])$/);
  if (!m) { console.error('dis discover: --since must look like 24h or 7d'); process.exit(2); }
  const since = new Date(Date.now() - Number(m[1]) * (m[2] === 'd' ? 24 : 1) * 3600e3);
  const limit = Number(opt('limit', config.discovery.perRunLimit));
  const only = opt('sources', '') ? opt('sources').split(',').map((s) => s.trim()) : undefined;
  const dstore = flag('save') ? new Store(statePath) : new Store(null);
  const disc = new Discovery({ ...config.discovery, enabled: true }, dstore, null, { log: { log: (...a) => console.error(...a), error: (...a) => console.error(...a) } });
  const summary = await disc.run({ since, limit, only });
  let rows = disc.list().filter((b) => b.firstSeen >= summary.at);
  if (flag('check')) {
    // One polite, guarded GET per watched endpoint, one at a time.
    for (const b of rows) {
      if (b.state !== 'pending') continue;
      const rec = disc.bots[b.id];
      const r = await checkHttpGuarded(disc.targetFor(rec));
      b.state = r.light;
      b.lastCheck = { at: new Date().toISOString(), detail: r.detail, status: r.status ?? null };
    }
  }
  if (flag('save')) dstore.save();
  if (flag('json')) console.log(JSON.stringify({ summary, bots: rows }, null, 2));
  else {
    for (const b of rows) {
      const st = b.state === 'pending' ? 'watch' : b.state;
      console.log(`${st.padEnd(11)} ${b.source.padEnd(6)} ${String(b.name).slice(0, 40).padEnd(40)} ${b.endpoint || ''}  ${b.lastCheck?.detail || b.reason || ''}`);
    }
    console.log(`\n${summary.found} found since ${summary.since} (limit ${limit} per source): ${summary.watching} watchable, ${summary.noEndpoint} no endpoint, ${summary.unverified} unverified (no dis.txt ownership line), ${summary.skipped} skipped`);
    for (const n of summary.notes) console.log(`  note: ${n}`);
  }
  process.exit(0);
}

const store = new Store(statePath);
// In one-shot mode keep stdout clean (table or --json); progress logs go to stderr.
const log = cmd === 'once' ? { log: (...a) => console.error(...a), error: (...a) => console.error(...a) } : console;
const monitor = new Monitor(config, store, { log });
const discovery = cmd === 'serve' && (config.discovery.enabled || config.discovery.register) ? new Discovery(config.discovery, store, monitor, { log }) : null;
const registrar = discovery && config.discovery.register
  ? new Registrar(discovery, { trustProxy: process.env.DIS_TRUST_PROXY === '1' || process.env.DIS_TRUST_PROXY === 'true' })
  : null;

if (cmd === 'once') {
  const snap = await monitor.runOnce({ retryDelayMs: Number(opt('retry-delay', 5000)) });
  if (flag('json')) console.log(JSON.stringify(snap, null, 2));
  else {
    for (const t of snap.targets) {
      const icon = t.light === 'lit' ? '●' : '○';
      console.log(`${icon} ${t.light.padEnd(5)} ${t.name.padEnd(24)} ${t.lastCheck?.detail || ''}`);
    }
    console.log(`\n${snap.light === 'lit' ? '● lit' : '○ dark'} — ${snap.counts.lit}/${snap.counts.total} lit`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`## ${snap.light === 'lit' ? '● All lit' : `○ ${snap.counts.dark} dark`} — ${config.title}`, '', '| light | target | detail | uptime (all) |', '|---|---|---|---|',
      ...snap.targets.map((t) => `| ${t.light === 'lit' ? '● lit' : '○ dark'} | ${t.name} | ${(t.lastCheck?.detail || '').replace(/\|/g, '\\|')} | ${t.uptime.all ?? '—'}% |`)].join('\n');
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch {}
  }
  process.exit(snap.light === 'lit' ? 0 : 1);
}

if (cmd !== 'serve') { console.error(`dis: unknown command "${cmd}" (try --help)`); process.exit(2); }

const port = Number(opt('port', process.env.PORT || 8080));
const host = process.env.HOST || '0.0.0.0';
const checkApi = createCheckApi(checkApiOptions());
const server = createServer(monitor, { checkApi, registrar });
server.listen(port, host, () => {
  console.log(`[dis] ${config.targets.length} target(s); page on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  state: ${statePath || 'memory'}`);
  console.log(`[dis] check API (/check): ${checkApi.enabled ? (process.env.DIS_API_KEY ? 'on, API key required' : 'on, PUBLIC (DIS_PUBLIC_CHECK=1)') : 'off'}`);
  monitor.start();
  if (discovery) {
    console.log(`[dis] discovery: ${config.discovery.enabled ? `on, every ${config.discovery.everyMinutes} min` : 'sources off'}; register: ${registrar ? 'on' : 'off'}`);
    discovery.start();
  }
});
const shutdown = () => { discovery?.stop(); monitor.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
