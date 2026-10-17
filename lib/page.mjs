// The tiny built-in status page. Server-rendered, no JS framework, auto-refreshes.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(iso, now) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const pct = (n) => (n == null ? '—' : `${n.toFixed(n === 100 ? 0 : 2)}%`);

export function renderPage(snap, now = Date.now()) {
  const overall = snap.light === 'lit' ? 'All lit' : snap.light === 'dark' ? `${snap.counts.dark} dark` : 'Checking…';
  const rows = snap.targets.map((t) => `
    <tr class="${esc(t.light)}">
      <td><span class="dot" title="${esc(t.light)}">${t.light === 'lit' ? '●' : t.light === 'dark' ? '○' : '◌'}</span> <b>${esc(t.light)}</b></td>
      <td><b>${esc(t.name)}</b><br><small>${esc(t.type)} · ${esc(t.target)}</small></td>
      <td>${pct(t.uptime['24h'])}<br><small>all: ${pct(t.uptime.all)} · ${t.checks} checks</small></td>
      <td>${esc(ago(t.lastCheck?.at, now))}<br><small>${esc(t.lastCheck?.detail || '')}</small></td>
    </tr>`).join('');
  const disc = snap.discovered || [];
  const dot = (st) => (st === 'lit' ? '●' : st === 'dark' ? '○' : st === 'pending' ? '◌' : '·');
  const discRows = disc.slice(0, 100).map((b) => `
    <tr class="${esc(b.state)}">
      <td><span class="dot">${dot(b.state)}</span> <b>${esc(b.state)}</b></td>
      <td><b>${b.project ? `<a href="${esc(b.project)}" rel="nofollow noopener">${esc(b.name)}</a>` : esc(b.name)}</b><br><small>${esc(b.endpoint || b.reason || '')}</small></td>
      <td>${esc(b.source)}</td>
      <td>${esc(ago(b.firstSeen, now))}<br><small>${esc(b.lastCheck?.detail || (b.state === 'skipped' ? b.reason : '') || '')}</small></td>
    </tr>`).join('');
  const discSection = disc.length ? `
<h2>Discovered bots <small>(${disc.length}; not part of the overall light)</small></h2>
<table><thead><tr><th>State</th><th>Bot</th><th>Source</th><th>First seen</th></tr></thead><tbody>${discRows}</tbody></table>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${esc(overall)} · ${esc(snap.title)} · DIS</title>
<style>
  :root { color-scheme: light dark; --lit:#1fa463; --dark:#888; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
  body { max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: .2rem } .sub { color: #888; margin-top: 0 }
  .banner { padding: .8rem 1rem; border-radius: 8px; font-weight: 600; margin: 1rem 0; }
  .banner.lit { background: color-mix(in srgb, var(--lit) 18%, transparent); }
  .banner.dark { background: color-mix(in srgb, #000 18%, transparent); }
  .banner.pending { background: color-mix(in srgb, #888 15%, transparent); }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: .6rem .4rem; border-bottom: 1px solid #8884; vertical-align: top; }
  small { color: #888; } .lit .dot { color: var(--lit) } .dark .dot { color: var(--dark) } .dot { font-size: 1.2rem }
  h2 { font-size: 1.1rem; margin-top: 2rem } h2 small { font-weight: normal }
  footer { color: #888; margin-top: 1.5rem; font-size: .85rem } a { color: inherit }
</style></head><body>
<h1>${esc(snap.title)}</h1>
<p class="sub">lit = up and healthy · dark = down, erroring or too slow</p>
<div class="banner ${esc(snap.light)}">${snap.light === 'lit' ? '●' : snap.light === 'dark' ? '○' : '◌'} ${esc(overall)} — ${snap.counts.lit}/${snap.counts.total} lit</div>
<table><thead><tr><th>Light</th><th>Target</th><th>Uptime 24h</th><th>Last check</th></tr></thead><tbody>${rows}</tbody></table>${discSection}
<footer>Updated ${esc(snap.generatedAt)} · <a href="/status.json">status.json</a> ·${disc.length ? ' <a href="/discovered.json">discovered.json</a> ·' : ''} powered by <a href="https://github.com/fitzyracing1/DIS">DIS</a></footer>
</body></html>`;
}
