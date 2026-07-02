"""Headless verification of mine ownership: a mine never fires on the player
who armed it — including after a page reload (ownership is stored server-side
and re-fed via the world config), and including when another client's sensor
is watching (simulated with a remote player carrying the owner's name).

Run with a fresh EVANS_DATA_DIR (leftover armed mines from other test scripts
would adopt and interfere). Same CDP recipe as tools/test_mines.py.
"""
import base64
import json
import sys
import time
import urllib.request

import websocket

DEBUG_PORT = 9223
GAME_URL = "localhost:8899"


def main():
    ws_url = None
    for _ in range(30):
        try:
            for t in json.load(urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=5)):
                if t.get("type") == "page" and GAME_URL in t.get("url", ""):
                    ws_url = t["webSocketDebuggerUrl"]
                    break
        except Exception:
            pass
        if ws_url:
            break
        time.sleep(1)
    if not ws_url:
        print("FAIL: page not found")
        sys.exit(1)
    ws = websocket.create_connection(ws_url, timeout=60)
    mid = [0]

    def rpc(method, params=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]:
                return r

    def ev(expr):
        r = rpc("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return "EXC: " + json.dumps(res["exceptionDetails"])[:300]
        return res.get("result", {}).get("value")

    def wait_ready():
        for _ in range(90):
            if ev("!!(window.game && !window.game.player.frozen)") is True:
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
        # Server-side wild spawns would wander into the mine arenas.
        urllib.request.urlopen(urllib.request.Request(
            f"http://{GAME_URL}/api/admin/wildlife", method="POST",
            data=json.dumps({"on": on, "clear": clear}).encode(),
            headers={"Content-Type": "application/json"}), timeout=5)

    wait_ready()
    set_wildlife(False, clear=True)
    time.sleep(0.5)
    check("logged-in name known", ev("window.game.gear.myName.length > 0"))

    # Arm a mine near the player (inside the adoption scan range), then reload.
    print("arm:", ev(r"""
(() => {
  const G = window.game, W = G.world;
  const px = Math.floor(G.player.pos.x), pz = Math.floor(G.player.pos.z);
  const PY = Math.floor(G.player.pos.y) + 6;
  window.M = { PY, x: px + 8, z: pz, x2: px + 8, z2: pz + 5 };
  for (let x = M.x - 3; x <= M.x + 3; x++)
    for (let z = M.z - 3; z <= M.z2 + 3; z++) {
      W.setBlock(x, PY, z, 3, false);
      for (let dy = 1; dy <= 4; dy++) W.setBlock(x, PY + dy, z, 0, false);
    }
  G.mobs.clear(); G.mobs.spawnTimer = 1e9;
  W.setBlock(M.x, PY + 1, M.z, 25, false);
  G.gear.strike(M.x, PY + 1, M.z, 25);            // OTHERS, owner = me (relayed)
  localStorage.setItem('mineTest', JSON.stringify(M));
  return 'armed at ' + JSON.stringify(M);
})()"""))
    time.sleep(1)                       # let the ws edit reach the server

    rpc("Page.reload")
    time.sleep(3)
    wait_ready()

    # After reload: sensors were wiped; ownership must come back from config.
    print("post-reload:", ev(r"""
(() => {
  const G = window.game;
  window.M = JSON.parse(localStorage.getItem('mineTest'));
  const k = `${M.x},${M.PY + 1},${M.z}`;
  G.mobs.clear(); G.mobs.spawnTimer = 1e9;
  // Owner stands right next to their own mine through adoption + arming.
  G.player.pos.set(M.x + 1.5, M.PY + 1, M.z + 0.5);
  G.player.vel.set(0, 0, 0);
  return JSON.stringify({ ownerOnRecord: G.gear.owners.get(k) || null, sensors: G.gear.mines.size });
})()"""))
    time.sleep(8)                       # adoption scan + full re-arm, owner adjacent
    check("owner recorded from config", ev(
        "window.game.gear.owners.get(`${M.x},${M.PY + 1},${M.z}`) === window.game.gear.myName"))
    check("sensor adopted and live", ev(
        "[...window.game.gear.mines.values()].some(m => m.state === 'live')"))
    check("did NOT blow on its owner", ev(
        "window.game.world.getBlock(M.x, M.PY + 1, M.z) === 26"))

    # A creature still sets it off (owner steps clear first — full lethal radius).
    ev("window.game.player.pos.set(M.x + 1.5, M.PY + 1, M.z + 12.5); window.game.player.vel.set(0,0,0); 'moved'")
    ev("window.pig = window.game.mobs.spawnAt('pig', M.x + 1.5, M.PY + 1, M.z + 0.5); "
       "window.pig.walking = false; window.pig.timer = 1e9; 'pig'")
    time.sleep(1.5)
    check("still blows for a creature", ev(
        "window.game.world.getBlock(M.x, M.PY + 1, M.z) === 0"))

    # Second mine: a remote player with the owner's name must not trip it;
    # renamed to someone else, it must.
    print("mine2:", ev(r"""
(() => {
  const G = window.game;
  G.mobs.clear();
  G.world.setBlock(M.x2, M.PY + 1, M.z2, 25, false);
  G.gear.strike(M.x2, M.PY + 1, M.z2, 25);
  return 'armed #2';
})()"""))
    # Goes live over ~6s. The reseeder replaces killed pigs with wanderers, so
    # sweep creatures every second — nothing may stray into the sensor.
    for _ in range(7):
        time.sleep(1)
        ev("window.game.mobs.clear(); 'swept'")
    check("mine2 intact before remote test", ev(
        "window.game.world.getBlock(M.x2, M.PY + 1, M.z2) === 26"))
    ev("window.game.remotes.add({ id: 9999, name: window.game.gear.myName, "
       "x: M.x2 + 1.5, y: M.PY + 1, z: M.z2 + 0.5 }); 'owner-remote added'")
    time.sleep(1.5)
    check("owner-named remote does not trip it", ev(
        "window.game.world.getBlock(M.x2, M.PY + 1, M.z2) === 26"))
    ev("window.game.remotes.players.get(9999).name = 'intruder'; 'renamed'")
    time.sleep(1.5)
    check("anyone else trips it", ev(
        "window.game.world.getBlock(M.x2, M.PY + 1, M.z2) === 0"))

    set_wildlife(True)
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
