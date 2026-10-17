// Ties checks, state, alerts, light-report and persistence together.
import { runCheck } from './checks.mjs';
import { applyResult, view } from './state.mjs';
import { sendAlerts } from './alerts.mjs';
import { LightReporter } from './light-report.mjs';

export class Monitor {
  constructor(config, store, { fetchImpl = globalThis.fetch, check = runCheck, log = console, env = process.env } = {}) {
    this.config = config;
    this.store = store;
    this.fetch = fetchImpl;
    this.check = check;
    this.log = log;
    this.timers = new Map();
    this.running = new Set();
    this.startedAt = new Date().toISOString();
    store.prune(config.targets.map((t) => t.name));
    this.reporter = config.lightReport ? new LightReporter(config.lightReport, store, { fetchImpl, env, log }) : null;
  }

  /** Run one check for a target and fold it in. Returns { result, transition }. */
  async checkTarget(t, { report = true } = {}) {
    const r = await this.check(t, { fetchImpl: this.fetch });
    const s = this.store.target(t.name);
    const transition = applyResult(s, r, t);
    if (transition) {
      const v = view(t, s);
      const ev = { name: t.name, type: t.type, target: v.target, ...transition, detail: r.detail, at: s.lastCheck.at };
      this.log.log(`[dis] ${t.name}: ${transition.from} → ${transition.to} (${r.detail})`);
      if (this.config.alerts.length) await sendAlerts(this.config.alerts, ev, { fetchImpl: this.fetch, title: this.config.title, log: this.log });
    }
    if (this.reporter && report) await this.reporter.maybeReport(t, s, { changed: !!transition });
    this.save();
    return { result: r, transition };
  }

  save() {
    try { this.store.save(); } catch (e) { this.log.error(`[dis] could not save state: ${e.message}`); }
  }

  /** Long-running mode: check every target on its own interval (first check right away, lightly staggered). */
  start() {
    this.config.targets.forEach((t, i) => {
      const loop = async () => {
        if (!this.running.has(t.name)) {
          this.running.add(t.name);
          try { await this.checkTarget(t); } catch (e) { this.log.error(`[dis] ${t.name}: ${e.stack || e}`); }
          finally { this.running.delete(t.name); }
        }
        if (this.timers.has(t.name)) this.timers.set(t.name, setTimeout(loop, t.intervalSeconds * 1000));
      };
      this.timers.set(t.name, setTimeout(loop, Math.min(i * 250, 5000)));
    });
  }

  stop() {
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
    this.save();
  }

  /**
   * One-shot mode (cron / GitHub Actions): check every target now. A failing target is retried
   * until it reaches failThreshold failures (same debounce as the server), so one blip is not dark.
   */
  async runOnce({ retryDelayMs = 5000 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await Promise.all(this.config.targets.map(async (t) => {
      for (let attempt = 1; ; attempt++) {
        const { result } = await this.checkTarget(t, { report: false });
        const s = this.store.target(t.name);
        if (result.ok || s.light === 'dark' || attempt >= t.failThreshold) break;
        await sleep(retryDelayMs);
      }
      const s = this.store.target(t.name);
      if (this.reporter) await this.reporter.maybeReport(t, s, { force: true });
    }));
    this.save();
    return this.snapshot();
  }

  snapshot() {
    const targets = this.config.targets.map((t) => view(t, this.store.target(t.name)));
    const lit = targets.filter((x) => x.light === 'lit').length;
    const dark = targets.filter((x) => x.light === 'dark').length;
    return {
      title: this.config.title,
      light: dark ? 'dark' : lit === targets.length ? 'lit' : 'pending',
      counts: { lit, dark, pending: targets.length - lit - dark, total: targets.length },
      generatedAt: new Date().toISOString(),
      startedAt: this.startedAt,
      targets,
    };
  }
}
