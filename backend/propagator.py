"""
SGP4 Orbit Propagator — the mathematical heart of the satellite tracker.

SGP4 (Simplified General Perturbations 4) is the standard algorithm used by
NORAD and space agencies worldwide to predict satellite positions. Given a TLE
(Two-Line Element set), it computes where a satellite will be at any time.

Coordinate Systems used here:
─────────────────────────────
ECI (Earth-Centered Inertial):
  Origin: Earth's center
  X-axis: Points toward the vernal equinox (fixed in space)
  Y-axis: 90° east in the equatorial plane
  Z-axis: Points toward the north celestial pole
  Key property: DOES NOT rotate with Earth — stars appear fixed in this frame
  Used by: SGP4 output, spacecraft navigation

ECEF (Earth-Centered, Earth-Fixed):
  Origin: Earth's center
  X-axis: Points toward 0° longitude (prime meridian) at the equator
  Y-axis: Points toward 90°E longitude at the equator
  Z-axis: Points toward the geographic north pole
  Key property: ROTATES with Earth — a fixed point on the ground has fixed coordinates
  Used by: GPS, geodesy, latitude/longitude calculations

The rotation between ECI and ECEF is given by GMST (Greenwich Mean Sidereal Time),
which tracks how much Earth has rotated since the vernal equinox reference.
"""

import math
import datetime
from sgp4.api import Satrec, jday


def propagate(tle_line1: str, tle_line2: str, dt: datetime.datetime) -> tuple:
    """
    Propagate satellite position using SGP4.

    SGP4 solves the differential equations of orbital motion including:
    - Earth's oblateness (J2, J3, J4 zonal harmonics)
    - Atmospheric drag (using the BSTAR drag term from TLE)
    - Solar radiation pressure (approximated)
    - Lunar/solar gravity perturbations (for deep-space objects)

    Args:
        tle_line1, tle_line2: TLE lines from Celestrak
        dt: UTC datetime to propagate to

    Returns:
        (r_eci, v_eci) — position [km] and velocity [km/s] in ECI frame
        r_eci = [x, y, z] in km from Earth's center
        v_eci = [vx, vy, vz] in km/s

    Error codes from sgp4(): 0=OK, 1=mean elements, 2=mean motion,
    3=pert elements, 4=semi-latus rectum, 6=decay
    """
    sat = Satrec.twoline2rv(tle_line1, tle_line2)

    # Convert datetime to Julian Date — the continuous day count used in astronomy
    # Julian Date 2451545.0 = January 1, 2000, 12:00 TT (J2000 epoch)
    jd, fr = jday(
        dt.year, dt.month, dt.day,
        dt.hour, dt.minute,
        dt.second + dt.microsecond / 1e6
    )

    error, r_eci, v_eci = sat.sgp4(jd, fr)

    if error != 0:
        raise ValueError(f"SGP4 propagation error code {error} at {dt}")

    return list(r_eci), list(v_eci)


def compute_gmst(dt: datetime.datetime) -> float:
    """
    Compute Greenwich Mean Sidereal Time (GMST) in radians.

    GMST is the hour angle of the mean vernal equinox at Greenwich.
    Equivalently: it's the rotation angle from the ECI X-axis to the
    ECEF X-axis (the prime meridian). This is what links the two frames.

    Earth completes one sidereal rotation in 86164.1 seconds (not 86400s!).
    The difference (~4 minutes/day) is because the Sun appears to move
    ~1°/day eastward relative to stars, so a solar day is slightly longer.

    Formula: IAU 1982 GMST model
      θ_GMST = 280.46061837° + 360.98564736629° × (JD - J2000)

    Args:
        dt: UTC datetime

    Returns:
        GMST angle in radians [0, 2π)
    """
    jd, fr = jday(dt.year, dt.month, dt.day, dt.hour, dt.minute,
                  dt.second + dt.microsecond / 1e6)
    jd_total = jd + fr

    # Days since J2000.0 epoch (Jan 1.5, 2000 = JD 2451545.0)
    d = jd_total - 2451545.0

    # GMST in degrees (IAU 1982 formula)
    theta_deg = 280.46061837 + 360.98564736629 * d

    # Normalize to [0°, 360°) and convert to radians
    return math.radians(theta_deg % 360.0)


