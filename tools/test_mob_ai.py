"""Drive the game in headless Chrome over CDP and exercise the new mob AI.

Builds controlled arenas (stone platform in the sky, water well) in a demo
world, spawns mobs, steps the simulation deterministically via mobs.update(),
and asserts: wolves drop into pits, wolves path around walls, squid dive to a
deep player, grazers flee but don't lemming into pits.
"""
import json
import sys
import time
import urllib.request

import websocket  # websocket-client

DEBUG_PORT = 9223
GAME_URL = "localhost:8899"

TEST_JS = r"""
(() => {
  const G = window.game;
  const { world, mobs } = G;
  const AIR = 0, STONE = 3, WATER = 7;
  const S = (x, y, z, b) => world.setBlock(x, y, z, b, false);
  const P = { x: Math.floor(G.player.pos.x), z: Math.floor(G.player.pos.z) };
  const PY = 50;
  const X0 = P.x - 8, Z0 = P.z - 2;   // platform: x in [X0,X0+11], z in [Z0,Z0+4]

  mobs.peaceful = false;
  mobs.spawnTimer = 1e9;              // no random spawns during the tests

  const fake = (x, y, z) => ({ pos: { x, y, z }, locked: false, frozen: true, dead: false });
  // Hunters (wolf, spider, squid) are aggressive only at night, so chase
  // scenarios sim with daylight 0; passive-creature scenarios use full day.
  const sim = (pl, seconds, daylight = 1) => { const dt = 1 / 60; for (let i = 0; i < seconds * 60; i++) mobs.update(dt, pl, daylight); };
  const horiz = (m, pl) => Math.hypot(m.pos.x - pl.pos.x, m.pos.z - pl.pos.z);

  function buildPlatform() {
    for (let x = X0; x <= X0 + 18; x++)
      for (let z = Z0; z <= Z0 + 4; z++) {
        for (let dy = 3; dy >= 0; dy--) S(x, PY - dy, z, STONE);   // 4-thick slab
        for (let dy = 1; dy <= 5; dy++) S(x, PY + dy, z, AIR);
      }
  }
  function digPit(px, pz) {   // 3-deep hole into the slab, floor stays solid
    S(px, PY, pz, AIR); S(px, PY - 1, pz, AIR); S(px, PY - 2, pz, AIR);
  }

  const results = {};

  // A: wolf drops into a 3-deep pit to reach the player.
  buildPlatform(); mobs.clear();
  {
    const pit = { x: X0 + 9, z: Z0 + 2 };
    digPit(pit.x, pit.z);
    const pl = fake(pit.x + 0.5, PY - 2, pit.z + 0.5);
    const w = mobs.spawnAt('wolf', X0 + 3.5, PY + 1, Z0 + 2.5);
    sim(pl, 10, 0);
    results.pit = {
      wolfY: +w.pos.y.toFixed(2), horiz: +horiz(w, pl).toFixed(2),
      descended: w.pos.y < PY - 0.5, reached: horiz(w, pl) < 1.2 && Math.abs(w.pos.y - pl.pos.y) < 1.2,
    };
  }

  // B: wolf paths around a wall through an offset doorway.
  buildPlatform(); mobs.clear();
  {
    const wx = X0 + 6;
    for (let z = Z0; z <= Z0 + 4; z++) for (let dy = 1; dy <= 3; dy++) S(wx, PY + dy, z, STONE);
    S(wx, PY + 1, Z0, AIR); S(wx, PY + 2, Z0, AIR);   // doorway at the north edge
    const pl = fake(X0 + 9.5, PY + 1, Z0 + 2.5);
    const w = mobs.spawnAt('wolf', X0 + 3.5, PY + 1, Z0 + 2.5);
    sim(pl, 15, 0);
    results.wall = {
      horiz: +horiz(w, pl).toFixed(2), reached: horiz(w, pl) < 1.6,
      pos: [+w.pos.x.toFixed(1), +w.pos.y.toFixed(1), +w.pos.z.toFixed(1)],
    };
  }

  // C: squid dives down a 1x1 water well to a deep player (at night).
  mobs.clear();
  const WELL = { cx: P.x + 8, cz: P.z + 8 };
  {
    const { cx, cz } = WELL, top = PY + 5, bot = PY - 4;
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let z = cz - 1; z <= cz + 1; z++)
        for (let y = bot; y <= top; y++)
          S(x, y, z, (x === cx && z === cz) ? (y === bot ? STONE : WATER) : STONE);
    const pl = fake(cx + 0.5, bot + 1, cz + 0.5);
    const sq = mobs.spawnAt('squid', cx + 0.5, top - 1.5, cz + 0.5);
    const startY = sq.pos.y;
    sim(pl, 12, 0);
    results.squid = {
      startY: +startY.toFixed(2), endY: +sq.pos.y.toFixed(2),
      dove: sq.pos.y < startY - 3, nearPlayer: Math.abs(sq.pos.y - pl.pos.y) < 2.2,
    };
  }

  // D: hurt pig flees fast, but still refuses the pit (no lemmings).
  buildPlatform(); mobs.clear();
  {
    const pit = { x: X0 + 9, z: Z0 + 2 };
    digPit(pit.x, pit.z);
    const pig = mobs.spawnAt('pig', X0 + 3.5, PY + 1, Z0 + 2.5);
    pig.yaw = pig.targetYaw = Math.atan2(-1, 0);      // already facing east
    const startX = pig.pos.x;
    const pl = fake(X0 + 1.5, PY + 1, Z0 + 2.5);
    pig.hurt(2, { x: 1, y: 0, z: 0 });                // knocked east, toward the pit
    let maxX = pig.pos.x;
    for (let i = 0; i < 8 * 60; i++) { mobs.update(1 / 60, pl, 1); maxX = Math.max(maxX, pig.pos.x); }
    results.flee = {
      ranEast: maxX > startX + 2.0, maxAdvance: +(maxX - startX).toFixed(2),
      stayedUp: pig.pos.y > PY + 0.5, pigY: +pig.pos.y.toFixed(2),
    };
  }

  // E: day/night temperament — wolves avoid by day, snap when crowded, turn
  // aggressive for a while when hit, and hunt from far away at night.
  buildPlatform(); mobs.clear();
  {
    const pl = fake(X0 + 6.5, PY + 1, Z0 + 2.5);
    const w = mobs.spawnAt('wolf', X0 + 2.5, PY + 1, Z0 + 2.5);   // 4 away
    sim(pl, 3, 1);                                   // full daylight
    const dayAvoids = horiz(w, pl) > 5.5 && !w.chasing;
    w.pos.set(pl.pos.x + 1.8, PY + 1, pl.pos.z);     // crowd it by day
    sim(pl, 1.5, 1);
    const daySnaps = w.chasing;
    mobs.clear();
    const w2 = mobs.spawnAt('wolf', X0 + 2.5, PY + 1, Z0 + 2.5);
    const pl2 = fake(X0 + 11.5, PY + 1, Z0 + 2.5);   // 9 away: calm daytime range
    sim(pl2, 2, 1);
    const calmBefore = !w2.chasing;
    w2.hurt(1, { x: 0, y: 0, z: 0 });                // poke it
    sim(pl2, 5, 1);
    const angryAfterHit = horiz(w2, pl2) < 3;        // came for us in daylight
    mobs.clear();
    const w3 = mobs.spawnAt('wolf', X0 + 1.5, PY + 1, Z0 + 2.5);
    const pl3 = fake(X0 + 16.5, PY + 1, Z0 + 2.5);   // 15 away: beyond day senses
    sim(pl3, 8, 0);                                  // night: extended senses
    const nightHuntsFar = horiz(w3, pl3) < 3;
    results.temperament = { dayAvoids, daySnaps, calmBefore, angryAfterHit, nightHuntsFar };
  }

  // F: spawn eggs — land creatures hatch anywhere; water creatures die on dry
  // land (with no wild replacement), and live when hatched into water.
  buildPlatform(); mobs.clear();
  {
    const pl = fake(X0 + 2.5, PY + 1, Z0 + 2.5);
    const pigOk = mobs.spawnFromEgg('pig', X0 + 6, PY + 1, Z0 + 2);
    sim(pl, 0.5, 1);
    const pigAlive = mobs.mobs.some((m) => m.type === 'pig');
    const before = mobs.mobs.length;
    mobs.spawnFromEgg('squid', X0 + 9, PY + 1, Z0 + 2);   // dry land!
    sim(pl, 0.5, 1);
    const drySquidDied = !mobs.mobs.some((m) => m.type === 'squid');
    const noReseed = mobs.mobs.length === before;
    const wetOk = mobs.spawnFromEgg('squid', WELL.cx, PY, WELL.cz);  // into the well
    sim(pl, 0.5, 1);
    const wetSquidAlive = mobs.mobs.some((m) => m.type === 'squid');
    results.eggs = { pigOk, pigAlive, drySquidDied, noReseed, wetOk, wetSquidAlive };
  }

  mobs.clear();
  return JSON.stringify(results);
})()
"""


