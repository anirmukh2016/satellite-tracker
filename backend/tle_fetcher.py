"""
TLE Fetcher — retrieves Two-Line Element sets for the ISS from Celestrak.

A TLE (Two-Line Element set) is a standardized format for encoding the orbital
parameters of an Earth-orbiting object. It contains everything SGP4 needs to
predict where the satellite will be at any future time.

TLEs are updated ~twice a day by NORAD/Space-Track. We cache for 1 hour to
avoid hammering the server on every request.
"""

import threading
import time
import httpx

# ISS NORAD Catalog Number (assigned when launched)
ISS_NORAD_ID = 25544

# Celestrak GP data API (new endpoint since 2022-02-13)
# Old URL (removed): https://celestrak.org/satcat/tle.php?CATNR=25544
CELESTRAK_URL = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={ISS_NORAD_ID}&FORMAT=TLE"

# Cache storage: (timestamp, tle_name, tle_line1, tle_line2)
_cache: dict = {}
_cache_lock = threading.Lock()
_condition = threading.Condition(_cache_lock)
_fetching = False  # True while some thread is actually calling Celestrak
_last_error: Exception | None = None  # the in-flight fetch's error, for waiters
CACHE_TTL_SECONDS = 3600  # 1 hour


def _cache_is_fresh(now: float) -> bool:
    return bool(_cache) and (now - _cache["timestamp"]) < CACHE_TTL_SECONDS


def fetch_tle() -> tuple[str, str, str]:
    """
    Fetch the latest ISS TLE from Celestrak, with 1-hour caching.

    Single-flight: if the cache is stale and a fetch is already in progress
    on another thread, wait for that fetch's result instead of firing a
    second concurrent request — Celestrak doesn't appreciate bursts of
    near-simultaneous requests when many local threads all notice the
    cache expired at once.

    Returns:
        (name, line1, line2) — the three lines of a standard TLE set

    TLE format overview:
        Line 0: Satellite name
        Line 1: Epoch, drag term, inclination origin data
        Line 2: Orbital elements — inclination, RAAN, eccentricity,
                argument of perigee, mean anomaly, mean motion
    """
    global _fetching, _last_error

    with _condition:
        if _cache_is_fresh(time.time()):
            return _cache["name"], _cache["line1"], _cache["line2"]

        if _fetching:
            # Someone else is already talking to Celestrak — wait for their
            # result instead of firing a second concurrent request. Once
            # they're done, take whatever they left behind: a cache (fresh
            # from success, or stale-but-valid from a graceful fallback) is
            # exactly what we'd have returned ourselves; no cache at all
            # means their attempt failed outright, so share their error
            # rather than each waiter retrying Celestrak on its own.
            while _fetching:
                _condition.wait(timeout=15.0)
            if _cache:
                return _cache["name"], _cache["line1"], _cache["line2"]
            raise RuntimeError(f"Could not fetch TLE and no cache available: {_last_error}")

        # Nobody else is fetching, and the cache is stale/empty — we do it.
        _fetching = True

    # The actual network call happens outside the lock, so a slow fetch
    # never blocks other threads from reading a still-valid cache.
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

        with _condition:
            _cache["timestamp"] = time.time()
            _cache["name"] = name
            _cache["line1"] = line1
            _cache["line2"] = line2
            _fetching = False
            _condition.notify_all()

        return name, line1, line2

    except Exception as e:
        with _condition:
            _fetching = False
            _last_error = e
            _condition.notify_all()
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
