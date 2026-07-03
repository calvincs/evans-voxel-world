#!/usr/bin/env python3
"""Headless verification of mine/TNT behaviour under SERVER-side sensing
(server/creatures.py mines_tick): the server watches every armed mine, so
they honour the arming delay, then stay live forever — and one client is told
to execute each explosion.

  T1. arming delay honoured with a creature standing on the sensor, then an
      instant trip: half crater, full lethal radius (near pig dies, far lives)
  T2. TNT chains an unarmed mine (client-side chain physics, unchanged)
  T3. a tripped mine chains TNT next door
  T4. THE rejoin case: an armed mine is live IMMEDIATELY after a page reload —
      no re-arming window

Same CDP recipe as the other gameplay tests (shared server on 8899 + Chrome
on 9223). Wild spawning is paused so nothing wanders into the arenas; the
trigger creatures are real server-side pigs hatched at exact spots.
"""
import json
import sys
import time
import urllib.request

import websocket

DEBUG_PORT = 9223
GAME_URL = "localhost:8899"


def set_wildlife(on, clear=False):
    urllib.request.urlopen(urllib.request.Request(
        f"http://{GAME_URL}/api/admin/wildlife", method="POST",
        data=json.dumps({"on": on, "clear": clear}).encode(),
        headers={"Content-Type": "application/json"}), timeout=5)