def cdp_targets():
    with urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=5) as r:
        return json.load(r)


def main():
    # Find the game page target.
    ws_url = None
    for _ in range(30):
        try:
            for t in cdp_targets():
                if t.get("type") == "page" and GAME_URL in t.get("url", ""):
                    ws_url = t["webSocketDebuggerUrl"]
                    break
        except Exception:
            pass
        if ws_url:
            break
        time.sleep(1)
    if not ws_url:
        print("FAIL: game page not found in Chrome targets")
        sys.exit(1)

    ws = websocket.create_connection(ws_url, timeout=120)
    msg_id = [0]

    def evaluate(expr):
        msg_id[0] += 1
        ws.send(json.dumps({"id": msg_id[0], "method": "Runtime.evaluate",
                            "params": {"expression": expr, "returnByValue": True,
                                       "awaitPromise": True, "timeout": 110000}}))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == msg_id[0]:
                return resp

    # Wait for the game to boot (player unfreezes once spawn chunks load).
    ready = False
    for _ in range(90):
        r = evaluate("!!(window.game && window.game.world && !window.game.player.frozen)")
        if r.get("result", {}).get("result", {}).get("value") is True:
            ready = True
            break
        time.sleep(1)
    if not ready:
        state = evaluate("window.game ? 'game-frozen' : (document.title + ' | ' + location.href)")
        print("FAIL: game never became ready:", state.get("result", {}).get("result", {}).get("value"))
        sys.exit(1)
    print("game ready — running AI scenarios (this steps ~45 simulated seconds)...")

    r = evaluate(TEST_JS)
    res = r.get("result", {}).get("result", {})
    if res.get("type") != "string":
        print("FAIL: test script error:", json.dumps(r)[:2000])
        sys.exit(1)
    results = json.loads(res["value"])
    print(json.dumps(results, indent=2))

    ok = (results["pit"]["descended"] and results["pit"]["reached"]
          and results["wall"]["reached"]
          and results["squid"]["dove"] and results["squid"]["nearPlayer"]
          and results["flee"]["ranEast"] and results["flee"]["stayedUp"]
          and all(results["temperament"].values())
          and all(results["eggs"].values()))
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
