#!/usr/bin/env python3
"""Headless guards for the client performance pass (2026-07-05):
- the glow light pool really turns OFF by day and ON at night (glowstones lit)
- toggling it compiles NO new shader programs (the loading-screen prewarm
  covers both variants — this is what keeps nightfall hitch-free)
- muting the sound suspends the AudioContext; unmuting resumes it
- the minimap's composed tile layer exists and holds pixels

Launches its own isolated server + Chrome (own ports — no collision with the
shared 8899/9223 suite instance or the other self-launching tests).

Run:  .venv/bin/python tools/test_client_perf.py
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

import websocket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8894
DEBUG_PORT = 9220
CHROME = next((p for p in ("/usr/bin/google-chrome", "/usr/bin/chromium-browser",
                           "/snap/bin/chromium") if os.path.exists(p)), None)

PASS = True


def check(name, cond, extra=""):
    global PASS
    ok = bool(cond)
    PASS = PASS and ok
    print(f"{'PASS' if ok else 'FAIL'}  {name} {extra if not ok else ''}")


class Page:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=120)
        self.n = 0
        self.errors = []
        self.send("Runtime.enable")
        self.send("Page.enable")

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
        res = r.get("result", {})
        if "exceptionDetails" in res:
            raise RuntimeError(json.dumps(res["exceptionDetails"])[:400])
        return res.get("result", {}).get("value")

    def wait_for(self, expr, seconds=90, desc=""):
        for _ in range(seconds * 2):
            if self.eval(expr) is True:
                return True
            time.sleep(0.5)
        raise AssertionError(f"timed out: {desc or expr}")


def page_for(url_substr, retries=120):
    for _ in range(retries):
        try:
            with urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=5) as r:
                targets = json.load(r)
            for t in targets:
                if t.get("type") == "page" and url_substr in t.get("url", ""):
                    return Page(t["webSocketDebuggerUrl"])
        except Exception:
            pass
        time.sleep(0.5)
    raise AssertionError("no page")


def main():
    data = tempfile.mkdtemp(prefix="evans-vperf-data-")
    prof = tempfile.mkdtemp(prefix="evans-vperf-chrome-")
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
        log = open(os.path.join(prof, "chrome.log"), "w")
        chrome = subprocess.Popen(
            [CHROME, "--headless=new", f"--remote-debugging-port={DEBUG_PORT}",
             "--remote-allow-origins=*", f"--user-data-dir={prof}",
             "--no-first-run", "--mute-audio", "--window-size=900,600",
             "--autoplay-policy=no-user-gesture-required",
             f"http://localhost:{PORT}/?demo"],
            stdout=log, stderr=log)

        page = page_for(f"localhost:{PORT}")
        page.wait_for("!!(window.game && window.game.world && !window.game.player.frozen)",
                      120, "game boot")
        check("game boots with all touched modules", True)
        check("no uncaught errors during boot", not page.errors, str(page.errors)[:400])
        check("renderer exposed for diagnostics", page.eval("!!window.game.renderer"))

        # Place glowstones near the player so the pool has something to light.
        page.eval("""(() => {
          const G = window.game, p = G.player.pos;
          const x = Math.floor(p.x), y = Math.floor(p.y) + 2, z = Math.floor(p.z);
          for (const [dx, dz] of [[2, 0], [-2, 1], [0, 3]])
            G.world.setBlock(x + dx, y, z + dz, 20, false);
          return G.world.glow.size;
        })()""")

        # Force NOON, let a few frames run.
        page.eval("window.game.sky._clockOffset = null; window.game.sky.time = 0.5; 1")
        time.sleep(1.0)
        progs_day = page.eval("window.game.renderer.info.programs.length")
        check("daytime: glow light pool hidden",
              page.eval("window.game.world._lightsOn === false"
                        " && window.game.world.glowLights.every((L) => !L.visible)"))

        # Force MIDNIGHT.
        page.eval("window.game.sky.time = 0.0; 1")
        time.sleep(1.5)
        check("night: pool visible and burning",
              page.eval("window.game.world._lightsOn === true"
                        " && window.game.world.glowLights.every((L) => L.visible)"
                        " && window.game.world.glowLights[0].intensity > 1"))
        progs_night = page.eval("window.game.renderer.info.programs.length")
        check("night toggle compiled NO new programs (prewarm hit)",
              progs_night == progs_day, f"day={progs_day} night={progs_night}")

        # Back to day, toggle again — still stable.
        page.eval("window.game.sky.time = 0.5; 1")
        time.sleep(1.0)
        progs_day2 = page.eval("window.game.renderer.info.programs.length")
        check("return to day: pool hidden again, programs stable",
              page.eval("window.game.world._lightsOn === false") and progs_day2 == progs_day)

        # Audio: mute -> ctx suspends (after the fade); unmute -> running.
        check("audio running while sound is on",
              page.eval("window.game.voice.ctxState()") == "running")
        page.eval("document.getElementById('music').click()")
        time.sleep(1.0)
        check("muted with no voice: AudioContext suspended",
              page.eval("window.game.voice.ctxState()") == "suspended")
        page.eval("document.getElementById('music').click()")
        time.sleep(0.5)
        check("unmute resumes the AudioContext",
              page.eval("window.game.voice.ctxState()") == "running")

        # Minimap composed layer: exists, sized to the chunk window, has pixels.
        check("minimap layer composed and non-empty", page.eval("""(() => {
          const m = window.game.minimap;
          if (!m._layer || m._layerCx0 === null) return false;
          const c = m._layerCtx.getImageData(0, 0, m._layer.width, m._layer.height).data;
          for (let i = 3; i < c.length; i += 4) if (c[i] > 0) return true;
          return false;
        })()"""))

        check("no uncaught errors at end", not page.errors, str(page.errors)[:400])
        print("RESULT:", "ALL PASS" if PASS else "SOME FAILED")
        sys.exit(0 if PASS else 2)
    finally:
        if chrome:
            chrome.send_signal(signal.SIGTERM)
            try:
                chrome.wait(timeout=5)
            except Exception:
                chrome.kill()
        server.send_signal(signal.SIGTERM)
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()
        shutil.rmtree(data, ignore_errors=True)
        shutil.rmtree(prof, ignore_errors=True)


if __name__ == "__main__":
    main()