def eci_to_ecef(r_eci: list, gmst_rad: float) -> list:
    """
    Rotate position vector from ECI to ECEF frame.

    The transformation is a simple rotation about the Z-axis by angle θ (GMST):

        [x_ecef]   [ cos θ   sin θ   0 ] [x_eci]
        [y_ecef] = [-sin θ   cos θ   0 ] [y_eci]
        [z_ecef]   [  0       0      1 ] [z_eci]

    Note: Z is unchanged because Earth rotates about its polar axis.
    Note: This is a simplified model — precise conversions also account for
    polar motion, UT1-UTC corrections, and nutation, but GMST is accurate
    to ~1 km for our purposes.

    Args:
        r_eci: [x, y, z] position in ECI frame (km)
        gmst_rad: GMST angle in radians

    Returns:
        [x, y, z] position in ECEF frame (km)
    """
    cos_t = math.cos(gmst_rad)
    sin_t = math.sin(gmst_rad)

    x_ecef = r_eci[0] * cos_t + r_eci[1] * sin_t
    y_ecef = -r_eci[0] * sin_t + r_eci[1] * cos_t
    z_ecef = r_eci[2]  # Z unchanged (rotation about Z-axis)

    return [x_ecef, y_ecef, z_ecef]


def ecef_to_geodetic(r_ecef: list) -> tuple:
    """
    Convert ECEF Cartesian coordinates to geodetic (lat, lon, alt).

    Geodetic coordinates:
      Latitude:  angle from equatorial plane to the normal of the WGS84 ellipsoid
      Longitude: angle from prime meridian (Greenwich) eastward
      Altitude:  height above WGS84 reference ellipsoid (≈ height above sea level)

    WGS84 ellipsoid parameters:
      a = 6378.137 km  (semi-major axis = equatorial radius)
      f = 1/298.257... (flattening — Earth is slightly squashed at poles)
      b = a(1-f) ≈ 6356.752 km  (semi-minor axis = polar radius)

    We use Bowring's iterative method for latitude — 5 iterations gives
    centimeter-level accuracy.

    Args:
        r_ecef: [x, y, z] in km

    Returns:
        (latitude_deg, longitude_deg, altitude_km)
    """
    # WGS84 constants
    a = 6378.137          # semi-major axis (equatorial radius), km
    f = 1.0 / 298.257223563  # flattening
    e2 = 2 * f - f * f    # first eccentricity squared: e² = 1 - (b/a)²

    x, y, z = r_ecef

    # Longitude: straightforward from x, y in ECEF
    lon_rad = math.atan2(y, x)

    # Distance from Earth's rotation axis
    p = math.sqrt(x * x + y * y)

    # Initial latitude estimate (assumes spherical Earth)
    lat_rad = math.atan2(z, p * (1.0 - e2))

    # Iterative refinement (Bowring's method)
    # N(φ) = radius of curvature in the prime vertical at latitude φ
    for _ in range(5):
        sin_lat = math.sin(lat_rad)
        N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
        lat_rad = math.atan2(z + e2 * N * sin_lat, p)

    # Final altitude calculation
    sin_lat = math.sin(lat_rad)
    cos_lat = math.cos(lat_rad)
    N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)

    # Altitude: distance from ellipsoid surface along the normal
    if abs(cos_lat) > 1e-10:
        alt_km = p / cos_lat - N
    else:
        # Near the poles, use Z component
        b = a * (1.0 - f)
        alt_km = abs(z) / abs(sin_lat) - (b * b / a)

    return (
        math.degrees(lat_rad),
        math.degrees(lon_rad),
        alt_km
    )


