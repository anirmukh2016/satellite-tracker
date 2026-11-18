/**
 * iss.js — ISS marker, orbit trail, and hover tooltip
 *
 * Responsibilities:
 *   - ISS 3D marker (low-poly station model + halo ring, constant on-screen size)
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
let issGroup;           // positioned at the ISS
let issScaler;          // child of issGroup: scaled each frame for constant on-screen size
let issModel;           // the low-poly station, oriented along the orbit
let issMesh;            // invisible hit sphere used for hover/tap detection
let issPing;            // expanding halo ring
const targetQuat = new THREE.Quaternion();
let quatSet = false;

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

// Marker sizing: the real ISS is ~109 m, so it is exaggerated and kept a
// constant number of CSS pixels wide at any zoom.
const ISS_TARGET_PX = 56;
const ISS_MIN_SCALE = 0.02;
const ISS_MAX_SCALE = 4;   // caps the size at max zoom-out so it doesn't dwarf the globe
const PING_PERIOD_S = 2.4;

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

function box(w, h, d, color, emissive) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color, emissive })
  );
}

/**
 * Low-poly ISS, ~1 unit across the truss (X), modules along Z (forward),
 * Y = zenith. Scaled to a constant on-screen size by animateISS.
 */
function buildISSModel() {
  const model = new THREE.Group();
  model.name = 'iss_model';

  const truss = box(1.0, 0.04, 0.04, 0xe4e4e4, 0x555555);
  model.add(truss);

  // Four solar-array wings crossing the truss. Gold, so they stand out against
  // dark ocean as well as bright land and cloud.
  [-0.44, -0.27, 0.27, 0.44].forEach(x => {
    const wing = box(0.14, 0.01, 0.8, 0xf2b632, 0x7a5410);
    wing.position.set(x, 0, 0);
    model.add(wing);
  });

  // Pressurised modules along the flight direction, plus a cross module
  const hull = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.5, 12),
    new THREE.MeshLambertMaterial({ color: 0xe6e6e6, emissive: 0x555555 })
  );
  hull.rotation.x = Math.PI / 2;
  hull.position.set(0, -0.04, 0);
  model.add(hull);

  const node = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.26, 12),
    new THREE.MeshLambertMaterial({ color: 0xd8d8d8, emissive: 0x4a4a4a })
  );
  node.rotation.z = Math.PI / 2;
  node.position.set(0, -0.04, 0.1);
  model.add(node);

  // Radiators (light grey plates either side of the centre)
  [-0.14, 0.14].forEach(x => {
    const rad = box(0.09, 0.004, 0.2, 0xcfd6de, 0x2a2e33);
    rad.position.set(x, 0.05, -0.12);
    model.add(rad);
  });

  return model;
}

/** Ring texture: white stroke over a thin dark one, so it reads on ice and ocean alike. */
function makeRingTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(5, 8, 15, 0.85)'; g.lineWidth = 9; g.stroke();
  g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createISSMarker() {
  issGroup = new THREE.Group();
  issGroup.name = 'iss';

  issScaler = new THREE.Group();
  issGroup.add(issScaler);

  issModel = buildISSModel();
  issScaler.add(issModel);

  // Static halo + an expanding "ping" (normal blending, so the map can't tint them)
  const ringTex = makeRingTexture();
  const ringMat = () => new THREE.SpriteMaterial({
    map: ringTex, transparent: true, depthWrite: false, toneMapped: false,
  });
  const halo = new THREE.Sprite(ringMat());
  halo.scale.setScalar(1.45);
  halo.material.opacity = 0.9;
  issScaler.add(halo);

  issPing = new THREE.Sprite(ringMat());
  issScaler.add(issPing);

  // Invisible, slightly oversized hit target for hover/tap
  issMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 8, 8),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  issScaler.add(issMesh);

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

  // Orient like the real station: nose along velocity, zenith up, truss across
  // the orbit plane. ECI (x, y, z) maps to scene (x, z, -y).
  if (state.r_eci && state.v_eci) {
    const [rx, ry, rz] = state.r_eci, [vx, vy, vz] = state.v_eci;
    const fwd = new THREE.Vector3(vx, vz, -vy).normalize();
    const up  = new THREE.Vector3(rx, rz, -ry).normalize();
    up.addScaledVector(fwd, -up.dot(fwd)).normalize();   // make exactly perpendicular
    const side = new THREE.Vector3().crossVectors(up, fwd);
    targetQuat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, fwd));
    if (!quatSet) { issModel.quaternion.copy(targetQuat); quatSet = true; }
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

  issModel.quaternion.slerp(targetQuat, lerpSpeed);

  // Constant on-screen size: scale with distance so the marker stays ~ISS_TARGET_PX wide
  const dist = camera.position.distanceTo(currentPos);
  const worldPerPx = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / window.innerHeight;
  const scale = THREE.MathUtils.clamp(dist * worldPerPx * ISS_TARGET_PX, ISS_MIN_SCALE, ISS_MAX_SCALE);
  issScaler.scale.setScalar(scale);

  // Ping: ring grows and fades, repeating
  const p = ((Date.now() / 1000) % PING_PERIOD_S) / PING_PERIOD_S;
  issPing.scale.setScalar(1.45 + 1.3 * p);
  issPing.material.opacity = 0.7 * (1 - p);
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

  // Test against the invisible hit sphere around the model
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
