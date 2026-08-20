#!/bin/bash
# ── ISS Satellite Tracker — One-command startup ───────────────────────────────
#
# Usage:
#   bash run.sh
#
# What this does:
#   1. Installs Python dependencies via uv (sgp4, fastapi, uvicorn, httpx)
#   2. Starts the FastAPI server on http://localhost:8000
#   3. The server also serves the frontend — open http://localhost:8000 in browser
#
# Requirements:
#   - uv (https://docs.astral.sh/uv/)
#   - Internet connection (to fetch live TLE from Celestrak)

set -e

echo ""
echo "  🛰  ISS Satellite Tracker"
echo "  ─────────────────────────────────────────"
echo ""

# Navigate to repo root
cd "$(dirname "$0")"

# Install Python dependencies
echo "  [1/2] Installing Python dependencies..."
uv sync

echo "  [2/2] Starting FastAPI server..."
echo ""
echo "  Open your browser at: http://localhost:8000"
echo "  Press Ctrl+C to stop."
echo ""

# Start the server
# --reload: auto-reload on file changes (dev mode)
# --port 8000: listen on port 8000
uv run uvicorn backend.main:app --reload --port 8000 --host 0.0.0.0
