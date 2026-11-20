/**
 * ui.js — HUD panel, TLE display, toggle controls, live tracking loop
 *
 * The ISS position is computed right here in the browser (see orbit.js) from
 * a TLE fetched from /api/tle. Every 2 seconds the fresh state is distributed to:
 *   - HUD: lat, lon, alt, speed, UTC time
 *   - ISS module: position update
 *   - Globe: GMST for Earth rotation
 *   - Frames: GMST for ECEF rotation
 *   - ECI vector display panel
 */

import { updateISSPosition, updateTrails, setTrailsVisible,
         updateGroundTrack, setGroundVisible, setTrackFlow, setISSSunlit,
         setObserverMarker, getISSWorldPosition } from './iss.js';
import { updateEarthRotation, pointCameraAtISS, updateSunLighting, setNightVisible, setZoneVisible,
         recenterOnISS, getCameraDistance, setCameraDistance, getControls, pickEarth, isHiddenByEarth } from './globe.js';
import { TOGGLES as TOGGLE_NAMES, loadSettings, saveSettings, decodeHash, encodeHash } from './settings.js';
import { initPasses, setSatrec as setPassSatrec, setObserver as setPassObserver, cancelPicking, refresh as refreshPasses } from './passes-ui.js';
import { setECIVisible, setECEFVisible, updateECEFRotation,
         updateGMSTIndicator, updateFrameVectors } from './frames.js';
import { makeSatrec, getFullState, computeOrbitTrail, sunDirectionEci, isInEarthShadow, visibleZoneAngle,
         parseTLEEpoch, parseTLEParams, tleEpochDate } from './orbit.js';

const TLE_URL        = '/api/tle';
const TICK_MS        = 2000;            // position update cadence
const TLE_MAX_AGE_MS = 3600_000;        // refetch the TLE hourly (edge-cached anyway)
const TLE_STALE_DAYS = 14;              // warn when the TLE epoch is older than this

let tle = null;            // { name, line1, line2, satrec, fetchedAt }
let tickTimer = null;
let orbitRefreshTimer = null;
let initialCameraSet = false;
let hiddenAt = null;
let latestState = null;

// Simulated time: the tracker normally shows "now"; the time bar shifts it.
let simOffsetMs = 0;
const simNow = () => new Date(Date.now() + simOffsetMs);
let observer = null;       // {lat, lon} for the pass finder

// Toggle states
let showPastTrail   = true;
let showFutureTrail = true;
let showGround      = false;
let showDayNight    = true;
let showZone        = false;
let showECI         = false;
let showECEF        = false;

export async function initUI() {
  // Earlier versions kept a TLE history in this browser; that analysis now lives outside the app.
  try { ['iss.tleLog', 'iss.elementHistory', 'iss.lastTle'].forEach(k => localStorage.removeItem(k)); } catch { /* storage unavailable */ }
  const saved = loadSettings();
  const fromLink = decodeHash(location.hash);
  observer = fromLink.observer ?? saved.observer ?? null;
  if (fromLink.t) { simOffsetMs = fromLink.t.getTime() - Date.now(); setTrackFlow(false); }
  if (saved.cam && !fromLink.on) setCameraDistance(saved.cam);

  setupToggleButtons(fromLink.on ?? saved.on);
  setupHelpTips();
  setupCollapsibles();
  setupControlsPanel();
  setupPasses();
  setupTimebar();
  setupKeyboard();
  getControls().addEventListener('end', () => { persist(); updateRecenterHint(); });
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Fallback: hide loading screen after 5s regardless of fetch state
  // so the 3D globe is always visible even if the TLE source is down
  setTimeout(hideLoading, 5000);

  setConnectionStatus('connecting');
  await loadTLE();
  startTracking();
  if (observer) setPassObserver(observer);   // after the TLE is in, so passes can be computed
}

function hideLoading() {
  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');
}

// ── Tracking loop ────────────────────────────────────────────────────────────

