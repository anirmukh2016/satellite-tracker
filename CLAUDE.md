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

Uses Three.js r160 via CDN import maps. Assets are served from the site root (`/globe.js`, `/textures/...`).

- **`orbit.js`** — The physics core, ported from the original Python propagator. SGP4 via vendored `vendor/satellite.es.js` (satellite.js v5.0.0); GMST, ECI→ECEF, ECEF→geodetic (Bowring), speed, orbit trail and TLE parsing are written out by hand. `getFullState()` returns the same shape the old WebSocket stream sent.
- **`index.html`** — Single-page app. Initializes all modules in sequence. Contains HUD, TLE panel, controls panel, and ECI vector display as HTML overlays.
- **`globe.js`** — 3D scene: Earth sphere, atmosphere, 5000-star field, lighting. Exports `latLonAltToXYZ()` and constants. Applies GMST rotation to Earth mesh each frame.
- **`iss.js`** — ISS marker, orbit trails (orange past, cyan future), smooth interpolation between 2s updates, raycaster hover tooltip.
- **`frames.js`** — ECI (fixed in space) and ECEF (rotates with Earth) axis visualizations with HTML labels.
- **`ui.js`** — Tracking loop (2s `setInterval` computing state from the cached TLE), hourly TLE refresh, trail refresh every 60s, visibility-change catch-up, toggles, TLE panel, stale-TLE warning (>14 days).

### Tests (`tests/`)

`orbit.test.js` checks the JS propagator against golden values produced by the original Python code; `tle-api.test.js` covers the serverless handler with mocked `fetch`.

### Coordinate Systems

- **ECI** (Earth-Centered Inertial): fixed to stars; SGP4 outputs positions in this frame
- **ECEF** (Earth-Centered, Earth-Fixed): rotates with Earth; used for lat/lon/alt

The bridge is **GMST**, computed in `orbit.js` and used to rotate the Earth mesh and ECEF axes.

### Scale

1 Three.js unit = 1,000 km. Earth radius is 6.378137 units. Positions from `orbit.js` are in km and divided by `SCALE = 1000` in the frontend.
