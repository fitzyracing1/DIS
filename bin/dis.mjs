#!/usr/bin/env node
// DIS — lit/dark status bot.
//   dis serve      long-running: checks on intervals, web page + JSON on $PORT (default)
//   dis once       one-shot (cron / GitHub Actions): check everything, exit 0 all lit, 1 any dark
//   dis validate   check the config file and print the targets
// Options: --config <file>  --state <file>  --port <n>  --json  --retry-delay <ms>  --no-state
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, normalizeConfig } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { Monitor } from '../lib/monitor.mjs';
import { createServer } from '../lib/server.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const VALUE_OPTS = ['--config', '--state', '--port', '--retry-delay'];
const cmd = argv.find((a, i) => !a.startsWith('-') && !VALUE_OPTS.includes(argv[i - 1])) || 'serve';

if (flag('help') || flag('h') || cmd === 'help') {
  console.log(`dis — lit (up) / dark (down) checks for your sites

  dis serve      run forever; web page + JSON on $PORT (default 8080)
  dis once       check everything once; exit 0 = all lit, 1 = something dark, 2 = config error
  dis validate   check the config and list targets

  --config <file>       config file (default $DIS_CONFIG or ./status.config.json)
                        or put the whole JSON in $DIS_CONFIG_JSON
  --state <file>        state file (default $DIS_STATE or $DATA_DIR/state.json or ./data/state.json)
  --no-state            keep state in memory only
  --port <n>            port for serve (default $PORT or 8080)
  --json                once: print the JSON snapshot instead of a table
  --retry-delay <ms>    once: wait between retries of a failing target (default 5000)`);
  process.exit(0);
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
  process.exit(0);
}

const store = new Store(statePath);
// In one-shot mode keep stdout clean (table or --json); progress logs go to stderr.
const log = cmd === 'once' ? { log: (...a) => console.error(...a), error: (...a) => console.error(...a) } : console;
const monitor = new Monitor(config, store, { log });

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
const server = createServer(monitor);
server.listen(port, host, () => {
  console.log(`[dis] ${config.targets.length} target(s); page on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  state: ${statePath || 'memory'}`);
  monitor.start();
});
const shutdown = () => { monitor.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
