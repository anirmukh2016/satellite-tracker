/**
 * passes-ui.js — the "Next Passes" panel.
 *
 * The user picks a location (device location, a click on the globe, or typed
 * coordinates); findPasses() in orbit.js lists the ISS passes over it for the
 * next 30 days (a search of ~50 ms). By default only passes that could be seen with
 * the naked eye are listed, since in a given fortnight there may be none for days;
 * a checkbox shows every pass. Clicking a pass jumps the time bar to its peak.
 */

import { findPasses, compass } from './orbit.js';

const DAYS = 30;                // how far ahead to search
const STEP_SEC = 30;
const PAGE = 6;                 // rows per page; "Show more" adds another page
const UNCERTAIN_AFTER_DAYS = 7; // past this, times are marked approximate (the TLE ages, and a reboost shifts timing)
const ALL_KEY = 'iss.passesShowAll';

let showAll = false;
let limit = PAGE;

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

  $('pp-presets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lat]');
    if (!b) return;
    stopPicking();
    setObserver({ lat: parseFloat(b.dataset.lat), lon: parseFloat(b.dataset.lon) });
  });

  $('pp-clear').addEventListener('click', () => setObserver(null));

  try { showAll = localStorage.getItem(ALL_KEY) === '1'; } catch { /* storage unavailable */ }
  $('pp-all').checked = showAll;
  $('pp-all').addEventListener('change', () => {
    showAll = $('pp-all').checked;
    limit = PAGE;
    try { localStorage.setItem(ALL_KEY, showAll ? '1' : '0'); } catch { /* ignore */ }
    refresh();
  });
  $('pp-more').addEventListener('click', () => { limit += PAGE; refresh(); });

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
  limit = PAGE;
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
  const list = $('pp-list'), more = $('pp-more');
  more.hidden = true;
  if (!observer) { list.innerHTML = ''; say('Set your location to see when the ISS flies over.'); return; }
  say(`${showAll ? 'All passes' : 'Visible passes'} over ${fmtLat(observer.lat)} ${fmtLon(observer.lon)}, next ${DAYS} days`);
  if (!satrec) return;

  let found = [];
  try { found = findPasses(satrec, observer.lat, observer.lon, new Date(), DAYS * 24, { stepSec: STEP_SEC }); }
  catch (e) { console.error('[Passes]', e); }

  const passes = showAll ? found : found.filter(p => p.visible);
  if (!passes.length) {
    list.innerHTML = found.length
      ? `<div class="pp-empty">No passes you could see in the next ${DAYS} days (${found.length} pass${found.length === 1 ? '' : 'es'} above 10°, all in daylight or the ISS's shadow). Tick “Show all passes” to see them.</div>`
      : `<div class="pp-empty">No passes above 10° in the next ${DAYS} days.</div>`;
    return;
  }

  const shown = passes.slice(0, limit);
  more.hidden = passes.length <= shown.length;
  more.textContent = `Show more (${passes.length - shown.length} left)`;

  list.replaceChildren(...shown.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pp-pass';
    const daysAway = (p.peak.time - Date.now()) / 86_400_000;
    const dateOpts = daysAway > 1.5 ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short' };
    const when = (daysAway > UNCERTAIN_AFTER_DAYS ? '≈ ' : '') +
      p.peak.time.toLocaleString([], { ...dateOpts, hour: '2-digit', minute: '2-digit' });
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
