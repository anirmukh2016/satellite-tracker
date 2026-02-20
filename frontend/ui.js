/**
 * ui.js — HUD panel, TLE display, toggle controls, WebSocket management
 *
 * Connects to the backend WebSocket and distributes data to:
 *   - HUD: lat, lon, alt, speed, UTC time
 *   - ISS module: position update
 *   - Globe: GMST for Earth rotation
 *   - Frames: GMST for ECEF rotation
 *   - ECI vector display panel
 */

import { updateISSPosition, updateTrails, setTrailsVisible } from './iss.js';
import { updateEarthRotation } from './globe.js';
import { setECIVisible, setECEFVisible, isECIVisible, isECEFVisible,
         updateECEFRotation, updateGMSTIndicator } from './frames.js';

const WS_URL      = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
const ORBIT_URL   = '/api/orbit';
const TLE_URL     = '/api/tle';

let ws = null;
let reconnectTimer = null;
let orbitRefreshTimer = null;

// Toggle states
let showPastTrail   = true;
let showFutureTrail = true;
let showECI         = false;
let showECEF        = false;

export function initUI() {
  setupToggleButtons();
  setupCollapsibles();
  connectWebSocket();
  loadTLEInfo();
  scheduleOrbitRefresh();

  // Fallback: hide loading screen after 5s regardless of WS state
  // so the 3D globe is always visible even if backend has issues
  setTimeout(hideLoading, 5000);
}

function hideLoading() {
  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function connectWebSocket() {
  setConnectionStatus('connecting');

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setConnectionStatus('connected');
    console.log('[WS] Connected to ISS tracker backend');
    clearTimeout(reconnectTimer);
    // Hide loading screen as soon as WS connects — globe is ready
    hideLoading();
  };

  ws.onmessage = (event) => {
    try {
      const state = JSON.parse(event.data);
      if (state.error) {
        console.error('[WS] Backend error:', state.error);
        setConnectionStatus('error', state.error);
        return;
      }
      handleState(state);
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected');
    console.log('[WS] Disconnected, reconnecting in 3s...');
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
    ws.close();
  };
}

function handleState(state) {
  updateHUD(state);
  updateISSPosition(state);
  updateEarthRotation(state.gmst_rad);
  updateECEFRotation(state.gmst_rad);
  updateGMSTIndicator(state.gmst_rad);
  updateECIDisplay(state);
}

// ── HUD Updates ──────────────────────────────────────────────────────────────

function updateHUD(state) {
  const latDir = state.lat >= 0 ? 'N' : 'S';
  const lonDir = state.lon >= 0 ? 'E' : 'W';

  setHUDValue('hud-lat',   `${Math.abs(state.lat).toFixed(3)}°&nbsp;${latDir}`);
  setHUDValue('hud-lon',   `${Math.abs(state.lon).toFixed(3)}°&nbsp;${lonDir}`);
  setHUDValue('hud-alt',   `${state.alt_km.toFixed(1)}<span class="unit">km</span>`);
  setHUDValue('hud-speed', `${state.speed_km_s.toFixed(3)}<span class="unit">km/s</span>`);

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

// ── ECI Vector Display ───────────────────────────────────────────────────────

function updateECIDisplay(state) {
  const panel = document.getElementById('eci-display');
  if (!panel) return;

  const visible = showECI || showECEF;
  panel.classList.toggle('visible', visible);

  if (!visible) return;

  const r = state.r_eci || [0, 0, 0];
  const v = state.v_eci || [0, 0, 0];

  setVecValues('eci-r', r);
  setVecValues('eci-v', v);

  const gmstEl = document.getElementById('eci-gmst');
  if (gmstEl) gmstEl.textContent = `${(state.gmst_deg || 0).toFixed(2)}°`;
}

function setVecValues(prefix, vec) {
  const fmt = (n) => (n >= 0 ? ' ' : '') + n.toFixed(1);
  const el = document.getElementById(prefix);
  if (!el) return;
  el.innerHTML = `
    <div class="vec-row"><span class="vec-axis x">X</span><span class="vec-value">${fmt(vec[0])}</span></div>
    <div class="vec-row"><span class="vec-axis y">Y</span><span class="vec-value">${fmt(vec[1])}</span></div>
    <div class="vec-row"><span class="vec-axis z">Z</span><span class="vec-value">${fmt(vec[2])}</span></div>
  `;
}

// ── Toggle Buttons ────────────────────────────────────────────────────────────

function setupToggleButtons() {
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

  setupBtn('btn-eci', () => {
    showECI = !showECI;
    setECIVisible(showECI);
    return showECI;
  });

  setupBtn('btn-ecef', () => {
    showECEF = !showECEF;
    setECEFVisible(showECEF);
    return showECEF;
  });
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

  header.addEventListener('click', () => {
    const isOpen = content.classList.contains('visible');
    content.classList.toggle('visible', !isOpen);
    header.classList.toggle('open', !isOpen);
  });
}

// ── TLE Info ─────────────────────────────────────────────────────────────────

async function loadTLEInfo() {
  try {
    const res  = await fetch(TLE_URL);
    const data = await res.json();

    // Display raw TLE lines
    const el = document.getElementById('tle-lines');
    if (el) {
      el.innerHTML = `
        <div class="tle-line name">${escapeHtml(data.name || 'ISS (ZARYA)')}</div>
        <div class="tle-line">${escapeHtml(data.line1 || '')}</div>
        <div class="tle-line">${escapeHtml(data.line2 || '')}</div>
      `;
    }

    // Display parsed parameters
    const p = data.params || {};
    setTLEParam('tle-epoch',      data.epoch     || '—');
    setTLEParam('tle-incl',       `${(p.inclination_deg || 0).toFixed(4)}°`);
    setTLEParam('tle-period',     `${(p.period_minutes || 0).toFixed(2)} min`);
    setTLEParam('tle-ecc',        (p.eccentricity || 0).toFixed(6));
    setTLEParam('tle-raan',       `${(p.raan_deg || 0).toFixed(4)}°`);
    setTLEParam('tle-motion',     `${(p.mean_motion_rev_per_day || 0).toFixed(4)} rev/day`);

  } catch (e) {
    console.error('[TLE] Failed to load TLE info:', e);
  }
}

function setTLEParam(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Orbit Trail Loading ──────────────────────────────────────────────────────

async function loadOrbitTrail() {
  try {
    const res  = await fetch(ORBIT_URL);
    const data = await res.json();
    if (data.past && data.future) {
      updateTrails(data.past, data.future);
    }
  } catch (e) {
    console.error('[Orbit] Failed to load orbit trail:', e);
  }
}

function scheduleOrbitRefresh() {
  // Load immediately on startup
  loadOrbitTrail();

  // Refresh every 60 seconds (orbit trail changes as ISS moves)
  orbitRefreshTimer = setInterval(loadOrbitTrail, 60_000);
}

// ── Connection Status ─────────────────────────────────────────────────────────

function setConnectionStatus(state, detail) {
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.className = state === 'error' ? 'disconnected' : state;
  el.textContent = {
    connected:    '● LIVE — ISS TRACKING ACTIVE',
    disconnected: '● DISCONNECTED — RECONNECTING...',
    connecting:   '◌ CONNECTING...',
    error:        `⚠ BACKEND ERROR — ${detail || 'check console'}`,
  }[state] || state;
}
