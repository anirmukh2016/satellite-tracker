const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/tle.js');

const L1 = '1 25544U 98067A   26321.85053418  .00010861  00000+0  20179-3 0  9995';
const L2 = '2 25544  51.6318 259.6690 0007363  37.3950 322.7550 15.49442652595576';

function mockRes() {
  const res = { headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = c => { res.code = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}
const withFetch = async (impl, fn) => {
  const orig = global.fetch; global.fetch = impl;
  const warn = console.warn; console.warn = () => {};
  try { await fn(); } finally { global.fetch = orig; console.warn = warn; }
};
const ok = body => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });

test('serves Celestrak TLE with edge-cache headers', () =>
  withFetch(async () => ok(`ISS (ZARYA)\n${L1}\n${L2}\n`), async () => {
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { name: 'ISS (ZARYA)', line1: L1, line2: L2, source: 'celestrak' });
    assert.match(res.headers['Cache-Control'], /s-maxage=3600/);
  }));

test('falls back to wheretheiss.at when Celestrak fails', () =>
  withFetch(async url => {
    if (url.includes('celestrak')) throw new Error('blocked');
    return ok(JSON.stringify({ header: 'ISS (ZARYA)', line1: L1, line2: L2 }));
  }, async () => {
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.source, 'wheretheiss.at');
  }));

test('returns 502 uncached when every source fails', () =>
  withFetch(async () => { throw new Error('down'); }, async () => {
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.code, 502);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }));

test('rejects malformed TLE data', () =>
  withFetch(async () => ok('ISS\nnot a tle\nstill not\n'), async () => {
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.code, 502);
  }));
