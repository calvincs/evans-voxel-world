#!/usr/bin/env python3
"""
Creature-AI scenarios against the SERVER simulation (server/creatures.py) —
no browser, no server process; pure Python against a synthetic world. These
are the same behaviours the old headless test_mob_ai.py proved when the AI
lived in the client:

  A. a wolf drops into a pit to reach its prey
  B. a wolf paths through an offset doorway in a wall
  C. a squid dives down a water well to a deep swimmer
  D. a hurt pig bolts, but won't lemming into a pit
  E. day/night temperament (avoid by day, snap when crowded, anger, night reach)
  F. eggs: land hatch lives; a squid hatched on dry land perishes
  G. bites are routed to the nearest player and rate-limited

Run:  .venv/bin/python tools/test_creature_ai.py
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import creatures as C
from server.creatures import Creature, WorldSim
from server.worldgen import AIR, GRASS, STONE, WATER

PASS = 0


def check(name, cond, extra=""):
    global PASS
    assert cond, f"FAIL: {name} {extra}"
    PASS += 1
    print(f"  ok: {name}")


class FakeView:
    """Dict-backed world: default AIR, with a solid floor at y<0 like the real
    BlockView. Tests paint platforms/walls/water into it."""

    def __init__(self):
        self.blocks = {}

    def set(self, x, y, z, b):
        self.blocks[(x, y, z)] = b

    def get_block(self, x, y, z):
        if y < 0:
            return STONE
        return self.blocks.get((x, y, z), AIR)

    def invalidate(self, x, z):
        pass


class FakeStore:
    def __init__(self):
        self.creatures = {}

    def add_creature(self, wid, cid, rec):
        self.creatures[cid] = rec
        return True

    def remove_creature(self, wid, cid):
        self.creatures.pop(cid, None)

    def set_creatures(self, wid, d):
        self.creatures = dict(d)

    def edits_in_chunk(self, *a):
        return {}


def make_sim(village=None):
    sim = WorldSim.__new__(WorldSim)
    sim.view = FakeView()
    sim.store = FakeStore()
    sim.wid = "w_test"
    sim.village = village
    sim.creatures = {}
    sim.spawn_timer = 1e9              # no random spawns during scenarios
    import itertools
    sim._wild_n = itertools.count(1)
    sim.dirty = False
    sim.mine_live = {}
    return sim


def platform(view, x0, z0, w, d, py):
    for x in range(x0, x0 + w):
        for z in range(z0, z0 + d):
            for dy in range(0, 4):
                view.set(x, py - dy, z, STONE)
            for dy in range(1, 6):
                view.set(x, py + dy, z, AIR)


def sim_seconds(sim, seconds, players, daylight, dt=0.1):
    evs = {"bites": [], "deaths": []}
    for _ in range(int(seconds / dt)):
        ev = sim.tick(dt, players, False, daylight)
        evs["bites"] += ev["bites"]
        evs["deaths"] += ev["deaths"]
    return evs


def horiz(c, p):
    return math.hypot(c.x - p["x"], c.z - p["z"])


PY = 50


def scenario_pit():
    random.seed(11)
    sim = make_sim()
    platform(sim.view, 0, 0, 19, 5, PY)
    px, pz = 9, 2
    for dy in range(0, 3):                     # 3-deep pit, floor stays solid
        sim.view.set(px, PY - dy, pz, AIR)
    pl = {"pid": 1, "x": px + 0.5, "y": PY - 2, "z": pz + 0.5}
    w = Creature("w1", "wolf", 3.5, PY + 1, 2.5)
    sim.creatures["w1"] = w
    sim_seconds(sim, 10, [pl], 0.0)            # night: full aggression
    check("wolf descends into the pit", w.y < PY - 0.5, f"y={w.y:.2f}")
    check("wolf reaches the prey", horiz(w, pl) < 1.2 and abs(w.y - pl["y"]) < 1.2,
          f"h={horiz(w, pl):.2f}")


def scenario_wall():
    random.seed(7)
    sim = make_sim()
    platform(sim.view, 0, 0, 19, 5, PY)
    wx = 6
    for z in range(0, 5):                      # wall across, 3 tall
        for dy in range(1, 4):
            sim.view.set(wx, PY + dy, z, STONE)
    sim.view.set(wx, PY + 1, 0, AIR)           # offset doorway, 2 tall
    sim.view.set(wx, PY + 2, 0, AIR)
    pl = {"pid": 1, "x": 9.5, "y": PY + 1, "z": 2.5}
    w = Creature("w1", "wolf", 3.5, PY + 1, 2.5)
    sim.creatures["w1"] = w
    sim_seconds(sim, 15, [pl], 0.0)
    check("wolf paths through the doorway", horiz(w, pl) < 1.6,
          f"h={horiz(w, pl):.2f} pos=({w.x:.1f},{w.z:.1f})")


def scenario_squid():
    random.seed(3)
    sim = make_sim()
    cx, cz, top, bot = 30, 30, PY + 5, PY - 4
    for x in range(cx - 1, cx + 2):
        for z in range(cz - 1, cz + 2):
            for y in range(bot, top + 1):
                if x == cx and z == cz:
                    sim.view.set(x, y, z, STONE if y == bot else WATER)
                else:
                    sim.view.set(x, y, z, STONE)
    pl = {"pid": 1, "x": cx + 0.5, "y": bot + 1, "z": cz + 0.5}
    sq = Creature("w1", "squid", cx + 0.5, top - 1.5, cz + 0.5)
    start_y = sq.y
    sim.creatures["w1"] = sq
    sim_seconds(sim, 12, [pl], 0.0)
    check("squid dives to the deep swimmer",
          sq.y < start_y - 3 and abs(sq.y - pl["y"]) < 2.2,
          f"y {start_y:.1f} -> {sq.y:.1f}")


def scenario_flee():
    random.seed(5)
    sim = make_sim()
    platform(sim.view, 0, 0, 19, 5, PY)
    for dy in range(0, 3):
        sim.view.set(9, PY - dy, 2, AIR)       # the pit it must NOT enter
    pig = Creature("w1", "pig", 3.5, PY + 1, 2.5)
    pig.yaw = pig.target_yaw = math.atan2(-1, 0)   # facing east
    sim.creatures["w1"] = pig
    pl = {"pid": 1, "x": 1.5, "y": PY + 1, "z": 2.5}
    start_x = pig.x
    pig.hurt(2, 1, 0)                          # knocked east, toward the pit
    max_x = pig.x
    for _ in range(80):
        sim.tick(0.1, [pl], False, 1.0)
        max_x = max(max_x, pig.x)
    check("hurt pig bolts away", max_x > start_x + 2.0, f"adv={max_x - start_x:.2f}")
    check("...but refuses the pit", pig.y > PY + 0.5, f"y={pig.y:.2f}")


def scenario_temperament():
    random.seed(9)
    sim = make_sim()
    platform(sim.view, 0, 0, 19, 5, PY)
    pl = {"pid": 1, "x": 6.5, "y": PY + 1, "z": 2.5}
    w = Creature("w1", "wolf", 2.5, PY + 1, 2.5)   # 4 away
    w.yaw = w.target_yaw = math.atan2(pl["x"] - w.x, pl["z"] - w.z)  # drift heading
    sim.creatures["w1"] = w
    sim_seconds(sim, 3, [pl], 1.0)             # full daylight
    check("docile by day: drifts away", horiz(w, pl) > 5.5 and not w.chasing,
          f"h={horiz(w, pl):.2f}")
    w.x, w.y, w.z = pl["x"] + 1.8, PY + 1, pl["z"]   # crowd it
    sim_seconds(sim, 1.5, [pl], 1.0)
    check("...but snaps when crowded", w.chasing)

    sim.creatures.clear()
    w2 = Creature("w2", "wolf", 2.5, PY + 1, 2.5)
    sim.creatures["w2"] = w2
    pl2 = {"pid": 1, "x": 11.5, "y": PY + 1, "z": 2.5}   # 9 away: calm by day
    sim_seconds(sim, 2, [pl2], 1.0)
    calm_before = not w2.chasing
    w2.hurt(1, 0, 0)                           # poke it
    sim_seconds(sim, 5, [pl2], 1.0)
    check("a poke makes it hunt in daylight", calm_before and horiz(w2, pl2) < 3,
          f"h={horiz(w2, pl2):.2f}")

    sim.creatures.clear()
    w3 = Creature("w3", "wolf", 1.5, PY + 1, 2.5)
    sim.creatures["w3"] = w3
    pl3 = {"pid": 1, "x": 16.5, "y": PY + 1, "z": 2.5}   # 15 away: beyond day senses
    sim_seconds(sim, 8, [pl3], 0.0)            # night: extended senses
    check("night hunters sense far", horiz(w3, pl3) < 3, f"h={horiz(w3, pl3):.2f}")


def scenario_eggs():
    random.seed(2)
    sim = make_sim()
    platform(sim.view, 0, 0, 19, 5, PY)
    pl = {"pid": 1, "x": 2.5, "y": PY + 1, "z": 2.5}
    check("pig hatches on land", sim.hatch("c1", "pig", 6.5, PY + 1, 2.5))
    ev = sim_seconds(sim, 0.5, [pl], 1.0)
    check("...and lives", any(c.kind == "pig" for c in sim.creatures.values()))
    check("squid hatches on dry land", sim.hatch("c2", "squid", 9.5, PY + 1, 2.5))
    ev = sim_seconds(sim, 0.5, [pl], 1.0)
    check("...and perishes at once (with a death event)",
          not any(c.kind == "squid" for c in sim.creatures.values())
          and any(d[3] == "squid" for d in ev["deaths"]))
    check("persistent pig never despawns by distance",
          any(c.kind == "pig" for c in sim.creatures.values()))
    far = [{"pid": 1, "x": 500.0, "y": PY + 1, "z": 500.0}]
    sim_seconds(sim, 1, far, 1.0)
    check("...even with every player far away",
          any(c.kind == "pig" for c in sim.creatures.values()))


def scenario_bites():
    random.seed(4)
    sim = make_sim()
    platform(sim.view, 0, 0, 19, 5, PY)
    near = {"pid": 1, "x": 4.5, "y": PY + 1, "z": 2.5}
    far = {"pid": 2, "x": 15.5, "y": PY + 1, "z": 2.5}
    w = Creature("w1", "wolf", 3.5, PY + 1, 2.5)
    sim.creatures["w1"] = w
    ev = sim_seconds(sim, 4, [far, near], 0.0)
    pids = {b[0] for b in ev["bites"]}
    check("bites go to the NEAREST player", pids == {1}, pids)
    check("bites respect the cooldown", 1 <= len(ev["bites"]) <= 6, len(ev["bites"]))
    check("snapshot flags the chase (growl cue)",
          any(e["c"] for e in sim.snapshot()))


def scenario_mines():
    import time as _t
    sim = make_sim()
    platform(sim.view, 0, 0, 12, 5, PY)
    key = f"5,{PY + 1},2"
    sim.view.set(5, PY + 1, 2, 26)                 # armed for OTHERS
    mines = {key: "Evan"}
    now = _t.monotonic()
    owner = {"pid": 1, "name": "Evan", "x": 6.5, "y": PY + 1, "z": 2.5}
    other = {"pid": 2, "name": "Bob", "x": 6.5, "y": PY + 1, "z": 2.5}

    # A key the sim has never seen = armed in an earlier session -> live NOW.
    check("pre-armed mine never fires on its owner",
          sim.mines_tick(mines, [owner], now) == [])
    check("...but is live immediately for anyone else",
          sim.mines_tick(mines, [other], now) == [(5, PY + 1, 2)])

    # Freshly armed mines honour the delay.
    sim.view.set(5, PY + 1, 2, 26)
    sim.mine_armed(key)
    t0 = _t.monotonic()
    check("fresh arm: not live during the delay",
          sim.mines_tick(mines, [other], t0) == [])
    check("fresh arm: live after the delay",
          sim.mines_tick(mines, [other], t0 + 6) == [(5, PY + 1, 2)])

    # PROX_ALL counts the owner too; creatures always count.
    sim.view.set(5, PY + 1, 2, 27)
    check("EVERYONE mine fires on its owner",
          sim.mines_tick(mines, [owner], now) == [(5, PY + 1, 2)])
    sim.view.set(5, PY + 1, 2, 26)
    sim.mine_live.pop(key, None)
    pig = Creature("w9", "pig", 4.5, PY + 1, 2.5)  # 1 block from the mine
    sim.creatures["w9"] = pig
    check("a creature trips it even with only the owner around",
          sim.mines_tick(mines, [owner], now) == [(5, PY + 1, 2)])
    sim.creatures.clear()

    # Defused (block changed) -> silently dropped.
    sim.view.set(5, PY + 1, 2, 25)
    check("defused mine never trips",
          sim.mines_tick(mines, [other], now) == [] and key not in sim.mine_live)


def main():
    for fn in (scenario_pit, scenario_wall, scenario_squid, scenario_flee,
               scenario_temperament, scenario_eggs, scenario_bites,
               scenario_mines):
        print(f"--- {fn.__name__} ---")
        fn()
    print(f"\nall {PASS} checks passed")


if __name__ == "__main__":
    main()
