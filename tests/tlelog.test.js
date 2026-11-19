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
  assert.ok(logToCsv([{ checkedAt: 'a', oldEpoch: 'b', newEpoch: 'c', source: 'celestrak', total_km: 1, along_km: 1, cross_km: 0, radial_km: 0 }]).includes('c,celestrak,1.000'));
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  saveLog(log, mem);
  assert.equal(loadLog(mem).length, 200);
  assert.deepEqual(loadLog({ getItem() { return 'not json'; } }), []);
});

// ── Orbit health ──────────────────────────────────────────────────────────────

const rec = (day, alt, bstar = 2e-4, decay = -0.07, raan = 250) => ({
  epoch: new Date(Date.UTC(2026, 10, 1) + day * 86_400_000).toISOString(),
  mean_alt_km: alt, bstar, decay_km_per_day: decay, raan_deg: raan,
});
/** Eight daily TLEs decaying at 0.07 km/day with a little noise. */
const smooth = () => Array.from({ length: 8 }, (_, i) => rec(i, 420 - 0.07 * i + (i % 2 ? 0.01 : -0.01), 2e-4 * (1 + 0.1 * (i % 3 - 1)), -0.07 * (1 + 0.1 * (i % 2 ? 1 : -1))));

test('tleElements: semi-major axis, altitude and decay rate from a TLE', async () => {
  const { tleElements } = await orb();
  const e = tleElements(L1, L2);
  assert.ok(Math.abs(e.mean_alt_km - 418.4) < 1, `alt ${e.mean_alt_km}`);
  assert.ok(Math.abs(e.bstar - 2.0179e-4) < 1e-9, `bstar ${e.bstar}`);
  assert.ok(Math.abs(e.ndot_rev_day2 - 0.00021722) < 1e-9);
  assert.ok(Math.abs(e.decay_km_per_day - (-0.0635)) < 0.003, `decay ${e.decay_km_per_day}`);   // about -2 km a month
  assert.ok(e.decay_km_per_day < 0, 'orbit shrinks');
});

test('j2RaanRate for the ISS is about -4.95 deg/day', async () => {
  const { tleElements, j2RaanRate } = await orb();
  const e = tleElements(L1, L2);
  assert.ok(Math.abs(j2RaanRate(e.sma_km, e.eccentricity, e.inclination_deg) - (-4.95)) < 0.03);
});

test('appendElements dedupes by epoch, sorts and caps', async () => {
  const { appendElements } = await lib();
  let h = [];
  h = appendElements(h, rec(2, 1)); h = appendElements(h, rec(1, 1)); h = appendElements(h, rec(1, 99));
  assert.equal(h.length, 2);
  assert.ok(h[0].epoch < h[1].epoch, 'sorted');
  for (let i = 0; i < 20; i++) h = appendElements(h, rec(10 + i, 1), 5);
  assert.equal(h.length, 5);
});

test('decayTrend recovers the slope and ignores data before a reboost', async () => {
  const { decayTrend } = await lib();
  const t = decayTrend(smooth());
  assert.ok(Math.abs(t.kmPerDay - (-0.07)) < 0.01, `slope ${t.kmPerDay}`);
  assert.equal(decayTrend(smooth().slice(0, 2)), null, 'needs 3 TLEs');
  assert.equal(decayTrend([rec(0, 420), rec(0.2, 420), rec(0.4, 420)]), null, 'needs a day of span');
  // a +3 km reboost at day 4: only the post-boost TLEs (days 4..9) count
  const h = [...smooth().slice(0, 4), ...Array.from({ length: 6 }, (_, i) => rec(4 + i, 423 - 0.07 * i))];
  const r = decayTrend(h);
  assert.ok(Math.abs(r.kmPerDay - (-0.07)) < 0.01, `post-boost slope ${r.kmPerDay}`);
});

test('findEvents: quiet on a smooth decay, flags a reboost and a drag surge', async () => {
  const { findEvents } = await lib();
  assert.deepEqual(findEvents(smooth()), [], 'no false positives');

  const boosted = [...smooth(), rec(8, 420 - 0.56 + 2.4)];
  const ev = findEvents(boosted);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'reboost');
  assert.ok(Math.abs(ev[0].value - 2.4 - 0.07) < 0.2, `step ${ev[0].value}`);

  const stormy = [...smooth(), rec(8, 419.4, 7e-4, -0.25)];
  const e2 = findEvents(stormy);
  assert.equal(e2.length, 1);
  assert.equal(e2[0].type, 'highdrag');
});

test('observedRaanRate wraps across 0/360 and needs two TLEs far enough apart', async () => {
  const { observedRaanRate } = await lib();
  assert.equal(observedRaanRate([rec(0, 420)]), null);
  assert.equal(observedRaanRate([rec(0, 420, 2e-4, -0.07, 100), rec(0.1, 420, 2e-4, -0.07, 99.5)]), null, 'under 6 h apart');
  const wrap = observedRaanRate([rec(0, 420, 2e-4, -0.07, 2.0), rec(1, 420, 2e-4, -0.07, 357.05)]);
  assert.ok(Math.abs(wrap - (-4.95)) < 1e-6, `wrapped rate ${wrap}`);
});
