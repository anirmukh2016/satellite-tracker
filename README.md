# ISS Real-Time Satellite Tracker

A real-time 3D tracker for the International Space Station using SGP4 orbit propagation, built as a showcase project demonstrating orbital mechanics, coordinate systems, and live satellite tracking.

**Live demo:** deployed on Vercel's free tier — static frontend plus one cached serverless function, so there is no cold-start wait.

## Quick Start

```bash
npm start
# Then open http://localhost:8000
```

Requirements: Node 20+ and an internet connection (to fetch the live TLE). No dependencies to install — `npm start` runs a tiny dev server that serves `frontend/` and mounts `api/tle.js` like Vercel does. Run the tests with `npm test`.

---

## What You'll See

- **3D Earth globe** with the ISS marker updating every 2 seconds
- **Orbit trail**: orange = past 30 min, cyan = predicted next 30 min
- **HUD**: live latitude, longitude, altitude, orbital speed, UTC time
- **TLE panel** (bottom-left): raw Two-Line Element data driving the simulation
- **ECI/ECEF frame toggles** (top-right): solid (ECI) vs dashed (ECEF) labeled axes, a GMST arc, the ISS position vector, and live ECI/ECEF coordinate panels showing the same vector in both frames
- **Ground Track & Footprint** toggle: dashed path of the ISS projected onto the surface (one full orbit), a line dropping to the point beneath it, and a ring showing where on Earth the ISS is currently above the horizon
- **Trails in ECI** toggle: switch the orbit trail between the Earth-fixed ground track and the true inertial orbit

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
                │   api/tle.js    │  Vercel serverless function
                │  GET /api/tle   │  → raw TLE, edge-cached 1h
                └────────┬────────┘
                         │ fetch (hourly)
                ┌────────▼────────────────────────────────┐
                │              Browser                     │
                │  orbit.js   → SGP4 → ECI → ECEF → lat/lon│
                │  index.html → Three.js scene             │
                │  globe.js   → Earth sphere, stars        │
                │  iss.js     → ISS marker, trails         │
                │  frames.js  → ECI/ECEF axis arrows       │
                │  ui.js      → HUD, toggles, 2s tick loop │
                └─────────────────────────────────────────┘
```

---

## File Structure

```
satellite-tracker/
├── api/
│   └── tle.js            # Serverless function: TLE from Celestrak (wheretheiss.at fallback)
├── frontend/             # Static site (Vercel outputDirectory)
│   ├── index.html        # Single-page app, Three.js ESM imports
│   ├── orbit.js          # SGP4 + GMST/ECI/ECEF/geodetic math (heavily commented)
│   ├── vendor/satellite.es.js  # satellite.js v5.0.0 (SGP4 core), vendored
│   ├── blog.html         # Thin shell: fetches & renders blog.md client-side
│   ├── blog.md           # Blog post content (edit this, not blog.html)
│   ├── globe.js          # Earth mesh, atmosphere, star field, render loop
│   ├── iss.js            # ISS marker, orbit trail, hover tooltip
│   ├── frames.js         # ECI/ECEF coordinate axis visualization
│   ├── ui.js             # HUD, TLE panel, toggle buttons, tracking loop
│   └── style.css         # Dark space theme
├── scripts/dev-server.js # Local dev server (npm start)
├── tests/                # node:test suites (npm test)
├── vercel.json           # outputDirectory + clean URLs
├── package.json
└── README.md
```

---

## Deployment

Deployed on [Vercel](https://vercel.com)'s free (Hobby) tier. Import the repo and deploy — [`vercel.json`](vercel.json) sets `frontend/` as the static output directory and `api/tle.js` is picked up automatically as a serverless function. No build step.

Why this fits the free tier: Vercel can't hold WebSockets, so the orbit math runs in the browser instead. The only server call is `/api/tle`, cached at the edge for an hour (`s-maxage=3600`, `stale-if-error`), so function invocations stay in the dozens per day regardless of traffic.

The previous FastAPI + WebSocket + Render version lives on the `v1` branch.

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

## Earth Texture

The globe uses a NASA Blue Marble daymap (`frontend/textures/earth_daymap.jpg`), already included in the repo — no setup needed. If it's ever missing or fails to load, `globe.js` falls back to a simple procedural blue-grey sphere automatically.

---

## Blog Post

A full write-up on the physics and implementation behind this tracker — TLEs, SGP4, ECI/ECEF, WGS84 geodetic conversion, and how it's all wired together — is available at:

**[Tracking the ISS: TLEs, SGP4, and Reference Frames](/blog)**

Also served locally at `/blog`. To edit the post, just edit [`frontend/blog.md`](frontend/blog.md) — plain Markdown, no HTML/CSS knowledge needed. `frontend/blog.html` is a thin shell that fetches and renders it client-side.

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Frontend (index.html) |
| `/blog` | GET | Blog post write-up (blog.html) |
| `/api/tle` | GET | Current ISS TLE: `{name, line1, line2, source}` (edge-cached 1h) |

All positions, trails and orbital parameters are computed client-side in [`frontend/orbit.js`](frontend/orbit.js). `getFullState()` returns:

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

*Built with satellite.js (SGP4) and Three.js. TLE data from Celestrak.*
