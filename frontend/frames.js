/**
 * frames.js — ECI and ECEF coordinate axis visualization
 *
 * Demonstrates the key difference between the two coordinate systems:
 *
 * ECI (Earth-Centered Inertial)  — solid, saturated axes, length 2 R⊕
 *   - Fixed in space — axes point to fixed stars
 *   - X → vernal equinox, Y → 90° east in the equatorial plane, Z → north celestial pole
 *   - Earth ROTATES within this frame; SGP4 outputs positions here
 *
 * ECEF (Earth-Centered, Earth-Fixed) — dashed, pastel axes, length 1.6 R⊕
 *   - Rotates with Earth — axes fixed to the surface
 *   - X → equator × prime meridian (0°N, 0°E), Y → 90°E on the equator, Z → north pole
 *   - A fixed point on the ground has constant ECEF coordinates
 *   - Drawn with a prime-meridian arc so you can see it carried round by the Earth
 *
 * Both frames use the same hue per axis (X red, Y green, Z blue), so "same axis,
 * different frame" is obvious; solid vs dashed (and length) tells the frames apart.
 * The yellow arc between ECI-X and ECEF-X is GMST (θ), the angle linking them.
 * The white arrow is the ISS position vector — one vector in space, whose
 * components differ between the frames (see the data panels).
 *
 * Scene axes: three.js is Y-up, so ECI/ECEF (x, y, z) map to scene (x, z, -y).
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { R_EARTH, SCALE } from './globe.js';

const ECI_LENGTH  = R_EARTH * 2.0;
const ECEF_LENGTH = R_EARTH * 1.6;
const LINE_WIDTH  = 1.5;   // px

// Keep in sync with the --eci-* / --ecef-* variables in style.css
const ECI_COLORS  = { x: 0xff4444, y: 0x44dd44, z: 0x4488ff };
const ECEF_COLORS = { x: 0xffa0a0, y: 0xa0ffa0, z: 0xa0c8ff };
const VECTOR_COLOR = 0xffffff;
const GMST_COLOR   = 0xffe600;
const RING_COLOR   = 0x4a6a99;

let scene;
let eciGroup  = null;
let ecefGroup = null;
let equatorRing = null;
let positionVector = null;

// Every LineMaterial needs the viewport size to turn pixel widths into geometry
const lineMaterials = [];

// HTML labels (created once, repositioned each frame)
let labelLayer = null;
const labels = [];          // { el, group, local: Vector3 }  — anchored to an axis tip
let gmstLabel = null;       // { el, world: Vector3 }          — anchored to the GMST arc
let gmstArc = null;

const _p = new THREE.Vector3();   // scratch vectors, reused every frame
const _d = new THREE.Vector3();

export function initFrames(threeScene) {
  scene = threeScene;

  labelLayer = document.createElement('div');
  labelLayer.id = 'axis-labels';
  document.body.appendChild(labelLayer);

  createECIFrame();
  createECEFFrame();
  createEquatorRing();
  createPositionVector();
  createGMSTArc();

  window.addEventListener('resize', () => {
    lineMaterials.forEach(m => m.resolution.set(window.innerWidth, window.innerHeight));
  });

  setECIVisible(false);
  setECEFVisible(false);
}

// ── Line helper ──────────────────────────────────────────────────────────────

/** Opaque, un-tonemapped Line2 so the map beneath can't tint it. */
function makeLine(positions, color, { dashed = false, width = LINE_WIDTH } = {}) {
  const mat = new LineMaterial({
    color,
    linewidth: width,
    transparent: false,
    depthWrite: false,
    toneMapped: false,
    dashed,
    dashSize: 0.12,
    gapSize: 0.08,
  });
  mat.resolution.set(window.innerWidth, window.innerHeight);
  lineMaterials.push(mat);

  const geom = new LineGeometry();
  geom.setPositions(positions);
  const line = new Line2(geom, mat);
  if (dashed) line.computeLineDistances();
  line.frustumCulled = false;
  return line;
}

// ── ECI Frame ────────────────────────────────────────────────────────────────

function createECIFrame() {
  eciGroup = new THREE.Group();
  eciGroup.name = 'eci_frame';

  addAxis(eciGroup, new THREE.Vector3(1, 0, 0),  ECI_COLORS.x, ECI_LENGTH, false, 'ECI X\nVernal Equinox');
  addAxis(eciGroup, new THREE.Vector3(0, 0, -1), ECI_COLORS.y, ECI_LENGTH, false, 'ECI Y\n90°E Equatorial');
  addAxis(eciGroup, new THREE.Vector3(0, 1, 0),  ECI_COLORS.z, ECI_LENGTH, false, 'ECI Z\nNorth Pole');

  scene.add(eciGroup);
}

