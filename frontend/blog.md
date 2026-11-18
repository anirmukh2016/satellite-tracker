# Tracking the ISS: TLEs, SGP4, and Reference Frames

*orbital mechanics — how this tracker turns two lines of numbers into a moving 3D orbit*

## 1. Introduction

The International Space Station is the largest object humans have ever put in orbit, circling Earth roughly every 92 minutes at about **7.66 km/s** — more than 22x the speed of sound. It's bright enough to see with the naked eye, it has been continuously crewed since November 2000, and its orbit is public data, updated and published multiple times a day.

That combination — a fast-moving, well-documented, visually verifiable object — makes the ISS an unusually good vehicle for learning real orbital mechanics instead of a toy simplification. Everything this tracker does (fetch orbital elements, propagate them forward and backward in time, convert between reference frames, project onto a rotating Earth) is the same pipeline used for GPS satellites, weather satellites, and deep-space missions. This post walks through that pipeline end to end: the data format, the propagation algorithm, the coordinate systems, and how it's all wired together in the live tracker.

## 2. What Is a TLE?

A **Two-Line Element set (TLE)** is a compact, fixed-width text format NORAD uses to describe a satellite's orbital state at a specific moment (the "epoch"). NORAD publishes TLEs for roughly 25,000 tracked objects. The ISS's looks like this:

```
ISS (ZARYA)
1 25544U 98067A   26321.85053418  .00010861  00000+0  20179-3 0  9995
2 25544  51.6318 259.6690 0007363  37.3950 322.7550 15.49442652595576
```

The key numbers, mostly in Line 2:

| Field | Value | Meaning |
|---|---|---|
| Inclination | 51.6318° | Orbital plane tilted 51.63° from the equator |
| RAAN | 259.6690° | Where the orbit crosses the equator heading north |
| Eccentricity | 0.0007363 | Nearly circular (0 = perfect circle) |
| Mean motion | 15.4944... | ~15.5 orbits/day → ~93 minute period |

