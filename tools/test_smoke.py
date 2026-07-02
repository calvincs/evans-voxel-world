#!/usr/bin/env python3
"""
End-to-end UI smoke test: launches an ISOLATED server (own EVANS_DATA_DIR,
never the real data/) and its own headless Chrome (killed by PID at the end),
boots the game via ?demo, and asserts the client actually works:

  - the demo world loads and the player unfreezes
  - the 🔊 button is a master mute (icon flips, choice persisted)
  - a bogus world id shows the "Couldn't start" panel with a retry button
    (not a silently dead menu)
  - no uncaught page errors during boot

Run:  .venv/bin/python tools/test_smoke.py
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket  # websocket-client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8899
DEBUG_PORT = 9223
CHROME = next((p for p in ("/usr/bin/google-chrome", "/usr/bin/chromium-browser",
                           "/snap/bin/chromium") if os.path.exists(p)), None)

PASS = 0


def check(name, cond, extra=""):
    global PASS
    assert cond, f"FAIL: {name} {extra}"
    PASS += 1
    print(f"  ok: {name}")


class Page:
    """Minimal CDP driver for one page target."""

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60)
        self.n = 0
        self.errors = []
        self.send("Runtime.enable")

    def send(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("method") == "Runtime.exceptionThrown":
                d = m["params"]["exceptionDetails"]
                self.errors.append(d.get("text", "") + " " +
                                   str((d.get("exception") or {}).get("description", ""))[:300])
            if m.get("id") == self.n:
                return m

    def eval(self, expr):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True, timeout=30000)
        return r.get("result", {}).get("result", {}).get("value")

    def wait_for(self, expr, seconds=60, desc=""):
        for _ in range(seconds * 2):
            if self.eval(expr) is True:
                return True
            time.sleep(0.5)
        raise AssertionError(f"timed out waiting for: {desc or expr}")


def page_for(url_substr, retries=120):
    last = "no /json response"
    for _ in range(retries):
        try:
            with urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=5) as r:
                targets = json.load(r)
            for t in targets:
                if t.get("type") == "page" and url_substr in t.get("url", ""):
                    return Page(t["webSocketDebuggerUrl"])
            last = "targets: " + str([(t.get("type"), t.get("url", "")[:80]) for t in targets])
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(0.5)
    raise AssertionError(f"no Chrome page matching {url_substr!r} — last: {last}")


def main():
    if not CHROME:
        print("SKIP: no Chrome/Chromium found")
        sys.exit(0)
    data = tempfile.mkdtemp(prefix="evans-smoke-data-")
    prof = tempfile.mkdtemp(prefix="evans-smoke-chrome-")
    env = dict(os.environ, EVANS_DATA_DIR=data)
    server = subprocess.Popen(
        [os.path.join(ROOT, ".venv/bin/uvicorn"), "server.main:app",
         "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome = None
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://localhost:{PORT}/api/health", timeout=2)
                break
            except Exception:
                time.sleep(0.25)
        chrome_log = open(os.path.join(prof, "chrome.log"), "w")
        chrome = subprocess.Popen(
            [CHROME, "--headless=new", f"--remote-debugging-port={DEBUG_PORT}",
             "--remote-allow-origins=*",     # CDP handshake (newer Chrome rejects otherwise)
             f"--user-data-dir={prof}", "--no-first-run", "--mute-audio",
             "--autoplay-policy=no-user-gesture-required",
             f"http://localhost:{PORT}/?demo"],
            stdout=chrome_log, stderr=chrome_log)

        # --- A: demo world boots and the player unfreezes ----------------------
        page = page_for(f"localhost:{PORT}")
        page.wait_for("!!(window.game && window.game.world && !window.game.player.frozen)",
                      90, "game boot")
        check("demo world boots, player active", True)
        boot_errors = [e for e in page.errors]
        check("no uncaught errors during boot", not boot_errors, str(boot_errors)[:400])

        # --- B: master mute — icon flips + persisted ----------------------------
        check("sound starts ON", page.eval(
            "document.getElementById('music').textContent") == "🔊")
        page.eval("document.getElementById('music').click()")
        check("mute flips icon to 🔇", page.eval(
            "document.getElementById('music').textContent") == "🔇")
        check("mute persisted to localStorage", page.eval(
            "localStorage.getItem('evans-sound')") == "0")
        page.eval("document.getElementById('music').click()")
        check("unmute flips back + persists", page.eval(
            "document.getElementById('music').textContent + localStorage.getItem('evans-sound')")
            == "🔊1")

        # --- C: bogus world -> visible error panel, not a dead menu ------------
        # (navigate the same page; headless Chrome doesn't open real popups)
        page.eval(f"location.href = 'http://localhost:{PORT}/?demo&w=w_bogus00'")
        page.wait_for("document.body.innerText.includes(\"Couldn't start\")", 30,
                      "error panel for bogus world")
        check("bogus world shows 'Couldn't start' panel", True)
        check("error panel has a Try-again button",
              page.eval("!!document.getElementById('retry-btn')") is True)

        print(f"\nall {PASS} checks passed")
    finally:
        for proc in (chrome, server):
            if proc:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
        shutil.rmtree(prof, ignore_errors=True)
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    main()
