/**
 * orbit.js — SGP4 propagation and coordinate math, in the browser.
 *
 * A direct port of the original Python propagator (see the v1 branch).
 * SGP4 itself comes from the vendored satellite.js; the frame conversions
 * (GMST, ECI → ECEF → geodetic) are written out here because they are the
 * educational core of the project.
 *
 * Coordinate systems:
 *   ECI  (Earth-Centered Inertial): fixed to the stars; SGP4 outputs this frame.
 *   ECEF (Earth-Centered Earth-Fixed): rotates with Earth; lat/lon/alt live here.
 * GMST (Greenwich Mean Sidereal Time) is the rotation angle linking them.
 */

import { twoline2satrec, propagate as sgp4Propagate, jday } from './vendor/satellite.es.js';

const DEG = Math.PI / 180;
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

/** Build a satellite record from the two TLE lines. */
export function makeSatrec(line1, line2) {
  return twoline2satrec(line1, line2);
}

/** SGP4 → ECI position [km] and velocity [km/s] (TEME frame). */
export function propagate(satrec, date) {
  const { position, velocity } = sgp4Propagate(satrec, date);
  if (!position || !velocity) {
    throw new Error(`SGP4 propagation error code ${satrec.error} at ${date.toISOString()}`);
  }
  return {
    rEci: [position.x, position.y, position.z],
    vEci: [velocity.x, velocity.y, velocity.z],
  };
}

/**
 * Greenwich Mean Sidereal Time in radians, [0, 2π). IAU 1982 model:
 *   θ = 280.46061837° + 360.98564736629° × (JD − J2000)
 */
export function computeGMST(date) {
  const jd = jday(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
                  date.getUTCHours(), date.getUTCMinutes(),
                  date.getUTCSeconds() + date.getUTCMilliseconds() / 1000);
  const d = jd - 2451545.0;
  const thetaDeg = 280.46061837 + 360.98564736629 * d;
  return (((thetaDeg % 360) + 360) % 360) * DEG;
}

/** Rotate ECI → ECEF about the Z axis by GMST. */
export function eciToEcef(r, gmst) {
  const c = Math.cos(gmst), s = Math.sin(gmst);
  return [r[0] * c + r[1] * s, -r[0] * s + r[1] * c, r[2]];
}

/** ECEF → geodetic (WGS84) using Bowring-style iteration. Returns {lat, lon, alt} (deg, deg, km). */
export function ecefToGeodetic([x, y, z]) {
  const a = 6378.137;
  const f = 1 / 298.257223563;
  const e2 = 2 * f - f * f;

  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));

  for (let i = 0; i < 5; i++) {
    const sl = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sl * sl);
    lat = Math.atan2(z + e2 * N * sl, p);
  }

  const sl = Math.sin(lat), cl = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sl * sl);
  let alt;
  if (Math.abs(cl) > 1e-10) {
    alt = p / cl - N;
  } else {
    const b = a * (1 - f);
    alt = Math.abs(z) / Math.abs(sl) - (b * b) / a;
  }
  return { lat: lat / DEG, lon: lon / DEG, alt };
}

/** Complete satellite state at `date` — same shape the old /ws stream sent. */
export function getFullState(satrec, date = new Date()) {
  const { rEci, vEci } = propagate(satrec, date);
  const gmst = computeGMST(date);
  const rEcef = eciToEcef(rEci, gmst);
  const { lat, lon, alt } = ecefToGeodetic(rEcef);
  const speed = Math.hypot(vEci[0], vEci[1], vEci[2]);

  return {
    timestamp: date.toISOString(),
    lat: round(lat, 4),
    lon: round(lon, 4),
    alt_km: round(alt, 2),
    speed_km_s: round(speed, 4),
    r_eci: rEci.map(v => round(v, 2)),
    v_eci: vEci.map(v => round(v, 6)),
    r_ecef: rEcef.map(v => round(v, 2)),
    gmst_rad: round(gmst, 6),
    gmst_deg: round(gmst / DEG, 4),
  };
}

function trailPoint(satrec, date) {
  const { rEci } = propagate(satrec, date);
  const { lat, lon, alt } = ecefToGeodetic(eciToEcef(rEci, computeGMST(date)));
  // `eci` is the inertial position, so the UI can draw the orbit in either frame
  return { lat: round(lat, 3), lon: round(lon, 3), alt_km: round(alt, 2), eci: rEci.map(v => round(v, 1)) };
}

