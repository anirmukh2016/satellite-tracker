// Run with: npm test
// Golden values were produced by the original Python propagator (v1 branch).
const test = require('node:test');
const assert = require('node:assert/strict');

const L1 = '1 25544U 98067A   26321.85053418  .00010861  00000+0  20179-3 0  9995';
const L2 = '2 25544  51.6318 259.6690 0007363  37.3950 322.7550 15.49442652595576';
const DATE = new Date('2026-11-18T18:00:00.500Z');

const orbit = () => import('../frontend/orbit.js');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('full state matches the Python reference', async () => {
  const { makeSatrec, getFullState } = await orbit();
  const s = getFullState(makeSatrec(L1, L2), DATE);
  assert.equal(s.timestamp, '2026-11-18T18:00:00.500Z');
  near(s.lat, -15.199, 0.002, 'lat');
  near(s.lon, -84.9312, 0.002, 'lon');
  near(s.alt_km, 419.72, 0.05, 'alt');
  near(s.speed_km_s, 7.6612, 0.001, 'speed');
  near(s.gmst_rad, 5.721101, 1e-5, 'gmst');
  [-2992.75, -5839.24, -1771.4].forEach((v, i) => near(s.r_eci[i], v, 0.1, `r_eci[${i}]`));
  [579.72, -6535.83, -1771.4].forEach((v, i) => near(s.r_ecef[i], v, 0.1, `r_ecef[${i}]`));
});

test('orbit trail matches the Python reference', async () => {
  const { makeSatrec, computeOrbitTrail } = await orbit();
  const t = computeOrbitTrail(makeSatrec(L1, L2), DATE, 1, 1, 30);
  assert.equal(t.past.length, 3);
  assert.equal(t.future.length, 2);
  near(t.past[0].lat, -18.167, 0.005, 'past[0].lat');
  near(t.past[0].lon, -87.299, 0.005, 'past[0].lon');
  near(t.future[1].lat, -12.2, 0.005, 'future[1].lat');
  near(t.future[1].alt_km, 418.62, 0.05, 'future[1].alt');
  // inertial position is carried along, and has the radius implied by the altitude (~6798 km)
  const r = Math.hypot(...t.past[0].eci);
  near(r, 6378.137 + 420.9, 25, 'past[0] |eci| ≈ Earth radius + alt');
});

test('TLE parsing matches the Python reference', async () => {
  const { parseTLEEpoch, parseTLEParams } = await orbit();
  assert.equal(parseTLEEpoch(L1), '2026-11-17 20:24:46 UTC');
  assert.deepEqual(parseTLEParams(L1, L2), {
    inclination_deg: 51.6318, raan_deg: 259.669, eccentricity: 0.000736,
    mean_motion_rev_per_day: 15.49442652, period_minutes: 92.94,
  });
});

test('SGP4 failure surfaces as an error', async () => {
  const { makeSatrec, propagate } = await orbit();
  // 100 years out the ISS orbit has decayed — SGP4 must report an error
  assert.throws(() => propagate(makeSatrec(L1, L2), new Date('2126-01-01T00:00:00Z')));
});

test('footprint circle is a horizon circle around the sub-satellite point', async () => {
  const { footprintCircle } = await orbit();
  const alt = 420;
  const pts = footprintCircle(-15.2, -84.9, alt, 90);
  assert.equal(pts.length, 91);
  const want = Math.acos(6378.137 / (6378.137 + alt));          // ≈ 20.3°
  const D = Math.PI / 180;
  for (const p of pts) {
    const c = Math.sin(p.lat * D) * Math.sin(-15.2 * D) +
              Math.cos(p.lat * D) * Math.cos(-15.2 * D) * Math.cos((p.lon + 84.9) * D);
    near(Math.acos(Math.min(1, c)), want, 1e-9, 'angular distance from centre');
  }
  near(want / D, 20.3, 0.1, 'horizon angle at 420 km');
  near(pts[0].lat, pts[90].lat, 1e-9, 'closed loop');
});

test('ground track covers one orbit and ends at the sub-satellite point', async () => {
  const { makeSatrec, computeOrbitTrail, getFullState } = await orbit();
  const sat = makeSatrec(L1, L2);
  const g = computeOrbitTrail(sat, DATE, 46, 46, 60);
  assert.equal(g.past.length, 47);
  assert.equal(g.future.length, 46);
  [...g.past, ...g.future].forEach(p => assert.ok(Math.abs(p.lat) <= 52));
  const now = getFullState(sat, DATE);
  near(g.past[46].lat, now.lat, 0.01, 'last past point lat');
  near(g.past[46].lon, now.lon, 0.01, 'last past point lon');
});
