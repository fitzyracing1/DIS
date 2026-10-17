// The lit/dark state machine with debounce, plus uptime math. Pure functions, easy to test.
import { HISTORY_MAX } from './store.mjs';

/**
 * Fold one check result into a target's state (mutates s). Returns a transition
 * { from, to } when the confirmed light changes, else null.
 *  - lit → dark only after failThreshold consecutive failures (default 2)
 *  - dark → lit after recoverThreshold consecutive successes (default 1)
 *  - pending (never checked) → lit on the first success; → dark after failThreshold failures
 */
export function applyResult(s, r, t, now = Date.now()) {
  const failThreshold = t.failThreshold ?? 2;
  const recoverThreshold = t.recoverThreshold ?? 1;
  s.checks += 1;
  if (r.ok) { s.okChecks += 1; s.consecutiveOk += 1; s.consecutiveFail = 0; }
  else { s.consecutiveFail += 1; s.consecutiveOk = 0; }
  s.lastCheck = { at: new Date(now).toISOString(), ok: r.ok, light: r.light, ms: r.ms, detail: r.detail, status: r.status ?? null };
  s.history.push([now, r.ok ? 1 : 0, r.ms]);
  if (s.history.length > HISTORY_MAX) s.history.splice(0, s.history.length - HISTORY_MAX);

  let to = null;
  if (r.ok && s.light !== 'lit' && (s.light === 'pending' || s.consecutiveOk >= recoverThreshold)) to = 'lit';
  if (!r.ok && s.light !== 'dark' && s.consecutiveFail >= failThreshold) to = 'dark';
  if (!to) return null;
  const from = s.light;
  s.light = to;
  s.since = s.lastCheck.at;
  s.lastChange = { from, to, at: s.lastCheck.at, detail: r.detail };
  return { from, to };
}

export function uptime(s, windowMs = null, now = Date.now()) {
  if (windowMs == null) return s.checks ? (100 * s.okChecks) / s.checks : null;
  const recent = s.history.filter(([t]) => t >= now - windowMs);
  if (!recent.length) return null;
  return (100 * recent.filter(([, ok]) => ok).length) / recent.length;
}

export const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/** Public view of one target for the JSON API and the page. */
export function view(t, s, now = Date.now()) {
  return {
    name: t.name,
    type: t.type,
    target: t.type === 'http' ? t.url : t.type === 'tcp' ? `${t.host}:${t.port}` : `${t.recordType} ${t.host}`,
    light: s.light,
    bit: s.light === 'lit' ? 0 : s.light === 'dark' ? 1 : null,
    since: s.since,
    lastCheck: s.lastCheck,
    intervalSeconds: t.intervalSeconds,
    uptime: { all: round2(uptime(s, null, now)), '24h': round2(uptime(s, 864e5, now)) },
    checks: s.checks,
    consecutiveFail: s.consecutiveFail,
    lastChange: s.lastChange,
  };
}
