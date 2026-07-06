#!/usr/bin/env python3
"""
Capture the README screenshots. Launches an ISOLATED server (own
EVANS_DATA_DIR, never the real data/) and its own headless Chrome (killed by
PID at the end), builds each scene in a fresh demo world, and saves PNGs.

Run:  .venv/bin/python tools/screenshots.py [output-dir]   (default docs/screenshots)

Scenes:
  village.png    the settlement from above at noon, villagers about
  villagers.png  ground level by the well, chatting distance
  night.png      a little glowstone cottage (door shut!) after dark
  tnt.png        a TNT cluster mid-explosion
"""

import base64
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
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else
                      os.path.join(ROOT, "docs", "screenshots"))
# Own ports — never collide with the shared test instance (8899/9223) or the
# self-launching tests (8897/8898, 9224/9225).
PORT = 8896
DEBUG_PORT = 9226
CHROME = next((p for p in ("/usr/bin/google-chrome", "/usr/bin/chromium-browser",
                           "/snap/bin/chromium") if os.path.exists(p)), None)


class Page:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=120)
        self.n = 0

    def send(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.n:
                return m

    def eval(self, expr):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True, timeout=60000)
        return r.get("result", {}).get("result", {}).get("value")

    def wait_for(self, expr, seconds=90, desc=""):
        for _ in range(seconds * 2):
            if self.eval(expr) is True:
                return
            time.sleep(0.5)
        raise AssertionError(f"timed out waiting for: {desc or expr}")

    def shot(self, path):
        r = self.send("Page.captureScreenshot", format="png")
        data = r.get("result", {}).get("data")
        if not data:
            raise AssertionError(f"no screenshot data for {path}")
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        print("  saved", os.path.relpath(path, ROOT))


def page_for(url_substr, retries=120):
    for _ in range(retries):
        try:
            with urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=5) as r:
                for t in json.load(r):
                    if t.get("type") == "page" and url_substr in t.get("url", ""):
                        return Page(t["webSocketDebuggerUrl"])
        except Exception:
            pass
        time.sleep(0.5)
    raise AssertionError(f"no Chrome page matching {url_substr!r}")


# Park the player on a dirt pillar at (px, pz), eye toward (tx, tz).
def perch(page, px, py, pz, tx, tz, pitch):
    page.eval(f"""(() => {{
      const G = window.game;
      const px = {px}, pz = {pz}, py = {py};
      let g = py - 1;
      while (g > 1 && G.world.getBlock(px, g, pz) === 0) g--;
      for (let y = g + 1; y < py; y++) G.world.setBlock(px, y, pz, 2, false);
      G.player.pos.set(px + 0.5, py + 0.01, pz + 0.5);
      G.player.vel.set(0, 0, 0);
      G.player.yaw = Math.atan2(-({tx} - px), -({tz} - pz));
      G.player.pitch = {pitch};
      return 'ok';
    }})()""")


def set_time(page, t):
    # Detach the sky from the server clock and pin the phase (0=midnight,
    # 0.5=noon). dayLength is minutes long, so it holds for a screenshot.
    page.eval(f"window.game.sky._clockOffset = null; window.game.sky.time = {t}; 'ok'")


def stream_chunks(page, x, z, seconds=30):
    page.eval(f"window.game.world.update({x}, {z}); 'load'")
    for _ in range(seconds):
        if page.eval(f"window.game.world.ready({x}, {z})") is True:
            return
        page.eval(f"window.game.world.update({x}, {z}); 'load'")
        time.sleep(1)
    raise AssertionError(f"chunks near ({x},{z}) never streamed in")


