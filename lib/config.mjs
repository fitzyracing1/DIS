// Load and validate status.config.json. Zero dependencies.
// Any string may contain ${ENV_VAR}; it is replaced from the environment (missing → empty string).
// An alert or lightReport block whose url ends up empty is simply disabled, so one config works
// everywhere and secrets stay in env vars.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { statusMatcher } from './checks.mjs';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TYPES = ['http', 'tcp', 'dns'];
export const ALERT_TYPES = ['discord', 'slack', 'json'];

export const DEFAULTS = Object.freeze({
  intervalSeconds: 60,
  timeoutMs: 10000,
  maxLatencyMs: 5000,
  failThreshold: 2,
  recoverThreshold: 1,
});

export function expandEnv(value, env = process.env) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => env[k] ?? '');
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
  }
  return value;
}

function posInt(v, field, where) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${where}: ${field} must be a positive number (got ${JSON.stringify(v)})`);
  return n;
}

/** Validate a parsed config object and return a normalized copy. Throws with a readable message. */
export function normalizeConfig(raw, env = process.env) {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const cfg = expandEnv(raw, env);
  const defaults = { ...DEFAULTS, ...(cfg.defaults || {}) };
  for (const k of Object.keys(DEFAULTS)) defaults[k] = posInt(defaults[k], k, 'defaults');

  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) throw new Error('config: "targets" must be a non-empty array');
  const seen = new Set();
  const targets = cfg.targets.map((t, i) => {
    const where = `targets[${i}]${t?.name ? ` (${t.name})` : ''}`;
    if (!t || typeof t !== 'object') throw new Error(`${where}: must be an object`);
    if (!NAME_RE.test(String(t.name || ''))) throw new Error(`${where}: name is required: letters, digits, . _ - (max 64)`);
    if (seen.has(t.name)) throw new Error(`${where}: duplicate name`);
    seen.add(t.name);
    const type = t.type || (t.url ? 'http' : undefined);
    if (!TYPES.includes(type)) throw new Error(`${where}: type must be one of ${TYPES.join(', ')}`);
    const out = { ...defaults, ...t, type };
    for (const k of Object.keys(DEFAULTS)) out[k] = posInt(out[k], k, where);
    if (type === 'http') {
      let u;
      try { u = new URL(t.url); } catch { throw new Error(`${where}: url must be a valid http(s) URL`); }
      if (!/^https?:$/.test(u.protocol)) throw new Error(`${where}: url must be http or https`);
      out.method = String(t.method || 'GET').toUpperCase();
      const es = t.expectStatus ?? '200-399';
      if (!statusMatcher(es)) throw new Error(`${where}: expectStatus must be a code (200), range ("200-299"), class ("2xx") or an array of those`);
      out.expectStatus = es;
      if (t.keyword != null && typeof t.keyword !== 'string') throw new Error(`${where}: keyword must be a string`);
    } else if (type === 'tcp') {
      if (!t.host) throw new Error(`${where}: host is required`);
      const p = Number(t.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`${where}: port must be 1-65535`);
      out.port = p;
    } else if (type === 'dns') {
      if (!t.host) throw new Error(`${where}: host is required`);
      out.recordType = String(t.recordType || 'A').toUpperCase();
      if (!['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].includes(out.recordType)) throw new Error(`${where}: recordType must be A, AAAA, CNAME, MX, TXT or NS`);
    }
    return out;
  });

  const alerts = (cfg.alerts || [])
    .map((a, i) => {
      if (!ALERT_TYPES.includes(a?.type)) throw new Error(`alerts[${i}]: type must be one of ${ALERT_TYPES.join(', ')}`);
      return { ...a };
    })
    .filter((a) => a.url && String(a.url).trim());

  let lightReport = null;
  if (cfg.lightReport && cfg.lightReport.url && String(cfg.lightReport.url).trim()) {
    lightReport = {
      url: String(cfg.lightReport.url).replace(/\/+$/, ''),
      prefix: cfg.lightReport.prefix ?? 'net-',
      heartbeatMinutes: Number(cfg.lightReport.heartbeatMinutes ?? 15),
      tokens: cfg.lightReport.tokens || {},
      token: cfg.lightReport.token || '',
      source: cfg.lightReport.source || 'dis',
    };
  }

  return { title: cfg.title || 'Status', defaults, targets, alerts, lightReport, discovery: normalizeDiscovery(cfg.discovery, env) };
}

export function loadConfig(path = process.env.DIS_CONFIG || 'status.config.json', env = process.env) {
  const file = resolve(path);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new Error(`cannot read config ${file}: ${e.message}`); }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`config ${file} is not valid JSON: ${e.message}`); }
  return { ...normalizeConfig(raw, env), file };
}

const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/**
 * Discovery settings. Off unless discovery.enabled (or env DIS_DISCOVERY=1); the register endpoint is
 * off unless discovery.register (or env DIS_REGISTER=1). Discovered targets never run faster than every 5 minutes.
 */
export function normalizeDiscovery(raw = {}, env = process.env) {
  const d = raw || {};
  const num = (v, def, min, max) => { const n = Number(v ?? def); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : def)); };
  const src = d.sources || {};
  const keywords = Array.isArray(d.keywords) && d.keywords.length ? d.keywords.map(String) : ['bot', 'discord-bot', 'telegram-bot', 'slack-bot', 'mcp-server', 'ai-agent'];
  return {
    enabled: truthy(d.enabled) || truthy(env.DIS_DISCOVERY),
    register: truthy(d.register) || truthy(env.DIS_REGISTER),
    everyMinutes: num(d.everyMinutes, 60, 15, 24 * 60),
    lookbackHours: num(d.lookbackHours, 24, 1, 24 * 7),
    perRunLimit: num(d.perRunLimit, 20, 1, 200),
    maxTargets: num(d.maxTargets, 50, 0, 500),
    maxRecords: num(d.maxRecords, 500, 10, 5000),
    perHostMax: num(d.perHostMax, 3, 1, 50),
    intervalSeconds: num(d.intervalSeconds, 300, 300, 86400),
    keywords,
    sources: {
      github: src.github !== false,
      npm: src.npm !== false,
      pypi: src.pypi !== false,
      mcp: src.mcp !== false,
      topgg: src.topgg !== false, // still needs TOPGG_TOKEN
    },
    githubToken: d.githubToken || env.GITHUB_TOKEN || '',
    topggToken: d.topggToken || env.TOPGG_TOKEN || '',
  };
}
