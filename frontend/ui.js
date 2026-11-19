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
         updateGroundTrack, setGroundVisible, setISSSunlit } from './iss.js';
import { updateEarthRotation, pointCameraAtISS, updateSunLighting, setNightVisible, setZoneVisible } from './globe.js';
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

// Toggle states
let showPastTrail   = true;
let showFutureTrail = true;
let showGround      = false;
let showDayNight    = true;
let showZone        = false;
let showECI         = false;
let showECEF        = false;

export async function initUI() {
  setupToggleButtons();
  setupCollapsibles();
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Fallback: hide loading screen after 5s regardless of fetch state
  // so the 3D globe is always visible even if the TLE source is down
  setTimeout(hideLoading, 5000);

  setConnectionStatus('connecting');
  await loadTLE();
  startTracking();
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
    handleState(getFullState(tle.satrec));
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

function setupToggleButtons() {
  setupHelpTips();
  setupBtn('btn-past-trail', () => {
    showPastTrail = !showPastTrail;
    setTrailsVisible(showPastTrail, showFutureTrail);
    return showPastTrail;
  });

  setupBtn('btn-future-trail', () => {
    showFutureTrail = !showFutureTrail;
    setTrailsVisible(showPastTrail, showFutureTrail);
    return showFutureTrail;
  });

  setupBtn('btn-daynight', () => {
    showDayNight = !showDayNight;
    setNightVisible(showDayNight);
    return showDayNight;
  });

  setupBtn('btn-zone', () => {
    showZone = !showZone;
    setZoneVisible(showZone);
    return showZone;
  });

  setupBtn('btn-ground', () => {
    showGround = !showGround;
    setGroundVisible(showGround);
    return showGround;
  });

  setupBtn('btn-eci', () => {
    showECI = !showECI;
    setECIVisible(showECI);
    if (latestState) { updateGMSTIndicator(latestState.gmst_rad); updateFramePanels(latestState); }
    return showECI;
  });

  setupBtn('btn-ecef', () => {
    showECEF = !showECEF;
    setECEFVisible(showECEF);
    if (latestState) { updateGMSTIndicator(latestState.gmst_rad); updateFramePanels(latestState); }
    return showECEF;
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
    const panel = document.getElementById('controls').getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight, m = 12;
    // Desktop: to the left of the panel. If that doesn't fit (phones), below the row.
    let left = panel.left - w - 8, top = r.top + r.height / 2 - h / 2;
    if (left < m) { left = window.innerWidth - w - m; top = r.bottom + 8; }
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

function setupBtn(id, onClick) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const active = onClick();
    btn.classList.toggle('active', active);
  });
}

// ── Collapsible Panels ────────────────────────────────────────────────────────

function setupCollapsibles() {
  setupCollapsible('tle-header', 'tle-content');
  setupCollapsible('info-header', 'info-content');
}

function setupCollapsible(headerId, contentId) {
  const header  = document.getElementById(headerId);
  const content = document.getElementById(contentId);
  if (!header || !content) return;
  header.classList.add('collapsible-header');
  content.classList.add('collapsible-content');

  header.addEventListener('click', () => {
    const isOpen = content.classList.contains('visible');
    // On phones the bottom panels are stacked, so keep only one open at a time
    if (!isOpen && window.matchMedia('(max-width: 640px)').matches) {
      document.querySelectorAll('.collapsible-content.visible').forEach(c => c.classList.remove('visible'));
      document.querySelectorAll('.collapsible-header.open').forEach(h => h.classList.remove('open'));
    }
    content.classList.toggle('visible', !isOpen);
    header.classList.toggle('open', !isOpen);
  });
}

// ── TLE Info ─────────────────────────────────────────────────────────────────

async function loadTLE() {
  try {
    const res  = await fetch(TLE_URL);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    tle = {
      name: data.name, line1: data.line1, line2: data.line2,
      satrec: makeSatrec(data.line1, data.line2),
      fetchedAt: Date.now(),
    };
    showTLEInfo(tle);
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
    const { past, future } = computeOrbitTrail(tle.satrec);
    updateTrails(past, future);
    // Ground track: one full orbit (±46 min) at 1-minute steps
    const ground = computeOrbitTrail(tle.satrec, new Date(), 46, 46, 60);
    updateGroundTrack(ground.past, ground.future);
  } catch (e) {
    console.error('[Orbit] Failed to compute orbit trail:', e);
  }
}

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

// ── Connection Status ─────────────────────────────────────────────────────────

function setConnectionStatus(state, detail) {
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.className = state === 'error' ? 'disconnected' : state;
  el.textContent = {
    connected:    '● LIVE — ISS TRACKING ACTIVE',
    connecting:   '◌ CONNECTING...',
    error:        `⚠ ${detail || 'ERROR — check console'}`,
  }[state] || state;
}
