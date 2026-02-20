# ISS Real-Time Satellite Tracker

A real-time 3D tracker for the International Space Station using SGP4 orbit propagation, built as a showcase project demonstrating orbital mechanics, coordinate systems, and live satellite tracking.

## Quick Start

```bash
bash run.sh
# Then open http://localhost:8000
```

Requirements: Python 3.9+, pip, internet connection.

---

## What You'll See

- **3D Earth globe** with the ISS marker updating every 2 seconds
- **Orbit trail**: orange = past 30 min, cyan = predicted next 30 min
- **HUD**: live latitude, longitude, altitude, orbital speed, UTC time
- **TLE panel** (bottom-left): raw Two-Line Element data driving the simulation
- **ECI/ECEF frame toggle** (top-right): visualize the coordinate systems with labeled axes

---

## The Physics — SGP4 Explained

### What is a TLE?

A **Two-Line Element set** (TLE) is a standardized way to encode a satellite's orbital state. NORAD publishes TLEs for all tracked objects (~25,000 of them). The ISS TLE looks like:

```
ISS (ZARYA)
1 25544U 98067A   24016.54842593  .00016717  00000-0  10270-3 0  9993
2 25544  51.6400 337.6640 0001938  86.2141 273.9285 15.49559958435128
```

Key numbers in Line 2:
| Field | Value | Meaning |
|---|---|---|
| `51.6400` | Inclination | Orbital plane tilted 51.64° from equator |
| `337.6640` | RAAN | Where orbit crosses equator going north |
| `0001938` | Eccentricity | 0.0001938 — nearly circular |
| `15.495...` | Mean motion | ~15.5 orbits per day → ~92 min period |

### SGP4 Algorithm

SGP4 solves the equations of orbital motion accounting for:
- **Earth's oblateness** (J2, J3, J4 terms) — Earth bulges at equator
- **Atmospheric drag** — encoded in the BSTAR drag term
- **Solar/lunar gravity** — for long-term predictions

Output: **ECI position** [km] and **velocity** [km/s] at any requested time.

### Coordinate Systems

```
ECI (Earth-Centered Inertial)           ECEF (Earth-Centered, Earth-Fixed)
─────────────────────────────           ──────────────────────────────────
Origin: Earth's center                  Origin: Earth's center
X-axis: → Vernal equinox (fixed)        X-axis: → Prime meridian (rotates)
Y-axis: → 90°E in equatorial plane      Y-axis: → 90°E meridian (rotates)
Z-axis: → North celestial pole          Z-axis: → Geographic north pole

Does NOT rotate with Earth              ROTATES with Earth (86164s/rev)
Used by: SGP4 output                    Used by: GPS, lat/lon/alt
```

The link between them: **GMST** (Greenwich Mean Sidereal Time) — the angle Earth has rotated from the vernal equinox. A simple rotation matrix converts ECI → ECEF:

```
[x_ecef]   [ cos θ   sin θ   0 ] [x_eci]
[y_ecef] = [-sin θ   cos θ   0 ] [y_eci]
[z_ecef]   [  0       0      1 ] [z_eci]
```

Then ECEF → geodetic (lat/lon/alt) via Bowring's iterative method on the WGS84 ellipsoid.

---

## Architecture

```
                ┌─────────────────┐
                │  Celestrak.org  │  TLE data (refreshed hourly)
                └────────┬────────┘
                         │ HTTPS GET
                ┌────────▼────────┐
                │  tle_fetcher.py │  cache with 1h TTL
                └────────┬────────┘
                         │
                ┌────────▼────────┐
                │  propagator.py  │  SGP4 → ECI → ECEF → lat/lon/alt
                └────────┬────────┘
                         │
                ┌────────▼────────┐
                │    main.py      │  FastAPI server
                │  GET /api/tle   │  → TLE + orbital params
                │  GET /api/orbit │  → ±30 min trail
                │  WS  /ws        │  → live position (2s)
                │  GET /          │  → serves frontend
                └────────┬────────┘
                         │ WebSocket
                ┌────────▼────────────────────────────────┐
                │              Browser                     │
                │  index.html → Three.js scene             │
                │  globe.js   → Earth sphere, stars        │
                │  iss.js     → ISS marker, trails         │
                │  frames.js  → ECI/ECEF axis arrows       │
                │  ui.js      → HUD, toggles, WS client    │
                └─────────────────────────────────────────┘
```

