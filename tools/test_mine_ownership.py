#!/usr/bin/env python3
"""Headless verification of mine OWNERSHIP under server-side sensing: a mine
armed for OTHERS never fires on the player who armed it — not while they
stand on it, and not after they leave and rejoin (ownership lives in the
world file). Armed for EVERYONE, it fires on the owner too. Creatures always
count. Same CDP recipe as the other gameplay tests (shared 8899/9223)."""
import json
import sys
import time
import urllib.request

import websocket

DEBUG_PORT = 9223
GAME_URL = "localhost:8899"


def main():
    def page_ws():
        for _ in range(30):
            try:
                for t in json.load(urllib.request.urlopen(
                        f"http://localhost:{DEBUG_PORT}/json", timeout=5)):
                    if t.get("type") == "page" and GAME_URL in t.get("url", ""):
                        return websocket.create_connection(t["webSocketDebuggerUrl"],
                                                           timeout=120)
            except Exception:
                pass
            time.sleep(1)
        return None

    ws = [page_ws()]
    if not ws[0]:
        print("FAIL: page not found")
        sys.exit(1)
    mid = [0]

    def ev(expr):
        mid[0] += 1
        ws[0].send(json.dumps({"id": mid[0], "method": "Runtime.evaluate",
                               "params": {"expression": expr, "returnByValue": True}}))
        while True:
            r = json.loads(ws[0].recv())
            if r.get("id") == mid[0]:
                res = r.get("result", {})
                if "exceptionDetails" in res:
                    return "EXC: " + json.dumps(res["exceptionDetails"])[:300]
                return res.get("result", {}).get("value")

    def rpc(method, params=None):
        mid[0] += 1
        ws[0].send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
        while True:
            r = json.loads(ws[0].recv())
            if r.get("id") == mid[0]:
                return r

    def wait_ready():
        for _ in range(90):
            if ev("!!(window.game && !window.game.player.frozen"
                  " && window.game.world.ready(window.game.player.pos.x + 10,"
                  " window.game.player.pos.z))") is True:
                return True
            time.sleep(1)
        return False

    ok = True

    def check(label, value, expect=True):
        nonlocal ok
        good = value is expect
        ok = ok and good
        print(f"{'PASS' if good else 'FAIL'}  {label}: {value!r}")

    def set_wildlife(on, clear=False):
        urllib.request.urlopen(urllib.request.Request(
            f"http://{GAME_URL}/api/admin/wildlife", method="POST",
            data=json.dumps({"on": on, "clear": clear}).encode(),
            headers={"Content-Type": "application/json"}), timeout=5)

    wait_ready()
    set_wildlife(False, clear=True)
    time.sleep(0.5)

    # Sky platform: mine at (M.x, PY+1, M.z), a second one 5 south.
    print("arm:", ev(r"""
(() => {
  const G = window.game, W = G.world;
  const px = Math.floor(G.player.pos.x), pz = Math.floor(G.player.pos.z);
  const PY = Math.floor(G.player.pos.y) + 6;
  window.M = { PY, x: px + 8, z: pz, x2: px + 8, z2: pz + 5 };
  // Persist the arena: creatures are server-simulated and mines server-sensed,
  // so the platform must exist server-side too, not just on this screen.
  const edits = [];
  const S = (x, y, z, b) => { W.setBlock(x, y, z, b, false); edits.push({ x, y, z, block: b }); };
  for (let x = M.x - 3; x <= M.x + 3; x++)
    for (let z = M.z - 3; z <= M.z2 + 3; z++) {
      S(x, PY, z, 3);
      for (let dy = 1; dy <= 4; dy++) S(x, PY + dy, z, 0);
    }
  S(M.x, PY + 1, M.z, 25);
  G.net.sendEdits(edits);
  G.gear.strike(M.x, PY + 1, M.z, 25);            // OTHERS — owner = me
  localStorage.setItem('mineTest', JSON.stringify(M));
  return 'armed at ' + JSON.stringify(M);
})()"""))
    time.sleep(6.5)                     # live (server-side) well before we test

    # Owner stands right on their own live mine: nothing happens.
    ev("window.game.player.pos.set(M.x + 1.2, M.PY + 1, M.z + 0.5);"
       "window.game.player.vel.set(0, 0, 0); 'on it'")
    time.sleep(3)
    check("live mine never fires on its owner",
          ev("window.game.world.getBlock(M.x, M.PY + 1, M.z) === 26"))

    # ...and still doesn't after a full leave + rejoin (ownership persisted).
    rpc("Page.reload")
    time.sleep(3)
    ws[0] = page_ws()
    wait_ready()
    ev("window.M = JSON.parse(localStorage.getItem('mineTest')); 'm'")
    ev("window.game.player.pos.set(M.x + 1.2, M.PY + 1, M.z + 0.5);"
       "window.game.player.vel.set(0, 0, 0); 'back on it'")
    time.sleep(3)
    check("still owner-safe after leave + rejoin",
          ev("window.game.world.getBlock(M.x, M.PY + 1, M.z) === 26"))

    # A creature still sets it off (owner steps clear — full lethal radius).
    ev("window.game.player.pos.set(M.x + 1.5, M.PY + 1, M.z + 12.5);"
       "window.game.player.vel.set(0, 0, 0); 'moved'")
    ev("window.game.mobs.hatchEgg('pig', M.x + 1, M.PY + 1, M.z); 'pig'")
    time.sleep(2.5)
    check("still blows for a creature (immediately — it was already live)",
          ev("window.game.world.getBlock(M.x, M.PY + 1, M.z) === 0"))

    # Mine #2 armed for EVERYONE: the owner counts too.
    ev(r"""(() => {
      const G = window.game;
      G.world.setBlock(M.x2, M.PY + 1, M.z2, 25, false);
      G.gear.strike(M.x2, M.PY + 1, M.z2, 25);      // -> OTHERS
      G.gear.strike(M.x2, M.PY + 1, M.z2, 26);      // -> EVERYONE
      return 'armed #2 for everyone';
    })()""")
    time.sleep(6.5)
    check("EVERYONE mine intact while nobody is near",
          ev("window.game.world.getBlock(M.x2, M.PY + 1, M.z2) === 27"))
    ev("window.game.player.pos.set(M.x2 + 1.2, M.PY + 1, M.z2 + 0.5);"
       "window.game.player.vel.set(0, 0, 0); 'stepped on'")
    time.sleep(2.5)
    check("EVERYONE mine fires on its owner too",
          ev("window.game.world.getBlock(M.x2, M.PY + 1, M.z2) === 0"))

    set_wildlife(True)
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
