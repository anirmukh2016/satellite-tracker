/**
 * iss.js — ISS marker, orbit trail, and hover tooltip
 *
 * Responsibilities:
 *   - ISS 3D marker (low-poly station model + blinking glow, constant on-screen size)
 *   - Past trail (orange line) and future trail (cyan line)
 *   - Ground track (dashed, on the surface) and nadir line
 *   - Hover raycasting for tooltip
 *   - Smooth position interpolation between updates
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { latLonAltToXYZ, EARTH_RADIUS_KM, SCALE, R_EARTH, getEarthMesh } from './globe.js';

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
let issPing;            // blinking glow dot
const targetQuat = new THREE.Quaternion();
let quatSet = false;

// Eclipse dimming: shade 1 = sunlit, ISS_ECLIPSE_SHADE = in Earth's shadow
const ISS_ECLIPSE_SHADE = 0.25;
let issShadeTarget = 1, issShade = 1;
const issMaterials = [];

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
const ISS_TARGET_PX = 34;
const ISS_MIN_SCALE = 0.02;
const ISS_MAX_SCALE = 2.4;  // caps the size at max zoom-out so it doesn't dwarf the globe
const PING_PERIOD_S = 1.4;

const MAX_PAST_POINTS = 120;  // 120 × 30s = 60 minutes of history

export function initISS(threeScene, threeCamera) {
  scene  = threeScene;
  camera = threeCamera;

  raycaster = new THREE.Raycaster();
  mouse     = new THREE.Vector2();

  createISSMarker();
  createTrailLines();
  createGroundLayer();
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
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.35, 'rgba(255,240,200,0.45)');
  grad.addColorStop(1.00, 'rgba(255,240,200,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
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
  issModel.traverse(o => {
    if (o.isMesh) {
      o.material.userData.base = { color: o.material.color.clone(), emissive: o.material.emissive.clone() };
      issMaterials.push(o.material);
    }
  });
  issScaler.add(issModel);

  // A soft glowing dot that blinks behind the model. It is a round, screen-facing blob
  // (no outline), so it looks the same from any camera angle.
  issPing = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(), transparent: true, depthWrite: false, toneMapped: false,
  }));
  issPing.renderOrder = -1;
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

// Direction arrows: small cones on each trail pointing the way the ISS travels, so it is
// obvious which trail is the past (orange, leading up to the ISS) and which the future
// (cyan, leading away). They sit at fixed clock times (every ARROW_EVERY_MIN minutes), so they
// stay put on the orbit while the ISS flows past them, and keep a constant size on screen.
const ARROW_EVERY_MIN = 8;
const ARROW_PX = 13;
const ARROW_UNIT_H = 1.4;               // height of the unit cone geometry below
let pastArrows, futureArrows;
let arrowGeom = null;
const _w = new THREE.Vector3();

function makeArrowGroup(name) {
  const g = new THREE.Group();
  g.name = name;
  (getEarthMesh() || scene).add(g);
  return g;
}

function placeArrows(group, color, points) {
  group.children.forEach(c => c.material.dispose());
  group.clear();
  if (!points || points.length < 2 || points[0].t == null) return;
  arrowGeom ??= new THREE.ConeGeometry(0.5, ARROW_UNIT_H, 10);
  const pos = points.map(p => latLonAltToXYZ(p.lat, p.lon, p.alt_km + 10));
  const step = ARROW_EVERY_MIN * 60_000;
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  for (let m = Math.ceil(points[0].t / step) * step; m < points[points.length - 1].t; m += step) {
    let i = 0;
    while (i < points.length - 2 && points[i + 1].t <= m) i++;
    const k = (m - points[i].t) / (points[i + 1].t - points[i].t);
    const cone = new THREE.Mesh(arrowGeom, mat.clone());
    cone.position.lerpVectors(pos[i], pos[i + 1], k);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos[i + 1].clone().sub(pos[i]).normalize());
    group.add(cone);
  }
  mat.dispose();
}

function scaleArrows(worldPerPx) {
  for (const g of [pastArrows, futureArrows]) {
    if (!g?.visible) continue;
    for (const c of g.children) {
      c.getWorldPosition(_w);
      c.scale.setScalar(THREE.MathUtils.clamp(_w.distanceTo(camera.position) * worldPerPx * ARROW_PX / ARROW_UNIT_H,
                                              0.004, 0.5));
    }
  }
}

function createTrailLines() {
  pastTrailLine   = makeTrail('pastTrail', COLOR_PAST);
  futureTrailLine = makeTrail('futureTrail', COLOR_FUTURE);
  pastArrows   = makeArrowGroup('pastArrows');
  futureArrows = makeArrowGroup('futureArrows');

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
    placeArrows(pastArrows, COLOR_PAST, pastPoints);
  }
  if (futurePoints && futurePoints.length > 1) {
    futureTrailPoints = futurePoints;
    setTrailGeometry(futureTrailLine, futurePoints);
    placeArrows(futureArrows, COLOR_FUTURE, futurePoints);
  }
}

function setTrailGeometry(line, points) {
  // Points are 3D positions, so the anti-meridian needs no special handling
  const positions = [];
  for (const p of points) {
    const pos = latLonAltToXYZ(p.lat, p.lon, p.alt_km + 10); // +10km offset above surface
    positions.push(pos.x, pos.y, pos.z);
  }
  line.geometry.dispose();
  line.geometry = new LineGeometry();
  line.geometry.setPositions(positions);
}

// ── Ground track and nadir line ─────────────────────────────────────────
// The ground track is the orbit projected onto the surface (Earth-fixed, so it
// rotates with the Earth mesh). The nadir line drops from the ISS to the point
// beneath it. All opaque and un-tonemapped, like the trails.

const GROUND_ALT_KM = 20;     // clears the 64-segment sphere's chord sag (~8 km)
const COLOR_GROUND = 0xffffff;
let groundGroup, groundPast, groundFuture, nadirLine;
let groundOn = false;   // off by default; toggled from the UI

function makeGroundLine(color, dashed) {
  const mat = new LineMaterial({
    color, linewidth: TRAIL_WIDTH, transparent: false, depthWrite: false,
    toneMapped: false, dashed, dashSize: 0.12, gapSize: 0.08,
  });
  mat.resolution.set(window.innerWidth, window.innerHeight);
  trailMaterials.push(mat);
  const line = new Line2(new LineGeometry(), mat);
  line.frustumCulled = false;
  line.visible = false;   // until it has positions
  groundGroup.add(line);
  return line;
}

function setLinePositions(line, points, dashed) {
  const pos = [];
  for (const p of points) {
    const v = latLonAltToXYZ(p.lat, p.lon, GROUND_ALT_KM);
    pos.push(v.x, v.y, v.z);
  }
  line.geometry.dispose();
  line.geometry = new LineGeometry();
  line.geometry.setPositions(pos);
  if (dashed) line.computeLineDistances();
  line.visible = true;
}

function createGroundLayer() {
  groundGroup = new THREE.Group();
  groundGroup.name = 'ground_layer';
  groundGroup.visible = groundOn;
  (getEarthMesh() || scene).add(groundGroup);

  groundPast    = makeGroundLine(COLOR_PAST, true);
  groundFuture  = makeGroundLine(COLOR_FUTURE, true);

  // Nadir line lives in world space (the ISS position is a world position)
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  nadirLine = new THREE.Line(geom, new THREE.LineDashedMaterial({
    color: COLOR_GROUND, dashSize: 0.05, gapSize: 0.04, toneMapped: false, depthWrite: false,
  }));
  nadirLine.frustumCulled = false;
  nadirLine.visible = false;
  scene.add(nadirLine);
}

/** Ground track from propagated points ({lat, lon}); future is joined to the last past point. */
export function updateGroundTrack(pastPoints, futurePoints) {
  if (!groundGroup) return;
  if (pastPoints && pastPoints.length > 1) setLinePositions(groundPast, pastPoints, true);
  if (futurePoints && futurePoints.length > 0) {
    const joined = pastPoints?.length ? [pastPoints[pastPoints.length - 1], ...futurePoints] : futurePoints;
    setLinePositions(groundFuture, joined, true);
  }
}

