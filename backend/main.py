"""
ISS Satellite Tracker — FastAPI Backend

Endpoints:
  GET  /              → serves the frontend (index.html)
  GET  /blog          → serves the blog post (blog.html)
  GET  /api/tle       → current TLE + parsed orbital parameters
  GET  /api/orbit     → orbit trail (±30 min around now)
  GET  /api/position  → current ISS position (single REST snapshot)
  WS   /ws            → WebSocket streaming position every 2 seconds

Static files (frontend/) are served directly by FastAPI.
"""

import asyncio
import json
import sys
from pathlib import Path

# Ensure this file's directory is on sys.path so sibling modules
# (propagator, tle_fetcher) are importable regardless of working directory.
sys.path.insert(0, str(Path(__file__).parent))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from propagator import get_full_state, compute_orbit_trail
from tle_fetcher import fetch_tle, parse_tle_epoch, parse_tle_params

# ── App setup ──────────────────────────────────────────────────────────────────
app = FastAPI(title="ISS Satellite Tracker", version="1.0.0")

# Serve frontend static assets (JS/CSS/textures) under /static/*.
# Note: this mounts at /static, not at "/" — the "/" route below serves
# index.html directly, which in turn references assets as /static/....
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


def _fetch_state() -> dict:
    """Fetch the current TLE and propagate it to a full position/velocity state."""
    _, line1, line2 = fetch_tle()
    return get_full_state(line1, line2)


# ── REST endpoints ─────────────────────────────────────────────────────────────
# get_tle/get_orbit/get_position are plain (non-async) functions: FastAPI runs
# sync path operations in a worker thread automatically, so a slow/expired TLE
# fetch here never blocks the event loop — and thus never stalls the /ws update
# loop for every other connected client.

@app.get("/")
async def serve_index():
    """Serve the main frontend page."""
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/blog")
async def serve_blog():
    """Serve the project write-up / blog post page."""
    return FileResponse(str(FRONTEND_DIR / "blog.html"))


@app.get("/api/tle")
def get_tle():
    """
    Return the current ISS TLE with parsed orbital parameters.

    The raw TLE lines are shown in the frontend's TLE panel so students
    can see exactly what data drives the simulation.
    """
    try:
        tle_name, line1, line2 = fetch_tle()
        params = parse_tle_params(line1, line2)
        epoch = parse_tle_epoch(line1)
        return {
            "name": tle_name,
            "line1": line1,
            "line2": line2,
            "epoch": epoch,
            "params": params,
        }
    except Exception as e:
        return JSONResponse(status_code=503, content={"error": str(e)})


@app.get("/api/orbit")
def get_orbit():
    """
    Return the ISS orbit trail: positions ±30 minutes around now.

    Called once on page load (and refreshed every minute) to draw the
    orange past trail and cyan future trail on the globe.

    Points are spaced every 30 seconds → 60 past + 60 future = 120 points total.
    """
    try:
        _, line1, line2 = fetch_tle()
        return compute_orbit_trail(line1, line2,
                                    past_minutes=30,
                                    future_minutes=30,
                                    step_seconds=30)
    except Exception as e:
        return JSONResponse(status_code=503, content={"error": str(e)})


@app.get("/api/position")
def get_position():
    """Return current ISS position as a REST snapshot (for debugging/testing)."""
    try:
        return _fetch_state()
    except Exception as e:
        return JSONResponse(status_code=503, content={"error": str(e)})


# ── WebSocket streaming ────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_position(websocket: WebSocket):
    """
    WebSocket endpoint: streams ISS position every 2 seconds.

    Why WebSocket instead of HTTP polling?
    - Persistent connection → no TCP handshake overhead every 2 seconds
    - Lower latency: server pushes data when ready, client doesn't need to ask
    - Less bandwidth: no HTTP headers on every update

    Message format (JSON):
    {
      "timestamp": "2024-01-15T12:34:56.789Z",
      "lat": 51.5,         // geodetic latitude (degrees)
      "lon": -0.1,         // longitude (degrees, -180 to +180)
      "alt_km": 408.3,     // altitude above WGS84 ellipsoid (km)
      "speed_km_s": 7.663, // orbital speed magnitude (km/s)
      "r_eci": [x, y, z],  // ECI position vector (km)
      "v_eci": [vx,vy,vz], // ECI velocity vector (km/s)
      "r_ecef": [x, y, z], // ECEF position vector (km)
      "gmst_rad": 1.234,   // Greenwich Mean Sidereal Time (radians)
      "gmst_deg": 70.7     // GMST in degrees (for display)
    }
    """
    await websocket.accept()
    print(f"[WS] Client connected: {websocket.client}")

    try:
        while True:
            # Offload the blocking fetch_tle()/SGP4 work to a thread so it
            # never stalls the event loop (and every other client's feed).
            try:
                state = await asyncio.to_thread(_fetch_state)
            except Exception as e:
                # Send an error to the client so it can display a warning.
                # If the socket is already broken, send_text raises here and
                # falls through to the outer handlers below, which log it.
                await websocket.send_text(json.dumps({"error": str(e)}))
            else:
                await websocket.send_text(json.dumps(state))

            # Update every 2 seconds — fast enough for smooth animation,
            # light enough not to overload the server
            await asyncio.sleep(2.0)

    except WebSocketDisconnect:
        print(f"[WS] Client disconnected: {websocket.client}")
    except Exception as e:
        print(f"[WS] Unexpected error: {e}")