function startTracking() {
  clearInterval(tickTimer);
  clearInterval(orbitRefreshTimer);
  tick();
  loadOrbitTrail();
  tickTimer = setInterval(tick, TICK_MS);
  // Orbit trail slides along with the ISS, so refresh it every minute
  orbitRefreshTimer = setInterval(loadOrbitTrail, 60_000);
}

function tick() {
  if (!tle) {
    // Initial fetch failed — keep retrying until we have a TLE
    loadTLE();
    return;
  }
  if (Date.now() - tle.fetchedAt > TLE_MAX_AGE_MS) loadTLE(); // refresh in background
  try {
    handleState(getFullState(tle.satrec, simNow()));
    updateRecenterHint();
    const ageDays = (Date.now() - tleEpochDate(tle.line1).getTime()) / 86_400_000;
    if (ageDays > TLE_STALE_DAYS) {
      setConnectionStatus('error', `TLE is ${Math.floor(ageDays)} days old — positions may be inaccurate`);
    } else {
      setConnectionStatus('connected');
    }
  } catch (e) {
    console.error('[SGP4] Propagation error:', e);
    setConnectionStatus('error', e.message);
  }
}

function handleState(state) {
  latestState = state;
  if (!initialCameraSet) {
    initialCameraSet = true;
    pointCameraAtISS(state.lat, state.lon, state.alt_km, state.gmst_rad || 0);
    hideLoading();
  }
  updateSunAndShadow(state);
  updateHUD(state);
  updateISSPosition(state);
  updateEarthRotation(state.gmst_rad);
  updateECEFRotation(state.gmst_rad);
  updateGMSTIndicator(state.gmst_rad);
  updateFrameVectors(state);
  updateFramePanels(state);
}

// ── Sun, shadow and visibility ───────────────────────────────────────────────

let issInShadow = false;

function updateSunAndShadow(state) {
  const sunDirEci = sunDirectionEci(new Date(state.timestamp));
  issInShadow = isInEarthShadow(state.r_eci, sunDirEci);
  updateSunLighting({
    sunDirEci,
    issDirEci: state.r_eci,
    issSunlit: !issInShadow,
    visCos: Math.cos(visibleZoneAngle(state.alt_km)),
  });
  setISSSunlit(!issInShadow);
}

// ── HUD Updates ──────────────────────────────────────────────────────────────

function updateHUD(state) {
  const latDir = state.lat >= 0 ? 'N' : 'S';
  const lonDir = state.lon >= 0 ? 'E' : 'W';

  setHUDValue('hud-lat',   `${Math.abs(state.lat).toFixed(3)}°&nbsp;${latDir}`);
  setHUDValue('hud-lon',   `${Math.abs(state.lon).toFixed(3)}°&nbsp;${lonDir}`);
  setHUDValue('hud-alt',   `${state.alt_km.toFixed(1)}<span class="unit">km</span>`);
  setHUDValue('hud-speed', `${state.speed_km_s.toFixed(3)}<span class="unit">km/s</span>`);
  setHUDValue('hud-sun', issInShadow ? '☾&nbsp;In shadow' : '☀&nbsp;Sunlit');

  // UTC clock
  const timeEl = document.getElementById('hud-time');
  if (timeEl) {
    const ts = state.timestamp || new Date().toISOString();
    timeEl.textContent = ts.replace('T', ' ').substring(0, 23) + ' UTC';
  }
}

