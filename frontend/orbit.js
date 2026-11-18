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

/**
 * Circle on the Earth's surface bounding what the satellite can see (the
 * horizon circle). Angular radius = acos(Re / (Re + alt)), ~20.3° (~2,260 km) for
 * the ISS. Returns n + 1 {lat, lon} points (first == last) via the spherical
 * destination-point formula.
 */
export function footprintCircle(lat, lon, altKm, n = 90) {
  const Re = 6378.137;
  const ang = Math.acos(Re / (Re + altKm));
  const phi1 = lat * DEG, lam1 = lon * DEG;
  const sinP1 = Math.sin(phi1), cosP1 = Math.cos(phi1);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const brg = (2 * Math.PI * i) / n;
    const sinP2 = sinP1 * Math.cos(ang) + cosP1 * Math.sin(ang) * Math.cos(brg);
    const phi2 = Math.asin(sinP2);
    const lam2 = lam1 + Math.atan2(Math.sin(brg) * Math.sin(ang) * cosP1,
                                   Math.cos(ang) - sinP1 * sinP2);
    pts.push({ lat: phi2 / DEG, lon: ((((lam2 / DEG) + 180) % 360) + 360) % 360 - 180 });
  }
  return pts;
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
