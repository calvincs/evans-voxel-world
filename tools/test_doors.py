#!/usr/bin/env python3
"""Headless verification of DOORS: placing one fills two cells facing the
placer; a closed door stops a walking player; clicking it swings it open
(both halves) and lets them through; an OPEN door's cell is click-through
except on its swung panel; the pair persists server-side; breaking either
half removes both. Same CDP recipe as the other gameplay tests (shared
8899/9223 instance)."""
import json
import sys
import time
import urllib.request

import websocket

DEBUG_PORT = 9223
GAME_URL = "localhost:8899"

DOOR_Z_CLOSED = 91
DOOR_Z_OPEN = 93


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

    ws = page_ws()
    if not ws:
        print("FAIL: page not found")
        sys.exit(1)
    mid = [0]

    def ev(expr):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": "Runtime.evaluate",
                            "params": {"expression": expr, "returnByValue": True}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]:
                res = r.get("result", {})
                if "exceptionDetails" in res:
                    return "EXC: " + json.dumps(res["exceptionDetails"])[:300]
                return res.get("result", {}).get("value")

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

    # Sky platform (PERSISTED — refreshAll must not wipe it) with a door
    # standing at (bx, PY+1..PY+2, z0), placed while facing +x.
    print("arena:", ev(r"""
(() => {
  const G = window.game, W = G.world;
  const px = Math.floor(G.player.pos.x), pz = Math.floor(G.player.pos.z);
  const PY = Math.floor(G.player.pos.y) + 8;
  window.D = { PY, bx: px + 8, z0: pz };
  const edits = [];
  const S = (x, y, z, b) => { W.setBlock(x, y, z, b, false); edits.push({ x, y, z, block: b }); };
  for (let x = D.bx - 4; x <= D.bx + 4; x++)
    for (let z = D.z0 - 2; z <= D.z0 + 2; z++) {
      S(x, PY, z, 3);
      for (let dy = 1; dy <= 4; dy++) S(x, PY + dy, z, 0);
    }
  G.net.sendEdits(edits);
  const placed = W.placeDoor(D.bx, PY + 1, D.z0, -Math.PI / 2);  // facing +x
  return placed ? 'door placed' : 'PLACE FAILED';
})()"""))
    time.sleep(0.5)

    def cells():
        return ev("[window.game.world.getBlock(D.bx, D.PY + 1, D.z0),"
                  " window.game.world.getBlock(D.bx, D.PY + 2, D.z0)]")

    check("door fills two cells, oriented to block the walk (id 91)",
          cells() == [DOOR_Z_CLOSED, DOOR_Z_CLOSED])

    # Repositioning helper — Runtime.evaluate runs at global scope, so no
    # `const`: a second declaration would throw and silently skip the move.
    def teleport(dz):
        ev(f"(() => {{ const p = window.game.player;"
           f" p.pos.set(D.bx - 2.5, D.PY + 1, D.z0 + {dz});"
           f" p.vel.set(0, 0, 0); p.yaw = -Math.PI / 2; p.pitch = 0; }})()")

    # Aiming straight at it targets the door.
    teleport(0.5)
    time.sleep(0.3)
    check("closed door is clickable (raycast hits it)",
          ev("(() => { const r = window.game.player.raycast();"
             " return !!r && r.hit.x === D.bx; })()"))

    # A closed door stops you.
    ev("window.game.player.keys.add('KeyW'); 'walk'")
    time.sleep(1.4)
    ev("window.game.player.keys.delete('KeyW'); 'stop'")
    check("closed door blocks walking through",
          ev("window.game.player.pos.x < D.bx + 0.01"))

    # A click (the place button) swings it open — both halves together.
    ev("window.game.player._place(); 'clicked'")
    time.sleep(0.4)
    check("click opens BOTH halves (id 93)",
          cells() == [DOOR_Z_OPEN, DOOR_Z_OPEN])

    # Open doorway: aiming through the middle no longer hits the door…
    teleport(0.5)
    time.sleep(0.3)
    check("open doorway is aim-through (ray passes the middle)",
          ev("(() => { const r = window.game.player.raycast();"
             " return !r || r.hit.x !== D.bx; })()"))
    # …but the swung panel (against the north jamb) is still clickable.
    teleport(0.06)
    check("the swung panel itself is still clickable",
          ev("(() => { const r = window.game.player.raycast();"
             " return !!r && r.hit.x === D.bx; })()"))

    # And you can walk straight through (short burst — stay on the platform).
    teleport(0.5)
    ev("window.game.player.keys.add('KeyW'); 'walk'")
    time.sleep(1.0)
    ev("window.game.player.keys.delete('KeyW'); 'stop'")
    check("open door lets the player walk through",
          ev("window.game.player.pos.x > D.bx + 1"))

    # Close it again and make sure the server has the pair (a chunk refetch
    # rebuilds from server data — client-only blocks would vanish).
    ev("window.game.world.toggleDoor(D.bx, D.PY + 1, D.z0); 'closed'")
    time.sleep(0.5)
    ev("window.game.world.refreshAll(); 'refetch'")
    time.sleep(2)
    check("door pair persisted server-side (survives chunk refetch)",
          cells() == [DOOR_Z_CLOSED, DOOR_Z_CLOSED])

    # Breaking either half removes the whole door.
    teleport(0.5)
    time.sleep(0.3)
    ev("window.game.player._break(); 'broken'")
    time.sleep(0.4)
    check("breaking one half removes both", cells() == [0, 0])

    set_wildlife(True)
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
