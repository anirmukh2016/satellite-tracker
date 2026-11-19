# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm start      # dev server at http://localhost:8000 (serves frontend/ + mounts api/tle.js)
npm test       # node:test suites in tests/
```

No dependencies to install, no bundler, no lint config. Node 20+.

**Production:** Vercel (free tier). `vercel.json` sets `outputDirectory: frontend` and `cleanUrls`; `api/tle.js` is auto-detected as a serverless function. No build step.

The old FastAPI + WebSocket + Render implementation lives on the `v1` branch.

## Architecture Overview

A real-time ISS tracker. It is a static vanilla JavaScript/Three.js site; all orbital math runs in the browser. The only server code is one serverless function that proxies the TLE. (Vercel can't hold WebSockets, which is why propagation moved client-side.)

### Data Flow

```
Celestrak.org (fallback: wheretheiss.at) → api/tle.js (edge-cached 1h)
                                                  ↓
Browser: ui.js fetches TLE → orbit.js (SGP4 + coordinate math) every 2s
   ↓
ui.js → distributes data to: globe.js, iss.js, frames.js, HUD
```

### Server (`api/`)

- **`tle.js`** — `GET /api/tle` → `{name, line1, line2, source}`. Tries Celestrak, falls back to wheretheiss.at, validates TLE shape. Sends `Cache-Control: s-maxage=3600, stale-while-revalidate, stale-if-error` so Vercel's CDN absorbs traffic; errors are `no-store`.

### Frontend (`frontend/`)

Uses Three.js r160 via CDN import maps (pinned version). satellite.js and marked are vendored in `vendor/` so nothing else floats on a CDN. Assets are served from the site root (`/globe.js`, `/textures/...`).

- **`orbit.js`** — The physics core, ported from the original Python propagator. SGP4 via vendored `vendor/satellite.es.js` (satellite.js v5.0.0); GMST, ECI→ECEF, ECEF→geodetic (Bowring), speed, orbit trail and TLE parsing are written out by hand. `getFullState()` returns the same shape the old WebSocket stream sent. Also `sunDirectionEci`, `isInEarthShadow` (cylindrical) and `visibleZoneAngle` for the day/night and in-view-zone features.
- **`index.html`** — Single-page app. Initializes all modules in sequence. Contains HUD, TLE panel, controls panel, and ECI vector display as HTML overlays.
- **`globe.js`** — 3D scene (the Earth's `MeshBasicMaterial` is patched via `onBeforeCompile` for the day/night terminator and the ISS in-view zone (optional ring at 10° elevation, filled only where dark and sunlit); `updateSunLighting()` feeds it the sun/ISS vectors and moves the scene's sun light): Earth sphere, atmosphere, 5000-star field, lighting. Exports `latLonAltToXYZ()` and constants. Applies GMST rotation to Earth mesh each frame.
- **`iss.js`** — ISS marker (procedural low-poly station oriented like the real one — nose along velocity, truss across the orbit plane — with a soft blinking glow dot behind it, kept ~34px wide at any zoom), orbit trails (orange past, cyan future; 1px opaque `Line2`), smooth interpolation between 2s updates, raycaster hover tooltip. `setTrailFrame('eci'|'ecef')` switches the altitude trails between the inertial orbit (fixed in space) and the Earth-fixed view. A separate ground layer draws the dashed ground track on the surface (±46 min, from `computeOrbitTrail`), a nadir line dropping from the ISS, (there is no footprint circle: the In-View Zone ring in `globe.js` replaced it).
- **`frames.js`** — ECI (solid, saturated axes, fixed in space) and ECEF (dashed pastel axes, rotates with Earth) visualizations, same hue per axis. Opaque `Line2` lines (no additive blending); HTML labels are created once and moved each frame, hidden when the Earth occludes them. Also draws the equatorial ring, prime-meridian arc, the white ISS position vector (`updateFrameVectors`) and the yellow GMST arc with a θ label.
- **`ui.js`** — Tracking loop (2s `setInterval` computing state from the cached TLE), hourly TLE refresh, trail refresh every 60s, visibility-change catch-up, toggles, (i) help tooltips for each Visualization option (one shared `#help-tip` element, text in `data-help` attributes), ECI and ECEF data panels (`updateFramePanels`), TLE panel, stale-TLE warning (>14 days).

### Tests (`tests/`)

`orbit.test.js` checks the JS propagator against golden values produced by the original Python code; `tle-api.test.js` covers the serverless handler with mocked `fetch`.

### Coordinate Systems

- **ECI** (Earth-Centered Inertial): fixed to stars; SGP4 outputs positions in this frame
- **ECEF** (Earth-Centered, Earth-Fixed): rotates with Earth; used for lat/lon/alt

The bridge is **GMST**, computed in `orbit.js` and used to rotate the Earth mesh and ECEF axes.

### Scale

1 Three.js unit = 1,000 km. Earth radius is 6.378137 units. Positions from `orbit.js` are in km and divided by `SCALE = 1000` in the frontend.
