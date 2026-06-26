#!/usr/bin/env bash
# Start EvansGame. Creates a local virtualenv on first run, installs deps,
# then launches the server. Open http://localhost:8000 in a browser.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi
source .venv/bin/activate

pip install -q --disable-pip-version-check -r requirements.txt

PORT="${PORT:-8765}"
echo ""
echo "  Evan's Voxel World is running!"
echo "  Open  ->  http://localhost:${PORT}"
echo ""
exec uvicorn server.main:app --host 0.0.0.0 --port "$PORT" "$@"
