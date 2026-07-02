#!/usr/bin/env python3
"""Headless verification of water settling dynamics (static/js/engine/world.js):

  W1. poured water streams to the DEEPEST reachable cell of a hole
  W2. a flat basin fills bottom-up, layer by layer
  W3. a 1x1 well stacks water from the bottom
  W4. breaching a pond wall drains it downhill through the channel
  W5. breaking the floor under a water column makes it fall
  ...and volume is conserved in every scenario (pours are finite — only water
  connected to the sea/lakes refills for free).

Same CDP recipe as the other gameplay tests: expects the shared server on
localhost:8899 + Chrome debug on 9223 (tools/run_game_tests.sh provides both).
All scenarios sit well above sea level (y=22), so the infinite water-table
path never triggers.
"""
import json
import sys
import time
import urllib.request

import websocket

DEBUG_PORT = 9223
GAME_URL = "localhost:8899"

TEST_JS = r"""
(() => {
  const G = window.game, { world } = G;
  const AIR = 0, STONE = 3, WATER = 7;
  const S = (x, y, z, b) => world.setBlock(x, y, z, b, false);
  const P = { x: Math.floor(G.player.pos.x), z: Math.floor(G.player.pos.z) };
  const step = (n) => { for (let i = 0; i < n; i++) { world._updateFloods(); world._updateSettles(); } };
  const pour = (x, y, z) => { world.setBlock(x, y, z, WATER, true); step(400); };
  const results = {};

  // A solid stone box we carve holes into (well above sea level: y 40..44).
  const box = (x0, z0, w, d) => {
    for (let x = x0; x < x0 + w; x++)
      for (let z = z0; z < z0 + d; z++) {
        for (let y = 40; y <= 44; y++) S(x, y, z, STONE);
        for (let y = 45; y <= 48; y++) S(x, y, z, AIR);
      }
  };
  const countWater = (x0, x1, z0, z1) => {
    let n = 0;
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (let y = 40; y <= 48; y++)
          if (world.getBlock(x, y, z) === WATER) n++;
    return n;
  };

  // W1: staircase hole — water poured at the shallow end must come to rest in
  // the single deepest cell.
  {
    const x0 = P.x + 16, z0 = P.z, zc = z0 + 1;
    box(x0, z0, 7, 3);
    S(x0 + 1, 44, zc, AIR);                                   // 1 deep
    S(x0 + 2, 44, zc, AIR); S(x0 + 2, 43, zc, AIR);           // 2 deep
    S(x0 + 3, 44, zc, AIR); S(x0 + 3, 43, zc, AIR); S(x0 + 3, 42, zc, AIR);  // 3 deep
    pour(x0 + 1, 44, zc);
    results.deepest = {
      atBottom: world.getBlock(x0 + 3, 42, zc) === WATER,
      sourceEmpty: world.getBlock(x0 + 1, 44, zc) === AIR,
      volume1: countWater(x0, x0 + 6, z0, z0 + 2) === 1,
    };
  }

  // W2: flat 3-wide basin, 2 deep — three pours fill the BOTTOM layer across,
  // not a stack under the pour point.
  {
    const x0 = P.x + 16, z0 = P.z + 6, zc = z0 + 1;
    box(x0, z0, 5, 3);
    for (const dx of [1, 2, 3]) { S(x0 + dx, 44, zc, AIR); S(x0 + dx, 43, zc, AIR); }
    pour(x0 + 1, 44, zc); pour(x0 + 1, 44, zc); pour(x0 + 1, 44, zc);
    results.layers = {
      bottomFull: [1, 2, 3].every((dx) => world.getBlock(x0 + dx, 43, zc) === WATER),
      topEmpty: [1, 2, 3].every((dx) => world.getBlock(x0 + dx, 44, zc) === AIR),
      volume3: countWater(x0, x0 + 4, z0, z0 + 2) === 3,
    };
  }

  // W3: 1x1 well, 3 deep — two pours stack from the bottom.
  {
    const x0 = P.x + 16, z0 = P.z + 12, zc = z0 + 1;
    box(x0, z0, 3, 3);
    S(x0 + 1, 44, zc, AIR); S(x0 + 1, 43, zc, AIR); S(x0 + 1, 42, zc, AIR);
    pour(x0 + 1, 44, zc); pour(x0 + 1, 44, zc);
    results.well = {
      bottom: world.getBlock(x0 + 1, 42, zc) === WATER,
      middle: world.getBlock(x0 + 1, 43, zc) === WATER,
      topOpen: world.getBlock(x0 + 1, 44, zc) === AIR,
      volume2: countWater(x0, x0 + 2, z0, z0 + 2) === 2,
    };
  }

  // W4: a pond behind a wall, lower ground beyond — breaking the wall drains
  // the pond downhill through the breach.
  {
    const x0 = P.x + 16, z0 = P.z + 18, zc = z0 + 1;
    box(x0, z0, 8, 3);
    S(x0 + 1, 44, zc, AIR); S(x0 + 2, 44, zc, AIR);           // pond cells (1 deep)
    S(x0 + 4, 44, zc, AIR); S(x0 + 4, 43, zc, AIR);           // runoff, 1 lower
    S(x0 + 5, 44, zc, AIR); S(x0 + 5, 43, zc, AIR);
    // One pour per pond cell — pouring onto settled water is a no-op.
    pour(x0 + 1, 44, zc); pour(x0 + 2, 44, zc);
    const pondFull = world.getBlock(x0 + 1, 44, zc) === WATER
                  && world.getBlock(x0 + 2, 44, zc) === WATER;
    world.setBlock(x0 + 3, 44, zc, AIR, true);                // breach the wall
    step(600);
    results.drain = {
      pondFull,
      pondEmpty: world.getBlock(x0 + 1, 44, zc) === AIR
              && world.getBlock(x0 + 2, 44, zc) === AIR,
      runoffFull: world.getBlock(x0 + 4, 43, zc) === WATER
               && world.getBlock(x0 + 5, 43, zc) === WATER,
      volume2: countWater(x0, x0 + 7, z0, z0 + 2) === 2,
    };
  }

  // W5: break the floor under a filled well — the column falls one cell.
  {
    const x0 = P.x + 16, z0 = P.z + 24, zc = z0 + 1;
    box(x0, z0, 3, 3);
    S(x0 + 1, 44, zc, AIR); S(x0 + 1, 43, zc, AIR);
    pour(x0 + 1, 44, zc); pour(x0 + 1, 44, zc);               // well full: 43+44
    world.setBlock(x0 + 1, 42, zc, AIR, true);                // knock out the floor
    step(400);
    results.fall = {
      bottom: world.getBlock(x0 + 1, 42, zc) === WATER,
      middle: world.getBlock(x0 + 1, 43, zc) === WATER,
      topDrained: world.getBlock(x0 + 1, 44, zc) === AIR,
      volume2: countWater(x0, x0 + 2, z0, z0 + 2) === 2,
    };
  }

  return JSON.stringify(results);
})()
"""


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

    # Ready = game booted AND the arena band (P.x+16..+24, P.z..P.z+27) streamed
    # in — blocks set into unloaded chunks are silently dropped.
    for _ in range(90):
        r = evaluate("""(() => {
          const G = window.game;
          if (!G || !G.world || G.player.frozen) return false;
          const P = G.player.pos;
          for (const [dx, dz] of [[16, 0], [24, 0], [16, 27], [24, 27]])
            if (!G.world.ready(P.x + dx, P.z + dz)) return false;
          return true;
        })()""")
        if r.get("result", {}).get("result", {}).get("value") is True:
            break
        time.sleep(1)
    else:
        print("FAIL: game never ready")
        sys.exit(1)
    print("game ready — running water scenarios...")

    r = evaluate(TEST_JS)
    res = r.get("result", {}).get("result", {})
    if res.get("type") != "string":
        print("FAIL:", json.dumps(r)[:2000])
        sys.exit(1)
    results = json.loads(res["value"])
    print(json.dumps(results, indent=2))
    ok = all(all(v.values()) for v in results.values())
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