---

## File Structure

```
satellite-tracker/
├── backend/
│   ├── main.py           # FastAPI app, WebSocket endpoint
│   ├── propagator.py     # SGP4 + coordinate conversions (heavily commented)
│   ├── tle_fetcher.py    # Celestrak fetch + 1h cache
│   └── requirements.txt
├── frontend/
│   ├── index.html        # Single-page app, Three.js ESM imports
│   ├── globe.js          # Earth mesh, atmosphere, star field, render loop
│   ├── iss.js            # ISS marker, orbit trail, hover tooltip
│   ├── frames.js         # ECI/ECEF coordinate axis visualization
│   ├── ui.js             # HUD, TLE panel, toggle buttons, WebSocket
│   └── style.css         # Dark space theme
├── run.sh                # One-command startup
└── README.md
```

---

## Educational Value

### For Understanding Orbital Mechanics

1. **`propagator.py`** is heavily commented — each function explains the physics
2. The TLE panel shows what each orbital element means
3. The ECI/ECEF frame toggle visually demonstrates coordinate system differences
4. The GMST angle arc shows Earth's rotation relative to stars in real-time

### What Each Coordinate System is Good For

| System | Best For | Why |
|---|---|---|
| ECI | Propagation, spacecraft navigation | Inertial — Newton's laws apply directly |
| ECEF | Ground station contacts, GPS | Fixed to Earth — ground points have constant coords |
| Geodetic (lat/lon/alt) | Maps, display | Human-readable, matches our maps |

### Key Numbers to Notice

- **Altitude**: ~400-420 km (ISS orbital altitude)
- **Speed**: ~7.66 km/s (~27,600 km/h — 22x the speed of sound)
- **Orbital period**: ~92 minutes
- **Inclination**: 51.6° — can be overflown by any location within ±51.6° latitude

---

## Optional: Adding an Earth Texture

For the best visual, add a NASA Blue Marble texture:

1. Download from NASA: `earth_daymap.jpg` (2048×1024 or 4096×2048)
2. Place in `frontend/textures/earth_daymap.jpg`
3. The globe will automatically use it; without it, a solid blue-grey sphere is shown

---

## Blog Post Outline

If you want to write about this project:

1. **Introduction**: Why track satellites? What makes the ISS special?
2. **What is a TLE?**: Decode the numbers, explain orbital elements
3. **SGP4 Algorithm**: Simplified explanation — what perturbations it handles
4. **ECI vs ECEF**: The rotation problem, introducing GMST
5. **WGS84 Geodetic**: Why lat/lon isn't trivial — the Earth is an ellipsoid
6. **Implementation**: Python backend, Three.js frontend, WebSocket streaming
7. **Demo**: Screenshots/video of the tracker in action
8. **Further Work**: Add ground station footprint, ISS pass predictor, etc.

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Frontend (index.html) |
| `/api/tle` | GET | Current TLE + parsed orbital parameters |
| `/api/orbit` | GET | Orbit trail (±30 min, 30s steps) |
| `/api/position` | GET | Snapshot of current ISS position |
| `/ws` | WS | Live position stream (every 2 seconds) |

### WebSocket Message Format

```json
{
  "timestamp": "2024-01-15T12:34:56.789Z",
  "lat": 51.5,
  "lon": -0.1,
  "alt_km": 408.3,
  "speed_km_s": 7.663,
  "r_eci": [4000.1, 3000.2, 4500.3],
  "v_eci": [-4.5, 5.2, 3.1],
  "r_ecef": [3500.0, 2800.0, 4500.3],
  "gmst_rad": 1.234,
  "gmst_deg": 70.7
}
```

---

*Built with FastAPI, sgp4, and Three.js. TLE data from Celestrak.*
