const test = require('node:test');
const assert = require('node:assert/strict');

const L1 = '1 25544U 98067A   26321.85053418  .00010861  00000+0  20179-3 0  9995';
const L2 = '2 25544  51.6318 259.6690 0007363  37.3950 322.7550 15.49442652595576';
// Same orbit with a slightly different mean motion (as after a refresh)
const L2b = '2 25544  51.6318 259.6690 0007363  37.3950 322.7550 15.49452652595576';

const lib = () => import('../frontend/tlelog.js');
const orb = () => import('../frontend/orbit.js');

test('identical TLEs have zero drift', async () => {
  const { tleDrift } = await lib(); const { makeSatrec } = await orb();
  const d = tleDrift(makeSatrec(L1, L2), makeSatrec(L1, L2), new Date('2026-11-19T00:00:00Z'));
  assert.ok(d.total_km < 1e-9);
});

test('a mean-motion change shows up mostly as along-track drift', async () => {
  const { tleDrift } = await lib(); const { makeSatrec } = await orb();
  const d = tleDrift(makeSatrec(L1, L2), makeSatrec(L1, L2b), new Date('2026-11-21T00:00:00Z'));
  assert.ok(d.total_km > 1, `drift ${d.total_km}`);
  assert.ok(Math.abs(d.along_km) > 0.9 * d.total_km, 'along-track dominates');
  assert.ok(Math.abs(Math.hypot(d.along_km, d.cross_km, d.radial_km) - d.total_km) < 1e-6, 'components add up');
});

test('log helpers: cap, CSV and storage round-trip', async () => {
  const { appendEntry, logToCsv, loadLog, saveLog } = await lib();
  let log = [];
  for (let i = 0; i < 250; i++) log = appendEntry(log, { checkedAt: 'a', oldEpoch: 'b', newEpoch: 'c', total_km: i, along_km: i, cross_km: 0, radial_km: 0 });
  assert.equal(log.length, 200);
  assert.equal(log[0].total_km, 50);
  assert.equal(logToCsv(log.slice(0, 2)).split('\n').length, 4);
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  saveLog(log, mem);
  assert.equal(loadLog(mem).length, 200);
  assert.deepEqual(loadLog({ getItem() { return 'not json'; } }), []);
});