function setHUDValue(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ── ECI / ECEF Data Panels ───────────────────────────────────────────────────
// Same ISS position vector, two frames: ECI panel shows what SGP4 outputs, the
// ECEF panel shows it after rotating by GMST (and as lat/lon/alt).

function updateFramePanels(state) {
  const eciPanel  = document.getElementById('eci-display');
  const ecefPanel = document.getElementById('ecef-display');
  const wrapper   = document.getElementById('frame-panels');
  if (!wrapper) return;

  eciPanel?.classList.toggle('visible', showECI);
  ecefPanel?.classList.toggle('visible', showECEF);
  wrapper.classList.toggle('visible', showECI || showECEF);

  if (showECI) {
    setVecValues('eci-r', state.r_eci || [0, 0, 0]);
    setVecValues('eci-v', state.v_eci || [0, 0, 0]);
    setTLEParam('eci-gmst', `${(state.gmst_deg || 0).toFixed(2)}°`);
  }
  if (showECEF) {
    setVecValues('ecef-r', state.r_ecef || [0, 0, 0]);
    setTLEParam('ecef-gmst', `${(state.gmst_deg || 0).toFixed(2)}°`);
    setTLEParam('ecef-geo',
      `${state.lat.toFixed(2)}°, ${state.lon.toFixed(2)}°, ${state.alt_km.toFixed(0)} km`);
  }
}

function setVecValues(id, vec) {
  const fmt = (n) => (n >= 0 ? ' ' : '') + n.toFixed(1);
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `
    <div class="vec-row"><span class="vec-axis x">X</span><span class="vec-value">${fmt(vec[0])}</span></div>
    <div class="vec-row"><span class="vec-axis y">Y</span><span class="vec-value">${fmt(vec[1])}</span></div>
    <div class="vec-row"><span class="vec-axis z">Z</span><span class="vec-value">${fmt(vec[2])}</span></div>
  `;
}

// ── Toggle Buttons ────────────────────────────────────────────────────────────
// One table drives the buttons, the keyboard shortcuts, saved settings and share links.

const refreshFrames = () => {
  if (latestState) { updateGMSTIndicator(latestState.gmst_rad); updateFramePanels(latestState); }
};

const TOGGLES = {
  past:     { btn: 'btn-past-trail',   key: 'p', apply: (on) => { showPastTrail = on;   setTrailsVisible(showPastTrail, showFutureTrail); } },
  future:   { btn: 'btn-future-trail', key: 'f', apply: (on) => { showFutureTrail = on; setTrailsVisible(showPastTrail, showFutureTrail); } },
  daynight: { btn: 'btn-daynight',     key: 'd', apply: (on) => { showDayNight = on;    setNightVisible(on); } },
  zone:     { btn: 'btn-zone',         key: 'z', apply: (on) => { showZone = on;        setZoneVisible(on); } },
  ground:   { btn: 'btn-ground',       key: 'g', apply: (on) => { showGround = on;      setGroundVisible(on); } },
  eci:      { btn: 'btn-eci',          key: 'e', apply: (on) => { showECI = on;         setECIVisible(on);  refreshFrames(); } },
  ecef:     { btn: 'btn-ecef',         key: 'c', apply: (on) => { showECEF = on;        setECEFVisible(on); refreshFrames(); } },
};
const toggleState = {};

function setToggle(name, on) {
  const t = TOGGLES[name];
  toggleState[name] = on;
  t.apply(on);
  const btn = document.getElementById(t.btn);
  btn?.classList.toggle('active', on);
  btn?.setAttribute('aria-pressed', String(on));
}

function setupToggleButtons(initiallyOn) {
  for (const name of TOGGLE_NAMES) {
    const t = TOGGLES[name];
    const btn = document.getElementById(t.btn);
    if (!btn) continue;
    const label = btn.textContent.trim().replace(/\s+/g, ' ');
    btn.title = `${label} (${t.key.toUpperCase()})`;
    const help = btn.parentElement?.querySelector('.help-btn');
    if (help) help.dataset.help += ` Shortcut: ${t.key.toUpperCase()}.`;
    btn.addEventListener('click', () => { setToggle(name, !toggleState[name]); persist(); });
    setToggle(name, initiallyOn.includes(name));
  }
}

function persist() {
  saveSettings({
    on: TOGGLE_NAMES.filter(n => toggleState[n]),
    cam: Math.round(getCameraDistance() * 100) / 100,
    observer,
  });
}

// ── Help (i) tooltips ────────────────────────────────────────────────────────
// One shared tooltip element: the controls panel clips overflow, so it can't live inside it.

function setupHelpTips() {
  const tip = document.getElementById('help-tip');
  if (!tip) return;
  let current = null;

  const hide = () => {
    tip.hidden = true;
    if (current) current.classList.remove('open');
    current = null;
  };
  const show = (btn) => {
    if (current) current.classList.remove('open');
    current = btn;
    btn.classList.add('open');
    tip.textContent = btn.dataset.help;
    tip.hidden = false;
    const r = btn.getBoundingClientRect();
    const host = btn.closest('[data-tip-panel]') || btn;
    const panel = host.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight, m = 12;
    // Beside the panel the button is in (right of a left-hand panel, left of a right-hand one),
    // or below it for panels marked "below". If that doesn't fit (phones), below the row.
    const onLeft = panel.left + panel.width / 2 < window.innerWidth / 2;
    let left = onLeft ? panel.right + 8 : panel.left - w - 8, top = r.top + r.height / 2 - h / 2;
    const fits = left >= m && left + w <= window.innerWidth - m;
    if (host.dataset.tipPanel === 'below' || !fits) {
      left = Math.max(m, Math.min(r.left - w / 2, window.innerWidth - w - m));
      top = r.bottom + 8;
      if (top + h > window.innerHeight - m) top = r.top - h - 8;      // not enough room below: above
    }
    top = Math.max(m, Math.min(top, window.innerHeight - h - m));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  };

  document.querySelectorAll('.help-btn').forEach((btn) => {
    btn.setAttribute('aria-describedby', 'help-tip');
    const canHover = window.matchMedia('(hover: hover)');
    btn.addEventListener('mouseenter', () => { if (canHover.matches) show(btn); });
    btn.addEventListener('mouseleave', () => { if (canHover.matches) hide(); });
    btn.addEventListener('focus', () => { if (btn.matches(':focus-visible')) show(btn); });  // keyboard only; a tap would focus then toggle off
    btn.addEventListener('blur', hide);
    btn.addEventListener('click', (e) => {   // tap toggles on touch screens
      e.stopPropagation();
      current === btn && !tip.hidden ? hide() : show(btn);
    });
  });
  document.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

// ── Collapsible Panels ────────────────────────────────────────────────────────

function setupCollapsibles() {
  setupCollapsible('tle-header', 'tle-content');
  setupCollapsible('info-header', 'info-content');
  setupCollapsible('passes-header', 'passes-content');
}

function setupCollapsible(headerId, contentId) {
  const header  = document.getElementById(headerId);
  const content = document.getElementById(contentId);
  if (!header || !content) return;
  header.classList.add('collapsible-header');
  content.classList.add('collapsible-content');
  header.setAttribute('role', 'button');
  header.tabIndex = 0;

  const close = (h, c) => { c.classList.remove('visible'); h.classList.remove('open'); };
  const flip = () => {
    const isOpen = content.classList.contains('visible');
    if (!isOpen) {
      // On phones all bottom panels share one stack, so only one is open at a time.
      // On desktop the two left-hand panels (passes, TLE) grow towards each other.
      const phone = window.matchMedia('(max-width: 640px)').matches;
      const sameColumn = ['passes-header', 'tle-header'];
      document.querySelectorAll('.collapsible-header.open').forEach((h) => {
        if (phone || (sameColumn.includes(h.id) && sameColumn.includes(headerId))) {
          close(h, document.getElementById(h.id.replace('-header', '-content')));
        }
      });
    }
    content.classList.toggle('visible', !isOpen);
    header.classList.toggle('open', !isOpen);
    header.setAttribute('aria-expanded', String(!isOpen));
    document.body.classList.toggle('sheet-open', !!document.querySelector('.collapsible-header.open'));
  };
  header.addEventListener('click', flip);
  header.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
}

// ── TLE Info ─────────────────────────────────────────────────────────────────

async function loadTLE() {
  try {
    const res  = await fetch(TLE_URL);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const fresh = {
      name: data.name, line1: data.line1, line2: data.line2,
      satrec: makeSatrec(data.line1, data.line2),
      fetchedAt: Date.now(),
    };
    tle = fresh;
    showTLEInfo(tle);
    setPassSatrec(tle.satrec);
  } catch (e) {
    // Keep using the previous TLE if we have one; otherwise tick() will retry.
    console.error('[TLE] Failed to load TLE:', e);
    if (!tle) setConnectionStatus('error', 'could not fetch TLE');
  }
}

function showTLEInfo({ name, line1, line2 }) {
  const el = document.getElementById('tle-lines');
  if (el) {
    el.innerHTML = `
      <div class="tle-line name">${escapeHtml(name || 'ISS (ZARYA)')}</div>
      <div class="tle-line">${escapeHtml(line1)}</div>
      <div class="tle-line">${escapeHtml(line2)}</div>
    `;
  }

  const p = parseTLEParams(line1, line2);
  setTLEParam('tle-epoch',  parseTLEEpoch(line1));
  setTLEParam('tle-incl',   `${p.inclination_deg.toFixed(4)}°`);
  setTLEParam('tle-period', `${p.period_minutes.toFixed(2)} min`);
  setTLEParam('tle-ecc',    p.eccentricity.toFixed(6));
  setTLEParam('tle-raan',   `${p.raan_deg.toFixed(4)}°`);
  setTLEParam('tle-motion', `${p.mean_motion_rev_per_day.toFixed(4)} rev/day`);
}

function setTLEParam(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Orbit Trail ──────────────────────────────────────────────────────────────

function loadOrbitTrail() {
  if (!tle) return;
  try {
    const now = simNow();
    const { past, future } = computeOrbitTrail(tle.satrec, now);
    updateTrails(past, future);
    // Ground track: one orbit behind (46 min), three ahead (230 min: this orbit + 2 more) at 1-minute steps
    const ground = computeOrbitTrail(tle.satrec, now, 46, 230, 60);
    updateGroundTrack(ground.past, ground.future);
  } catch (e) {
    console.error('[Orbit] Failed to compute orbit trail:', e);
  }
  if (Date.now() - lastPassRefresh > 5 * 60_000) { lastPassRefresh = Date.now(); refreshPasses(); }
}
let lastPassRefresh = Date.now();

// Background tabs throttle setInterval, so a long stint in the background
// leaves the display stale. Catch up immediately when the tab is visible again.
function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }

  const hiddenMs = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = null;

  startTracking();   // recompute position + trail now and reset the timers

  // Only recenter after a real absence (3min+) — a quick tab switch
  // shouldn't override a view the user deliberately rotated to.
  if (hiddenMs >= 3 * 60_000 && latestState) {
    pointCameraAtISS(latestState.lat, latestState.lon,
                      latestState.alt_km, latestState.gmst_rad || 0);
  }
}

// ── Visualization panel: collapsible (collapsed by default on phones) ───────

function setupControlsPanel() {
  const panel = document.getElementById('controls');
  const header = document.getElementById('controls-header');
  if (!panel || !header) return;
  const set = (collapsed) => {
    panel.classList.toggle('collapsed', collapsed);
    header.setAttribute('aria-expanded', String(!collapsed));
  };
  set(window.matchMedia('(max-width: 640px)').matches);
  const flip = () => set(!panel.classList.contains('collapsed'));
  header.addEventListener('click', flip);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
  });
}

