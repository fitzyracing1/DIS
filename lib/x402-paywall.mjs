// x402 paywall for the paid /check/report route.
// Uses the official @x402/{core,evm,extensions} server SDK against a facilitator
// (verify + settle). Config is env-only; nothing is hard-coded as a real wallet.
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar';

const NETWORK_ALIASES = Object.freeze({
  'base-sepolia': 'eip155:84532',
  basesepolia: 'eip155:84532',
  'eip155:84532': 'eip155:84532',
  base: 'eip155:8453',
  'base-mainnet': 'eip155:8453',
  'eip155:8453': 'eip155:8453',
});

const REPORT_DESCRIPTION = 'Full lit/dark check report for a public URL (headers, redirects, body hash)';

const INPUT_SCHEMA = {
  properties: {
    url: { type: 'string', description: 'Public http(s) URL, host:port for tcp, or hostname for dns' },
    type: { type: 'string', description: 'Check type: http (default), tcp, or dns' },
    expect: { type: 'string', description: 'Expected HTTP status matcher or DNS substring' },
    maxMs: { type: 'number', description: 'Latency budget in ms (default 5000, capped at 10000)' },
    keyword: { type: 'string', description: 'Substring the HTTP body must contain' },
    method: { type: 'string', description: 'HTTP method: GET or HEAD' },
    host: { type: 'string', description: 'Hostname for tcp/dns checks' },
    port: { type: 'number', description: 'TCP port (1-65535)' },
    recordType: { type: 'string', description: 'DNS record type: A, AAAA, CNAME, MX, TXT, NS' },
  },
  required: ['url'],
};

const OUTPUT_EXAMPLE = {
  state: 'lit',
  bit: 0,
  tier: 'full',
  type: 'http',
  target: 'https://example.com/',
  status: 200,
  ms: 42,
  detail: 'HTTP 200 in 42ms',
  checkedAt: '2026-11-17T00:00:00.000Z',
  redirects: 0,
  redirectChain: [],
  finalUrl: 'https://example.com/',
  bytes: 1256,
  truncated: false,
  contentType: 'text/html',
  bodyHash: 'sha256:…',
  headers: { 'content-type': 'text/html' },
};

