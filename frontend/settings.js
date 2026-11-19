/**
 * settings.js — remembered view settings and shareable links.
 *
 * Toggle states, the camera distance and the observer location persist in
 * localStorage. The same things (plus an optional fixed time) travel in the URL
 * hash for sharing: #on=past,future,daynight&t=2026-11-19T04:00:00Z&o=51.5,-0.12
 * The hash wins over saved settings.
 */

const KEY = 'iss.settings';

export const TOGGLES = ['past', 'future', 'daynight', 'zone', 'ground', 'eci', 'ecef'];

export function defaults() {
  return { on: ['past', 'future', 'daynight'], cam: null, observer: null };
}

/** Parse a location hash into {on?, t?, observer?}; unknown or malformed parts are ignored. */
export function decodeHash(hash) {
  const out = {};
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (p.has('on')) out.on = p.get('on').split(',').filter(k => TOGGLES.includes(k));
  if (p.has('t')) { const d = new Date(p.get('t')); if (!isNaN(d)) out.t = d; }
  if (p.has('o')) {
    const [lat, lon] = p.get('o').split(',').map(Number);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.observer = { lat, lon };
  }
  return out;
}

/** Build a hash string. `t` (a Date) is included only when viewing a non-live time. */
export function encodeHash({ on, t, observer }) {
  const p = new URLSearchParams();
  p.set('on', on.join(','));
  if (t) p.set('t', t.toISOString().replace(/\.\d+Z$/, 'Z'));
  if (observer) p.set('o', `${observer.lat.toFixed(3)},${observer.lon.toFixed(3)}`);
  return '#' + p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
}

export function loadSettings(s) {
  try {
    const st = s || globalThis.localStorage;
    return { ...defaults(), ...JSON.parse(st.getItem(KEY)) };
  } catch { return defaults(); }
}

export function saveSettings(settings, s) {
  try { (s || globalThis.localStorage).setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}