def main():
    ws_url = None
    for _ in range(30):
        try:
            for t in json.load(urllib.request.urlopen(
                    f"http://localhost:{DEBUG_PORT}/json", timeout=5)):
                if t.get("type") == "page" and GAME_URL in t.get("url", ""):
                    ws_url = t["webSocketDebuggerUrl"]
                    break
        except Exception:
            pass
        if ws_url:
            break
        time.sleep(1)
    if not ws_url:
        print("FAIL: game page not found")
        sys.exit(1)

    ws = [websocket.create_connection(ws_url, timeout=120)]
    mid = [0]

    def reconnect_page():
        for _ in range(30):
            try:
                for t in json.load(urllib.request.urlopen(
                        f"http://localhost:{DEBUG_PORT}/json", timeout=5)):
                    if t.get("type") == "page" and GAME_URL in t.get("url", ""):
                        ws[0] = websocket.create_connection(t["webSocketDebuggerUrl"],
                                                            timeout=120)
                        return
            except Exception:
                pass
            time.sleep(1)

    def ev(expr):
        mid[0] += 1
        ws[0].send(json.dumps({"id": mid[0], "method": "Runtime.evaluate",
                               "params": {"expression": expr, "returnByValue": True,
                                          "awaitPromise": True, "timeout": 110000}}))
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
            if ev("""(() => {
              const G = window.game;
              if (!G || !G.world || G.player.frozen) return false;
              const P = G.player.pos;
              for (const [dx, dz] of [[16, -14], [34, -14], [16, 14], [34, 14]])
                if (!G.world.ready(P.x + dx, P.z + dz)) return false;
              return true;
            })()""") is True:
                return True
            time.sleep(1)
        return False

    ok = True

    def check(label, value, expect=True):
        nonlocal ok
        good = value is expect
        ok = ok and good
        print(f"{'PASS' if good else 'FAIL'}  {label}: {value!r}")

    if not wait_ready():
        print("FAIL: game never ready")
        sys.exit(1)
    set_wildlife(False, clear=True)
    time.sleep(0.5)

    # Common helpers evaluated once per page load. Arenas must be PERSISTED
    # (batched to the server): creatures are server-simulated and mines are
    # server-sensed, so a client-only platform is a phantom the server's pigs
    # fall straight through.
    HELPERS = r"""
      window.T = (() => {
        const G = window.game, W = G.world;
        const P = { x: Math.floor(G.player.pos.x), z: Math.floor(G.player.pos.z) };
        const PY = 44;
        const edits = [];
        const S = (x, y, z, b) => {
          W.setBlock(x, y, z, b, false);
          edits.push({ x, y, z, block: b });
        };
        const flush = () => { if (edits.length) G.net.sendEdits(edits.splice(0)); };
        const slab = (x0, z0, w, d) => {
          for (let x = x0; x < x0 + w; x++)
            for (let z = z0; z < z0 + d; z++) {
              S(x, PY, z, 3);
              for (let dy = 1; dy <= 4; dy++) S(x, PY + dy, z, 0);
            }
        };
        const pigs = () => G.mobs.mobs.filter((m) => m.type === 'pig').length;
        return { G, W, P, PY, S, slab, flush, pigs };
      })();
      'helpers'
    """
    ev(HELPERS)

    # --- T1: delay honoured, then instant trip; half crater, full kill radius --
    print("--- T1: arming delay + trip geometry ---")
    ev(r"""(() => {
      const { G, W, P, PY, S, slab } = T;
      window.M1 = { x: P.x + 20, z: P.z };
      slab(M1.x - 8, M1.z - 2, 16, 5);
      S(M1.x, PY + 1, M1.z, 25);
      S(M1.x + 3, PY + 1, M1.z, 3);                  // witness: outside half crater
      // Pigs are real (server-side) creatures now and WANDER — pen the trigger
      // next to the mine so it stays on the sensor through the arming delay.
      // The cap stops it climbing out (creatures step up single blocks).
      S(M1.x + 2, PY + 1, M1.z, 3);
      S(M1.x + 1, PY + 1, M1.z - 1, 3);
      S(M1.x + 1, PY + 1, M1.z + 1, 3);
      S(M1.x + 1, PY + 2, M1.z, 3);
      T.flush();                                     // the server needs the arena
      G.gear.strike(M1.x, PY + 1, M1.z, 25);         // -> MONSTERS (green)
      G.gear.strike(M1.x, PY + 1, M1.z, 28);         // -> OTHERS (yellow)
      G.mobs.hatchEgg('pig', M1.x + 1, PY + 1, M1.z);   // trigger, penned 1 away
      return 'armed + trigger';
    })()""")
    time.sleep(2)
    check("delay honoured (pig on the sensor, mine still armed at t+2s)",
          ev("T.W.getBlock(M1.x, T.PY + 1, M1.z) === 26"))
    # Bystander (3 away: inside the 4.5 kill radius, outside the 2.5 sensor)
    # and far pig (7 away) hatch just before the mine goes live — no time to
    # wander off their marks.
    ev("T.G.mobs.hatchEgg('pig', M1.x - 3, T.PY + 1, M1.z);"
       "T.G.mobs.hatchEgg('pig', M1.x, T.PY + 1, M1.z + 7); 'more pigs'")
    time.sleep(1)
    check("still armed just before going live",
          ev("T.W.getBlock(M1.x, T.PY + 1, M1.z) === 26"))
    time.sleep(4)
    check("tripped once live (mine gone)",
          ev("T.W.getBlock(M1.x, T.PY + 1, M1.z) === 0"))
    check("half crater (stone 3 away survives)",
          ev("T.W.getBlock(M1.x + 3, T.PY + 1, M1.z) === 3"))
    time.sleep(1)
    check("full lethal radius (trigger + bystander die, far pig lives)",
          ev("T.pigs() === 1"))

    # --- T2: TNT chains an unarmed mine (client-side physics, synchronous) -----
    print("--- T2: TNT -> mine chain ---")
    res = ev(r"""(() => {
      const { W, P, PY, S, slab } = T;
      const x0 = P.x + 20, z0 = P.z + 8;
      slab(x0, z0, 12, 5);
      const tx = x0 + 2, mx = tx + 3, wx = tx + 4, tz = z0 + 2;
      S(tx, PY + 1, tz, 18);                         // TNT
      S(mx, PY + 1, tz, 25);                         // unarmed mine
      S(wx, PY + 1, tz, 3);                          // witness by the mine
      W.igniteTNT(tx, PY + 1, tz, 0.05);
      for (let i = 0; i < 90; i++) W._updateEffects(1 / 60);
      return JSON.stringify({
        tntGone: W.getBlock(tx, PY + 1, tz) === 0,
        mineGone: W.getBlock(mx, PY + 1, tz) === 0,
        witnessGone: W.getBlock(wx, PY + 1, tz) === 0,
      });
    })()""")
    for k, v in json.loads(res).items():
        check(f"T2 {k}", v)

    # --- T3: a tripped mine chains TNT next door -------------------------------
    print("--- T3: mine -> TNT chain ---")
    ev(r"""(() => {
      const { G, P, PY, S, slab } = T;
      window.M3 = { x: P.x + 20, z: P.z - 12 };
      slab(M3.x - 2, M3.z - 2, 10, 5);
      S(M3.x, PY + 1, M3.z, 25);
      S(M3.x + 1, PY + 1, M3.z, 18);                 // TNT next door
      S(M3.x + 4, PY + 1, M3.z, 3);                  // witness: only TNT reaches it
      T.flush();
      G.gear.strike(M3.x, PY + 1, M3.z, 25);         // -> MONSTERS
      G.gear.strike(M3.x, PY + 1, M3.z, 28);         // -> OTHERS (pig can trip)
      return 'armed';
    })()""")
    time.sleep(6)                                    # arming period passes
    ev("T.G.mobs.hatchEgg('pig', M3.x - 1, T.PY + 1, M3.z); 'pig'")
    time.sleep(3)
    check("T3 mine gone", ev("T.W.getBlock(M3.x, T.PY + 1, M3.z) === 0"))
    check("T3 TNT chained", ev("T.W.getBlock(M3.x + 1, T.PY + 1, M3.z) === 0"))
    check("T3 witness gone (TNT's full blast)",
          ev("T.W.getBlock(M3.x + 4, T.PY + 1, M3.z) === 0"))

    # --- T4: THE rejoin case — armed mines are live immediately after reload ---
    print("--- T4: live across reload, no re-arming ---")
    ev(r"""(() => {
      const { G, P, PY, S, slab } = T;
      const m = { x: P.x + 26, z: P.z + 8, PY };
      slab(m.x - 2, m.z - 2, 5, 5);
      S(m.x, PY + 1, m.z, 25);
      T.flush();
      G.gear.strike(m.x, PY + 1, m.z, 25);           // -> MONSTERS
      G.gear.strike(m.x, PY + 1, m.z, 28);           // -> OTHERS (pig can trip)
      localStorage.setItem('mineT4', JSON.stringify(m));
      return 'armed';
    })()""")
    time.sleep(6)                                    # goes live before we leave
    rpc("Page.reload")
    time.sleep(3)
    reconnect_page()
    if not wait_ready():
        print("FAIL: game not ready after reload")
        sys.exit(1)
    ev(HELPERS)
    ev("window.M4 = JSON.parse(localStorage.getItem('mineT4')); 'm4'")
    check("mine still armed after rejoin",
          ev("T.W.getBlock(M4.x, M4.PY + 1, M4.z) === 26"))
    ev("T.G.mobs.hatchEgg('pig', M4.x + 1, M4.PY + 1, M4.z); 'pig'")
    time.sleep(2.5)                                  # far less than the 5s re-arm
    check("live IMMEDIATELY (no re-arming window)",
          ev("T.W.getBlock(M4.x, M4.PY + 1, M4.z) === 0"))

    # --- T5: monster trap — hostile creatures only ------------------------------
    print("--- T5: monster trap (green eye) ---")
    ev(r"""(() => {
      const { G, P, PY, S, slab } = T;
      window.M5 = { x: P.x + 26, z: P.z - 8 };
      slab(M5.x - 2, M5.z - 2, 5, 5);
      S(M5.x, PY + 1, M5.z, 25);
      T.flush();
      G.gear.strike(M5.x, PY + 1, M5.z, 25);         // ONE strike = monster trap
      return 'armed';
    })()""")
    time.sleep(6)                                    # live
    check("one strike arms the monster trap (green, 28)",
          ev("T.W.getBlock(M5.x, T.PY + 1, M5.z) === 28"))
    ev("T.G.mobs.hatchEgg('pig', M5.x + 1, T.PY + 1, M5.z); 'pig'")
    time.sleep(2.5)
    check("a pig walks the sensor safely",
          ev("T.W.getBlock(M5.x, T.PY + 1, M5.z) === 28"))
    # The owner standing on it is also safe (players never trigger this mode).
    ev("T.G.player.pos.set(M5.x + 1.2, T.PY + 1, M5.z + 0.5);"
       "T.G.player.vel.set(0, 0, 0); 'standing on it'")
    time.sleep(2.5)
    check("players are safe too",
          ev("T.W.getBlock(M5.x, T.PY + 1, M5.z) === 28"))
    ev("T.G.player.pos.set(M5.x + 1.5, T.PY + 1, M5.z + 12.5);"
       "T.G.player.vel.set(0, 0, 0); 'stepped clear'")
    ev("T.G.mobs.hatchEgg('wolf', M5.x + 1, T.PY + 1, M5.z); 'wolf'")
    time.sleep(2.5)
    check("...but a wolf sets it off",
          ev("T.W.getBlock(M5.x, T.PY + 1, M5.z) === 0"))

    set_wildlife(True)
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