// ── Time bar: scrub, Live, Recenter, Share ───────────────────────────────────

let timeDebounce = null;

function setSimOffset(ms) {
  simOffsetMs = Math.abs(ms) < 1000 ? 0 : ms;
  setTrackFlow(simOffsetMs === 0);
  const slider = document.getElementById('tb-slider');
  if (slider) slider.value = String(Math.round(simOffsetMs / 60_000));   // pegs at the ends beyond ±3 h
  renderTimebar();
  tick();                                                // update the picture now
  clearTimeout(timeDebounce);
  timeDebounce = setTimeout(loadOrbitTrail, 150);        // trails follow once scrubbing settles
}

function offsetText() {
  const min = Math.round(simOffsetMs / 60_000), a = Math.abs(min);
  const t = a >= 60 ? `${Math.floor(a / 60)} h ${a % 60 ? `${a % 60} min` : ''}`.trim() : `${a} min`;
  return `${min < 0 ? '−' : '+'}${t}`;
}

function renderTimebar() {
  const sim = simOffsetMs !== 0;
  document.getElementById('timebar')?.classList.toggle('sim', sim);
  const label = document.getElementById('tb-label');
  if (label) label.textContent = sim ? `SIMULATED ${offsetText()}` : 'LIVE';
  const live = document.getElementById('btn-live');
  if (live) live.disabled = !sim;
}