// ── ECEF Frame ───────────────────────────────────────────────────────────────

function createECEFFrame() {
  ecefGroup = new THREE.Group();
  ecefGroup.name = 'ecef_frame';

  addAxis(ecefGroup, new THREE.Vector3(1, 0, 0),  ECEF_COLORS.x, ECEF_LENGTH, true, 'ECEF X\nPrime Meridian');
  addAxis(ecefGroup, new THREE.Vector3(0, 0, -1), ECEF_COLORS.y, ECEF_LENGTH, true, 'ECEF Y\n90°E Meridian');
  addAxis(ecefGroup, new THREE.Vector3(0, 1, 0),  ECEF_COLORS.z, ECEF_LENGTH, true, 'ECEF Z\nGeog. North Pole');

  // Prime-meridian arc (lon 0°, pole to pole) just above the surface: it is
  // carried round with the Earth, unlike the fixed ECI axes.
  const R = R_EARTH * 1.01, pts = [];
  for (let i = 0; i <= 64; i++) {
    const lat = -Math.PI / 2 + (Math.PI * i) / 64;
    pts.push(R * Math.cos(lat), R * Math.sin(lat), 0);
  }
  ecefGroup.add(makeLine(pts, ECEF_COLORS.x, { dashed: true }));

  scene.add(ecefGroup);
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function addAxis(group, direction, color, length, dashed, labelText) {
  const end = direction.clone().multiplyScalar(length);

  group.add(makeLine([0, 0, 0, end.x, end.y, end.z], color, { dashed }));

  // Arrowhead cone at the tip
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.04, 0.12, 12),
    new THREE.MeshBasicMaterial({ color, toneMapped: false, depthWrite: false })
  );
  arrow.position.copy(end);
  arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  group.add(arrow);

  addLabel(group, end, labelText, color);
}

/** Equatorial reference plane ring — the same for both frames, so one shared ring. */
function createEquatorRing() {
  const R = R_EARTH * 1.8, pts = [];
  for (let i = 0; i <= 96; i++) {
    const a = (Math.PI * 2 * i) / 96;
    pts.push(R * Math.cos(a), 0, R * Math.sin(a));
  }
  equatorRing = makeLine(pts, RING_COLOR, { width: 1 });
  scene.add(equatorRing);
}

/** The ISS position vector (origin → ISS). Identical in both frames; only its components differ. */
function createPositionVector() {
  positionVector = makeLine([0, 0, 0, 0, 0, 0], VECTOR_COLOR);
  positionVector.name = 'iss_position_vector';
  scene.add(positionVector);
}

/**
 * Point the position vector at the ISS. Uses the ECI vector from SGP4 directly
 * (km → scene units, mapped to the Y-up scene axes).
 */
export function updateFrameVectors(state) {
  if (!positionVector || !state?.r_eci) return;
  const [x, y, z] = state.r_eci;
  positionVector.geometry.dispose();
  positionVector.geometry = new LineGeometry();
  positionVector.geometry.setPositions([0, 0, 0, x * SCALE, z * SCALE, -y * SCALE]);
}

// ── GMST Rotation for ECEF ───────────────────────────────────────────────────

/**
 * Rotate the ECEF frame to match Earth's current rotation.
 * When GMST = θ, the prime meridian (ECEF X) sits at angle θ from the
 * vernal equinox (ECI X). Three.js rotates about +Y (our north axis).
 *
 * @param {number} gmst_rad - Greenwich Mean Sidereal Time in radians
 */
export function updateECEFRotation(gmst_rad) {
  if (ecefGroup) ecefGroup.rotation.y = gmst_rad;
}

// ── Visibility Toggles ───────────────────────────────────────────────────────

function refreshShared() {
  const eci  = !!eciGroup?.visible;
  const ecef = !!ecefGroup?.visible;
  if (equatorRing)    equatorRing.visible    = eci || ecef;
  if (positionVector) positionVector.visible = eci || ecef;
  if (!(eci && ecef)) hideGMST();
}

export function setECIVisible(visible) {
  if (eciGroup) eciGroup.visible = visible;
  refreshShared();
}

export function setECEFVisible(visible) {
  if (ecefGroup) ecefGroup.visible = visible;
  refreshShared();
}

// ── HTML Labels (projected 3D → 2D) ─────────────────────────────────────────

function makeLabelEl(text, color) {
  const el = document.createElement('div');
  el.className = 'axis-label';
  el.style.color = `#${color.toString(16).padStart(6, '0')}`;
  el.textContent = text;
  el.style.display = 'none';
  labelLayer.appendChild(el);
  return el;
}

