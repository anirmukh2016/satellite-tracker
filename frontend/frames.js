/**
 * frames.js — ECI and ECEF coordinate axis visualization
 *
 * Demonstrates the key difference between the two coordinate systems:
 *
 * ECI (Earth-Centered Inertial):
 *   - Fixed in space — axes point to fixed stars
 *   - X → vernal equinox (reference direction in space)
 *   - Y → 90° east in equatorial plane
 *   - Z → north celestial pole
 *   - Earth ROTATES within this frame
 *   - Used by SGP4 for propagation
 *
 * ECEF (Earth-Centered, Earth-Fixed):
 *   - Rotates with Earth — axes fixed to Earth's surface
 *   - X → intersection of equator and prime meridian (0°N, 0°E)
 *   - Y → 90°E on equator
 *   - Z → geographic north pole
 *   - A fixed point on the ground has constant ECEF coordinates
 *   - Used for lat/lon/alt calculations
 *
 * Visually: toggle both on to see ECI axes stay fixed while ECEF rotates.
 * The angle between them is GMST.
 */

import * as THREE from 'three';
import { R_EARTH } from './globe.js';

const AXIS_LENGTH = R_EARTH * 2.0;  // Axes extend to 2x Earth radius
const AXIS_WIDTH  = 0.003;

let scene;
let eciGroup  = null;
let ecefGroup = null;

// Labels (HTML elements positioned over 3D axes)
let eciLabels  = [];
let ecefLabels = [];

// Current GMST for ECEF rotation
let currentGMST = 0;

export function initFrames(threeScene) {
  scene = threeScene;
  createECIFrame();
  createECEFFrame();
  setECIVisible(false);
  setECEFVisible(false);
}

// ── ECI Frame ────────────────────────────────────────────────────────────────

function createECIFrame() {
  eciGroup = new THREE.Group();
  eciGroup.name = 'eci_frame';

  // X-axis: Red — points to vernal equinox (γ, the First Point of Aries)
  addAxis(eciGroup, new THREE.Vector3(1, 0, 0), 0xff4444, 'ECI X\nVernal Equinox');

  // Y-axis: Green — 90° east in equatorial plane
  addAxis(eciGroup, new THREE.Vector3(0, 0, -1), 0x44ff44, 'ECI Y\n90°E Equatorial');

  // Z-axis: Blue — north celestial pole (aligned with Earth's rotation axis)
  addAxis(eciGroup, new THREE.Vector3(0, 1, 0), 0x4444ff, 'ECI Z\nNorth Pole');

  // Add equatorial plane ring (faint) to show reference plane
  addEquatorialRing(eciGroup, 0x334466, 0.06);

  scene.add(eciGroup);
}

// ── ECEF Frame ───────────────────────────────────────────────────────────────

function createECEFFrame() {
  ecefGroup = new THREE.Group();
  ecefGroup.name = 'ecef_frame';

  // X-axis: Orange-Red — points to 0°E on equator (prime meridian)
  addAxis(ecefGroup, new THREE.Vector3(1, 0, 0), 0xff6622, 'ECEF X\nPrime Meridian');

  // Y-axis: Orange-Green — points to 90°E on equator
  addAxis(ecefGroup, new THREE.Vector3(0, 0, -1), 0x88ff22, 'ECEF Y\n90°E Meridian');

  // Z-axis: Orange-Blue — points to geographic north pole
  addAxis(ecefGroup, new THREE.Vector3(0, 1, 0), 0x22aaff, 'ECEF Z\nGeog. North Pole');

  // Add equatorial plane ring
  addEquatorialRing(ecefGroup, 0x443300, 0.06);

  scene.add(ecefGroup);
}

// ── Axis Creation Helper ─────────────────────────────────────────────────────

function addAxis(group, direction, color, labelText) {
  // Shaft: cylinder from origin along direction
  const start = new THREE.Vector3(0, 0, 0);
  const end   = direction.clone().multiplyScalar(AXIS_LENGTH);

  // Create line for the axis
  const points  = [start, end];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  group.add(line);

  // Arrowhead cone at tip
  const arrowGeom = new THREE.ConeGeometry(0.04, 0.12, 12);
  const arrowMat  = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const arrow = new THREE.Mesh(arrowGeom, arrowMat);

  // Position and orient the arrowhead
  arrow.position.copy(end);
  const defaultDir = new THREE.Vector3(0, 1, 0);
  const quaternion = new THREE.Quaternion();
  quaternion.setFromUnitVectors(defaultDir, direction.clone().normalize());
  arrow.quaternion.copy(quaternion);

  group.add(arrow);

  // Store label info for HTML label positioning
  group.userData.labels = group.userData.labels || [];
  group.userData.labels.push({ position: end.clone(), text: labelText, color });
}

