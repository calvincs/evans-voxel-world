"""Headless verification of mine/TNT changes: instant proximity trip,
TNT -> mine chaining, mine -> TNT chaining. Same CDP recipe as test_mob_ai.py.
All simulation is stepped manually inside single evaluates (gear.update +
world._updateEffects), so results are deterministic."""
import json
import sys
import time
import urllib.request

import websocket

DEBUG_PORT = 9223
GAME_URL = "localhost:8899"


def set_wildlife(on, clear=False):
    """Server-side wild spawns would wander into the arenas — pause them (the
    parked test pigs are local dummies, unaffected)."""
    urllib.request.urlopen(urllib.request.Request(
        f"http://{GAME_URL}/api/admin/wildlife", method="POST",
        data=json.dumps({"on": on, "clear": clear}).encode(),
        headers={"Content-Type": "application/json"}), timeout=5)

TEST_JS = r"""
(() => {
  const G = window.game;
  const { world, mobs, gear } = G;
  const AIR = 0, STONE = 3, TNT = 18, PROX_OFF = 25;
  const S = (x, y, z, b) => world.setBlock(x, y, z, b, false);
  const P = { x: Math.floor(G.player.pos.x), z: Math.floor(G.player.pos.z) };
  const PY = 44;   // below the mob-test platform band, still in loaded chunks
  const dt = 1 / 60;
  const step = (n) => { for (let i = 0; i < n; i++) { gear.update(dt); world._updateEffects(dt); mobs.update(dt, G.player, 1); } };
  const results = {};

  function slab(x0, z0, w, d) {   // thin floor to host the toys
    for (let x = x0; x < x0 + w; x++)
      for (let z = z0; z < z0 + d; z++) {
        S(x, PY, z, STONE);
        for (let dy = 1; dy <= 4; dy++) S(x, PY + dy, z, AIR);
      }
  }

  mobs.spawnTimer = 1e9;

  // Mines carve only half a TNT's crater (radius ~1.7 vs 3.4) but keep the
  // full TNT lethal radius (4.5) for creatures. Chain geometry (T2/T3) keys
  // off the crater radius, so mine-triggered explosives sit adjacent.

  // T1: live mine + creature stepping close -> boom with no delay; the crater
  // is mine-sized (a stone 3 away survives) while the kill radius is
  // TNT-sized (a bystander pig 3.5 away dies; a far pig at ~7 does not).
  {
    const x0 = P.x + 20, z0 = P.z;
    slab(x0, z0, 12, 5);
    const mx = x0 + 4, mz = z0 + 2;
    S(mx, PY + 1, mz, PROX_OFF);
    S(mx + 3, PY + 1, mz, STONE);                    // outside the half crater
    gear.strike(mx, PY + 1, mz, PROX_OFF);          // arm for OTHERS
    mobs.clear();
    const park = (x, z) => { const p = mobs.spawnAt('pig', x, PY + 1, z); p.walking = false; p.timer = 1e9; return p; };
    const pig = park(mx + 6.5, mz + 0.5);            // will walk in and trip it
    const bystander = park(mx - 3.5, mz + 0.5);      // inside kill, outside sensor
    const farPig = park(mx + 6.5, mz + 2.5);         // outside the kill radius
    step(Math.ceil(5.2 / dt));                       // arming period passes
    const liveStill = world.getBlock(mx, PY + 1, mz) === PROX_OFF + 1; // PROX_OTHERS, unblown
    pig.pos.set(mx + 1.5, PY + 1, mz + 0.5);         // step into sensor range
    step(2);                                         // trip frame + fuse(0) frame
    results.instantTrip = {
      liveStill,
      blewInTwoFrames: world.getBlock(mx, PY + 1, mz) === AIR,
      pigCaught: pig.hp <= 0,
      bystanderKilled: bystander.hp <= 0,            // full lethal radius
      farPigSafe: farPig.hp > 0,                     // ...but still bounded
      smallCrater: world.getBlock(mx + 3, PY + 1, mz) === STONE,
    };
  }

  // T2: TNT explosion sets off an (unarmed) mine 3 blocks away; the witness
  // sits 1 from the mine (inside its half blast) but 4 from the TNT (outside).
  {
    const x0 = P.x + 20, z0 = P.z + 12;
    slab(x0, z0, 12, 5);
    const tx = x0 + 2, mx = tx + 3, wx = tx + 4, tz = z0 + 2;
    S(tx, PY + 1, tz, TNT);
    S(mx, PY + 1, tz, PROX_OFF);
    S(wx, PY + 1, tz, STONE);
    world.igniteTNT(tx, PY + 1, tz, 0.05);
    step(Math.ceil(1.5 / dt));
    results.tntTriggersMine = {
      tntGone: world.getBlock(tx, PY + 1, tz) === AIR,
      mineGone: world.getBlock(mx, PY + 1, tz) === AIR,
      witnessGone: world.getBlock(wx, PY + 1, tz) === AIR,   // only the mine's own blast reaches it
    };
  }

  // T3: tripped mine sets off TNT next door (its half blast only reaches
  // ~1.7); the witness sits 3 from the TNT (inside its full blast) but 4 from
  // the mine. (Kept close to the player — a corner further out crosses the
  // mob DESPAWN radius and eats the pig.)
  {
    const x0 = P.x + 20, z0 = P.z - 12;
    slab(x0, z0, 12, 5);
    const mx = x0 + 2, tx = mx + 1, wx = mx + 4, mz = z0 + 2;
    S(mx, PY + 1, mz, PROX_OFF);
    S(tx, PY + 1, mz, TNT);
    S(wx, PY + 1, mz, STONE);
    gear.strike(mx, PY + 1, mz, PROX_OFF);
    mobs.clear();                                    // arm with nothing nearby
    step(Math.ceil(5.2 / dt));
    const pig = mobs.spawnAt('pig', mx - 0.5, PY + 1, mz + 0.5); // step onto the sensor
    pig.walking = false; pig.timer = 1e9;
    step(Math.ceil(1.5 / dt));
    results.mineTriggersTnt = {
      mineGone: world.getBlock(mx, PY + 1, mz) === AIR,
      tntGone: world.getBlock(tx, PY + 1, mz) === AIR,
      witnessGone: world.getBlock(wx, PY + 1, mz) === AIR,   // only the TNT's own blast reaches it
    };
  }

  // T4: reload case — an armed mine block whose sensor was wiped (page
  // reload) gets adopted by the nearby client, re-arms, and still blows for
  // a creature. Must sit within adoption range of the REAL player (16
  // blocks, +/-10 vertically), unlike the other arenas.
  {
    const py = Math.floor(G.player.pos.y), PY2 = py + 6;
    const mx = P.x + 10, mz = P.z;
    for (let x = mx - 2; x <= mx + 2; x++)
      for (let z = mz - 2; z <= mz + 2; z++) {
        S(x, PY2, z, STONE);
        for (let dy = 1; dy <= 3; dy++) S(x, PY2 + dy, z, AIR);
      }
    S(mx, PY2 + 1, mz, PROX_OFF);
    gear.strike(mx, PY2 + 1, mz, PROX_OFF);
    for (const k of [...gear.mines.keys()]) gear._dropMine(k);   // "reload"
    const orphaned = gear.mines.size === 0;
    mobs.clear();
    step(Math.ceil(6.5 / dt));            // adoption scan + full re-arm
    const adopted = [...gear.mines.values()].some((m) => m.state === 'live');
    const pig = mobs.spawnAt('pig', mx + 1.5, PY2 + 1, mz + 0.5);
    pig.walking = false; pig.timer = 1e9;
    step(3);
    results.orphanAdoption = {
      orphaned, adopted,
      blown: world.getBlock(mx, PY2 + 1, mz) === AIR,
    };
  }

  mobs.clear();
  return JSON.stringify(results);
})()
"""


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
        print("FAIL: game page not found")
        sys.exit(1)

    ws = websocket.create_connection(ws_url, timeout=120)
    mid = [0]

    def evaluate(expr):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": "Runtime.evaluate",
                            "params": {"expression": expr, "returnByValue": True,
                                       "awaitPromise": True, "timeout": 110000}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]:
                return r

    for _ in range(90):
        r = evaluate("!!(window.game && window.game.world && !window.game.player.frozen)")
        if r.get("result", {}).get("result", {}).get("value") is True:
            break
        time.sleep(1)
    else:
        print("FAIL: game never ready")
        sys.exit(1)
    print("game ready — running mine/TNT scenarios...")

    set_wildlife(False, clear=True)
    time.sleep(0.5)                     # let the empty snapshot reach the client
    r = evaluate(TEST_JS)
    set_wildlife(True)
    res = r.get("result", {}).get("result", {})
    if res.get("type") != "string":
        print("FAIL:", json.dumps(r)[:2000])
        sys.exit(1)
    results = json.loads(res["value"])
    print(json.dumps(results, indent=2))
    ok = all(all(v.values()) for v in results.values())
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")
    # scenarios: instantTrip, tntTriggersMine, mineTriggersTnt, orphanAdoption
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
