/**
 * iss.js — ISS marker, orbit trail, and hover tooltip
 *
 * Responsibilities:
 *   - ISS 3D marker (glowing sprite + mesh)
 *   - Past trail (orange line) and future trail (cyan line)
 *   - Hover raycasting for tooltip
 *   - Smooth position interpolation between updates
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { latLonAltToXYZ, EARTH_RADIUS_KM, SCALE, getEarthMesh } from './globe.js';

// Colors
// Trails are drawn opaque and un-tonemapped (no blending), so the colour reads
// the same over ocean, desert, forest, ice and cloud. Orange vs cyan is also
// colour-blind safe and avoids the greens/browns of the map.
// Keep in sync with --trail-past / --trail-future in style.css.
const COLOR_PAST   = 0xff8a00;   // orange — where ISS has been
const COLOR_FUTURE = 0x00e5ff;   // cyan   — predicted future path
const TRAIL_WIDTH  = 1;          // px

let scene, camera;

// ISS marker objects
let issGroup;           // parent group
let issMesh;            // the physical marker
let issGlow;            // glow sprite
let issOrbitRing;       // small ring around ISS position

// Trail line objects
let pastTrailLine;
let futureTrailLine;
let pastTrailPoints   = [];
let futureTrailPoints = [];

// Current and target positions for smooth interpolation
let currentPos = new THREE.Vector3();
let targetPos  = new THREE.Vector3();
let positionSet = false;

// Latest state data from WebSocket
let latestState = null;

// Raycaster for hover detection
let raycaster, mouse;
let isHovering = false;

const MAX_PAST_POINTS = 120;  // 120 × 30s = 60 minutes of history

export function initISS(threeScene, threeCamera) {
  scene  = threeScene;
  camera = threeCamera;

  raycaster = new THREE.Raycaster();
  mouse     = new THREE.Vector2();

  createISSMarker();
  createTrailLines();
  setupHoverEvents();
}

// ── ISS Marker ──────────────────────────────────────────────────────────────

function createISSMarker() {
  issGroup = new THREE.Group();
  issGroup.name = 'iss';

  // Core marker: glowing sphere
  const coreGeom = new THREE.SphereGeometry(0.055, 16, 16);
  const coreMat  = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: false,
  });
  issMesh = new THREE.Mesh(coreGeom, coreMat);
  issGroup.add(issMesh);

  // Inner glow: slightly larger, semi-transparent
  const innerGlowGeom = new THREE.SphereGeometry(0.10, 16, 16);
  const innerGlowMat  = new THREE.MeshBasicMaterial({
    color: 0x88ddff,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const innerGlow = new THREE.Mesh(innerGlowGeom, innerGlowMat);
  issGroup.add(innerGlow);

  // Outer glow: large, very transparent
  const outerGlowGeom = new THREE.SphereGeometry(0.22, 16, 16);
  const outerGlowMat  = new THREE.MeshBasicMaterial({
    color: 0x4488ff,
    transparent: true,
    opacity: 0.15,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  issGlow = new THREE.Mesh(outerGlowGeom, outerGlowMat);
  issGroup.add(issGlow);

  // Orbit direction indicator: small arrow-like cone
  const arrowGeom = new THREE.ConeGeometry(0.022, 0.07, 8);
  const arrowMat  = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
  const arrowMesh = new THREE.Mesh(arrowGeom, arrowMat);
  arrowMesh.name  = 'arrow';
  issGroup.add(arrowMesh);

  scene.add(issGroup);
}

// ── Orbit Trail Lines ────────────────────────────────────────────────────────

const trailMaterials = [];

function makeTrail(name, color) {
  const mat = new LineMaterial({
    color,
    linewidth: TRAIL_WIDTH,
    transparent: false,
    depthWrite: false,
    toneMapped: false,   // blending stays off, so the map can't tint the line
  });
  mat.resolution.set(window.innerWidth, window.innerHeight);
  trailMaterials.push(mat);

  const line = new Line2(new LineGeometry(), mat);
  line.name = name;
  line.frustumCulled = false;
  (getEarthMesh() || scene).add(line);
  return line;
}

function createTrailLines() {
  pastTrailLine   = makeTrail('pastTrail', COLOR_PAST);
  futureTrailLine = makeTrail('futureTrail', COLOR_FUTURE);

  // LineMaterial needs the viewport size to turn pixel widths into geometry
  window.addEventListener('resize', () => {
    trailMaterials.forEach(m => m.resolution.set(window.innerWidth, window.innerHeight));
  });
}

/**
 * Update the trail lines from the propagated orbit.
 *
 * @param {Array} pastPoints   - [{lat, lon, alt_km}, ...] past positions
 * @param {Array} futurePoints - [{lat, lon, alt_km}, ...] future positions
 */