function setupTimebar() {
  const slider = document.getElementById('tb-slider');
  slider?.addEventListener('input', () => setSimOffset(Number(slider.value) * 60_000));
  document.getElementById('btn-live')?.addEventListener('click', () => setSimOffset(0));
  document.getElementById('btn-recenter')?.addEventListener('click', recenter);

  const share = document.getElementById('btn-share');
  share?.addEventListener('click', async () => {
    const hash = encodeHash({
      on: TOGGLE_NAMES.filter(n => toggleState[n]),
      t: simOffsetMs !== 0 ? simNow() : null,
      observer,
    });
    const url = location.origin + location.pathname + hash;
    history.replaceState(null, '', hash);
    let msg = 'Link copied';
    try { await navigator.clipboard.writeText(url); } catch { msg = 'Link is in the address bar'; }
    share.textContent = msg;
    setTimeout(() => { share.textContent = 'Share'; }, 2000);
  });
  if (simOffsetMs !== 0) { const s = document.getElementById('tb-slider'); if (s) s.value = String(Math.round(simOffsetMs / 60_000)); }
  renderTimebar();
}

function recenter() {
  if (!latestState) return;
  recenterOnISS(latestState.lat, latestState.lon, latestState.alt_km, latestState.gmst_rad || 0);
  document.getElementById('btn-recenter')?.classList.remove('attn');
}

