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
  return { lat: round(lat, 3), lon: round(lon, 3), alt_km: round(alt, 2) };
}

/** Orbit trail around `center`: {past: [...], future: [...]} of {lat, lon, alt_km}. */
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