def main():
    if not CHROME:
        sys.exit("no Chrome/Chromium found")
    os.makedirs(OUT, exist_ok=True)
    data = tempfile.mkdtemp(prefix="evans-shots-data-")
    prof = tempfile.mkdtemp(prefix="evans-shots-chrome-")
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
             "--remote-allow-origins=*", f"--user-data-dir={prof}",
             "--no-first-run", "--mute-audio", "--window-size=1280,720",
             "--autoplay-policy=no-user-gesture-required",
             f"http://localhost:{PORT}/?demo"],
            stdout=chrome_log, stderr=chrome_log)

        page = page_for(f"localhost:{PORT}")
        page.wait_for("!!(window.game && window.game.world && !window.game.player.frozen)",
                      120, "game boot")
        if page.eval("!!window.game.mobs.village") is not True:
            sys.exit("demo world has no village (rare seed) — rerun for a fresh one")
        v = page.eval("JSON.stringify(window.game.mobs.village)")
        v = json.loads(v)
        vx, vz, vg = v["x"], v["z"], v["ground"]
        print(f"village at ({vx},{vz}) ground {vg}")
        stream_chunks(page, vx, vz)

        # Villagers are server-spawned while a player is in town.
        page.eval(f"""window.game.player.pos.set({vx} + 0.5, {vg} + 3, {vz} + 6.5);
                      window.game.player.vel.set(0,0,0); 'ok'""")
        for _ in range(75):
            n = page.eval("window.game.mobs.mobs.filter(m => m.t.villager).length")
            if isinstance(n, int) and n >= 4:
                break
            time.sleep(1)
        print("  villagers:", n)

        scenes = set(os.environ.get("SCENES", "village,villagers,night,tnt").split(","))

        # --- 1: the village from above, noon ---------------------------------
        if "village" in scenes:
            set_time(page, 0.5)
            perch(page, vx - 16, vg + 9, vz + 10, vx, vz, -0.35)
            time.sleep(2.5)
            page.shot(os.path.join(OUT, "village.png"))

        # --- 2: among the villagers ------------------------------------------
        # Aim at where the villagers actually are, not at the well tower.
        if "villagers" in scenes:
            set_time(page, 0.45)
            c = page.eval("""(() => {
              const vs = window.game.mobs.mobs.filter(m => m.t.villager);
              if (!vs.length) return null;
              const cx = vs.reduce((s, m) => s + m.pos.x, 0) / vs.length;
              const cz = vs.reduce((s, m) => s + m.pos.z, 0) / vs.length;
              return JSON.stringify({x: cx, z: cz});
            })()""")
            c = json.loads(c) if c else {"x": vx, "z": vz + 4}
            cx, cz = int(c["x"]), int(c["z"])
            perch(page, cx + 7, vg + 3, cz + 5, cx, cz, -0.12)
            time.sleep(1)
            page.shot(os.path.join(OUT, "villagers.png"))

        # --- 3: glowstone cottage after dark ----------------------------------
        # Build on open ground outside the village so the shot is just ours.
        if "night" in scenes:
            bx, bz = vx + 28, vz + 4
            stream_chunks(page, bx, bz)
            g = page.eval(f"""(() => {{
              const G = window.game, W = G.world;
              const bx = {bx}, bz = {bz};
              let g = 40;
              while (g > 1 && W.getBlock(bx, g, bz) === 0) g--;
              const setB = (x, y, z, b) => W.setBlock(x, y, z, b, false);
              // 7x5 footprint: x bx-3..bx+3, z bz-2..bz+2, walls 3 high.
              for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) {{
                setB(bx + x, g, bz + z, 11);                   // cobble floor
                for (let y = 1; y <= 3; y++) {{
                  const wall = Math.abs(x) === 3 || Math.abs(z) === 2;
                  setB(bx + x, g + y, bz + z, wall ? 8 : 0);   // plank walls
                }}
                setB(bx + x, g + 4, bz + z, 8);                // flat plank roof
              }}
              // Windows on the long sides.
              for (const x of [-2, 0, 2]) {{
                setB(bx + x, g + 2, bz - 2, 9); setB(bx + x, g + 2, bz + 2, 9);
              }}
              // Door on the east face (facing the camera), shut for the night.
              setB(bx + 3, g + 1, bz, 91); setB(bx + 3, g + 2, bz, 91);
              // Glowstone: roof corners + porch lights either side of the door.
              setB(bx - 3, g + 5, bz - 2, 20); setB(bx + 3, g + 5, bz - 2, 20);
              setB(bx - 3, g + 5, bz + 2, 20); setB(bx + 3, g + 5, bz + 2, 20);
              setB(bx + 4, g + 2, bz - 2, 20); setB(bx + 4, g + 2, bz + 2, 20);
              // Clear a sightline: no tree trunks/leaves between camera & house.
              for (let x = bx + 4; x <= bx + 13; x++)
                for (let z = bz - 5; z <= bz + 9; z++)
                  for (let y = g + 1; y <= g + 14; y++) {{
                    const b = W.getBlock(x, y, z);
                    if (b === 4 || b === 5) setB(x, y, z, 0);
                  }}
              return g;
            }})()""")
            set_time(page, 0.02)                # deep night
            perch(page, bx + 9, g + 5, bz + 5, bx, bz, -0.22)
            time.sleep(3)
            page.shot(os.path.join(OUT, "night.png"))

        # --- 4: TNT going off --------------------------------------------------
        if "tnt" in scenes:
            tx, tz = vx - 30, vz - 6
            stream_chunks(page, tx, tz)
            set_time(page, 0.5)
            g = page.eval(f"""(() => {{
              const G = window.game, W = G.world;
              const tx = {tx}, tz = {tz};
              let g = 40;
              while (g > 1 && W.getBlock(tx, g, tz) === 0) g--;
              for (const [dx, dz] of [[0,0],[1,0],[0,1],[1,1],[-1,0],[0,-1]])
                W.setBlock(tx + dx, g + 1, tz + dz, 18, false);  // TNT cluster
              // Clear a sightline from the camera to the blast.
              for (let x = tx + 3; x <= tx + 12; x++)
                for (let z = tz - 4; z <= tz + 9; z++)
                  for (let y = g + 1; y <= g + 14; y++) {{
                    const b = W.getBlock(x, y, z);
                    if (b === 4 || b === 5) W.setBlock(x, y, z, 0, false);
                  }}
              return g;
            }})()""")
            perch(page, tx + 9, g + 4, tz + 6, tx, tz, -0.15)
            time.sleep(2)
            page.eval(f"window.game.world.igniteTNT({tx}, {g + 1}, {tz}, 1.0); 'lit'")
            # Headless rAF can run slower than wall-clock, so poll for the
            # actual detonation (TNT block gone) and shoot into the debris.
            for _ in range(600):
                if page.eval(f"window.game.world.getBlock({tx}, {g + 1}, {tz}) === 0") is True:
                    break
                time.sleep(0.05)
            time.sleep(0.15)
            page.shot(os.path.join(OUT, "tnt.png"))

        print("done")
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
