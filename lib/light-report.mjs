// OPTIONAL adapter: mirror each target's light to a light-report server
// (https://github.com/fitzyracing1/light-report). Off unless lightReport.url is set.
//
// light-report API used:  POST {url}/lights/{name}   body {state: "lit"|"dark", source, detail}
//   - first report of a new name returns 201 + {token} once; every later report needs
//     "Authorization: Bearer <token>". We remember the token in the state file.
//   - lights go stale (dark) after the server TTL (24h by default), so we also send a heartbeat.
// Token lookup per light: lightReport.tokens[target] → env LIGHT_TOKEN_<LIGHT_NAME> → env LIGHT_TOKEN
//   → lightReport.token → token saved from an earlier first report.

export function lightName(prefix, targetName) {
  return `${prefix || ''}${targetName}`.slice(0, 100);
}

export function tokenEnvKey(name) {
  return 'LIGHT_TOKEN_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export class LightReporter {
  constructor(cfg, store, { fetchImpl = globalThis.fetch, env = process.env, log = console } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.fetch = fetchImpl;
    this.env = env;
    this.log = log;
    this.warned = new Set();
  }

  token(targetName, name) {
    return this.cfg.tokens?.[targetName] || this.env[tokenEnvKey(name)] || this.env.LIGHT_TOKEN || this.cfg.token || this.store.data.lightReportTokens[name] || '';
  }

  /** Report when the light changed or the heartbeat is due. Returns the server response summary or null. */
  async maybeReport(target, s, { force = false, changed = false, now = Date.now() } = {}) {
    if (s.light === 'pending') return null;
    const hb = (this.cfg.heartbeatMinutes || 15) * 60000;
    const due = !s.lastReportedAt || now - Date.parse(s.lastReportedAt) >= hb;
    if (!force && !changed && !due) return null;
    return this.report(target, s, now);
  }

  async report(target, s, now = Date.now()) {
    const name = lightName(this.cfg.prefix, target.name);
    const token = this.token(target.name, name);
    try {
      const res = await this.fetch(`${this.cfg.url}/lights/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ state: s.light, source: this.cfg.source || 'dis', detail: (s.lastCheck?.detail || '').slice(0, 500) }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        if (!this.warned.has(name)) {
          this.warned.add(name);
          this.log.error(`[dis] light-report adapter: "${name}" already exists and our token is missing or wrong. Set ${tokenEnvKey(name)} or lightReport.tokens["${target.name}"], or change lightReport.prefix.`);
        }
        return { name, ok: false, status: 401 };
      }
      if (!res.ok) { this.log.error(`[dis] light-report adapter: POST ${name} → HTTP ${res.status} ${body.error || ''}`); return { name, ok: false, status: res.status }; }
      if (body.token) {
        this.store.data.lightReportTokens[name] = body.token;
        // Never print the token in CI: GitHub Actions logs of public repos are public.
        const ci = this.env.CI || this.env.GITHUB_ACTIONS;
        this.log.log(`[dis] light-report adapter: claimed light "${name}"; write token saved to the state file` +
          (ci ? ` (not printed in CI; copy it from the state file into secret ${tokenEnvKey(name)} if you need it elsewhere)` : ` (to pin it, set ${tokenEnvKey(name)}=${body.token})`));
      }
      s.lastReportedAt = new Date(now).toISOString();
      return { name, ok: true, status: res.status, light: body.light };
    } catch (e) {
      this.log.error(`[dis] light-report adapter: POST ${name} failed: ${e.message}`);
      return { name, ok: false, error: e.message };
    }
  }
}
