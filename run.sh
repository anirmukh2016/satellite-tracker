#!/bin/bash
# ── ISS Satellite Tracker — One-command startup ───────────────────────────────
#
# Usage:
#   bash run.sh
#
# What this does:
#   1. Installs Python dependencies (sgp4, fastapi, uvicorn, httpx)
#   2. Starts the FastAPI server on http://localhost:8000
#   3. The server also serves the frontend — open http://localhost:8000 in browser
#
# Requirements:
#   - Python 3.9+
#   - pip
#   - Internet connection (to fetch live TLE from Celestrak)

set -e

echo ""
echo "  🛰  ISS Satellite Tracker"
echo "  ─────────────────────────────────────────"
echo ""

# Navigate to backend directory
cd "$(dirname "$0")/backend"

# Install Python dependencies
echo "  [1/2] Installing Python dependencies..."
pip install -q -r requirements.txt 2>/dev/null || \
  pip install -q -r requirements.txt --break-system-packages

echo "  [2/2] Starting FastAPI server..."
echo ""
echo "  Open your browser at: http://localhost:8000"
echo "  Press Ctrl+C to stop."
echo ""

# Start the server
# --reload: auto-reload on file changes (dev mode)
# --port 8000: listen on port 8000
uvicorn main:app --reload --port 8000 --host 0.0.0.0
