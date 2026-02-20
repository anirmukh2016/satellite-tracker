"""
TLE Fetcher — retrieves Two-Line Element sets for the ISS from Celestrak.

A TLE (Two-Line Element set) is a standardized format for encoding the orbital
parameters of an Earth-orbiting object. It contains everything SGP4 needs to
predict where the satellite will be at any future time.

TLEs are updated ~twice a day by NORAD/Space-Track. We cache for 1 hour to
avoid hammering the server on every request.
"""

import time
import httpx

# ISS NORAD Catalog Number (assigned when launched)
ISS_NORAD_ID = 25544

# Celestrak GP data API (new endpoint since 2022-02-13)
# Old URL (removed): https://celestrak.org/satcat/tle.php?CATNR=25544
CELESTRAK_URL = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={ISS_NORAD_ID}&FORMAT=TLE"

# Cache storage: (timestamp, tle_name, tle_line1, tle_line2)
_cache: dict = {}
CACHE_TTL_SECONDS = 3600  # 1 hour


def fetch_tle() -> tuple[str, str, str]:
    """
    Fetch the latest ISS TLE from Celestrak, with 1-hour caching.

    Returns:
        (name, line1, line2) — the three lines of a standard TLE set

    TLE format overview:
        Line 0: Satellite name
        Line 1: Epoch, drag term, inclination origin data
        Line 2: Orbital elements — inclination, RAAN, eccentricity,
                argument of perigee, mean anomaly, mean motion
    """
    now = time.time()

    # Return cached TLE if still fresh
    if _cache and (now - _cache["timestamp"]) < CACHE_TTL_SECONDS:
        return _cache["name"], _cache["line1"], _cache["line2"]

    # Fetch fresh TLE
    try:
        response = httpx.get(CELESTRAK_URL, timeout=10.0)
        response.raise_for_status()
        lines = [l.strip() for l in response.text.strip().splitlines() if l.strip()]

        if len(lines) < 3:
            raise ValueError(f"Unexpected TLE response: {response.text[:200]}")

        name = lines[0]
        line1 = lines[1]
        line2 = lines[2]

        # Validate it looks like a real TLE
        if not line1.startswith("1 ") or not line2.startswith("2 "):
            raise ValueError(f"Malformed TLE lines: {line1[:30]} / {line2[:30]}")

        _cache["timestamp"] = now
        _cache["name"] = name
        _cache["line1"] = line1
        _cache["line2"] = line2

        return name, line1, line2

    except Exception as e:
        # If fetch fails and we have a stale cache, use it rather than crashing
        if _cache:
            print(f"[TLE] Fetch failed ({e}), using stale cache")
            return _cache["name"], _cache["line1"], _cache["line2"]
        raise RuntimeError(f"Could not fetch TLE and no cache available: {e}")


def parse_tle_epoch(line1: str) -> str:
    """
    Parse the epoch from TLE line 1 into a human-readable UTC string.

    TLE epoch format: YYDDD.DDDDDDDD
      YY  = 2-digit year (57-99 → 1957-1999, 00-56 → 2000-2056)
      DDD = day of year (1-based)
      .DD = fractional day
    """
    epoch_str = line1[18:32].strip()
    year_2digit = int(epoch_str[:2])
    year = 2000 + year_2digit if year_2digit < 57 else 1900 + year_2digit
    day_of_year = float(epoch_str[2:])

    import datetime
    base = datetime.datetime(year, 1, 1)
    epoch_dt = base + datetime.timedelta(days=day_of_year - 1)
    return epoch_dt.strftime("%Y-%m-%d %H:%M:%S UTC")


def parse_tle_params(line1: str, line2: str) -> dict:
    """
    Extract key orbital parameters from TLE lines for display in the HUD.

    These numbers come directly from the TLE — no propagation needed.
    """
    # Inclination (degrees) — angle between orbital plane and equator
    inclination = float(line2[8:16].strip())

    # Right Ascension of Ascending Node (degrees) — where orbit crosses equator going north
    raan = float(line2[17:25].strip())

    # Eccentricity — 0 = circular, 1 = parabolic (ISS is nearly circular ~0.0002)
    eccentricity = float("0." + line2[26:33].strip())

    # Mean motion (revolutions per day) → orbital period in minutes
    mean_motion = float(line2[52:63].strip())
    period_minutes = 1440.0 / mean_motion  # 1440 min/day

    return {
        "inclination_deg": round(inclination, 4),
        "raan_deg": round(raan, 4),
        "eccentricity": round(eccentricity, 6),
        "mean_motion_rev_per_day": round(mean_motion, 8),
        "period_minutes": round(period_minutes, 2),
    }
