# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Start the application (recommended):**
```bash
bash run.sh
```
This installs Python dependencies and starts the FastAPI server with hot-reload at http://localhost:8000.

**Manual backend start:**
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000 --host 0.0.0.0
```

**Production (Heroku):**
```bash
uvicorn backend.main:app --host 0.0.0.0 --port $PORT
```

There are no test or lint configurations in this project.

## Architecture Overview

This is a real-time ISS tracker with a Python FastAPI backend and a vanilla JavaScript/Three.js frontend. The frontend is served as static files by the backend — no separate frontend server or bundler.

### Data Flow

```
Celestrak.org → tle_fetcher.py (1h cache) → propagator.py (SGP4 + coordinate math)
                                                       ↓
Browser ← WebSocket (2s updates) ← main.py endpoints (/api/tle, /api/orbit, /ws)
   ↓
ui.js → distributes data to: globe.js, iss.js, frames.js, HUD
```

### Backend (`backend/`)

- **`main.py`** — FastAPI app. Serves `frontend/` as static files at `/`. REST endpoints: `/api/tle`, `/api/orbit`, `/api/position`. WebSocket at `/ws` streams position every 2 seconds.
- **`propagator.py`** — The physics core. SGP4 propagation → ECI → ECEF → geodetic (lat/lon/alt). Also computes GMST for Earth rotation, speed, and orbit trail points.
- **`tle_fetcher.py`** — Fetches ISS TLE from Celestrak (NORAD ID 25544), caches for 1 hour. Falls back to stale cache on fetch failure.

### Frontend (`frontend/`)

Uses Three.js r160 via CDN import maps — no npm/bundler involved.

- **`index.html`** — Single-page app. Initializes all modules in sequence. Contains HUD, TLE panel, controls panel, and ECI vector display as HTML overlays.
- **`globe.js`** — 3D scene: Earth sphere (Blue Marble texture, 64-segment), atmosphere, 5000-star field, lighting. Exports `latLonAltToXYZ()` and constants used by other modules. Applies GMST rotation to Earth mesh each frame.
- **`iss.js`** — ISS marker (glowing sphere composite), orbit trails (orange past, cyan future), smooth interpolation between WebSocket updates, raycaster hover tooltip.
- **`frames.js`** — ECI (fixed in space) and ECEF (rotates with Earth) axis visualizations with HTML labels projected from 3D to screen space.
- **`ui.js`** — WebSocket client with auto-reconnect, data distribution to all modules, toggle buttons for trails and coordinate frames, TLE panel population, orbit refresh every 60s.

### Coordinate Systems

The app visualizes two reference frames as an educational feature:
- **ECI** (Earth-Centered Inertial): fixed to stars; SGP4 outputs positions in this frame
- **ECEF** (Earth-Centered, Earth-Fixed): rotates with Earth; used for lat/lon/alt

The bridge between them is **GMST** (Greenwich Mean Sidereal Time), computed in `propagator.py` and sent to the frontend to rotate the Earth mesh and ECEF axes.

### Scale

1 Three.js unit = 1,000 km. Earth radius is 6.378137 units. All positions from the backend are already in km and divided by `SCALE = 1000` in the frontend.
