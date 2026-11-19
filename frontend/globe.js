/**
 * globe.js — Three.js Earth globe, atmosphere, stars
 *
 * Sets up the 3D scene:
 *   - Earth sphere with NASA Blue Marble texture
 *   - Glow atmosphere (additive blending)
 *   - Star field (5000 random points)
 *   - Lighting (ambient + directional sun)
 *   - Camera + OrbitControls for mouse interaction
 *   - Render loop
 *
 * Earth rotation: matches real sidereal rate (86164s per revolution)
 * via GMST from the backend — so the globe position always matches
 * the coordinate calculations.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Earth radius in km (WGS84 equatorial)
export const EARTH_RADIUS_KM = 6378.137;

// Scene scale: 1 Three.js unit = 1000 km (so Earth radius ≈ 6.378 units)
export const SCALE = 1 / 1000;

// Three.js unit equivalent of Earth radius
export const R_EARTH = EARTH_RADIUS_KM * SCALE;

let scene, camera, renderer, controls;
let earthMesh, atmosphereMesh;
let sunLight;

// Uniforms for the day/night + visible-zone shading (see createEarth).
// Directions are unit vectors in the world frame (ECI mapped to scene axes).
const earthUniforms = {
  uSunDir:    { value: new THREE.Vector3(1, 0, 0) },
  uIssDir:    { value: new THREE.Vector3(1, 0, 0) },
  uVisCos:    { value: 1.0 },   // cos of the visible-zone angular radius around the ISS
  uIssSunlit: { value: 0.0 },   // 1 when the ISS is in sunlight
  uNightOn:   { value: 1.0 },
  uZoneOn:    { value: 0.0 },   // In-View Zone toggle (outline + fill)
};
let starField;

// Current GMST from backend (radians) — set by ui.js
let currentGMST = 0;

export function initGlobe(canvas) {
  // ── Scene ────────────────────────────────────────────────────────────────
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000005);

  // ── Camera ───────────────────────────────────────────────────────────────
  camera = new THREE.PerspectiveCamera(
    45,                                    // field of view (degrees)
    window.innerWidth / window.innerHeight, // aspect ratio
    0.01,                                  // near clip
    1000                                   // far clip
  );
  camera.position.set(0, 3, 26); // Globe fills ~60% of screen height

  // ── Renderer ─────────────────────────────────────────────────────────────
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,  // prevents z-fighting between Earth and trail
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  // ── OrbitControls ────────────────────────────────────────────────────────
  // Allows user to rotate/zoom the globe with mouse
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = R_EARTH * 1.3;  // can't go inside Earth
  controls.maxDistance = R_EARTH * 25;
  controls.autoRotate = false;

  // ── Lighting ─────────────────────────────────────────────────────────────
  // Ambient: soft fill light so dark side isn't pitch black
  const ambient = new THREE.AmbientLight(0x334466, 0.4);
  scene.add(ambient);

  // Directional: the Sun (moved to the real direction by updateSunLighting)
  sunLight = new THREE.DirectionalLight(0xffffff, 1.8);
  sunLight.position.set(50, 20, 30);
  scene.add(sunLight);

  // Hemisphere: subtle blue sky / brown ground gradient
  const hemi = new THREE.HemisphereLight(0x1a2a4a, 0x0a0a14, 0.3);
  scene.add(hemi);

  // ── Earth ────────────────────────────────────────────────────────────────
  createEarth();

  // ── Atmosphere ───────────────────────────────────────────────────────────
  createAtmosphere();

  // ── Stars ────────────────────────────────────────────────────────────────
  createStars();

  // ── Resize handler ───────────────────────────────────────────────────────
  window.addEventListener('resize', onResize);

  return { scene, camera, renderer, controls };
}

function createEarth() {
  // High-resolution sphere: 64 segments gives a smooth appearance
  const geometry = new THREE.SphereGeometry(R_EARTH, 64, 64);

  // Load NASA Blue Marble texture
  // Fallback: procedural if texture fails to load
  const loader = new THREE.TextureLoader();
  const texture = loader.load(
    '/textures/earth_daymap.jpg',
    () => { /* loaded */ },
    undefined,
    () => {
      // Texture not found — use a simple procedural material
      console.warn('[Globe] Earth texture not found, using procedural material');
      earthMesh.material = createProceduralEarthMaterial();
    }
  );

  const material = new THREE.MeshBasicMaterial({
    map: texture,
  });
  material.onBeforeCompile = patchEarthShader;

  earthMesh = new THREE.Mesh(geometry, material);
  earthMesh.name = 'earth';
  scene.add(earthMesh);
}

