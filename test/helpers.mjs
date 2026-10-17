import http from 'node:http';

/** Start a throwaway HTTP server; handler(req, res, body). Returns { url, port, close, requests }. */
export async function serve(handler) {
  const requests = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  return { url: `http://127.0.0.1:${port}`, port, requests, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

export const quiet = { log() {}, error() {} };
