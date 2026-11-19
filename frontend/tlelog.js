/**
 * tlelog.js — how far the ISS jumps when a fresh TLE replaces the old one.
 *
 * Between refreshes the tracker keeps propagating the old TLE. When a new one
 * arrives, comparing both at the same instant shows the error the old one had
 * built up. The difference is split into radial / along-track / cross-track
 * parts (the orbit's own axes), because for the ISS nearly all of it is along-track.
 * Pure functions plus a small localStorage-backed log.
 */

import { propagate } from './orbit.js';

const MAX_ENTRIES = 200;
const LOG_KEY = 'iss.tleLog';
const LAST_KEY = 'iss.lastTle';

/** Position difference (new − old) at `date`, in km, split along the orbit's axes. */
export function tleDrift(oldSat, newSat, date) {
  const a = propagate(oldSat, date), b = propagate(newSat, date);
  const d = [b.rEci[0] - a.rEci[0], b.rEci[1] - a.rEci[1], b.rEci[2] - a.rEci[2]];
  const r = b.rEci, v = b.vEci;
  const rn = Math.hypot(...r);
  const R = r.map(x => x / rn);                                           // radial
  const n = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const nn = Math.hypot(...n);
  const N = n.map(x => x / nn);                                           // cross-track
  const T = [N[1] * R[2] - N[2] * R[1], N[2] * R[0] - N[0] * R[2], N[0] * R[1] - N[1] * R[0]];  // along-track
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  return { total_km: Math.hypot(...d), along_km: dot(d, T), cross_km: dot(d, N), radial_km: dot(d, R) };
}

/** Add an entry, keeping only the newest MAX_ENTRIES. Returns a new array. */
export function appendEntry(log, entry, max = MAX_ENTRIES) {
  return [...log, entry].slice(-max);
}

export function logToCsv(log) {
  const head = 'checked_at_utc,old_epoch_utc,new_epoch_utc,total_km,along_km,cross_km,radial_km';
  const f = (x) => x.toFixed(3);
  return [head, ...log.map(e => [e.checkedAt, e.oldEpoch, e.newEpoch,
    f(e.total_km), f(e.along_km), f(e.cross_km), f(e.radial_km)].join(','))].join('\n') + '\n';
}

function store() { try { return globalThis.localStorage || null; } catch { return null; } }

export function loadLog(s = store()) {
  try { const v = JSON.parse(s.getItem(LOG_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveLog(log, s = store()) {
  try { s.setItem(LOG_KEY, JSON.stringify(log)); } catch { /* storage unavailable */ }
}
/** The last TLE seen (possibly in an earlier visit), as {line1, line2}. */
export function loadLastTle(s = store()) {
  try { return JSON.parse(s.getItem(LAST_KEY)); } catch { return null; }
}
export function saveLastTle(tle, s = store()) {
  try { s.setItem(LAST_KEY, JSON.stringify({ line1: tle.line1, line2: tle.line2 })); } catch { /* ignore */ }
}