function updateNadir() {
  if (!nadirLine) return;
  const a = nadirLine.geometry.attributes.position;
  const surface = currentPos.clone().setLength(R_EARTH + GROUND_ALT_KM * SCALE);
  a.setXYZ(0, currentPos.x, currentPos.y, currentPos.z);
  a.setXYZ(1, surface.x, surface.y, surface.z);
  a.needsUpdate = true;
  nadirLine.computeLineDistances();
  nadirLine.visible = groundOn;
}

/** Dim the model while the ISS is in Earth's shadow. */
export function setISSSunlit(sunlit) {
  issShadeTarget = sunlit ? 1 : ISS_ECLIPSE_SHADE;
}

/** Current world position of the ISS marker (a copy). */
export function getISSWorldPosition() { return currentPos.clone(); }

// ── Observer marker (for the pass finder) ───────────────────────────────────
let observerMarker = null;

/** Mark a ground location on the Earth, or clear it with null. */
export function setObserverMarker(obs) {
  if (observerMarker) { observerMarker.parent?.remove(observerMarker); observerMarker = null; }
  if (!obs) return;
  const m = new THREE.Group();
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xff4fd8, toneMapped: false }));
  m.add(core);
  m.position.copy(latLonAltToXYZ(obs.lat, obs.lon, 8));
  observerMarker = m;
  (getEarthMesh() || scene).add(m);
}

export function setGroundVisible(visible) {
  groundOn = visible;
  if (groundGroup) groundGroup.visible = visible;
  if (nadirLine) nadirLine.visible = visible && positionSet;
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
  // A time-scrub (or long absence) moves the ISS thousands of km: jump instead of gliding across the globe
  if (currentPos.distanceTo(newPos) > 1.2) currentPos.copy(newPos);

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
  updateNadir();

  // Ease into / out of eclipse rather than popping
  if (Math.abs(issShade - issShadeTarget) > 0.002) {
    issShade += (issShadeTarget - issShade) * Math.min(1, deltaTime * 3);
    issMaterials.forEach(m => {
      m.color.copy(m.userData.base.color).multiplyScalar(issShade);
      m.emissive.copy(m.userData.base.emissive).multiplyScalar(issShade);
    });
  }

  // Constant on-screen size: scale with distance so the marker stays ~ISS_TARGET_PX wide
  const dist = camera.position.distanceTo(currentPos);
  const worldPerPx = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / window.innerHeight;
  const scale = THREE.MathUtils.clamp(dist * worldPerPx * ISS_TARGET_PX, ISS_MIN_SCALE, ISS_MAX_SCALE);
  issScaler.scale.setScalar(scale);
  scaleArrows(worldPerPx);

  // Blink: the glow swells and fades, repeating
  const p = ((Date.now() / 1000) % PING_PERIOD_S) / PING_PERIOD_S;
  const pulse = 0.5 - 0.5 * Math.cos(p * Math.PI * 2);   // 0 → 1 → 0
  issPing.scale.setScalar(1.3 + 1.0 * pulse);
  issPing.material.opacity = 0.25 + 0.75 * pulse;
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
  if (pastArrows)   pastArrows.visible   = past;
  if (futureArrows) futureArrows.visible = future;
}

export function getISSGroup() {
  return issGroup;
}