/** Orbit trail around `center`: {past: [...], future: [...]} of {lat, lon, alt_km, eci}. */
export function computeOrbitTrail(satrec, center = new Date(),
                                  pastMinutes = 30, futureMinutes = 30, stepSeconds = 30) {
  const step = stepSeconds * 1000;
  const c = center.getTime();
  const past = [], future = [];

  for (let t = c - pastMinutes * 60_000; t <= c; t += step) {
    try { past.push(trailPoint(satrec, new Date(t))); } catch { /* skip bad point */ }
  }
  for (let t = c + step; t <= c + futureMinutes * 60_000; t += step) {
    try { future.push(trailPoint(satrec, new Date(t))); } catch { /* skip bad point */ }
  }
  return { past, future };
}

// ── Sun, shadow and visibility ───────────────────────────────────────────────

const R_EARTH_KM = 6378.137;

/**
 * Unit vector from Earth towards the Sun in the ECI frame (same axes as SGP4's
 * output). Low-precision Astronomical Almanac formula, good to ~0.01°.
 */
export function sunDirectionEci(date) {
  const jd = jday(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
                  date.getUTCHours(), date.getUTCMinutes(),
                  date.getUTCSeconds() + date.getUTCMilliseconds() / 1000);
  const n = jd - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;                 // mean longitude (deg)
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;         // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;   // ecliptic longitude
  const eps = (23.439 - 4e-7 * n) * DEG;                     // obliquity of the ecliptic
  return [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)];
}

/**
 * Is a point at ECI position `r` (km) inside Earth's shadow? Cylindrical
 * shadow model (ignores penumbra and oblateness — seconds of error for the ISS).
 */
export function isInEarthShadow(r, sunDir) {
  const d = r[0] * sunDir[0] + r[1] * sunDir[1] + r[2] * sunDir[2];
  if (d >= 0) return false;                                   // on the sunward side
  const px = r[0] - d * sunDir[0], py = r[1] - d * sunDir[1], pz = r[2] - d * sunDir[2];
  return Math.hypot(px, py, pz) < R_EARTH_KM;
}

/**
 * Angular radius (radians) of the ground circle from which a satellite at
 * `altKm` is at least `minElevDeg` above the horizon.
 */
export function visibleZoneAngle(altKm, minElevDeg = 10) {
  const el = minElevDeg * DEG;
  return Math.acos(R_EARTH_KM * Math.cos(el) / (R_EARTH_KM + altKm)) - el;
}

/** Epoch of TLE line 1 as a Date (UTC). */
export function tleEpochDate(line1) {
  const s = line1.substring(18, 32).trim();
  const yy = parseInt(s.substring(0, 2), 10);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const day = parseFloat(s.substring(2));
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000);
}

