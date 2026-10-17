// HTTP server: status page + JSON (+ the optional on-demand check API). Zero dependencies.
//   GET /                  HTML status page
//   GET /status.json       full JSON snapshot (alias: /api/status)
//   GET /lights/:name      one target as JSON;  /lights/:name/LIGHT → "lit" | "dark" | "pending"
//   GET /LIGHT             overall light (lit only when every target is lit)
//   GET /healthz           200 "ok" (the bot itself is alive — use this for Railway/Docker health checks)
//   GET|POST /check        on-demand lit/dark check of any public URL (off unless enabled, see lib/check-api.mjs)
import http from 'node:http';
import { renderPage } from './page.mjs';
import { createCheckApi } from './check-api.mjs';

export function createServer(monitor, { checkApi = createCheckApi() } = {}) {
  return http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      if (res.headersSent) return;
      const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(req.method === 'HEAD' ? undefined : data);
    };
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
    if (path === '/check') {
      try { return await checkApi.handle(req, res, send); } catch (e) { return send(500, { error: 'internal error' }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'method not allowed' });
    if (path === '/healthz') return send(200, 'ok\n', 'text/plain; charset=utf-8');
    const snap = monitor.snapshot();
    if (path === '/') return send(200, renderPage(snap), 'text/html; charset=utf-8');
    if (path === '/status.json' || path === '/api/status') return send(200, snap);
    if (path === '/LIGHT') return send(200, `${snap.light}\n`, 'text/plain; charset=utf-8');
    const m = path.match(/^\/lights\/([^/]+)(\/LIGHT)?$/);
    if (m) {
      const t = snap.targets.find((x) => x.name === decodeURIComponent(m[1]));
      if (!t) return send(404, { error: 'no such target' });
      return m[2] ? send(200, `${t.light}\n`, 'text/plain; charset=utf-8') : send(200, t);
    }
    return send(404, { error: 'not found' });
  });
}
