"""Headless verification of village worldgen + villagers.

Checks, in the real client against a freshly created demo world:
  1. world config carries village info,
  2. village blocks stream in (planks/glass/cobble/glowstone counts, well water),
  3. the SERVER spawns villagers of mixed sorts while the player is in town
     (creatures are server-simulated and streamed; the client just renders),
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

BLOCKS_JS = r"""
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
  return JSON.stringify({
    village: v, wellWater,
    planks: counts[8] || 0, glass: counts[9] || 0, brick: counts[10] || 0,
    cobble: counts[11] || 0, glowstone: counts[20] || 0,
  });
})()
"""

# Move the REAL player into the village — the server spawns villagers while a
# player is in town, and streams them back to every client.
GOTO_VILLAGE_JS = r"""
(() => {
  const G = window.game, v = G.mobs.village;
  G.player.pos.set(v.x + 0.5, v.ground + 3, v.z + 6.5);
  G.player.vel.set(0, 0, 0);
  return 'moved';
})()
"""

VILLAGER_STATE_JS = r"""
(() => {
  const G = window.game, v = G.mobs.village;
  const vills = G.mobs.mobs.filter((m) => m.t.villager);
  let maxDist = 0;
  for (const m of vills)
    maxDist = Math.max(maxDist, Math.hypot(m.pos.x - (v.x + 0.5), m.pos.z - (v.z + 0.5)));
  return JSON.stringify({
    villagers: vills.length,
    kinds: [...new Set(vills.map((m) => m.type))],
    maxDist: +maxDist.toFixed(1),
  });
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

    # Villagers are server-spawned: make sure wildlife is on (a mine test may
    # have paused it on this shared instance).
    urllib.request.urlopen(urllib.request.Request(
        f"http://{GAME_URL}/api/admin/wildlife", method="POST",
        data=json.dumps({"on": True}).encode(),
        headers={"Content-Type": "application/json"}), timeout=5)

    r = evaluate(BLOCKS_JS)
    res = val(r)
    if not isinstance(res, str):
        print("FAIL:", json.dumps(r)[:1500])
        sys.exit(1)
    results = json.loads(res)
    if "error" in results:
        print(json.dumps(results))
        sys.exit(3)

    # Walk the real player into town and watch the server populate it.
    evaluate(GOTO_VILLAGE_JS)
    state = {"villagers": 0, "kinds": [], "maxDist": 0}
    filled_after = None
    max_dist = 0.0
    for sec in range(75):
        state = json.loads(val(evaluate(VILLAGER_STATE_JS)))
        max_dist = max(max_dist, state["maxDist"])
        if state["villagers"] >= 4 and filled_after is None:
            filled_after = sec
        if filled_after is not None and sec >= filled_after + 15:
            break                          # 15s of wander observation after fill
        time.sleep(1)
    results.update(villagers=state["villagers"], kinds=state["kinds"],
                   maxDistFromCentre=max_dist,
                   secondsToFill=filled_after if filled_after is not None else -1)
    print(json.dumps(results, indent=2))

    ok = (results["wellWater"] and results["planks"] > 50 and results["glass"] > 5
          and results["cobble"] > 30 and results["glowstone"] >= 2
          and results["villagers"] >= 4 and len(results["kinds"]) >= 2
          and results["secondsToFill"] >= 0
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
