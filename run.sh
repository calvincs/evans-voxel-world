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

# Optional HTTPS (needed for microphone / voice chat on non-localhost devices).
# Set EVANS_SSL_CERT + EVANS_SSL_KEY, or run ./tools/make_cert.sh first.
SSL_ARGS=()
SCHEME="http"
if [ -n "$EVANS_SSL_CERT" ] && [ -n "$EVANS_SSL_KEY" ]; then
  SSL_ARGS=(--ssl-certfile "$EVANS_SSL_CERT" --ssl-keyfile "$EVANS_SSL_KEY")
  SCHEME="https"
fi

echo ""
echo "  Evan's Voxel World is running!"
echo "  Open  ->  ${SCHEME}://localhost:${PORT}"
echo ""
exec uvicorn server.main:app --host 0.0.0.0 --port "$PORT" "${SSL_ARGS[@]}" "$@"
