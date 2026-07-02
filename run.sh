#!/usr/bin/env bash
# Start EvansGame. Creates a local virtualenv on first run, installs deps,
# then launches the server. Open https://localhost:8765 in a browser.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi
source .venv/bin/activate

pip install -q --disable-pip-version-check -r requirements.txt

PORT="${PORT:-8765}"

# HTTPS is on by default (so microphone / voice chat works for everyone on the
# LAN). A self-signed cert is generated automatically the first time if one
# isn't already present. Set EVANS_HTTP=1 to run plain HTTP instead.
SSL_ARGS=()
SCHEME="https"
CERT="${EVANS_SSL_CERT:-certs/cert.pem}"
KEY="${EVANS_SSL_KEY:-certs/key.pem}"

if [ "${EVANS_HTTP:-}" = "1" ]; then
  SCHEME="http"
else
  if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    echo "  No HTTPS certificate found — generating a self-signed one..."
    if ! ./tools/make_cert.sh >/dev/null 2>&1; then
      echo "  Could not generate a certificate; starting in HTTP mode instead."
      echo "  (Voice chat will only work on the host via localhost. Set EVANS_HTTP=1 to silence.)"
      SCHEME="http"
    fi
  fi
  [ "$SCHEME" = "https" ] && SSL_ARGS=(--ssl-certfile "$CERT" --ssl-keyfile "$KEY")
fi

echo ""
echo "  Evan's Voxel World is running!"
echo "  Open  ->  ${SCHEME}://localhost:${PORT}"
if [ "$SCHEME" = "https" ]; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$IP" ] && echo "  LAN   ->  https://${IP}:${PORT}  (accept the one-time cert warning)"
fi
echo ""
exec uvicorn server.main:app --host 0.0.0.0 --port "$PORT" "${SSL_ARGS[@]}" "$@"
