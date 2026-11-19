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
  // each point carries its time, increasing along the trail (used to place direction arrows)
  assert.ok(t.past[0].t < t.past[1].t && t.past[2].t < t.future[0].t && t.future[0].t < t.future[1].t);
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

const subsolar = async (date) => {
  const { sunDirectionEci, computeGMST } = await orbit();
  const [x, y, z] = sunDirectionEci(date);
  const dec = Math.asin(z) * 180 / Math.PI;
  const ra = Math.atan2(y, x);
  let lon = (ra - computeGMST(date)) * 180 / Math.PI;   // east longitude of the sub-solar point
  lon = ((lon + 540) % 360) - 180;
  return { dec, lon, ra: ((ra * 180 / Math.PI) + 360) % 360 };
};

test('sun direction: equinox and solstice declinations', async () => {
  const eq = await subsolar(new Date('2026-03-20T14:46:00Z'));
  near(eq.dec, 0, 0.1, 'March equinox declination');
  const sol = await subsolar(new Date('2026-06-21T08:24:00Z'));
  near(sol.dec, 23.44, 0.1, 'June solstice declination');
  near(sol.ra, 90, 0.5, 'June solstice right ascension');
});

test('sub-solar point on 18 Nov 2026 18:00 UTC', async () => {
  // Declination ≈ −19.3°; equation of time ≈ +14.9 min → longitude ≈ −93.6°
  const s = await subsolar(new Date('2026-11-18T18:00:00Z'));
  near(s.dec, -19.3, 0.2, 'declination');
  near(s.lon, -93.6, 1.0, 'longitude');
});

test('Earth shadow truth table', async () => {
  const { isInEarthShadow } = await orbit();
  assert.equal(isInEarthShadow([7000, 0, 0], [-1, 0, 0]), true);    // behind Earth
  assert.equal(isInEarthShadow([7000, 0, 0], [1, 0, 0]), false);    // sunward
  assert.equal(isInEarthShadow([0, 7000, 0], [-1, 0, 0]), false);   // beside the shadow cylinder
  assert.equal(isInEarthShadow([-7000, 0, 0], [-1, 0, 0]), false);  // sunward side again
});

test('ISS spends a plausible share of an orbit in eclipse; visibility zone is smaller than the horizon circle', async () => {
  const { makeSatrec, propagate, sunDirectionEci, isInEarthShadow, visibleZoneAngle } = await orbit();
  const sat = makeSatrec(L1, L2);
  let inShadow = 0, total = 0;
  for (let m = 0; m < 93; m++) {
    const d = new Date(DATE.getTime() + m * 60_000);
    inShadow += isInEarthShadow(propagate(sat, d).rEci, sunDirectionEci(d)) ? 1 : 0;
    total++;
  }
  assert.ok(inShadow / total <= 0.4, `eclipse share ${inShadow}/${total}`);
  const horizon = Math.acos(6378.137 / (6378.137 + 420));
  const zone = visibleZoneAngle(420, 10);
  near(zone * 180 / Math.PI, 12.5, 0.5, '10° elevation zone');
  assert.ok(zone < horizon);
});

test('look angles: overhead, horizon and compass directions', async () => {
  const { lookAngles, compass } = await orbit();
  const up = lookAngles([6378.137 + 420, 0, 0], 0, 0);
  near(up.el, 90, 1e-6, 'overhead elevation');
  near(up.range, 420, 1e-6, 'overhead range');
  const north = lookAngles([6378.137 + 420, 0, 800], 0, 0);   // displaced north
  near(north.az, 0, 1e-6, 'north azimuth');
  const east = lookAngles([6378.137 + 420, 800, 0], 0, 0);
  near(east.az, 90, 1e-6, 'east azimuth');
  assert.equal(compass(0), 'N');
  assert.equal(compass(95), 'E');
  assert.equal(compass(359), 'N');
});

test('passes over London in 48 h are well-formed', async () => {
  const { makeSatrec, findPasses, getFullState, lookAngles } = await orbit();
  const sat = makeSatrec(L1, L2);
  const passes = findPasses(sat, 51.5, -0.12, DATE, 48);
  assert.ok(passes.length >= 4 && passes.length <= 14, `pass count ${passes.length}`);
  for (const p of passes) {
    assert.ok(p.start < p.peak.time && p.peak.time < p.end, 'start < peak < end');
    assert.ok(p.peak.el >= 10 && p.peak.el <= 90, 'peak elevation');
    assert.ok(p.durationS > 60 && p.durationS < 720, `duration ${p.durationS}`);
  }
  for (let i = 1; i < passes.length; i++) assert.ok(passes[i].start > passes[i - 1].end, 'sorted, non-overlapping');
  // The reported peak really is above the horizon at that time
  const p = passes[0];
  const s = getFullState(sat, p.peak.time);
  near(lookAngles(s.r_ecef, 51.5, -0.12).el, p.peak.el, 0.01, 'peak elevation reproducible');
});

test('visible passes are dusk or dawn ones: sun below -6 deg, ISS sunlit', async () => {
  const { makeSatrec, findPasses, sunDirectionEci, sunElevationAt, computeGMST, propagate, isInEarthShadow } = await orbit();
  const sat = makeSatrec(L1, L2);
  const passes = findPasses(sat, 40, -100, DATE, 24 * 5);
  const vis = passes.filter(p => p.visible);
  assert.ok(vis.length > 0 && vis.length < passes.length, 'some, but not all, passes are visible');
  for (const p of vis) {
    // At least one instant of the pass satisfies the rule
    let ok = false;
    for (let t = p.start.getTime(); t <= p.end.getTime(); t += 15000) {
      const d = new Date(t), r = propagate(sat, d).rEci, sun = sunDirectionEci(d);
      if (!isInEarthShadow(r, sun) && sunElevationAt(40, -100, sun, computeGMST(d)) < -6) ok = true;
    }
    assert.ok(ok, 'visible pass has a dark-sky, sunlit moment');
  }
});

test('every pass says whether it is visible and why', async () => {
  const { makeSatrec, findPasses } = await orbit();
  const passes = findPasses(makeSatrec(L1, L2), 40, -100, DATE, 24 * 5);
  const vis = passes.filter(p => p.visible), not = passes.filter(p => !p.visible);
  assert.ok(vis.length && not.length, 'both kinds occur');
  for (const p of vis) {
    assert.ok(p.visStart && p.visEnd && p.visStart <= p.visEnd, 'visible window');
    assert.ok(p.visStart >= p.start && p.visEnd <= p.end, 'window inside the pass');
    assert.equal(p.reason, undefined);
  }
  for (const p of not) {
    assert.ok(['daylight', 'shadow'].includes(p.reason), `reason ${p.reason}`);
    assert.equal(p.visStart, undefined);
  }
  assert.ok(not.some(p => p.reason === 'daylight'), 'some daytime passes');
});
