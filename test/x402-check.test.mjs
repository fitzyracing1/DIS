import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckApi } from '../lib/check-api.mjs';
import { createX402Paywall, normalizeX402Network, x402Options } from '../lib/x402-paywall.mjs';
import { createServer } from '../lib/server.mjs';
import { makeGuard } from '../lib/net-guard.mjs';
import { serve } from './helpers.mjs';

const PAY_TO = '0x00000000000000000000000000000000000000A1';
const NETWORK = 'eip155:84532';
const loop = makeGuard({ allowCidrs: ['127.0.0.0/8'] });

const site = await serve((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'text/plain', server: 'dis-test' });
    return res.end('hello lit');
  }
  res.writeHead(404); res.end();
});
after(() => site.close());

const fakeMonitor = { snapshot: () => ({ light: 'lit', counts: { lit: 0, dark: 0, total: 0 }, targets: [], title: 't', generatedAt: '' }) };

function mockFacilitator({ settleOk = true } = {}) {
  const calls = { verify: 0, settle: 0, supported: 0 };
  return {
    calls,
    async getSupported() {
      calls.supported += 1;
      return {
        kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }],
        extensions: ['bazaar'],
        signers: {},
      };
    },
    async verify() {
      calls.verify += 1;
      return { isValid: true, payer: PAY_TO };
    },
    async settle() {
      calls.settle += 1;
      if (!settleOk) return { success: false, errorReason: 'settlement_rejected', transaction: '', network: NETWORK };
      return { success: true, transaction: '0xtestsettle', network: NETWORK, payer: PAY_TO };
    },
  };
}

async function withServer(apiOpts, fn) {
  const srv = createServer(fakeMonitor, { checkApi: createCheckApi(apiOpts) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); }
  finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
}

function b64json(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

test('normalizeX402Network aliases and x402Options defaults', () => {
  assert.equal(normalizeX402Network('base-sepolia'), 'eip155:84532');
  assert.equal(normalizeX402Network('base'), 'eip155:8453');
  assert.equal(normalizeX402Network('eip155:8453'), 'eip155:8453');
  const o = x402Options({});
  assert.equal(o.payTo, '');
  assert.equal(o.network, 'eip155:84532');
  assert.equal(o.price, '$0.01');
  assert.match(o.facilitatorUrl, /x402\.org\/facilitator/);
});

test('free /check works without payment when public', async () => {
  const facilitator = mockFacilitator();
  await withServer({
    public: true,
    guard: loop,
    paywall: createX402Paywall({ payTo: PAY_TO, network: NETWORK, facilitator, syncFacilitatorOnStart: false }),
  }, async (base) => {
    const r = await fetch(`${base}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${site.url}/ok` }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.state, 'lit');
    assert.equal(body.tier, undefined, 'basic tier has no tier field');
    assert.equal(facilitator.calls.verify, 0);
    assert.equal(facilitator.calls.settle, 0);
  });
});

test('paid /check/report returns 402 with PAYMENT-REQUIRED when unpaid', async () => {
  const facilitator = mockFacilitator();
  await withServer({
    public: true,
    guard: loop,
    paywall: createX402Paywall({ payTo: PAY_TO, network: NETWORK, price: '$0.01', facilitator, syncFacilitatorOnStart: false }),
  }, async (base) => {
    const r = await fetch(`${base}/check/report?url=${encodeURIComponent(`${site.url}/ok`)}`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(r.status, 402);
    const requiredHdr = r.headers.get('payment-required');
    assert.ok(requiredHdr, 'PAYMENT-REQUIRED header present');
    const required = JSON.parse(Buffer.from(requiredHdr, 'base64').toString());
    assert.equal(required.x402Version, 2);
    assert.ok(required.accepts?.length >= 1);
    assert.equal(required.accepts[0].network, NETWORK);
    assert.equal(required.accepts[0].payTo, PAY_TO);
    assert.equal(required.accepts[0].amount, '10000', '$0.01 USDC = 10000 atomic units');
    assert.ok(required.extensions?.bazaar, 'Bazaar discovery metadata present');
    assert.equal(facilitator.calls.verify, 0);
    assert.equal(facilitator.calls.settle, 0);
  });
});

test('paid /check/report succeeds with mocked facilitator verify+settle', async () => {
  const facilitator = mockFacilitator();
  await withServer({
    public: true,
    guard: loop,
    paywall: createX402Paywall({ payTo: PAY_TO, network: NETWORK, facilitator, syncFacilitatorOnStart: false }),
  }, async (base) => {
    const unpaid = await fetch(`${base}/check/report?url=${encodeURIComponent(`${site.url}/ok`)}`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(unpaid.status, 402);
    const required = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64').toString());

    const paymentPayload = {
      x402Version: 2,
      accepted: required.accepts[0],
      payload: { authorization: { stub: true } },
      extensions: required.extensions,
    };

    const paid = await fetch(`${base}/check/report?url=${encodeURIComponent(`${site.url}/ok`)}`, {
      headers: {
        accept: 'application/json',
        'payment-signature': b64json(paymentPayload),
      },
    });
    assert.equal(paid.status, 200);
    const body = await paid.json();
    assert.equal(body.state, 'lit');
    assert.equal(body.tier, 'full');
    assert.equal(body.status, 200);
    assert.ok(body.bodyHash?.startsWith('sha256:'));
    assert.equal(body.headers?.server, 'dis-test');
    assert.ok(Array.isArray(body.redirectChain));
    assert.ok(paid.headers.get('payment-response'), 'PAYMENT-RESPONSE after settle');
    assert.equal(facilitator.calls.verify, 1);
    assert.equal(facilitator.calls.settle, 1);
  });
});

test('missing DIS_X402_PAY_TO: /check/report fails safe; free /check still works', async () => {
  await withServer({
    public: true,
    guard: loop,
    paywall: createX402Paywall({ payTo: '', network: NETWORK }),
  }, async (base) => {
    const paid = await fetch(`${base}/check/report?url=${encodeURIComponent(`${site.url}/ok`)}`);
    assert.equal(paid.status, 503);
    assert.match((await paid.json()).error, /DIS_X402_PAY_TO/);

    const free = await fetch(`${base}/check?url=${encodeURIComponent(`${site.url}/ok`)}`);
    assert.equal(free.status, 200);
    assert.equal((await free.json()).state, 'lit');
  });
});

test('createX402Paywall rejects non-address payTo', () => {
  const pw = createX402Paywall({ payTo: 'not-an-address' });
  assert.equal(pw.configured, false);
  assert.match(pw.reason, /0x-prefixed/);
});
