"""Headless verification of village worldgen + villagers.

Checks, in the real client against a freshly created demo world:
  1. world config carries village info,
  2. village blocks stream in (planks/glass/cobble/glowstone counts, well water),
  3. villagers of mixed sorts spawn while the player is in town,
  4. they wander but keep close to the village,
and captures a screenshot of the village for visual inspection.
"""
import base64
import json
import sys
import time
import urllib.request

import websocket

DEBUG_PORT = 9223
GAME_URL = "localhost:8899"
SHOT = sys.argv[1] if len(sys.argv) > 1 else "village.png"

SIM_JS = r"""
(() => {
  const G = window.game;
  const { world, mobs } = G;
  const v = mobs.village;
  if (!v) return JSON.stringify({ error: 'no village in config' });

  const counts = {};
  for (let x = v.x - 20; x <= v.x + 20; x++)
    for (let z = v.z - 20; z <= v.z + 20; z++)
      for (let y = v.ground - 1; y <= v.ground + 10; y++) {
        const b = world.getBlock(x, y, z);
        counts[b] = (counts[b] || 0) + 1;
      }
  const wellWater = world.getBlock(v.x, v.ground + 1, v.z) === 7;

  mobs.clear();
  mobs.spawnTimer = 0;
  const fake = { pos: { x: v.x + 0.5, y: v.ground + 1, z: v.z + 6.5 },
                 locked: false, frozen: true, dead: false };
  const dt = 1 / 60;
  let ticks = 0;
  const isV = (m) => m.t.villager;
  while (ticks < 240 * 60 && mobs.mobs.filter(isV).length < 4) { mobs.update(dt, fake, 1); ticks++; }
  const vills = mobs.mobs.filter(isV);
  const kinds = [...new Set(vills.map((m) => m.type))];

  let maxDist = 0;
  for (let i = 0; i < 60 * 60; i++) {                 // a sim-minute of wandering
    mobs.update(dt, fake, 1);
    for (const m of mobs.mobs) {
      if (!isV(m)) continue;
      maxDist = Math.max(maxDist, Math.hypot(m.pos.x - (v.x + 0.5), m.pos.z - (v.z + 0.5)));
    }
  }
  const out = {
    village: v, wellWater,
    planks: counts[8] || 0, glass: counts[9] || 0, brick: counts[10] || 0,
    cobble: counts[11] || 0, glowstone: counts[20] || 0,
    villagers: vills.length, kinds,
    aliveAfterMinute: mobs.mobs.filter(isV).length,
    maxDistFromCentre: +maxDist.toFixed(1),
    secondsToFill: +(ticks / 60).toFixed(1),
  };
  return JSON.stringify(out);
})()
"""

# Perch the real player above the village edge looking at the centre, so the
# renderer draws the whole settlement for a screenshot.
CAMERA_JS_TMPL = """
(() => {{
  const G = window.game;
  const v = G.mobs.village;
  const px = v.x - 16, pz = v.z + 10, py = v.ground + 9;
  for (let y = v.ground; y < py; y++) G.world.setBlock(px, y, pz, 3, false);
  G.player.pos.set(px + 0.5, py, pz + 0.5);
  G.player.vel.set(0, 0, 0);
  G.player.yaw = Math.atan2(-(v.x - px), -(v.z - pz));
  G.player.pitch = {pitch};
  return 'ok';
}})()
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

    def rpc(method, params=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]:
                return r

    def evaluate(expr):
        return rpc("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                        "awaitPromise": True, "timeout": 110000})

    def val(r):
        return r.get("result", {}).get("result", {}).get("value")

    for _ in range(90):
        if val(evaluate("!!(window.game && window.game.world && !window.game.player.frozen)")) is True:
            break
        time.sleep(1)
    else:
        print("FAIL: game never ready")
        sys.exit(1)

    if not val(evaluate("!!window.game.mobs.village")):
        print("FAIL: config has no village (ocean/mountain seed? recreate the demo world)")
        sys.exit(3)

    # Make sure the chunks around the village are streamed in before scanning.
    evaluate("const v=window.game.mobs.village; window.game.world.update(v.x, v.z); 'load'")
    for _ in range(30):
        if val(evaluate("window.game.world.ready(window.game.mobs.village.x, window.game.mobs.village.z)")):
            break
        evaluate("const w=window.game.mobs.village; window.game.world.update(w.x, w.z); 'load'")
        time.sleep(1)

    r = evaluate(SIM_JS)
    res = val(r)
    if not isinstance(res, str):
        print("FAIL:", json.dumps(r)[:1500])
        sys.exit(1)
    results = json.loads(res)
    print(json.dumps(results, indent=2))
    if "error" in results:
        sys.exit(3)

    ok = (results["wellWater"] and results["planks"] > 50 and results["glass"] > 5
          and results["cobble"] > 30 and results["glowstone"] >= 2
          and results["villagers"] >= 4 and len(results["kinds"]) >= 2
          and results["aliveAfterMinute"] >= 4
          and results["maxDistFromCentre"] < results["village"]["radius"] + 10)
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")

    # Screenshot for visual inspection (best effort).
    evaluate(CAMERA_JS_TMPL.format(pitch=-0.35))
    time.sleep(2.5)
    shot = rpc("Page.captureScreenshot", {"format": "png"})
    data = shot.get("result", {}).get("data")
    if data:
        with open(SHOT, "wb") as f:
            f.write(base64.b64decode(data))
        print("screenshot:", SHOT)

    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