function headerValue(headers, name) {
  const v = headers[name] ?? headers[String(name).toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Map friendly names (base-sepolia, base) to CAIP-2; pass through already-CAIP values. */
export function normalizeX402Network(raw) {
  const key = String(raw || 'eip155:84532').trim().toLowerCase();
  if (NETWORK_ALIASES[key]) return NETWORK_ALIASES[key];
  if (/^eip155:\d+$/i.test(String(raw).trim())) return String(raw).trim();
  return NETWORK_ALIASES[key] || String(raw || 'eip155:84532').trim();
}

/** Settings from env. Missing payTo → paid route is not configured (fail closed). */
export function x402Options(env = process.env) {
  const payTo = String(env.DIS_X402_PAY_TO || '').trim();
  return {
    payTo,
    network: normalizeX402Network(env.DIS_X402_NETWORK || 'eip155:84532'),
    price: String(env.DIS_X402_PRICE || '$0.01').trim() || '$0.01',
    facilitatorUrl: String(env.DIS_X402_FACILITATOR_URL || 'https://x402.org/facilitator').trim(),
  };
}

function bazaarExtensions(method) {
  const common = {
    input: { url: 'https://example.com', type: 'http', expect: '200-399', maxMs: 5000 },
    inputSchema: INPUT_SCHEMA,
    output: { example: OUTPUT_EXAMPLE },
  };
  if (method === 'POST') {
    return declareDiscoveryExtension({ ...common, bodyType: 'json' });
  }
  return declareDiscoveryExtension(common);
}

function routeConfig(opts) {
  const accepts = {
    scheme: 'exact',
    price: opts.price,
    network: opts.network,
    payTo: opts.payTo,
  };
  const base = {
    accepts,
    description: REPORT_DESCRIPTION,
    mimeType: 'application/json',
    serviceName: 'DIS check',
    tags: ['status', 'uptime', 'lit-dark', 'http'],
  };
  return {
    'GET /check/report': { ...base, extensions: bazaarExtensions('GET') },
    'POST /check/report': { ...base, extensions: bazaarExtensions('POST') },
  };
}

/** Minimal HTTPAdapter for Node's raw `http.IncomingMessage`. */
export class NodeHttpAdapter {
  constructor(req, { path, url, body, query } = {}) {
    this.req = req;
    this._path = path || new URL(req.url || '/', 'http://x').pathname;
    this._url = url || absoluteRequestUrl(req);
    this._body = body;
    this._query = query || Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams);
  }
  getHeader(name) {
    return headerValue(this.req.headers, String(name).toLowerCase());
  }
  getMethod() { return this.req.method || 'GET'; }
  getPath() { return this._path; }
  getUrl() { return this._url; }
  getAcceptHeader() { return this.getHeader('accept') || ''; }
  getUserAgent() { return this.getHeader('user-agent') || ''; }
  getQueryParams() { return this._query; }
  getQueryParam(name) { return this._query[name]; }
  getBody() { return this._body; }
}

function absoluteRequestUrl(req) {
  const host = headerValue(req.headers, 'host') || 'localhost';
  const proto = headerValue(req.headers, 'x-forwarded-proto') || 'http';
  return `${proto}://${host}${req.url || '/'}`;
}

function writeInstructions(res, send, response) {
  for (const [k, v] of Object.entries(response.headers || {})) {
    if (v != null) res.setHeader(k, String(v));
  }
  const contentType = response.headers?.['Content-Type'] || response.headers?.['content-type'] || 'application/json; charset=utf-8';
  const body = response.body === undefined ? {} : response.body;
  if (response.isHtml || (typeof body === 'string' && String(contentType).includes('text/'))) {
    return send(response.status, typeof body === 'string' ? body : String(body ?? ''), contentType);
  }
  return send(response.status, body, contentType);
}

/**
 * Build the paywall. Returns { configured, reason, network, price, payTo, protect }.
 * protect(req, res, send, run) → runs `run()` only after verify; settles on success.
 * Inject `facilitator` (FacilitatorClient) for tests.
 */
export function createX402Paywall(opts = {}) {
  const o = { ...x402Options({}), ...opts };
  const configured = Boolean(o.payTo) && /^0x[a-fA-F0-9]{40}$/.test(o.payTo);
  const reason = !o.payTo
    ? 'paid /check/report is off; set DIS_X402_PAY_TO to an EVM receiving address'
    : !/^0x[a-fA-F0-9]{40}$/.test(o.payTo)
      ? 'DIS_X402_PAY_TO must be a 0x-prefixed 20-byte EVM address'
      : '';

  if (!configured) {
    return {
      configured: false,
      reason,
      network: o.network,
      price: o.price,
      payTo: o.payTo,
      async protect(_req, _res, send) {
        return send(503, { error: reason });
      },
    };
  }

  const facilitator = o.facilitator || new HTTPFacilitatorClient({ url: o.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(o.network, new ExactEvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension);

  const httpServer = new x402HTTPResourceServer(resourceServer, routeConfig(o));
  // Always initialize ourselves: prepareHttpServer's init() is a no-op when
  // syncFacilitatorOnStart is false, which breaks deferred/test setups.
  let initPromise = null;
  const ensureInit = () => {
    if (!initPromise) {
      initPromise = httpServer.initialize().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  };
  if (o.syncFacilitatorOnStart !== false) {
    ensureInit().catch(() => {}); // retry on first protected request
  }

  async function protect(req, res, send, run, { path = '/check/report', body, query } = {}) {
    try {
      await ensureInit();
    } catch (e) {
      return send(502, { error: `x402 facilitator unavailable: ${e?.message || e}` });
    }

    const adapter = new NodeHttpAdapter(req, { path, body, query, url: absoluteRequestUrl(req) });
    const paymentHeader = adapter.getHeader('payment-signature') || adapter.getHeader('x-payment');
    const context = {
      adapter,
      path,
      decodedPath: path,
      method: req.method || 'GET',
      paymentHeader: paymentHeader || undefined,
    };

    let result;
    try {
      result = await httpServer.processHTTPRequest(context);
    } catch (e) {
      return send(502, { error: `x402 payment processing failed: ${e?.message || e}` });
    }

    if (result.type === 'payment-error') {
      return writeInstructions(res, send, result.response);
    }
    if (result.type === 'no-payment-required') {
      const outcome = await run();
      return send(outcome?.status ?? 200, outcome?.body ?? {});
    }

    // payment-verified: run the handler, settle only on 2xx, then send the body
    const {
      cancellationDispatcher,
      beforeHandlerSettlement,
      paymentPayload,
      paymentRequirements,
      declaredExtensions,
    } = result;

    let outcome;
    try {
      outcome = await run();
    } catch (e) {
      await cancellationDispatcher.cancel({ reason: 'handler_threw', error: e }).catch(() => {});
      throw e;
    }

    const status = outcome?.status ?? 200;
    if (status >= 400) {
      await cancellationDispatcher.cancel({ reason: 'handler_failed', responseStatus: status }).catch(() => {});
      return send(status, outcome?.body ?? { error: 'check failed' });
    }

    try {
      const settleResult = await httpServer.processSettlement(
        paymentPayload,
        paymentRequirements,
        declaredExtensions,
        { request: context },
        undefined,
        beforeHandlerSettlement,
      );
      if (!settleResult.success) {
        // Do not leak the paid body when settlement fails.
        if (settleResult.response) return writeInstructions(res, send, settleResult.response);
        return send(402, { error: settleResult.errorReason || 'settlement failed' });
      }
      if (settleResult.headers) {
        for (const [k, v] of Object.entries(settleResult.headers)) {
          if (v != null) res.setHeader(k, String(v));
        }
      }
    } catch (e) {
      await cancellationDispatcher.cancel({ reason: 'handler_threw', error: e }).catch(() => {});
      return send(502, { error: `x402 settlement failed: ${e?.message || e}` });
    }
    return send(status, outcome?.body ?? {});
  }

  return {
    configured: true,
    reason: '',
    network: o.network,
    price: o.price,
    payTo: o.payTo,
    facilitatorUrl: o.facilitatorUrl,
    protect,
    // test helpers
    _httpServer: httpServer,
    _ensureInit: ensureInit,
  };
}
