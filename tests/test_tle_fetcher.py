"""Tests for tle_fetcher.py's TLE cache and single-flight fetch coordination."""

import threading
import time
from unittest.mock import patch, MagicMock

import pytest

import tle_fetcher


FAKE_TLE_TEXT = (
    "ISS (ZARYA)\n"
    "1 25544U 98067A   24016.54842593  .00016717  00000-0  10270-3 0  9993\n"
    "2 25544  51.6400 337.6640 0001938  86.2141 273.9285 15.49559958435128\n"
)


@pytest.fixture(autouse=True)
def reset_tle_fetcher_state():
    """tle_fetcher keeps its cache/coordination state as module globals."""
    tle_fetcher._cache.clear()
    tle_fetcher._fetching = False
    yield
    tle_fetcher._cache.clear()
    tle_fetcher._fetching = False


def _make_fake_response(text=FAKE_TLE_TEXT):
    resp = MagicMock()
    resp.text = text
    resp.raise_for_status = MagicMock()
    return resp


def test_fresh_cache_short_circuits():
    call_count = {"n": 0}

    def fake_get(*args, **kwargs):
        call_count["n"] += 1
        return _make_fake_response()

    with patch.object(tle_fetcher.httpx, "get", side_effect=fake_get):
        first = tle_fetcher.fetch_tle()
        second = tle_fetcher.fetch_tle()

    assert call_count["n"] == 1
    assert first == second


def test_stale_cache_fallback_still_works():
    tle_fetcher._cache.update({
        "timestamp": time.time() - tle_fetcher.CACHE_TTL_SECONDS - 10,
        "name": "ISS (ZARYA)",
        "line1": "1 25544U 98067A   24016.54842593  .00016717  00000-0  10270-3 0  9993",
        "line2": "2 25544  51.6400 337.6640 0001938  86.2141 273.9285 15.49559958435128",
    })

    with patch.object(tle_fetcher.httpx, "get", side_effect=RuntimeError("network down")):
        name, line1, line2 = tle_fetcher.fetch_tle()

    assert name == "ISS (ZARYA)"
    assert line1.startswith("1 25544U")


def test_concurrent_expired_cache_triggers_one_fetch_only():
    call_count = {"n": 0}
    call_lock = threading.Lock()

    def fake_get(*args, **kwargs):
        with call_lock:
            call_count["n"] += 1
        time.sleep(0.15)  # simulate real network latency so threads overlap
        return _make_fake_response()

    results = []
    errors = []

    def worker():
        try:
            results.append(tle_fetcher.fetch_tle())
        except Exception as e:
            errors.append(e)

    with patch.object(tle_fetcher.httpx, "get", side_effect=fake_get):
        threads = [threading.Thread(target=worker) for _ in range(20)]
        start = time.time()
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)
        elapsed = time.time() - start

    assert not errors
    assert call_count["n"] == 1
    assert len(results) == 20
    assert len(set(results)) == 1  # everyone got the identical tuple
    assert elapsed < 1.0  # should not have serialized 20x sleeps


def test_concurrent_fetch_failure_with_no_cache_dedups_too():
    call_count = {"n": 0}
    call_lock = threading.Lock()

    def fake_get(*args, **kwargs):
        with call_lock:
            call_count["n"] += 1
        time.sleep(0.1)
        raise RuntimeError("celestrak is down")

    errors = []

    def worker():
        try:
            tle_fetcher.fetch_tle()
        except Exception as e:
            errors.append(e)

    with patch.object(tle_fetcher.httpx, "get", side_effect=fake_get):
        threads = [threading.Thread(target=worker) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

    assert call_count["n"] == 1
    assert len(errors) == 10
    assert all(isinstance(e, RuntimeError) for e in errors)