/** Nudge the Recenter button when the ISS is hidden behind the Earth. */
function updateRecenterHint() {
  const btn = document.getElementById('btn-recenter');
  if (btn) btn.classList.toggle('attn', isHiddenByEarth(getISSWorldPosition()));
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

function setupKeyboard() {
  const byKey = {};
  for (const name of TOGGLE_NAMES) byKey[TOGGLES[name].key] = name;

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape') { cancelPicking(); return; }
    const k = e.key.toLowerCase();
    if (byKey[k]) { setToggle(byKey[k], !toggleState[byKey[k]]); persist(); return; }
    if (k === 'r') { recenter(); return; }
    if (k === 'l') { setSimOffset(0); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSimOffset(simOffsetMs + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1) * 60_000);
    }
  });
}

// ── Next passes ──────────────────────────────────────────────────────────────

function setupPasses() {
  let pickCb = null, down = null;
  const canvas = document.getElementById('canvas');
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!pickCb || !down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;   // that was a drag, not a click
    const cb = pickCb;
    cb(pickEarth(e.clientX, e.clientY));
  });

  initPasses({
    onObserver: (obs) => { observer = obs; setObserverMarker(obs); persist(); },
    jumpTo: (date) => {
      setSimOffset(date.getTime() - Date.now());
      recenter();
      if (window.matchMedia('(max-width: 640px)').matches) {           // get the passes sheet out of the way
        document.getElementById('passes-content')?.classList.remove('visible');
        document.getElementById('passes-header')?.classList.remove('open');
      }
    },
    requestPick: (cb) => { pickCb = cb; canvas.style.cursor = cb ? 'crosshair' : ''; },
  });
}

// ── Connection Status ─────────────────────────────────────────────────────────

function setConnectionStatus(state, detail) {
  const el = document.getElementById('connection-status');
  if (!el) return;
  const sim = state === 'connected' && simOffsetMs !== 0;
  el.className = sim ? 'simulated' : state === 'error' ? 'disconnected' : state;
  el.textContent = sim ? `⏱ SIMULATED TIME ${offsetText()}` : {
    connected:    '● LIVE — ISS TRACKING ACTIVE',
    connecting:   '◌ CONNECTING...',
    error:        `⚠ ${detail || 'ERROR — check console'}`,
  }[state] || state;
}