/** Epoch as "YYYY-MM-DD HH:MM:SS UTC" for the TLE panel. */
export function parseTLEEpoch(line1) {
  return tleEpochDate(line1).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

/** Orbital parameters read straight from the TLE text (no propagation). */
export function parseTLEParams(line1, line2) {
  const meanMotion = parseFloat(line2.substring(52, 63));
  return {
    inclination_deg: round(parseFloat(line2.substring(8, 16)), 4),
    raan_deg: round(parseFloat(line2.substring(17, 25)), 4),
    eccentricity: round(parseFloat('0.' + line2.substring(26, 33).trim()), 6),
    mean_motion_rev_per_day: round(meanMotion, 8),
    period_minutes: round(1440 / meanMotion, 2),
  };
}

// ── Orbit health: elements, drag and J2 ─────────────────────────────────────

const MU_KM3_S2 = 398600.4418;     // Earth's gravitational parameter
const J2 = 1.08262668e-3;          // Earth's oblateness coefficient

/** TLE exponent field like " 20179-3" -> 0.20179e-3. */
function parseTLEExp(field) {
  const f = field.trim();
  if (!f) return 0;
  const m = f.match(/^([+-]?)(\d+)([+-]\d)$/);
  if (!m) return NaN;
  return Number(`${m[1]}0.${m[2]}e${m[3]}`);
}

/**
 * The slowly-changing orbital elements of a TLE plus what they imply:
 *   a = (mu / n^2)^(1/3)           semi-major axis from the mean motion
 *   decay_km_per_day               from the fitted drag term (n-dot/2): da/dt = -(2/3) a (n-dot / n)
 * `mean_alt_km` is a minus the Earth's equatorial radius: an average height, not the instantaneous one.
 */
export function tleElements(line1, line2) {
  const n = parseFloat(line2.substring(52, 63));                  // rev/day
  const nRadS = n * 2 * Math.PI / 86400;
  const a = Math.cbrt(MU_KM3_S2 / (nRadS * nRadS));
  const ndot = 2 * parseFloat(line1.substring(33, 43));           // line 1 holds n-dot / 2 (rev/day^2)
  return {
    epoch: tleEpochDate(line1).toISOString(),
    mean_motion: n,
    ndot_rev_day2: ndot,
    bstar: parseTLEExp(line1.substring(53, 61)),
    inclination_deg: parseFloat(line2.substring(8, 16)),
    raan_deg: parseFloat(line2.substring(17, 25)),
    eccentricity: parseFloat('0.' + line2.substring(26, 33).trim()),
    sma_km: a,
    mean_alt_km: a - R_EARTH_KM,
    decay_km_per_day: -(2 / 3) * a * (ndot / n),
  };
}

/** Theoretical J2 drift of the orbit plane (deg/day, negative = westward) for given elements. */
export function j2RaanRate(smaKm, ecc, inclDeg) {
  const n = Math.sqrt(MU_KM3_S2 / smaKm ** 3);                    // rad/s
  const p = smaKm * (1 - ecc * ecc);
  const rate = -1.5 * n * J2 * (R_EARTH_KM / p) ** 2 * Math.cos(inclDeg * DEG);   // rad/s
  return rate / DEG * 86400;
}

// ── Observer passes ──────────────────────────────────────────────────────────

/** WGS84 ECEF position [km] of a ground point. */
export function observerEcef(latDeg, lonDeg, altKm = 0) {
  const a = 6378.137, f = 1 / 298.257223563, e2 = 2 * f - f * f;
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [(N + altKm) * Math.cos(lat) * Math.cos(lon),
          (N + altKm) * Math.cos(lat) * Math.sin(lon),
          (N * (1 - e2) + altKm) * Math.sin(lat)];
}

/**
 * Where a satellite at ECEF position `rEcef` appears from a ground point:
 * azimuth (deg clockwise from north), elevation (deg) and range (km).
 */
export function lookAngles(rEcef, latDeg, lonDeg, altKm = 0) {
  const o = observerEcef(latDeg, lonDeg, altKm);
  const d = [rEcef[0] - o[0], rEcef[1] - o[1], rEcef[2] - o[2]];
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  const east  = -so * d[0] + co * d[1];
  const north = -sl * co * d[0] - sl * so * d[1] + cl * d[2];
  const up    =  cl * co * d[0] + cl * so * d[1] + sl * d[2];
  const range = Math.hypot(east, north, up);
  return {
    az: ((Math.atan2(east, north) / DEG) + 360) % 360,
    el: Math.asin(up / range) / DEG,
    range,
  };
}

/** Sun elevation (deg) at a ground point, from the sun's ECI direction and GMST. */
export function sunElevationAt(latDeg, lonDeg, sunDirEci, gmst) {
  const s = eciToEcef(sunDirEci, gmst);
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  return Math.asin(s[0] * up[0] + s[1] * up[1] + s[2] * up[2]) / DEG;
}

/**
 * Upcoming passes of the satellite over a ground point, found by stepping
 * through time and tracking when it is above the horizon.
 *
 * Each pass: {start, end, peak: {time, el, az}, startAz, endAz, durationS, visible}
 * (times are Dates). Passes whose peak elevation is below `minPeakEl` are skipped.
 * `visible` means that, at some moment above 10° elevation, the ISS was in
 * sunlight while the observer's sky was dark (Sun below −6°) — the naked-eye rule.
 */
export function findPasses(satrec, latDeg, lonDeg, from = new Date(), hours = 48,
                           { stepSec = 15, minPeakEl = 10 } = {}) {
  const passes = [];
  const end = from.getTime() + hours * 3600_000;
  let cur = null;

  for (let t = from.getTime(); t <= end; t += stepSec * 1000) {
    const date = new Date(t);
    let rEci;
    try { ({ rEci } = propagate(satrec, date)); } catch { continue; }
    const gmst = computeGMST(date);
    const la = lookAngles(eciToEcef(rEci, gmst), latDeg, lonDeg);

    if (la.el > 0) {
      if (!cur) cur = { start: date, startAz: la.az, peak: { time: date, el: la.el, az: la.az }, visible: false };
      if (la.el > cur.peak.el) cur.peak = { time: date, el: la.el, az: la.az };
      cur.endAz = la.az; cur.end = date;
      if (la.el >= 10 && !cur.visible) {
        const sun = sunDirectionEci(date);
        if (!isInEarthShadow(rEci, sun) && sunElevationAt(latDeg, lonDeg, sun, gmst) < -6) cur.visible = true;
      }
    } else if (cur) {
      if (cur.peak.el >= minPeakEl) passes.push({ ...cur, durationS: (cur.end - cur.start) / 1000 });
      cur = null;
    }
  }
  if (cur && cur.peak.el >= minPeakEl) passes.push({ ...cur, durationS: (cur.end - cur.start) / 1000 });
  return passes;
}

/** Compass point name for an azimuth in degrees. */
export function compass(az) {
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
    [Math.round(az / 22.5) % 16];
}
