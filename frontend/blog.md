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

## 3. SGP4: From Snapshot to Position

A TLE is a snapshot: it describes the orbit at one instant, its epoch. To know where the ISS *is right now*, or will be in 30 minutes, you have to carry that snapshot forward in time. **SGP4** (Simplified General Perturbations 4) is the algorithm NORAD's TLEs are built to be used with. It is easiest to understand as a simple idea plus a list of corrections.

### The simple idea: an ellipse

If Earth were a perfect point mass, an orbit would be a fixed ellipse, and six numbers from the TLE would pin it down:

| Describes | Element | ISS value (this TLE) |
|---|---|---|
| Size and shape | Mean motion *n* (→ semi-major axis *a*) | 15.494 rev/day (→ a ≈ 6,796 km, about 418 km up) |
| | Eccentricity *e* | 0.0007363 (almost a circle) |
| Tilt and orientation | Inclination *i* | 51.6318° |
| | RAAN Ω — where the orbit crosses the equator heading north | 259.669° |
| | Argument of perigee ω — where the closest point sits in the orbit | 37.395° |
| Where you are on it | Mean anomaly *M* — how far round the orbit at the epoch | 322.755° |

To find the position at a later time *t*, move round the ellipse and then orient it in space:

```
M(t) = M₀ + n·(t − t₀)       steady average sweep round the orbit
M    = E − e·sin E           Kepler's equation: solve for E
r    = a·(1 − e·cos E)       distance from Earth's centre
ν    = 2·atan( √((1+e)/(1−e)) · tan(E/2) )
                             true anomaly: angle from perigee
```