/**
 * Add the day/night terminator and the ISS "visible zone" to the Earth's basic
 * material (keeping its tone-mapping and colour handling). The Earth mesh is
 * rotated by GMST, so the world-space normal is compared with ECI directions.
 *
 *  - night: darken by the sun's elevation at each point, with a soft twilight band
 *    (sun ≈ −18° … +4.6°), leaving continents faintly visible
 *  - zone: a ring where the ISS is 10° above the horizon (uVisCos), always drawn when on.
 *    Inside it, a green fill only where the ground is dark (sun below −6°) and the ISS is
 *    sunlit — i.e. where you could actually see it
 */
function patchEarthShader(shader) {
  Object.assign(shader.uniforms, earthUniforms);

  shader.vertexShader = 'varying vec3 vWN;\n' + shader.vertexShader.replace(
    '#include <begin_vertex>',
    '#include <begin_vertex>\n  vWN = normalize(mat3(modelMatrix) * normal);'
  );

  shader.fragmentShader = `
    varying vec3 vWN;
    uniform vec3 uSunDir;
    uniform vec3 uIssDir;
    uniform float uVisCos;
    uniform float uIssSunlit;
    uniform float uNightOn;
    uniform float uZoneOn;
  ` + shader.fragmentShader.replace(
    '#include <map_fragment>',
    `#include <map_fragment>
    vec3 wn = normalize(vWN);
    vec3 dayColor = diffuseColor.rgb;                                // texture, linear light
    float sunDot = dot(wn, uSunDir);
    float day = smoothstep(-0.31, 0.08, sunDot);
    // Night factors are in linear light, so they look brighter than their value
    vec3 shade = mix(vec3(0.03, 0.04, 0.085), vec3(1.0), day);
    diffuseColor.rgb = dayColor * mix(vec3(1.0), shade, uNightOn);

    float cosA = dot(wn, uIssDir);
    float dark = 1.0 - smoothstep(-0.13, -0.08, sunDot);             // sun below about -6 degrees
    float fillOn = uZoneOn * uIssSunlit * dark;
    float inZone = smoothstep(uVisCos - 0.0008, uVisCos + 0.0008, cosA);
    float rim = 1.0 - smoothstep(0.0, 0.0012, abs(cosA - uVisCos));
    vec3 zoneColor = dayColor * 0.55 + vec3(0.02, 0.10, 0.05);       // the ground lit up where the ISS is visible
    diffuseColor.rgb = mix(diffuseColor.rgb, zoneColor, fillOn * inZone * 0.9);
    diffuseColor.rgb += uZoneOn * rim * vec3(0.25, 0.8, 0.45);   // outline: always`
  );
}

function createProceduralEarthMaterial() {
  // Simple blue-green procedural Earth when no texture is available
  return new THREE.MeshPhongMaterial({
    color: 0x1a4a7a,
    emissive: 0x001122,
    specular: 0x224466,
    shininess: 20,
    wireframe: false,
  });
}

