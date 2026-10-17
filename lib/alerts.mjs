// Pluggable webhook alerts. Fired only on a confirmed state change (lit → dark, dark → lit).
// Types: discord, slack, json (generic). Each alert may set "on": ["dark"] to only hear about outages.

export function alertText(ev) {
  const icon = ev.to === 'lit' ? '●' : '○';
  const verb = ev.to === 'lit' ? 'is lit again (up)' : 'went dark (down)';
  return `${icon} ${ev.name} ${verb} — ${ev.target}${ev.detail ? ` — ${ev.detail}` : ''}`;
}

/** Build the request body for one alert type. */
export function alertPayload(type, ev, title = 'DIS') {
  const text = alertText(ev);
  if (type === 'discord') {
    return {
      username: title.slice(0, 80),
      content: text.slice(0, 1900),
      embeds: [{
        title: `${ev.name}: ${ev.to}`,
        description: `${ev.target}\n${ev.detail || ''}`.slice(0, 2000),
        color: ev.to === 'lit' ? 0x2ecc71 : 0x2c2f33,
        timestamp: ev.at,
      }],
    };
  }
  if (type === 'slack') return { text };
  return {
    event: 'state_change',
    name: ev.name,
    type: ev.type,
    target: ev.target,
    from: ev.from,
    to: ev.to,
    light: ev.to,
    bit: ev.to === 'lit' ? 0 : 1,
    detail: ev.detail,
    at: ev.at,
    text,
  };
}

/** Should this transition alert? pending → lit (first boot, all fine) is never worth a ping. */
export function shouldAlert(alert, ev) {
  if (ev.from === 'pending' && ev.to === 'lit') return false;
  if (Array.isArray(alert.on) && !alert.on.includes(ev.to)) return false;
  return true;
}

export async function sendAlerts(alerts, ev, { fetchImpl = globalThis.fetch, title, log = console } = {}) {
  const jobs = alerts.filter((a) => shouldAlert(a, ev)).map(async (a) => {
    try {
      const res = await fetchImpl(a.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(a.headers || {}) },
        body: JSON.stringify(alertPayload(a.type, ev, title)),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) log.error(`[dis] ${a.type} alert for ${ev.name} got HTTP ${res.status}`);
      return { type: a.type, ok: res.ok, status: res.status };
    } catch (e) {
      log.error(`[dis] ${a.type} alert for ${ev.name} failed: ${e.message}`);
      return { type: a.type, ok: false, error: e.message };
    }
  });
  return Promise.all(jobs);
}
