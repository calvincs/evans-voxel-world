#!/usr/bin/env bash
# Launch an ISOLATED game server (+ its own headless Chrome) and run the full
# headless gameplay test suite against it: mob AI, mines/TNT, mine ownership,
# villages — plus the UI smoke test (which launches its own instance).
#
# Never touches the real data/ (EVANS_DATA_DIR points at a scratch dir) and
# only kills the Chrome it started (by PID).
set -u
cd "$(dirname "$0")/.."

PORT=8899
DEBUG_PORT=9223
SCRATCH=$(mktemp -d /tmp/evans-gametests-XXXXXX)
CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome || command -v chromium-browser || command -v chromium)}"

EVANS_DATA_DIR="$SCRATCH/data" .venv/bin/uvicorn server.main:app \
  --host 127.0.0.1 --port $PORT >"$SCRATCH/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done

"$CHROME_BIN" --headless=new --remote-debugging-port=$DEBUG_PORT \
  --remote-allow-origins='*' --user-data-dir="$SCRATCH/chrome" \
  --no-first-run --mute-audio --autoplay-policy=no-user-gesture-required \
  "http://localhost:$PORT/?demo" >"$SCRATCH/chrome.log" 2>&1 &
CHR=$!

cleanup() {
  kill "$CHR" "$SRV" 2>/dev/null
  wait "$CHR" "$SRV" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

FAIL=0
echo "=== tools/test_creature_ai.py (pure Python, server AI) ==="
.venv/bin/python tools/test_creature_ai.py || FAIL=1

for t in test_mines test_mine_ownership test_village; do
  echo "=== tools/$t.py ==="
  .venv/bin/python "tools/$t.py" || FAIL=1
done

echo "=== tools/test_smoke.py (own instance) ==="
.venv/bin/python tools/test_smoke.py || FAIL=1

echo "=== tools/test_mob_sync.py (own instance, two players) ==="
.venv/bin/python tools/test_mob_sync.py || FAIL=1

echo
[ $FAIL -eq 0 ] && echo "GAME TESTS: ALL PASS" || echo "GAME TESTS: FAILURES ABOVE"
exit $FAIL