function addLabel(group, local, text, color) {
  labels.push({ el: makeLabelEl(text, color), group, local: local.clone() });
}

/** True if the Earth sphere sits between the camera and `point`. */
function isOccludedByEarth(camera, point) {
  _d.copy(point).sub(camera.position);
  const dist = _d.length();
  _d.divideScalar(dist);
  const b = camera.position.dot(_d);
  const c = camera.position.lengthSq() - R_EARTH * R_EARTH;
  const disc = b * b - c;
  if (disc <= 0) return false;
  const t = -b - Math.sqrt(disc);   // near intersection with the sphere
  return t > 0 && t < dist;
}

// Panels the labels should not run underneath. Rectangles are cached for a few
// frames (reading layout every frame for every label would be wasteful).
const UI_SELECTOR = '#hud, #controls, #timebar, #passes-panel, #tle-panel, #info-panel, #frame-panels.visible, #connection-status';
let uiRects = [], uiRectsAt = 0;
function isUnderUI(x, y) {
  const now = performance.now();
  if (now - uiRectsAt > 400) {
    uiRectsAt = now;
    uiRects = [...document.querySelectorAll(UI_SELECTOR)].map(e => e.getBoundingClientRect());
  }
  // The label extends right of and below its anchor; test a point and its far corner
  return uiRects.some(r => (x > r.left - 4 && x < r.right && y > r.top - 4 && y < r.bottom) ||
                           (x + 70 > r.left && x + 70 < r.right && y + 12 > r.top && y + 12 < r.bottom));
}

function placeLabel(el, world, camera, rect) {
  if (isOccludedByEarth(camera, world)) { el.style.display = 'none'; return; }
  _p.copy(world).project(camera);
  if (_p.z > 1 || _p.z < -1) { el.style.display = 'none'; return; }   // behind camera
  const x = rect.left + (_p.x + 1) / 2 * rect.width;
  const y = rect.top  + (-_p.y + 1) / 2 * rect.height;
  if (isUnderUI(x + 8, y - 8)) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.transform = `translate(${x + 8}px, ${y - 8}px)`;
}

/**
 * Reposition the axis labels over their 3D anchors. Called every frame from
 * the render loop; elements are created once and only moved here.
 */
export function updateAxisLabels(camera, renderer) {
  const rect = renderer.domElement.getBoundingClientRect();

  for (const { el, group, local } of labels) {
    if (!group.visible) { el.style.display = 'none'; continue; }
    group.localToWorld(_p.copy(local));
    placeLabel(el, _p.clone(), camera, rect);
  }

  if (gmstLabel && gmstLabel.el.dataset.on === '1') {
    placeLabel(gmstLabel.el, gmstLabel.world, camera, rect);
  }
}

// ── GMST Angle Indicator ─────────────────────────────────────────────────────

function createGMSTArc() {
  gmstArc = makeLine([0, 0, 0, 0, 0, 0], GMST_COLOR);
  gmstArc.name = 'gmst_arc';
  gmstArc.visible = false;
  scene.add(gmstArc);

  gmstLabel = { el: makeLabelEl('θ', GMST_COLOR), world: new THREE.Vector3() };
  gmstLabel.el.dataset.on = '0';
}

function hideGMST() {
  if (gmstArc) gmstArc.visible = false;
  if (gmstLabel) { gmstLabel.el.dataset.on = '0'; gmstLabel.el.style.display = 'none'; }
}

/**
 * Draw an arc on the equatorial plane from ECI-X to ECEF-X, labelled with θ.
 * Only shown when both frames are visible.
 */
export function updateGMSTIndicator(gmst_rad) {
  if (!eciGroup?.visible || !ecefGroup?.visible) { hideGMST(); return; }

  const R = R_EARTH * 1.5, segments = 48, pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = (gmst_rad * i) / segments;
    pts.push(R * Math.cos(a), 0, -R * Math.sin(a));   // east = -Z in our scene
  }
  gmstArc.geometry.dispose();
  gmstArc.geometry = new LineGeometry();
  gmstArc.geometry.setPositions(pts);
  gmstArc.visible = true;

  const mid = gmst_rad / 2, Rl = R_EARTH * 1.62;
  gmstLabel.world.set(Rl * Math.cos(mid), 0, -Rl * Math.sin(mid));
  gmstLabel.el.textContent = `θ ${(gmst_rad * 180 / Math.PI).toFixed(1)}°`;
  gmstLabel.el.dataset.on = '1';
}