export function updateTrails(pastPoints, futurePoints) {
  if (pastPoints && pastPoints.length > 1) {
    pastTrailPoints = pastPoints;
    setTrailGeometry(pastTrailLine, pastPoints);
  }
  if (futurePoints && futurePoints.length > 1) {
    futureTrailPoints = futurePoints;
    setTrailGeometry(futureTrailLine, futurePoints);
  }
}

// Trail frame. 'ecef': the trail is carried round with the Earth (ground-track
// view — each point is lat/lon/alt, a child of the Earth mesh). 'eci': the true
// inertial orbit, a fixed ellipse in space (child of the scene, drawn from the
// ECI vectors; ECI (x,y,z) maps to scene (x, z, -y)).
let trailFrame = 'ecef';

export function setTrailFrame(frame) {
  trailFrame = frame;
  const parent = frame === 'eci' ? scene : (getEarthMesh() || scene);
  [pastTrailLine, futureTrailLine].forEach(line => line && parent.add(line));
  if (pastTrailPoints.length)   setTrailGeometry(pastTrailLine, pastTrailPoints);
  if (futureTrailPoints.length) setTrailGeometry(futureTrailLine, futureTrailPoints);
}

function setTrailGeometry(line, points) {
  // Points are 3D positions, so the anti-meridian needs no special handling
  const positions = [];
  for (const p of points) {
    if (trailFrame === 'eci' && p.eci) {
      const [x, y, z] = p.eci;
      const k = (Math.hypot(x, y, z) + 10) / Math.hypot(x, y, z); // +10km above the orbit radius
      positions.push(x * k * SCALE, z * k * SCALE, -y * k * SCALE);
    } else {
      const pos = latLonAltToXYZ(p.lat, p.lon, p.alt_km + 10); // +10km offset above surface
      positions.push(pos.x, pos.y, pos.z);
    }
  }
  line.geometry.dispose();
  line.geometry = new LineGeometry();
  line.geometry.setPositions(positions);
}

// ── ISS Position Update ──────────────────────────────────────────────────────

/**
 * Called every 2 seconds when new WebSocket data arrives.
 * Smoothly interpolates ISS marker to new position.
 *
 * @param {Object} state - {lat, lon, alt_km, speed_km_s, r_eci, v_eci, ...}
 */
export function updateISSPosition(state) {
  latestState = state;
  if (isHovering) updateTooltip(state);

  // Convert ECEF → world (ECI) by rotating by -GMST around Y.
  // The Earth mesh is rotated by -GMST, so the same rotation maps
  // ECEF coordinates into the scene's world frame.
  const ecefPos = latLonAltToXYZ(state.lat, state.lon, state.alt_km);
  const gmst = state.gmst_rad || 0;
  const cosG = Math.cos(gmst);
  const sinG = Math.sin(gmst);
  const newPos = new THREE.Vector3(
    ecefPos.x * cosG + ecefPos.z * sinG,
    ecefPos.y,
    -ecefPos.x * sinG + ecefPos.z * cosG,
  );

  if (!positionSet) {
    currentPos.copy(newPos);
    issGroup.position.copy(newPos);
    positionSet = true;
  }

  targetPos.copy(newPos);

  // Orient the arrow in the direction of velocity (approximately)
  if (state.v_eci) {
    const vel = new THREE.Vector3(...state.v_eci).normalize();
    const arrow = issGroup.getObjectByName('arrow');
    if (arrow) {
      // Project velocity to tangent plane at satellite position
      const up = newPos.clone().normalize();
      const tangent = vel.clone().projectOnPlane(up).normalize();
      if (tangent.lengthSq() > 0.001) {
        const quaternion = new THREE.Quaternion();
        quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
        arrow.quaternion.copy(quaternion);
      }
    }
  }
}