The size *a* comes from the period (*a*³ = μ/*n*², with μ ≈ 398,600 km³/s²). The point (*r*, ν) in the orbital plane is then rotated by ω, *i* and Ω into the inertial frame. For the ISS, with *e* this small, *E* is almost equal to *M* and the equation is nearly trivial.

### Why that isn't enough

The real orbit is not a fixed ellipse. Two effects matter most for the ISS:

- **Earth's bulge (J2).** Earth's equatorial radius is about 21 km larger than its polar radius, and that extra mass tugs on the orbit. For an inclined orbit the effect is that the orbital plane slowly turns about Earth's axis (the node "regresses", westward for a prograde orbit):

  ```
  dΩ/dt ≈ −(3/2) · J₂ · (Rₑ/p)² · n · cos i          J₂ ≈ 1.083 × 10⁻³
  ```

  For the ISS that works out to **about −4.95° per day**, so the plane makes a full turn in roughly 73 days. SGP4's own output agrees to the digit (−4.952°/day), and you can watch it happen: the TLE panel's RAAN falls by about 5° from one day to the next. The same effect is how sun-synchronous orbits are engineered. J2 also rotates the perigee, and the smaller J3 and J4 terms add tiny periodic wiggles.
- **Atmospheric drag.** At about 420 km the air is extremely thin but not absent. Drag slowly shrinks the orbit (the ISS loses roughly a couple of kilometres a month, more when the Sun is active, which is why it is periodically re-boosted) and, counter-intuitively, makes it *speed up*: a lower orbit is a faster one. The TLE carries a drag term, B* (about 2.0 × 10⁻⁴ for this TLE), that SGP4 feeds into a simple atmosphere model.

### What SGP4 does about it

SGP4 is an *analytic* theory, not a numerical simulation. It does not step the equations of motion forward in tiny increments; it applies closed-form corrections to the ellipse, in this order:

1. **Initialise once per TLE.** Convert the TLE's mean motion into SGP4's internal mean elements and precompute the constants for the J2 rates and the drag coefficients. (`twoline2satrec` in the code.)
2. **Secular update to time *t*.** The slow, steady drifts that grow with time: Ω, ω and *M* advance faster or slower because of J2, and *a* and *e* decay because of drag.
3. **Long-period correction.** Small J3 terms that vary slowly with ω.
4. **Solve Kepler's equation** with the updated elements to get the position along the orbit.
5. **Short-period correction.** Small J2 oscillations at the orbital period: the satellite is slightly higher and lower, and slightly ahead or behind, depending on where it is in the orbit.
6. **Rotate into space** to get the position and velocity vectors, in km and km/s.

### Mean elements, not Kepler's

A trap worth knowing: the TLE numbers are *mean* elements, averaged in SGP4's own convention and fitted by NORAD *using* SGP4. They are not the instantaneous elements of a plain ellipse, so plugging them into the simple Kepler recipe gives the wrong answer. To measure how wrong, I propagated this article's TLE (epoch 17 Nov 2026) both ways, using the plain Kepler steps above with the same elements:

| Time after epoch | Distance between plain Kepler and SGP4 |
|---|---|
| 0 | 12 km |
| 30 min | 11 km |
| 90 min | 30 km |
| 1 day | about 470 km |

The 12 km at the epoch comes from the mean-versus-instantaneous difference and the missing short-period terms. The growth after that is mostly the orbit turning: adding *only* J2's drift of Ω and ω to the plain Kepler recipe cuts the one-day error from about 470 km to about 16 km. The lesson is that SGP4 and TLEs are a matched pair, and that most of what SGP4 adds to a fixed ellipse is the slow turning of the orbit.

### Output frame and accuracy

SGP4 outputs in **TEME** ("true equator, mean equinox"), an inertial frame tied to the equator and equinox of the date. The tracker treats it as ECI, and pairing it with GMST to get latitude and longitude is the consistent choice (the leftover, nutation, is around half a kilometre at this altitude). Precise work that compares against a J2000 catalogue would apply a further rotation for precession (about 0.36° since 2000, tens of kilometres at orbital radius).

As commonly cited, SGP4 is accurate to about a kilometre at the TLE's epoch and degrades by roughly 1 to 3 km per day afterwards, mostly *along* the track, because tiny errors in the orbit's timing accumulate. Re-boosts and other manoeuvres make older TLEs wrong outright. That is why the tracker refetches its TLE regularly and warns if the one it has is more than two weeks old.

One more distinction: SGP4 proper handles "near-Earth" orbits, with periods under 225 minutes, which includes the ISS (about 93 minutes). Orbits with longer periods use SDP4, which adds solar and lunar gravity and resonance terms. satellite.js implements both and chooses automatically; for the ISS the Sun and Moon do not enter the calculation.

### In this code

Two calls do all of it: `twoline2satrec(line1, line2)` parses the TLE and runs the initialisation (step 1), and `propagate(satrec, date)` converts the date to minutes since the epoch and runs steps 2 to 6, returning position and velocity (or an error code if, say, the orbit has decayed). The tracker's `orbit.js` wraps these, then does the frame conversions described next.

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

- **ECI axes are solid and never move; ECEF axes are dashed and ride around with the Earth.** Both use the same colour per axis (X red, Y green, Z blue), so "same axis, different frame" is obvious. ECEF's X-axis is drawn with a dashed prime-meridian arc on the surface, so you can watch Greenwich being carried round. Both sets of axes continue, fainter, through the globe to a dot at the Earth's centre: the origin that every vector in both frames is measured from.
- **A yellow arc between ECI-X and ECEF-X is θ**, the GMST angle, labelled with its live value. It grows by 360° every sidereal day.
- **Arrows on the trails** show the direction of travel: a small arrow on each trail, about ten minutes from the ISS, so the orange past path visibly leads up to the ISS and the cyan future path leads away from it.
- **A white arrow runs from the centre to the ISS.** That is one vector in space; it only *looks* different in the two frames because the axes it is measured against differ. The ECI and ECEF data panels show its components in each frame, and the ECEF panel shows the relation r<sub>ECEF</sub> = R<sub>3</sub>(θ) · r<sub>ECI</sub> with live numbers.

## 5. WGS84 Geodetic: Why Lat/Lon Isn't Trivial

ECEF coordinates are Cartesian (x, y, z in km) — useful for math, useless for a human reading a map. Converting to latitude/longitude/altitude sounds like basic trigonometry until you remember Earth isn't a sphere: it's an oblate **WGS84 ellipsoid**, flattened slightly at the poles. That flattening means latitude isn't a simple arctangent of z over the equatorial radius — the tracker uses **Bowring's iterative method** to solve for geodetic latitude and altitude on the WGS84 ellipsoid accurately, rather than approximating Earth as a sphere and accepting the resulting altitude error.

## 6. Ground Track and Nadir

The orange and cyan trails float at the ISS's altitude, about 420 km above the surface, so they don't say which *places* the station passes over. The **ground track** does: it is the orbit projected down onto the surface, the sequence of **sub-satellite points** (the latitude and longitude the HUD shows). Computing it needs exactly the pipeline above — for each time *t*, propagate with SGP4, rotate ECI to ECEF using GMST(*t*), convert to geodetic — and drawing the result on the Earth-fixed globe. In effect, it is the orbit as seen from the rotating Earth.

Two features of the track are worth noticing:

- **It stays within about ±51.6° of latitude** (the orbit's inclination), tracing a sinusoid-like curve across the map.
- **Each orbit is shifted west by about 23°.** The ISS completes an orbit in ~93 minutes, during which the Earth turns 360° × 93 / 1436 ≈ 23° beneath it. That is why successive passes cover different longitudes, and why you only see the ISS from a given place on some orbits.

The **nadir line** drops from the ISS straight to the sub-satellite point ("nadir" is straight down, the opposite of zenith). The circle of ground from which the ISS is above the horizon (angular radius acos(R / (R + h)), about 20° or ~2,260 km at 420 km) is shown separately, as the In-View Zone in the next section.

The ground track covers the last orbit (46 minutes) and the next two and a half (230 minutes), so you can see each lap land about 23° west of the previous one, and the track and nadir line are a single toggle, off by default.

## 7. Day, Night and "Can I See It?"

You can only see the ISS with your own eyes when two things are true at once: **you are in darkness, and the ISS is still in sunlight.** That is why passes happen shortly after dusk or before dawn. By then the Sun has dropped below your horizon, but at 420 km the ISS sits high enough to still catch its light, a bit like a mountain peak glowing after the valley has gone dark. Around midday you can't see it (the sky is too bright), and in the middle of the night it is usually inside Earth's shadow.

The tracker works this out from the Sun's position, which has a short closed-form approximation:

```
n  = days since J2000
L  = 280.460° + 0.9856474°·n          mean longitude of the Sun
g  = 357.528° + 0.9856003°·n          mean anomaly
λ  = L + 1.915°·sin g + 0.020°·sin 2g ecliptic longitude
ε  = 23.439° − 0.0000004°·n           tilt of Earth's axis
Sun direction (ECI) = ( cos λ,  cos ε·sin λ,  sin ε·sin λ )
```

It is good to about 0.01°, and in the same ECI frame as SGP4's output, so the Sun, the ISS and the rotating Earth can all be compared directly. (It also makes the frames lesson concrete: at the March equinox the Sun lies along +X, the vernal-equinox direction.)

Three things follow from that one vector:

- **The terminator.** A point on the ground is in daylight when its outward normal makes an acute angle with the Sun direction. The terminator is the great circle 90° from the sub-solar point. The shading uses the Sun's elevation at each point and fades across the twilight stages: *civil* (Sun 0° to −6°), *nautical* (−6° to −12°) and *astronomical* (−12° to −18°) before full night.
- **Is the ISS sunlit?** SGP4 gives its ECI position. If it is on the sun side of Earth it is lit. If it is behind Earth, it is in shadow only if it lies within one Earth radius of the Earth–Sun axis: a cylinder of shadow trailing away from the Sun. (The real shadow is a cone with a fuzzy edge; the difference is seconds of timing.) In mid-November the ISS spends about 36 minutes of each 93-minute orbit in that shadow, close to the maximum; at other times of year it can stay in continuous sunlight for days.
- **The in-view zone.** Combine the three conditions: the ISS at least ~10° above the horizon (a circle of about 12.5° radius under it, smaller than the 20° geometric horizon circle, because anything lower is lost in haze and trees), the ground dark enough (Sun below −6°) and the ISS sunlit. An optional toggle draws the ring on the globe and fills it in green only where all three hold. A ring with no fill means nobody inside it can see the ISS right now.

What it ignores: weather, the ISS's actual brightness (it varies with its orientation and range), and the observer's own horizon. It answers "could it be seen from there?", not "will it be bright?".

## 8. Implementation

The tracker is a static Three.js site plus one tiny serverless function — no bundler, no build step, and no always-on server. The orbit math runs in your browser.

```
Celestrak.org → api/tle.js (edge-cached 1h)
                   → browser: orbit.js (SGP4 → ECI → ECEF → geodetic)
                        → Three.js: globe, ISS marker, trails, axes
```

- **TLE endpoint** — `api/tle.js` fetches the ISS TLE from Celestrak (falling back to wheretheiss.at), validates it, and lets the CDN cache it for an hour (`s-maxage` plus `stale-if-error`), so the upstream sources see roughly one request per hour no matter how many people are watching.
- **Physics** — `orbit.js` is the physics core. SGP4 comes from the vendored satellite.js; GMST, ECI→ECEF, ECEF→geodetic (Bowring), speed, orbit and ground-track sampling, the horizon-circle geometry and TLE parsing are written out by hand, because they are the educational part. It recomputes the ISS state every 2 seconds. The same module is checked in Node tests against golden values produced by the project's original Python implementation.
- **Frontend** — `globe.js` builds the Earth/atmosphere/star field and render loop. `iss.js` draws the ISS marker (dimmed in eclipse), the trails and the ground layer. The Earth's material is patched in `globe.js` with a small shader that adds the terminator and the in-view zone. `frames.js` renders the ECI/ECEF axes, equatorial ring, GMST arc and position vector. `ui.js` runs the tracking loop that ties it all together and drives the HUD, the toggles and the ECI/ECEF data panels.
- **Passes** — `findPasses()` steps through the next 30 days at 30-second intervals (about 50 ms of work), turns each ECEF position into azimuth and elevation for the observer, and applies the same sunlit-and-dark rule as the zone. Everything runs in the browser; settings live in `localStorage`. Long-running analysis (collecting every TLE, the jump when a new one arrives, decay and reboost tracking) is done separately, outside the app, in a Python job.
- **The ISS marker** — a small procedural model (truss, solar arrays, modules) rather than a dot. It is exaggerated (the real station is ~109 m) and kept a constant size on screen, and it is oriented like the real thing: nose along the velocity vector, zenith up, truss across the orbit plane — all derived from the ECI position and velocity SGP4 already returns.
- **Colour that doesn't depend on the map** — trails, axes and rings are opaque lines without blending or tone-mapping, so they read the same over ocean, forest, desert and ice.
- **Deployment** — hosted on Vercel's free tier: static files plus the one cached function. (An earlier version ran SGP4 on a Python server and streamed positions over a WebSocket; Vercel's serverless functions can't hold WebSockets, and doing the maths in the browser also means zero per-viewer server load.)

## 9. Demo

> **Live tracker:** [open the tracker](/)

What you'll see: the 3D Earth rotating in real sidereal time with the real day/night terminator, the ISS model moving along its live position, the orange/cyan past/future trail, a HUD with live lat/lon/altitude/speed, and the raw TLE panel.

Things to try:

- **Day / Night** and **In-View Zone** — turn on the zone, then find a moment when the HUD says "Sunlit" and part of the ring is filled green on the dark side of the globe: that is where the ISS is visible.
- **Ground Track & Nadir** — turn it on, then tilt the globe toward the horizon to see the dashed track hugging the surface and the nadir line.
- **ECI and ECEF axes** — turn both on to see the solid/dashed axes, the yellow θ arc, the ISS position vector, and the two coordinate panels side by side.
- **Next Passes** — type your coordinates (or click the globe), then click a ★ pass to jump to it: the time bar moves to the peak and the ISS flies over your marker.
- **Time bar** — drag the slider to watch the terminator sweep and the zone appear and vanish; share the moment with the **Share** link.
- **Hover (or tap) the ISS** for its live position, altitude and speed.

## 10. Further Work

- **Richer passes** — an elevation mask for local horizons, brightness (magnitude) estimates, and a sky-chart view of each pass
- **Multi-satellite support** — extend past NORAD 25544 to track any object with a public TLE
- **Inertial orbit view** — draw several orbits in the inertial frame to show the fixed ellipse while the Earth turns beneath it
- **Follow-Earth camera** — a camera locked to the rotating Earth, to see the inertial frame spin around you

---

Built with satellite.js (SGP4) and Three.js. TLE data from Celestrak, with wheretheiss.at as a fallback.