This tracker fetches a fresh TLE from [Celestrak](https://celestrak.org) (NORAD catalog ID 25544), falling back to [wheretheiss.at](https://wheretheiss.at) when Celestrak is unreachable (it throttles some cloud IP ranges). The result is cached for an hour at the CDN, and the last known-good TLE keeps being served if both sources fail — TLEs only update a couple of times a day, so an hour-old set is still accurate to within a few kilometers. Because SGP4 accuracy degrades as a TLE ages, the tracker shows a warning if the TLE's epoch is more than two weeks old.

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

The tracker computes GMST in the browser alongside every position update, which is also what lets the 3D Earth mesh and the ECEF axis overlay rotate in sync with real time.

### Seeing the two frames

Toggle the frames on the globe and the difference becomes visible rather than abstract:

- **ECI axes are solid and never move; ECEF axes are dashed and ride around with the Earth.** Both use the same colour per axis (X red, Y green, Z blue), so "same axis, different frame" is obvious. ECEF's X-axis is drawn with a dashed prime-meridian arc on the surface, so you can watch Greenwich being carried round.
- **A yellow arc between ECI-X and ECEF-X is θ**, the GMST angle, labelled with its live value. It grows by 360° every sidereal day.
- **A white arrow runs from the centre to the ISS.** That is one vector in space; it only *looks* different in the two frames because the axes it is measured against differ. The ECI and ECEF data panels show its components in each frame, and the ECEF panel shows the relation r<sub>ECEF</sub> = R<sub>3</sub>(θ) · r<sub>ECI</sub> with live numbers.
- **"Trails in ECI"** redraws the orange/cyan altitude trails as the true inertial orbit — a fixed ellipse in space while the Earth turns underneath. By default the trails are drawn in the Earth-fixed frame, where the same orbit is carried around with the planet. Over ±30 minutes the two differ by only ~7.5° of Earth rotation, so the effect is subtle; it gets dramatic over several orbits.

## 5. WGS84 Geodetic: Why Lat/Lon Isn't Trivial

ECEF coordinates are Cartesian (x, y, z in km) — useful for math, useless for a human reading a map. Converting to latitude/longitude/altitude sounds like basic trigonometry until you remember Earth isn't a sphere: it's an oblate **WGS84 ellipsoid**, flattened slightly at the poles. That flattening means latitude isn't a simple arctangent of z over the equatorial radius — the tracker uses **Bowring's iterative method** to solve for geodetic latitude and altitude on the WGS84 ellipsoid accurately, rather than approximating Earth as a sphere and accepting the resulting altitude error.

## 6. Ground Track, Nadir and Footprint

The orange and cyan trails float at the ISS's altitude, about 420 km above the surface, so they don't say which *places* the station passes over. The **ground track** does: it is the orbit projected down onto the surface, the sequence of **sub-satellite points** (the latitude and longitude the HUD shows). Computing it needs exactly the pipeline above — for each time *t*, propagate with SGP4, rotate ECI to ECEF using GMST(*t*), convert to geodetic — and drawing the result on the Earth-fixed globe. In effect, it is the orbit as seen from the rotating Earth.

Two features of the track are worth noticing:

- **It stays within about ±51.6° of latitude** (the orbit's inclination), tracing a sinusoid-like curve across the map.
- **Each orbit is shifted west by about 23°.** The ISS completes an orbit in ~93 minutes, during which the Earth turns 360° × 93 / 1436 ≈ 23° beneath it. That is why successive passes cover different longitudes, and why you only see the ISS from a given place on some orbits.

The **nadir line** drops from the ISS straight to the sub-satellite point ("nadir" is straight down, the opposite of zenith). The **footprint** — the white ring — is the horizon circle: the set of ground points from which the ISS is currently above the horizon. For a satellite at altitude *h* over an Earth of radius *R*, it has an angular radius of acos(R / (R + h)), about 20° or ~2,260 km at 420 km. Anyone inside the ring could, in principle, see the ISS overhead (whether they actually do also depends on daylight and weather, since the ISS is only visible when sunlit and the observer is in darkness).

The ground track covers one full orbit (±46 minutes), and the whole layer is a single toggle, off by default.

## 7. Implementation

The tracker is a static Three.js site plus one tiny serverless function — no bundler, no build step, and no always-on server. The orbit math runs in your browser.

```
Celestrak.org → api/tle.js (edge-cached 1h)
                   → browser: orbit.js (SGP4 → ECI → ECEF → geodetic)
                        → Three.js: globe, ISS marker, trails, axes
```

- **TLE endpoint** — `api/tle.js` fetches the ISS TLE from Celestrak (falling back to wheretheiss.at), validates it, and lets the CDN cache it for an hour (`s-maxage` plus `stale-if-error`), so the upstream sources see roughly one request per hour no matter how many people are watching.
- **Physics** — `orbit.js` is the physics core. SGP4 comes from the vendored satellite.js; GMST, ECI→ECEF, ECEF→geodetic (Bowring), speed, orbit and ground-track sampling, the horizon-circle geometry and TLE parsing are written out by hand, because they are the educational part. It recomputes the ISS state every 2 seconds. The same module is checked in Node tests against golden values produced by the project's original Python implementation.
- **Frontend** — `globe.js` builds the Earth/atmosphere/star field and render loop. `iss.js` draws the ISS marker, the trails and the ground layer. `frames.js` renders the ECI/ECEF axes, equatorial ring, GMST arc and position vector. `ui.js` runs the tracking loop that ties it all together and drives the HUD, the toggles and the ECI/ECEF data panels.
- **The ISS marker** — a small procedural model (truss, solar arrays, modules) rather than a dot. It is exaggerated (the real station is ~109 m) and kept a constant size on screen, and it is oriented like the real thing: nose along the velocity vector, zenith up, truss across the orbit plane — all derived from the ECI position and velocity SGP4 already returns.
- **Colour that doesn't depend on the map** — trails, axes and rings are opaque lines without blending or tone-mapping, so they read the same over ocean, forest, desert and ice.
- **Deployment** — hosted on Vercel's free tier: static files plus the one cached function. (An earlier version ran SGP4 on a Python server and streamed positions over a WebSocket; Vercel's serverless functions can't hold WebSockets, and doing the maths in the browser also means zero per-viewer server load.)

## 8. Demo

> **Live tracker:** [open the tracker](/)

What you'll see: the 3D Earth rotating in real sidereal time, the ISS model moving along its live position, the orange/cyan past/future trail, a HUD with live lat/lon/altitude/speed, and the raw TLE panel.

Things to try:

- **Ground Track & Footprint** — turn it on, then tilt the globe toward the horizon to see the dashed track hugging the surface, the nadir line, and the horizon circle.
- **ECI and ECEF axes** — turn both on to see the solid/dashed axes, the yellow θ arc, the ISS position vector, and the two coordinate panels side by side.
- **Trails in ECI** — compare the inertial orbit with the Earth-fixed one.
- **Hover (or tap) the ISS** for its live position, altitude and speed.

## 9. Further Work

- **Observer-specific passes** — extend the horizon circle to a chosen lat/lon with an elevation mask, and compute upcoming visible passes (sunlit ISS, dark observer) the way apps like Heavens-Above do
- **Day/night terminator** — shade the night side so "can I actually see it?" is answerable at a glance
- **Longer ground tracks** — several orbits at once, to show the ~23° westward drift directly
- **Multi-satellite support** — extend past NORAD 25544 to track any object with a public TLE
- **Follow-Earth camera** — a camera locked to the rotating Earth, to see the inertial frame spin around you

---

Built with satellite.js (SGP4) and Three.js. TLE data from Celestrak, with wheretheiss.at as a fallback.