/**
 * Called every animation frame to interpolate and animate.
 * @param {number} deltaTime - seconds since last frame
 */
export function animateISS(deltaTime) {
  if (!positionSet) return;

  // Smooth interpolation: lerp towards target (speed: ~90% per second)
  const lerpSpeed = 1.0 - Math.pow(0.1, deltaTime * 0.5);
  currentPos.lerp(targetPos, lerpSpeed);
  issGroup.position.copy(currentPos);

  // Pulse animation on glow
  const t = Date.now() / 1000;
  if (issGlow) {
    issGlow.material.opacity = 0.1 + 0.1 * Math.sin(t * 2);
    issGlow.scale.setScalar(1.0 + 0.15 * Math.sin(t * 2));
  }

  // Always face camera
  issGroup.children.forEach(child => {
    if (child.isMesh && child !== issGroup.getObjectByName('arrow')) {
      child.lookAt(camera.position);
    }
  });
}

// ── Hover / Raycasting ───────────────────────────────────────────────────────

function setupHoverEvents() {
  window.addEventListener('mousemove', onMouseMove);
  // Touch has no hover: a tap on the ISS shows the tooltip, a tap elsewhere hides it
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') onMouseMove(e);
  });
}

function onMouseMove(event) {
  if (!issMesh || !camera) return;

  mouse.x =  (event.clientX / window.innerWidth)  * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Test against ISS core mesh with a larger hit area
  raycaster.params.Points = { threshold: 0.1 };
  const hits = raycaster.intersectObject(issMesh, false);

  const tooltip = document.getElementById('tooltip');
  if (!tooltip) return;

  if (hits.length > 0 && latestState) {
    isHovering = true;
    tooltip.style.display = 'block';
    tooltip.style.left    = (event.clientX + 16) + 'px';
    tooltip.style.top     = (event.clientY - 8) + 'px';
    updateTooltip(latestState);
  } else {
    isHovering = false;
    tooltip.style.display = 'none';
  }
}

function updateTooltip(state) {
  const tooltip = document.getElementById('tooltip');
  if (!tooltip) return;

  const latDir = state.lat >= 0 ? 'N' : 'S';
  const lonDir = state.lon >= 0 ? 'E' : 'W';

  tooltip.innerHTML = `
    <div class="tt-title">ISS — ZARYA</div>
    <div class="tt-row">
      <span class="tt-label">Latitude</span>
      <span class="tt-value">${Math.abs(state.lat).toFixed(2)}° ${latDir}</span>
    </div>
    <div class="tt-row">
      <span class="tt-label">Longitude</span>
      <span class="tt-value">${Math.abs(state.lon).toFixed(2)}° ${lonDir}</span>
    </div>
    <div class="tt-row">
      <span class="tt-label">Altitude</span>
      <span class="tt-value">${state.alt_km.toFixed(1)} km</span>
    </div>
    <div class="tt-row">
      <span class="tt-label">Speed</span>
      <span class="tt-value">${state.speed_km_s.toFixed(3)} km/s</span>
    </div>
  `;
}

export function setTrailsVisible(past, future) {
  if (pastTrailLine)   pastTrailLine.visible   = past;
  if (futureTrailLine) futureTrailLine.visible  = future;
}

export function getISSGroup() {
  return issGroup;
}
