#!/usr/bin/env python3
"""
Two-client creature-sync test: launches an ISOLATED server + one headless
Chrome, opens TWO game pages in it (two players in the same world), and
asserts the sim-owner model end to end:

  - second player becomes a mirror of the first (the sim owner)
  - a hatched creature appears for BOTH players in the same place, and is
    persisted server-side
  - a mirror player's attacks kill it for everyone (and un-persist it)
  - when the owner leaves, the mirror is promoted and keeps the creatures
  - a full leave + rejoin still finds the placed creatures (persistence)

Run:  .venv/bin/python tools/test_mob_sync.py
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
# Own ports: this test launches its own server + Chrome and must not collide
# with the shared instance run_game_tests.sh keeps on 8899/9223.
PORT = 8897
DEBUG_PORT = 9224
CHROME = next((p for p in ("/usr/bin/google-chrome", "/usr/bin/chromium-browser",
                           "/snap/bin/chromium") if os.path.exists(p)), None)

PASS = 0


def check(name, cond, extra=""):
    global PASS
    assert cond, f"FAIL: {name} {extra}"
    PASS += 1
    print(f"  ok: {name}")


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60)
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
                      awaitPromise=True, timeout=30000)
        return r.get("result", {}).get("result", {}).get("value")

    def wait_for(self, expr, seconds=60, desc=""):
        for _ in range(seconds * 4):
            if self.eval(expr) is True:
                return
            time.sleep(0.25)
        raise AssertionError(f"timed out waiting for: {desc or expr} — last: {self.eval(expr)!r}")


def targets():
    with urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=5) as r:
        return json.load(r)


def page_for(target_id, retries=60):
    for _ in range(retries):
        for t in targets():
            if t.get("id") == target_id and t.get("type") == "page":
                return CDP(t["webSocketDebuggerUrl"])
        time.sleep(0.5)
    raise AssertionError(f"page {target_id} never appeared")


def browser_cdp(retries=60):
    for _ in range(retries):
        try:
            with urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json/version",
                                        timeout=5) as r:
                return CDP(json.load(r)["webSocketDebuggerUrl"])
        except Exception:
            time.sleep(0.5)
    raise AssertionError("browser CDP endpoint never appeared")


GAME_READY = "!!(window.game && window.game.world && !window.game.player.frozen)"


def main():
    if not CHROME:
        print("SKIP: no Chrome/Chromium found")
        sys.exit(0)
    data = tempfile.mkdtemp(prefix="evans-sync-data-")
    prof = tempfile.mkdtemp(prefix="evans-sync-chrome-")
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
        chrome = subprocess.Popen(
            [CHROME, "--headless=new", f"--remote-debugging-port={DEBUG_PORT}",
             "--remote-allow-origins=*", f"--user-data-dir={prof}", "--no-first-run",
             "--mute-audio", f"http://localhost:{PORT}/?demo"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        browser = browser_cdp()
        a_id = next(t["id"] for t in targets() if t.get("type") == "page")
        A = page_for(a_id)
        A.wait_for(GAME_READY, 90, "player A boot")
        A.eval("game.mobs.spawnTimer = 1e9; game.mobs.clear()")   # deterministic stage

        # --- second player joins the same world --------------------------------
        b_id = browser.send("Target.createTarget",
                            url=f"http://localhost:{PORT}/?demo")["result"]["targetId"]
        B = page_for(b_id)
        B.wait_for(GAME_READY, 90, "player B boot")
        A.wait_for("game.mobs.role === 'owner' && game.mobs.peers === 1", 20,
                   "A is sim owner with a peer")
        B.wait_for("game.mobs.role === 'mirror'", 20, "B is a mirror")
        check("first player simulates, second mirrors", True)

        # --- hatch on A -> same creature on both + persisted --------------------
        A.eval("""(() => {
          const p = game.player.pos;
          game.mobs.hatchEgg('wolf', Math.floor(p.x) + 2, Math.floor(p.y) + 1, Math.floor(p.z));
        })()""")
        A.wait_for("game.mobs.mobs.some(m => m.cid)", 15, "wolf hatched on A")
        cid = A.eval("game.mobs.mobs.find(m => m.cid).cid")
        check("hatched wolf has a server id", isinstance(cid, str) and cid.startswith("c"), cid)
        B.wait_for(f"game.mobs.mobs.some(m => m.nid === '{cid}')", 15, "wolf visible on B")
        check("both players see the same wolf", True)
        dist = B.eval(f"""(() => {{
          const a = game.mobs.mobs.find(m => m.nid === '{cid}');
          return a ? 1 : 99;
        }})()""")
        time.sleep(1.5)   # let the stream settle, then compare live positions
        pa = A.eval(f"(() => {{ const m = game.mobs.mobs.find(m => m.nid === '{cid}'); "
                    f"return m ? [m.pos.x, m.pos.z] : null; }})()")
        pb = B.eval(f"(() => {{ const m = game.mobs.mobs.find(m => m.nid === '{cid}'); "
                    f"return m ? [m.pos.x, m.pos.z] : null; }})()")
        check("same place on both screens (<2 blocks apart)",
              pa and pb and abs(pa[0] - pb[0]) < 2 and abs(pa[1] - pb[1]) < 2,
              f"A={pa} B={pb}")
        persisted = A.eval("(async () => (await (await fetch(game.world.base + '/config')).json())"
                           ".creatures)()")
        check("wolf persisted in the world file", cid in (persisted or {}), persisted)

        # --- mirror player kills it for everyone --------------------------------
        for _ in range(3):   # 3 x 4 dmg > wolf 12 hp
            B.eval(f"game.net.sendMobHit('{cid}', 4, 1, 0)")
            time.sleep(0.3)
        A.wait_for(f"!game.mobs.mobs.some(m => m.nid === '{cid}')", 15, "wolf dead on A")
        B.wait_for(f"!game.mobs.mobs.some(m => m.nid === '{cid}')", 15, "wolf gone on B")
        check("a mirror player's attacks kill it for everyone", True)
        persisted = A.eval("(async () => (await (await fetch(game.world.base + '/config')).json())"
                           ".creatures)()")
        check("dead wolf removed from the world file", cid not in (persisted or {}), persisted)

        # --- owner leaves -> mirror promoted, creatures survive -----------------
        A.eval("""(() => {
          const p = game.player.pos;
          game.mobs.hatchEgg('wolf', Math.floor(p.x) + 2, Math.floor(p.y) + 1, Math.floor(p.z));
          game.mobs.hatchEgg('pig',  Math.floor(p.x) - 2, Math.floor(p.y) + 1, Math.floor(p.z));
        })()""")
        B.wait_for("game.mobs.mobs.filter(m => m.cid).length === 2", 15,
                   "both new creatures visible on B")
        browser.send("Target.closeTarget", targetId=a_id)
        B.wait_for("game.mobs.role === 'owner'", 20, "B promoted to sim owner")
        check("owner left; mirror promoted seamlessly", True)
        check("promoted owner kept the creatures", B.eval(
            "game.mobs.mobs.filter(m => m.cid).length") == 2)

        # --- full leave + rejoin: persistence ------------------------------------
        B.eval("location.reload()")
        B.wait_for(GAME_READY, 90, "B re-boot")
        B.wait_for("game.mobs.mobs.filter(m => m.cid).length === 2", 20,
                   "persisted creatures after full leave + rejoin")
        types = sorted(B.eval("game.mobs.mobs.filter(m => m.cid).map(m => m.type)") or [])
        check("the wolf room survives leave + rejoin", types == ["pig", "wolf"], types)

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