function createAtmosphere() {
  // Slightly larger sphere, rendered with additive blending
  // Creates a glowing blue halo effect around the Earth
  const geometry = new THREE.SphereGeometry(R_EARTH * 1.025, 64, 64);
  const material = new THREE.MeshPhongMaterial({
    color: 0x2255ff,
    emissive: 0x001133,
    transparent: true,
    opacity: 0.08,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,  // Don't write to depth buffer — renders over everything
  });

  atmosphereMesh = new THREE.Mesh(geometry, material);
  atmosphereMesh.name = 'atmosphere';
  scene.add(atmosphereMesh);

  // Outer glow ring
  const glowGeom = new THREE.SphereGeometry(R_EARTH * 1.06, 64, 64);
  const glowMat = new THREE.MeshPhongMaterial({
    color: 0x0033aa,
    emissive: 0x000033,
    transparent: true,
    opacity: 0.04,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowMesh = new THREE.Mesh(glowGeom, glowMat);
  scene.add(glowMesh);
}

function createStars() {
  // 5000 random stars on a large sphere
  const N = 5000;
  const positions = new Float32Array(N * 3);
  const sizes = new Float32Array(N);
  const colors = new Float32Array(N * 3);

  for (let i = 0; i < N; i++) {
    // Random direction on unit sphere
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 500 + Math.random() * 200; // far away

    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    // Variable star sizes
    sizes[i] = 0.5 + Math.random() * 2.0;

    // Slight color variation: some stars are bluer, some warmer
    const t = Math.random();
    if (t < 0.1) {
      // Blue-white stars
      colors[i * 3] = 0.8; colors[i * 3 + 1] = 0.9; colors[i * 3 + 2] = 1.0;
    } else if (t < 0.15) {
      // Warm orange stars
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.6;
    } else {
      // White/near-white
      const b = 0.7 + Math.random() * 0.3;
      colors[i * 3] = b; colors[i * 3 + 1] = b; colors[i * 3 + 2] = b;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.8,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  starField = new THREE.Points(geometry, material);
  starField.name = 'stars';
  scene.add(starField);
}

/**
 * Convert geographic coordinates to 3D position on the globe.
 *
 * The conversion follows spherical coordinate geometry:
 *   x = (R + alt) * cos(lat) * cos(lon)    (towards prime meridian)
 *   y = (R + alt) * sin(lat)               (towards north pole)
 *   z = (R + alt) * cos(lat) * sin(lon)    (towards 90°E)
 *
 * Note: In Three.js convention, Y is "up" (north pole direction).
 *
 * @param {number} lat - Geodetic latitude (degrees)
 * @param {number} lon - Longitude (degrees)
 * @param {number} alt_km - Altitude above Earth surface (km)
 * @returns {THREE.Vector3}
 */
export function latLonAltToXYZ(lat, lon, alt_km) {
  const lat_r = THREE.MathUtils.degToRad(lat);
  const lon_r = THREE.MathUtils.degToRad(lon);
  const r = (EARTH_RADIUS_KM + alt_km) * SCALE;

  return new THREE.Vector3(
    r * Math.cos(lat_r) * Math.cos(lon_r),
    r * Math.sin(lat_r),
    -r * Math.cos(lat_r) * Math.sin(lon_r)
  );
}

/**
 * Update Earth rotation to match real GMST.
 *
 * Earth's Y-axis rotation in Three.js corresponds to the ECEF frame rotation.
 * When GMST increases, Earth rotates eastward (positive Y rotation in our setup).
 *
 * @param {number} gmst_rad - Greenwich Mean Sidereal Time in radians
 */
/**
 * Feed the sun and ISS geometry to the Earth shader and the scene's sun light.
 * All vectors are ECI; they are mapped to scene axes (x, z, −y) here.
 *
 * @param {number[]} sunDirEci - unit vector Earth → Sun
 * @param {number[]} issDirEci - ISS position direction (any length)
 * @param {boolean}  issSunlit
 * @param {number}   visCos    - cos of the visible-zone angular radius
 */
export function updateSunLighting({ sunDirEci, issDirEci, issSunlit, visCos }) {
  const toScene = ([x, y, z]) => new THREE.Vector3(x, z, -y).normalize();
  const sun = toScene(sunDirEci);
  earthUniforms.uSunDir.value.copy(sun);
  earthUniforms.uIssDir.value.copy(toScene(issDirEci));
  earthUniforms.uVisCos.value = visCos;
  earthUniforms.uIssSunlit.value = issSunlit ? 1.0 : 0.0;
  if (sunLight) sunLight.position.copy(sun).multiplyScalar(50);   // light the ISS from the real sun side
}

export function setNightVisible(on) {
  earthUniforms.uNightOn.value = on ? 1.0 : 0.0;
}

export function setZoneVisible(on) {
  earthUniforms.uZoneOn.value = on ? 1.0 : 0.0;
}

export function updateEarthRotation(gmst_rad) {
  if (earthMesh) {
    // Negate because Three.js rotates counter-clockwise around +Y,
    // but GMST measures eastward rotation
    earthMesh.rotation.y = gmst_rad;
  }
  currentGMST = gmst_rad;
}

/**
 * Rotate the camera to face the ISS on initial load.
 * Keeps the same orbital distance but points the camera directly at the ISS.
 */
export function pointCameraAtISS(lat, lon, alt_km, gmst_rad) {
  // Compute ISS world-space position (mirrors the formula in iss.js)
  const ecef = latLonAltToXYZ(lat, lon, alt_km);
  const cosG = Math.cos(gmst_rad);
  const sinG = Math.sin(gmst_rad);
  const wx = ecef.x * cosG + ecef.z * sinG;
  const wy = ecef.y;
  const wz = -ecef.x * sinG + ecef.z * cosG;

  // Move camera along the ISS direction at the same distance
  const dist = camera.position.length();
  const len  = Math.sqrt(wx * wx + wy * wy + wz * wz);
  camera.position.set(
    (wx / len) * dist,
    (wy / len) * dist,
    (wz / len) * dist
  );
  controls.update();
}

export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getControls() { return controls; }
export function getEarthMesh() { return earthMesh; }

export function startRenderLoop(onFrame) {
  function animate() {
    requestAnimationFrame(animate);
    controls.update();  // Required for damping
    onFrame();
    renderer.render(scene, camera);
  }
  animate();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
