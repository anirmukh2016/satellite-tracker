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
  const head = 'checked_at_utc,old_epoch_utc,new_epoch_utc,source,total_km,along_km,cross_km,radial_km,new_alt_km,bstar';
  const f = (x) => x.toFixed(3);
  return [head, ...log.map(e => [e.checkedAt, e.oldEpoch, e.newEpoch, e.source || '',
    f(e.total_km), f(e.along_km), f(e.cross_km), f(e.radial_km),
    e.new_alt_km == null ? '' : f(e.new_alt_km), e.bstar == null ? '' : e.bstar.toExponential(4)].join(','))].join('\n') + '\n';
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

// ── Orbit health: element history, decay trend, events, plane drift ─────────
// A "record" is what tleElements() in orbit.js returns for one TLE, plus `source`.
// The history holds one record per distinct TLE epoch, oldest first.

const HIST_KEY = 'iss.elementHistory';
const MAX_HISTORY = 2000;

export const REBOOST_ALT_KM = 0.5;       // altitude step up between consecutive TLEs
export const HIGH_DRAG_FACTOR = 2;       // drag term / B* this many times its recent median
export const HIGH_DRAG_MIN_KM_DAY = 0.05; // ...and at least this fast a decay (ignore noise when drag is tiny)

/** Insert a record in epoch order; a record with an epoch already present is ignored. Returns a new array. */
export function appendElements(history, rec, max = MAX_HISTORY) {
  if (history.some(r => r.epoch === rec.epoch)) return history;
  return [...history, rec].sort((a, b) => a.epoch < b.epoch ? -1 : 1).slice(-max);
}

export function loadHistory(s = store()) {
  try { const v = JSON.parse(s.getItem(HIST_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveHistory(h, s = store()) {
  try { s.setItem(HIST_KEY, JSON.stringify(h)); } catch { /* storage unavailable */ }
}

const days = (a, b) => (new Date(b.epoch) - new Date(a.epoch)) / 86_400_000;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Indices where the mean altitude steps up by more than REBOOST_ALT_KM from the previous TLE. */
function reboostIndices(history) {
  const out = [];
  for (let i = 1; i < history.length; i++) if (history[i].mean_alt_km - history[i - 1].mean_alt_km > REBOOST_ALT_KM) out.push(i);
  return out;
}

/**
 * How fast the orbit is shrinking, from the last `n` TLEs (least-squares slope of mean altitude, km/day).
 * Only TLEs after the latest reboost are used, so a burn does not hide the decay. Returns
 * {kmPerDay, count, spanDays} or null when there are fewer than 3 TLEs or they span under a day.
 */
export function decayTrend(history, n = 10) {
  let h = history.slice(-n);
  const b = reboostIndices(h);
  if (b.length) h = h.slice(b[b.length - 1]);
  if (h.length < 3) return null;
  const t0 = new Date(h[0].epoch).getTime();
  const xs = h.map(r => (new Date(r.epoch).getTime() - t0) / 86_400_000), ys = h.map(r => r.mean_alt_km);
  const span = xs[xs.length - 1];
  if (span < 1) return null;
  const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  return { kmPerDay: num / den, count: h.length, spanDays: span };
}

/**
 * Notable changes, newest last: {type: 'reboost'|'highdrag', epoch, detail, value}.
 *  - reboost: mean altitude jumps up by more than REBOOST_ALT_KM between consecutive TLEs
 *  - highdrag: the fitted drag term (or B*) is HIGH_DRAG_FACTOR times the median of up to 10 earlier TLEs
 * Heuristic: both quantities are fitted, noisy values, so treat an event as "worth a look", not proof.
 */
export function findEvents(history) {
  const events = [];
  for (let i = 1; i < history.length; i++) {
    const r = history[i], d = r.mean_alt_km - history[i - 1].mean_alt_km;
    if (d > REBOOST_ALT_KM) events.push({ type: 'reboost', epoch: r.epoch, value: d, detail: `+${d.toFixed(2)} km` });

    const prior = history.slice(Math.max(0, i - 10), i);
    if (prior.length >= 3) {
      const rate = -r.decay_km_per_day, base = median(prior.map(p => -p.decay_km_per_day));
      const bBase = median(prior.map(p => p.bstar));
      const dragUp = rate > HIGH_DRAG_MIN_KM_DAY && base > 0 && rate > HIGH_DRAG_FACTOR * base;
      const bstarUp = bBase > 0 && r.bstar > HIGH_DRAG_FACTOR * bBase;
      if (dragUp || bstarUp) {
        events.push({ type: 'highdrag', epoch: r.epoch, value: rate,
          detail: dragUp ? `decay ${rate.toFixed(3)} km/day vs ${base.toFixed(3)} usual` : `B* ${(r.bstar / bBase).toFixed(1)}x usual` });
      }
    }
  }
  return events;
}

/**
 * Observed drift of the orbit plane (RAAN, deg/day) between the last two TLEs at least
 * `minHours` apart, to compare with the J2 prediction. Returns null if there is no such pair.
 */
export function observedRaanRate(history, minHours = 6) {
  const last = history[history.length - 1];
  if (!last) return null;
  for (let i = history.length - 2; i >= 0; i--) {
    const dt = days(history[i], last);
    if (dt * 24 >= minHours) {
      let d = last.raan_deg - history[i].raan_deg;
      d = ((d + 540) % 360) - 180;                                  // wrap into [-180, 180)
      return d / dt;
    }
  }
  return null;
}
