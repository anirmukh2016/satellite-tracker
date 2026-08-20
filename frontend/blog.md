# Tracking the ISS: TLEs, SGP4, and Reference Frames

*orbital mechanics — how this tracker turns two lines of numbers into a moving 3D orbit*

## 1. Introduction

The International Space Station is the largest object humans have ever put in orbit, circling Earth roughly every 92 minutes at about **7.66 km/s** — more than 22x the speed of sound. It's bright enough to see with the naked eye, it has been continuously crewed since November 2000, and its orbit is public data, updated and published multiple times a day.

That combination — a fast-moving, well-documented, visually verifiable object — makes the ISS an unusually good vehicle for learning real orbital mechanics instead of a toy simplification. Everything this tracker does (fetch orbital elements, propagate them forward and backward in time, convert between reference frames, project onto a rotating Earth) is the same pipeline used for GPS satellites, weather satellites, and deep-space missions. This post walks through that pipeline end to end: the data format, the propagation algorithm, the coordinate systems, and how it's all wired together in the live tracker.

## 2. What Is a TLE?

A **Two-Line Element set (TLE)** is a compact, fixed-width text format NORAD uses to describe a satellite's orbital state at a specific moment (the "epoch"). NORAD publishes TLEs for roughly 25,000 tracked objects. The ISS's looks like this:

```
ISS (ZARYA)
1 25544U 98067A   24016.54842593  .00016717  00000-0  10270-3 0  9993
2 25544  51.6400 337.6640 0001938  86.2141 273.9285 15.49559958435128
```

The key numbers, mostly in Line 2:

| Field | Value | Meaning |
|---|---|---|
| Inclination | 51.6400° | Orbital plane tilted 51.64° from the equator |
| RAAN | 337.6640° | Where the orbit crosses the equator heading north |
| Eccentricity | 0.0001938 | Nearly circular (0 = perfect circle) |
| Mean motion | 15.4956... | ~15.5 orbits/day → ~92 minute period |

This tracker fetches a fresh TLE from [Celestrak](https://celestrak.org) (NORAD catalog ID 25544), caches it for an hour, and falls back to the last known-good TLE if a fetch fails — TLEs only update a couple of times a day, so an hour-old set is still accurate to within a few kilometers.

## 3. The SGP4 Algorithm

A TLE alone is just a snapshot. To know where the ISS *is right now*, or where it will be in 30 minutes, you need to propagate it forward in time. That's what **SGP4** (Simplified General Perturbations 4) does — the standard algorithm NORAD's own TLEs are designed to be used with. It accounts for:

- **Earth's oblateness** — the J2, J3, and J4 gravitational harmonic terms, since Earth bulges at the equator rather than being a perfect sphere
- **Atmospheric drag** — encoded directly in the TLE's BSTAR drag term, which matters a lot at the ISS's relatively low ~400 km altitude
- **Solar and lunar gravitational perturbations** — smaller effects that matter for longer-range predictions

Given a TLE and a target time, SGP4 outputs a position and velocity vector in kilometers and kilometers/second — in the **ECI** reference frame, described next.

## 4. ECI vs. ECEF: The Rotation Problem

SGP4's output is fixed relative to the stars, not to the ground — which is exactly why a second coordinate system, and a conversion between them, is needed.

| | ECI (Earth-Centered Inertial) | ECEF (Earth-Centered, Earth-Fixed) |
|---|---|---|
| Origin | Earth's center | Earth's center |
| X-axis | → Vernal equinox (fixed) | → Prime meridian (rotates) |
| Z-axis | → North celestial pole | → Geographic north pole |
| Rotates with Earth? | No | Yes (once every 86,164 s — a sidereal day) |
| Used by | SGP4's raw output, orbital mechanics | GPS, lat/lon/alt, ground tracking |

> The bridge between the two is **GMST** (Greenwich Mean Sidereal Time) — the angle Earth has rotated relative to the vernal equinox at a given instant.

A simple rotation by −GMST around the Z axis converts ECI into ECEF:

```
[x_ecef]   [ cosθ   sinθ   0 ] [x_eci]
[y_ecef] = [-sinθ   cosθ   0 ] [y_eci]
[z_ecef]   [  0       0    1 ] [z_eci]
```

The tracker computes GMST on the backend and sends it to the browser alongside every position update, which is also what lets the 3D Earth mesh and the ECEF axis overlay rotate in sync with real time.

## 5. WGS84 Geodetic: Why Lat/Lon Isn't Trivial

ECEF coordinates are Cartesian (x, y, z in km) — useful for math, useless for a human reading a map. Converting to latitude/longitude/altitude sounds like basic trigonometry until you remember Earth isn't a sphere: it's an oblate **WGS84 ellipsoid**, flattened slightly at the poles. That flattening means latitude isn't a simple arctangent of z over the equatorial radius — the tracker uses **Bowring's iterative method** to solve for geodetic latitude and altitude on the WGS84 ellipsoid accurately, rather than approximating Earth as a sphere and accepting the resulting altitude error.

## 6. Implementation

The tracker is a small FastAPI backend paired with a vanilla Three.js frontend — no bundler, no build step for the frontend, dependencies managed with [uv](https://docs.astral.sh/uv/) on the backend.

```
Celestrak.org → tle_fetcher.py (1h cache)
                   → propagator.py (SGP4 → ECI → ECEF → geodetic)
                        → main.py (FastAPI: REST + WebSocket)
                             → browser (Three.js: globe, ISS marker, trails, axes)
```

- **Backend** — `tle_fetcher.py` fetches and caches the TLE; `propagator.py` is the physics core (SGP4, GMST, ECI/ECEF/geodetic conversions, speed, orbit trail); `main.py` exposes REST endpoints (`/api/tle`, `/api/orbit`, `/api/position`) and a WebSocket at `/ws` that pushes a fresh position every 2 seconds.
- **Frontend** — `globe.js` builds the Earth/atmosphere/star field and render loop; `iss.js` draws the ISS marker and orange (past)/cyan (future) orbit trail; `frames.js` renders the ECI/ECEF axis overlay; `ui.js` is the WebSocket client that ties it all together and drives the HUD.
- **Deployment** — a Render Blueprint (`render.yaml`) runs `uv sync` and starts `uvicorn` directly against the FastAPI app, on Render's free tier.

## 7. Demo

> **Live tracker:** [satellite-tracker-vblj.onrender.com](https://satellite-tracker-vblj.onrender.com/)
>
> Runs on Render's free tier — the instance spins down after inactivity, so the first load after a while can take ~50 seconds to wake up.

What you'll see: the 3D Earth rotating in real sidereal time, the ISS marker moving along its live position, the orange/cyan past/future trail, a HUD with live lat/lon/altitude/speed, the raw TLE panel, and a toggle to overlay the ECI and ECEF axes directly on the globe.

## 8. Further Work

- **Ground station footprint** — draw the ISS's visibility circle on the globe for a given observer location
- **Pass predictor** — compute upcoming visible passes for a chosen lat/lon, the way apps like Heavens-Above do
- **Multi-satellite support** — extend past NORAD 25544 to track any object with a public TLE
- **Historical trail persistence** — store and replay past orbits instead of only a rolling ±30 minute window

---

Built with FastAPI, sgp4, and Three.js. TLE data from Celestrak.
