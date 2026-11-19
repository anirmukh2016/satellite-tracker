/**
 * passes-ui.js — the "Next Passes" panel.
 *
 * The user picks a location (device location, a click on the globe, or typed
 * coordinates); findPasses() in orbit.js lists the ISS passes over it for the
 * next 48 hours. Clicking a pass jumps the time bar to its peak.
 */

import { findPasses, compass } from './orbit.js';

const HOURS = 48;
const MAX_ROWS = 6;

let hooks = null;      // { onObserver(obs|null), jumpTo(date), requestPick(cb|null) }
let satrec = null;
let observer = null;
let picking = false;

const $ = (id) => document.getElementById(id);

export function initPasses(h) {
  hooks = h;

  $('pp-geo').addEventListener('click', () => {
    if (!navigator.geolocation) { say('This browser cannot share a location. Pick on the globe or type one.'); return; }
    say('Asking for your location…');
    navigator.geolocation.getCurrentPosition(
      (p) => setObserver({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => say('Location unavailable or blocked. Pick on the globe or type coordinates instead.'),
      { timeout: 10_000, maximumAge: 600_000 },
    );
  });

  $('pp-pick').addEventListener('click', () => {
    if (picking) { stopPicking(); return; }
    picking = true;
    $('pp-pick').textContent = 'Click the globe… (Esc)';
    hooks.requestPick((pt) => { stopPicking(); if (pt) setObserver(pt); });
  });

  $('pp-clear').addEventListener('click', () => setObserver(null));

  $('pp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = $('pp-input').value.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
    const lat = m ? Number(m[1]) : NaN, lon = m ? Number(m[2]) : NaN;
    if (!m || Math.abs(lat) > 90 || Math.abs(lon) > 180) { say('Enter latitude and longitude as decimal degrees, e.g. 51.5, -0.12'); return; }
    setObserver({ lat, lon });
    $('pp-input').value = '';
  });
}

function stopPicking() {
  picking = false;
  hooks.requestPick(null);
  $('pp-pick').textContent = 'Pick on globe';
}

export function cancelPicking() { if (picking) stopPicking(); }

export function setSatrec(s) { satrec = s; refresh(); }

export function setObserver(obs) {
  observer = obs;
  hooks.onObserver(obs);
  $('pp-clear').hidden = !obs;
  refresh();
}

function say(text) { $('pp-loc').textContent = text; }

const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`;

function untilText(date) {
  const min = Math.round((date - Date.now()) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `in ${h} h ${min % 60} min` : `in ${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Recompute and redraw the pass list (cheap: ~10k propagations). */
export function refresh() {
  const list = $('pp-list');
  if (!observer) { list.innerHTML = ''; say('Set your location to see when the ISS flies over.'); return; }
  say(`Passes over ${fmtLat(observer.lat)} ${fmtLon(observer.lon)}, next ${HOURS} h`);
  if (!satrec) return;

  let passes = [];
  try { passes = findPasses(satrec, observer.lat, observer.lon, new Date(), HOURS); }
  catch (e) { console.error('[Passes]', e); }

  if (!passes.length) { list.innerHTML = '<div class="pp-empty">No passes above 10° in this window.</div>'; return; }

  list.replaceChildren(...passes.slice(0, MAX_ROWS).map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pp-pass';
    const when = p.peak.time.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const mins = Math.floor(p.durationS / 60), secs = Math.round(p.durationS % 60);
    const hm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    b.classList.add(p.visible ? 'is-visible' : 'not-visible');
    const marker = p.visible
      ? '<span class="pp-vis">★ Visible</span>'
      : '<span class="pp-novis">○ Not visible</span>';
    const why = p.visible
      ? (hm(p.visStart) === hm(p.visEnd) ? `Visible around ${hm(p.visStart)}` : `Visible ${hm(p.visStart)}–${hm(p.visEnd)}`)
      : (p.reason === 'shadow' ? 'ISS in Earth\'s shadow' : 'Sky too bright (daylight)');
    b.innerHTML =
      `<span class="pp-when">${when}</span>${marker}` +
      `<br><span class="pp-dim">${untilText(p.peak.time)} · peak ${Math.round(p.peak.el)}°</span>` +
      `<br><span class="pp-dim">${compass(p.startAz)} → ${compass(p.endAz)} · ${mins}m ${String(secs).padStart(2, '0')}s</span>` +
      `<br><span class="${p.visible ? 'pp-why-yes' : 'pp-dim'}">${why}</span>`;
    b.setAttribute('aria-label', `${when}, ${p.visible ? 'visible' : 'not visible: ' + why}`);
    b.title = 'Jump to the peak of this pass';
    b.addEventListener('click', () => hooks.jumpTo(p.peak.time));
    return b;
  }));
}