function addEquatorialRing(group, color, opacity) {
  const ringGeom = new THREE.RingGeometry(R_EARTH * 1.8, R_EARTH * 1.85, 64);
  const ringMat  = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.rotation.x = Math.PI / 2; // Rotate to lie in the XZ plane (equatorial)
  group.add(ring);
}

// ── GMST Rotation for ECEF ───────────────────────────────────────────────────

/**
 * Rotate ECEF frame to match Earth's current rotation.
 *
 * The ECEF frame is always aligned with Earth's surface.
 * When GMST = θ, the prime meridian (ECEF X) is at angle θ from the
 * vernal equinox (ECI X).
 *
 * @param {number} gmst_rad - Greenwich Mean Sidereal Time in radians
 */
export function updateECEFRotation(gmst_rad) {
  currentGMST = gmst_rad;
  if (ecefGroup) {
    // ECEF rotates about Z by -GMST relative to ECI
    // In our coordinate system, Y is north, so we rotate about Y
    ecefGroup.rotation.y = gmst_rad;
  }
}

// ── Visibility Toggles ───────────────────────────────────────────────────────

export function setECIVisible(visible) {
  if (eciGroup) eciGroup.visible = visible;
}

export function setECEFVisible(visible) {
  if (ecefGroup) ecefGroup.visible = visible;
}

export function isECIVisible()  { return eciGroup  ? eciGroup.visible  : false; }
export function isECEFVisible() { return ecefGroup ? ecefGroup.visible : false; }

// ── HTML Labels (projected 3D → 2D) ─────────────────────────────────────────

/**
 * Create and update HTML labels positioned over the axis tips.
 * Called from the main render loop to update positions.
 *
 * @param {THREE.Camera} camera
 * @param {THREE.WebGLRenderer} renderer
 */
export function updateAxisLabels(camera, renderer) {
  // Remove old labels
  document.querySelectorAll('.axis-label').forEach(el => el.remove());

  const canvas = renderer.domElement;
  const width  = canvas.clientWidth;
  const height = canvas.clientHeight;

  function projectAndDraw(group, visible) {
    if (!visible || !group) return;
    const labels = group.userData.labels || [];

    labels.forEach(({ position, text, color }) => {
      // Transform position from group local space to world space
      const worldPos = position.clone();
      group.localToWorld(worldPos);

      // Project to NDC (-1 to 1)
      const ndc = worldPos.clone().project(camera);

      // Check if behind camera
      if (ndc.z > 1) return;

      // Convert NDC to screen pixels
      const x = ( ndc.x + 1) / 2 * width;
      const y = (-ndc.y + 1) / 2 * height;

      // Create HTML element
      const el = document.createElement('div');
      el.className = 'axis-label';
      el.style.cssText = `
        position: fixed;
        left: ${x + 8}px;
        top:  ${y - 8}px;
        color: #${color.toString(16).padStart(6, '0')};
        font-size: 10px;
        font-family: 'Courier New', monospace;
        pointer-events: none;
        white-space: pre;
        text-shadow: 0 0 6px rgba(0,0,0,0.9);
        z-index: 40;
        line-height: 1.3;
        opacity: 0.9;
      `;
      el.textContent = text;
      document.body.appendChild(el);
    });
  }

  projectAndDraw(eciGroup,  eciGroup  && eciGroup.visible);
  projectAndDraw(ecefGroup, ecefGroup && ecefGroup.visible);
}

// ── GMST Angle Indicator ─────────────────────────────────────────────────────

let gmstIndicator = null;

/**
 * Draw a small arc on the equatorial plane showing the GMST angle
 * between ECI-X and ECEF-X.
 */
export function updateGMSTIndicator(gmst_rad) {
  // Remove old indicator
  if (gmstIndicator) {
    scene.remove(gmstIndicator);
    gmstIndicator.geometry.dispose();
    gmstIndicator = null;
  }

  // Only show when both frames are visible
  if (!eciGroup?.visible || !ecefGroup?.visible) return;

  const R = R_EARTH * 1.5;
  const segments = 32;
  const points   = [];

  // Arc from 0 to gmst_rad in the XZ plane (equatorial plane in our system)
  for (let i = 0; i <= segments; i++) {
    const angle = (gmst_rad * i) / segments;
    points.push(new THREE.Vector3(
      R * Math.cos(angle),
      0,
      -R * Math.sin(angle)  // Negative: east = -Z in our coord convention
    ));
  }

  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat  = new THREE.LineBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  gmstIndicator = new THREE.Line(geom, mat);
  gmstIndicator.name = 'gmst_arc';
  scene.add(gmstIndicator);
}