def compute_speed(v_eci: list) -> float:
    """
    Compute orbital speed magnitude from velocity vector.

    The ISS orbits at ~7.66 km/s. At this speed:
    - It completes one orbit in ~92 minutes
    - It travels ~460 m every 0.06 seconds (one animation frame at 60fps)

    Vis-viva equation: v² = GM(2/r - 1/a)
    For circular orbit: v ≈ sqrt(GM/r) ≈ 7.67 km/s at 400 km altitude
    """
    return math.sqrt(v_eci[0]**2 + v_eci[1]**2 + v_eci[2]**2)


def get_full_state(tle_line1: str, tle_line2: str, dt: datetime.datetime = None) -> dict:
    """
    Compute complete satellite state at a given time.

    This is the main function called by the API endpoints.

    Returns a dictionary with all coordinate representations plus metadata,
    suitable for JSON serialization and frontend display.
    """
    if dt is None:
        dt = datetime.datetime.utcnow()

    # Step 1: SGP4 propagation → ECI position and velocity
    r_eci, v_eci = propagate(tle_line1, tle_line2, dt)

    # Step 2: Compute GMST → rotation angle between ECI and ECEF
    gmst_rad = compute_gmst(dt)

    # Step 3: ECI → ECEF (apply Earth rotation)
    r_ecef = eci_to_ecef(r_eci, gmst_rad)

    # Step 4: ECEF → Geodetic (lat/lon/alt for display)
    lat, lon, alt = ecef_to_geodetic(r_ecef)

    # Step 5: Speed from velocity vector magnitude
    speed = compute_speed(v_eci)

    return {
        "timestamp": dt.isoformat() + "Z",
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "alt_km": round(alt, 2),
        "speed_km_s": round(speed, 4),
        "r_eci": [round(v, 2) for v in r_eci],
        "v_eci": [round(v, 6) for v in v_eci],
        "r_ecef": [round(v, 2) for v in r_ecef],
        "gmst_rad": round(gmst_rad, 6),
        "gmst_deg": round(math.degrees(gmst_rad), 4),
    }


def compute_orbit_trail(tle_line1: str, tle_line2: str,
                        center_dt: datetime.datetime = None,
                        past_minutes: int = 30,
                        future_minutes: int = 30,
                        step_seconds: int = 30) -> dict:
    """
    Compute the orbit trail: positions before and after the current time.

    The ISS orbital period is ~92 minutes, so ±30 minutes gives roughly
    2/3 of the full orbit arc, which looks good on the globe.

    Args:
        center_dt: Center time (default: now)
        past_minutes: How far back to compute trail
        future_minutes: How far forward to compute trail
        step_seconds: Time interval between trail points

    Returns:
        {"past": [...], "future": [...]} — arrays of {lat, lon, alt} dicts
    """
    if center_dt is None:
        center_dt = datetime.datetime.utcnow()

    past_points = []
    future_points = []

    # Past trail (orange on frontend)
    t = center_dt - datetime.timedelta(minutes=past_minutes)
    while t <= center_dt:
        try:
            r_eci, _ = propagate(tle_line1, tle_line2, t)
            gmst_rad = compute_gmst(t)
            r_ecef = eci_to_ecef(r_eci, gmst_rad)
            lat, lon, alt = ecef_to_geodetic(r_ecef)
            past_points.append({"lat": round(lat, 3), "lon": round(lon, 3), "alt_km": round(alt, 2)})
        except Exception:
            pass
        t += datetime.timedelta(seconds=step_seconds)

    # Future trail (cyan on frontend)
    t = center_dt + datetime.timedelta(seconds=step_seconds)
    end_t = center_dt + datetime.timedelta(minutes=future_minutes)
    while t <= end_t:
        try:
            r_eci, _ = propagate(tle_line1, tle_line2, t)
            gmst_rad = compute_gmst(t)
            r_ecef = eci_to_ecef(r_eci, gmst_rad)
            lat, lon, alt = ecef_to_geodetic(r_ecef)
            future_points.append({"lat": round(lat, 3), "lon": round(lon, 3), "alt_km": round(alt, 2)})
        except Exception:
            pass
        t += datetime.timedelta(seconds=step_seconds)

    return {"past": past_points, "future": future_points}
