"""
Server-side creature simulation.

The server — not any player's browser — runs every creature's brain, so all
players see the same animals in the same places, nothing freezes when a tab
is hidden or a player leaves, and placed creatures persist with the world.
Clients are pure renderers: they receive ~10 Hz snapshots (see main.py's sim
loop) and send back only "I hit creature X" and "hatch an egg here".

This is a faithful port of the AI that used to live in static/js/mobs.js —
constants and behaviour match it move for move (wander, day/night hunter
temperament, A* corner pathfinding with the wall-slide stuck fix, cliff and
water sense, grazer flight, villagers keeping to their village, squid depth
chase). The client file keeps only the visual half (bodies, animation).

Behaviour constants must stay in sync with the *feel* the client was tuned
for; the day/night formula must match static/js/engine/sky.js exactly, or the
server's wolves would hunt while a player's screen still shows daylight.
"""

import heapq
import itertools
import math
import random
import time

from . import worldgen
from .worldgen import AIR, GRASS, STONE, WATER, COBBLE, CHUNK_X, CHUNK_Z, WORLD_Y

# --- Type data (physical + behavioural; visuals live in static/js/mobs.js) ----
TYPES = {
    "pig":     dict(w=0.62, bh=0.50, legH=0.32, speed=1.5, hp=8),
    "sheep":   dict(w=0.62, bh=0.60, legH=0.34, speed=1.2, hp=8),
    "cow":     dict(w=0.72, bh=0.62, legH=0.42, speed=1.1, hp=10),
    "wolf":    dict(w=0.48, bh=0.48, legH=0.44, speed=2.5, hp=12,
                    hostile=True, attack=2, night_hunter=True),
    "chicken": dict(w=0.34, bh=0.32, legH=0.24, speed=1.5, hp=4),
    "spider":  dict(w=0.70, bh=0.34, legH=0.30, speed=2.2, hp=8,
                    hostile=True, attack=1, night_hunter=True, night=True),
    "squid":   dict(w=0.50, bh=0.66, legH=0.00, speed=1.1, hp=8,
                    hostile=True, attack=1, night_hunter=True, aquatic=True),
    "farmer":  dict(w=0.50, bh=0.72, legH=0.45, speed=1.2, hp=10, villager=True),
    "smith":   dict(w=0.54, bh=0.75, legH=0.46, speed=1.1, hp=12, villager=True),
    "elder":   dict(w=0.50, bh=0.70, legH=0.42, speed=0.7, hp=8,  villager=True),
    "kid":     dict(w=0.38, bh=0.50, legH=0.30, speed=2.0, hp=6,  villager=True),
}
LAND_KEYS = [k for k, t in TYPES.items() if not t.get("aquatic") and not t.get("villager")]
WATER_KEYS = [k for k, t in TYPES.items() if t.get("aquatic")]
VILLAGER_KEYS = [k for k, t in TYPES.items() if t.get("villager")]

GRAVITY, TURN = 24.0, 2.2
TARGET_MOBS = 8              # wild population kept alive around the players
SPAWN_MIN, SPAWN_MAX, DESPAWN = 12, 26, 42
VILLAGER_TARGET = 4
VILLAGE_NEARBY = 24

DETECT = 11                  # aggro range — day (angered) baseline
DETECT_NIGHT = 18            # night hunters sense much farther after dark
DAY_DEFEND = 2.5             # docile daytime hunters still snap this close
DAY_AVOID = 7                # ...and drift away from players inside this
ANGER_TIME = 12.0            # seconds a hit keeps a docile hunter aggressive
MAX_MOBS = 48                # simulated creatures per world, all kinds
ATTACK_RANGE = 1.7
ATTACK_INTERVAL = 1.0
FLEE_TIME = 2.5

CHASE_DROP = 3
CHASE_DROP_DEEP = 8
PATH_INTERVAL = 0.6
PATH_NODES = 400
PATH_TTL = 5.0               # walls are static; expiring mid-doorway oscillates
WP_RADIUS = 0.55

# Day/night — MUST match static/js/engine/sky.js (dayLength, +0.30 offset).
DAY_LENGTH = 420.0


def daylight_now(now: float | None = None) -> float:
    t = (((time.time() if now is None else now) / DAY_LENGTH) + 0.30) % 1.0
    sun = -math.cos(t * math.pi * 2)
    return max(0.0, min(1.0, (sun + 0.15) / 0.45))


def is_solid(b: int) -> bool:
    return b != AIR and b != WATER


class BlockView:
    """Composed block reads for one world: pristine terrain from the (cached,
    deterministic) generator plus the players' edits, flattened into one
    bytearray per chunk. main.py invalidates chunks as edits land."""

    def __init__(self, store, gen, wid: str):
        self.store = store
        self.gen = gen
        self.wid = wid
        self._chunks: dict[tuple, bytearray] = {}

    def get_block(self, x: int, y: int, z: int) -> int:
        if y < 0:
            return STONE
        if y >= WORLD_Y:
            return AIR
        cx, cz = x // CHUNK_X, z // CHUNK_Z          # int // floors negatives
        data = self._chunks.get((cx, cz))
        if data is None:
            data = bytearray(self.gen.generate_chunk(cx, cz))
            edits = self.store.edits_in_chunk(self.wid, cx, cz,
                                              CHUNK_X, CHUNK_Z, WORLD_Y)
            for (lx, ly, lz), b in edits.items():
                data[lx + CHUNK_X * (lz + CHUNK_Z * ly)] = b
            if len(self._chunks) > 256:              # bounded footprint
                self._chunks.clear()
            self._chunks[(cx, cz)] = data
        lx, lz = x - cx * CHUNK_X, z - cz * CHUNK_Z
        return data[lx + CHUNK_X * (lz + CHUNK_Z * y)]

    def invalidate(self, x: int, z: int):
        self._chunks.pop((x // CHUNK_X, z // CHUNK_Z), None)


def find_path(view, sx, sy, sz, tx, ty, tz, max_drop):
    """Voxel A* for hunters (port of the client's): compass steps, one-block
    climbs, drops up to max_drop. Budgeted; a spent budget still returns the
    path to the reachable cell nearest the goal."""
    def solid(x, y, z): return is_solid(view.get_block(x, y, z))
    def water(x, y, z): return view.get_block(x, y, z) == WATER
    def stand(x, y, z):
        return not solid(x, y, z) and not water(x, y, z) and solid(x, y - 1, z)
    def h(x, y, z): return abs(x - tx) + abs(y - ty) + abs(z - tz)

    start = (sx, sy, sz)
    g_best = {start: 0.0}
    prev = {}
    seq = itertools.count()
    heap = [(h(sx, sy, sz), next(seq), start, 0.0)]
    best, best_h = start, h(sx, sy, sz)

    for _ in range(PATH_NODES):
        if not heap:
            break
        _, _, cur, g = heapq.heappop(heap)
        if g > g_best.get(cur, math.inf):
            continue                                  # stale heap entry
        ch = h(*cur)
        if ch < best_h:
            best, best_h = cur, ch
        if cur[0] == tx and cur[2] == tz and abs(cur[1] - ty) <= 1:
            best = cur
            break
        cx, cy, cz = cur
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, nz = cx + dx, cz + dz
            ny, cost = None, 1.0
            if stand(nx, cy, nz):
                ny = cy                               # level walk
            elif not solid(nx, cy, nz) and not water(nx, cy, nz):
                for m in range(1, max_drop + 2):      # open, no floor: a drop?
                    b = view.get_block(nx, cy - m, nz)
                    if b == WATER:
                        break
                    if is_solid(b):
                        if m >= 2:
                            ny, cost = cy - m + 1, 1 + (m - 1) * 0.4
                        break
            elif not solid(cx, cy + 1, cz) and stand(nx, cy + 1, nz):
                ny, cost = cy + 1, 1.4                # one-block climb
            if ny is None:
                continue
            node = (nx, ny, nz)
            ng = g + cost
            if ng >= g_best.get(node, math.inf):
                continue
            g_best[node] = ng
            prev[node] = cur
            heapq.heappush(heap, (ng + h(nx, ny, nz), next(seq), node, ng))

    path = []
    n = best
    while n in prev:
        path.append(n)
        n = prev[n]
    path.reverse()
    return path


class Creature:
    def __init__(self, nid, kind, x, y, z):
        self.nid = nid               # 'c…' = persistent (egg-hatched), 'w…' = wild
        self.kind = kind
        self.t = TYPES[kind]
        self.x, self.y, self.z = float(x), float(y), float(z)
        self.vx = self.vy = self.vz = 0.0
        self.yaw = random.random() * math.pi * 2
        self.target_yaw = self.yaw
        self.on_ground = False
        self.walking = False
        self.moving = False
        self.timer = 1 + random.random() * 2
        self.hp = self.t["hp"]
        self.hostile = bool(self.t.get("hostile"))
        self.aquatic = bool(self.t.get("aquatic"))
        self.attack_cd = 0.0
        self.hurt_flash = 0.0        # mirrored to clients as the red flash
        self.chasing = False
        self.kbx = self.kbz = 0.0
        self.flee_t = 0.0
        self.anger_t = 0.0
        self.home = None             # villagers: (x, z, r)
        self.path = None
        self.path_t = 0.0
        self.path_age = 0.0
        self.stuck_t = 0.0
        self.bob = random.random() * 10

    # --- shared helpers --------------------------------------------------------
    def _collides(self, view):
        t = self.t
        hw, h = t["w"] * 0.45, t["legH"] + t["bh"]
        eps = 0.001
        x0, x1 = math.floor(self.x - hw + eps), math.floor(self.x + hw - eps)
        y0, y1 = math.floor(self.y + eps), math.floor(self.y + h - eps)
        z0, z1 = math.floor(self.z - hw + eps), math.floor(self.z + hw - eps)
        for y in range(y0, y1 + 1):
            for z in range(z0, z1 + 1):
                for x in range(x0, x1 + 1):
                    if is_solid(view.get_block(x, y, z)):
                        return True
        return False

    def _move_axis(self, view, axis, amount):
        step = 0.1
        rem = amount
        while abs(rem) > 1e-9:
            s = max(-step, min(step, rem))
            setattr(self, axis, getattr(self, axis) + s)
            if self._collides(view):
                setattr(self, axis, getattr(self, axis) - s)
                return True
            rem -= s
        return False

    def _step_move(self, view, axis, amount):
        """Horizontal move that can climb a single block; True if still blocked."""
        if not self._move_axis(view, axis, amount):
            return False
        if not self.on_ground:
            return True
        start_y = self.y
        self.y += 1.0
        if self._collides(view):
            self.y = start_y
            return True
        if self._move_axis(view, axis, amount):
            self.y = start_y
            return True
        return False                                  # stepped up; gravity settles

    def hurt(self, dmg, dirx=0.0, dirz=0.0):
        self.hp -= dmg
        self.hurt_flash = 0.14
        if self.hostile:
            self.anger_t = ANGER_TIME                 # poking a hunter wakes it
        if dirx or dirz:
            self.kbx, self.kbz = dirx * 7, dirz * 7
            if not self.aquatic and self.on_ground:
                self.vy = max(self.vy, 4.5)
            if not self.hostile and not self.aquatic:
                self.flee_t = FLEE_TIME               # grazers bolt from the blow
                self.walking = True
                self.timer = FLEE_TIME
                self.target_yaw = math.atan2(-dirx, -dirz)

    def _choose_action(self):
        if self.flee_t > 0:
            self.walking = True
            self.timer = 0.5
            return
        if random.random() < 0.45:
            self.walking = True
            self.target_yaw = random.random() * math.pi * 2
            self.timer = 1.5 + random.random() * 2.5
        else:
            self.walking = False
            self.timer = 1 + random.random() * 2.5

    def _try_attack(self, tgt, dist, bites):
        if tgt is None or dist > ATTACK_RANGE or self.attack_cd > 0:
            return
        bites.append((tgt["pid"], self.t.get("attack", 1),
                      self.x, self.z, self.kind))
        self.attack_cd = ATTACK_INTERVAL

    # --- land movement (see mobs.js _walk for the design notes) ----------------
    def update(self, dt, view, tgt, daylight, bites, budget):
        if self.anger_t > 0:
            self.anger_t -= dt
        if self.aquatic:
            self._swim(dt, view, tgt, daylight, bites)
        else:
            self._walk(dt, view, tgt, daylight, bites, budget)
        if self.attack_cd > 0:
            self.attack_cd -= dt
        if self.hurt_flash > 0:
            self.hurt_flash -= dt

    def _walk(self, dt, view, tgt, daylight, bites, budget):
        self.timer -= dt
        if self.timer <= 0:
            self._choose_action()
        if self.flee_t > 0:
            self.flee_t -= dt

        chasing = False
        if self.hostile and tgt is not None:
            dx, dz = tgt["x"] - self.x, tgt["z"] - self.z
            dist = math.hypot(dx, dz)
            night = daylight < 0.35
            aggressive = (not self.t.get("night_hunter")) or night or self.anger_t > 0
            rng = (DETECT_NIGHT if night and self.t.get("night_hunter") else DETECT) \
                if aggressive else DAY_DEFEND
            if dist < rng:
                chasing = True
                self.walking = True
                self._steer_chase(dt, view, tgt, dx, dz, budget)
                self._try_attack(tgt, math.hypot(dx, tgt["y"] - self.y, dz), bites)
            elif not aggressive and dist < DAY_AVOID:
                self.walking = True                   # daylight: sidle away
                self.target_yaw = math.atan2(dx, dz)
        self.chasing = chasing                        # 'c' in snapshots -> growl cue
        if not chasing:
            self.path = None
            self.stuck_t = 0.0

        if self.home and self.walking and not chasing:
            hx, hz = self.home[0] - self.x, self.home[1] - self.z
            if math.hypot(hx, hz) > self.home[2]:
                self.target_yaw = math.atan2(-hx, -hz)

        dy = self.target_yaw - self.yaw
        while dy > math.pi:
            dy -= 2 * math.pi
        while dy < -math.pi:
            dy += 2 * math.pi
        self.yaw += max(-TURN * dt, min(TURN * dt, dy))

        fx, fz = -math.sin(self.yaw), -math.cos(self.yaw)
        speed = self.t["speed"] * (1.15 if chasing else 1.6 if self.flee_t > 0 else 1.0) \
            if self.walking else 0.0
        if chasing and abs(dy) > 0.8:
            speed *= 0.35                             # brake into sharp turns

        if self.walking:
            ax, az = math.floor(self.x + fx * 0.7), math.floor(self.z + fz * 0.7)
            ground_ahead = (is_solid(view.get_block(ax, math.floor(self.y - 0.4), az))
                            or is_solid(view.get_block(ax, math.floor(self.y - 1.2), az)))
            water_ahead = (view.get_block(ax, math.floor(self.y + 0.1), az) == WATER
                           or view.get_block(ax, math.floor(self.y - 0.4), az) == WATER)
            drop_ok = (chasing and not water_ahead and not ground_ahead
                       and self._drop_ahead_ok(view, ax, az, tgt))
            if (water_ahead or not ground_ahead) and not drop_ok:
                speed = 0.0
                if not chasing:
                    self.walking = self.flee_t > 0
                    self.timer = 0.4
                    self.target_yaw = self.yaw + 2.2

        self.kbx *= max(0.0, 1 - dt * 6)
        self.kbz *= max(0.0, 1 - dt * 6)
        self.vx = fx * speed + self.kbx
        self.vz = fz * speed + self.kbz
        self.vy = max(self.vy - GRAVITY * dt, -40.0)
        if view.get_block(math.floor(self.x), math.floor(self.y + 0.2),
                          math.floor(self.z)) == WATER:
            self.vy = max(self.vy, 1.5)               # paddle up, don't lakebed-walk

        px, pz = self.x, self.z
        bumped = False
        if self._step_move(view, 'x', self.vx * dt):
            if not chasing:
                self.target_yaw = self.yaw + 1.5
            self.vx = 0.0
            bumped = True
        if self._step_move(view, 'z', self.vz * dt):
            if not chasing:
                self.target_yaw = self.yaw + 1.5
            self.vz = 0.0
            bumped = True
        if self._move_axis(view, 'y', self.vy * dt):
            self.on_ground = self.vy < 0
            self.vy = 0.0
        else:
            self.on_ground = False

        # Wall bumps count as stuck even while sliding along the face — the
        # cue that buys a path (see the doorway-orbit fix in the client port).
        if chasing and self.on_ground:
            moved = math.hypot(self.x - px, self.z - pz)
            if bumped or moved < self.t["speed"] * dt * 0.35:
                self.stuck_t += dt
            else:
                self.stuck_t = max(0.0, self.stuck_t - dt * 2)

        self.moving = speed > 0 and self.on_ground

    def _steer_chase(self, dt, view, tgt, dx, dz, budget):
        self.path_t -= dt
        if self.stuck_t > 0.35 and self.path_t <= 0 and self.on_ground and budget[0] > 0:
            budget[0] -= 1
            self.path_t = PATH_INTERVAL
            drop = CHASE_DROP_DEEP if tgt["y"] < self.y - 1.5 else CHASE_DROP
            p = find_path(view, math.floor(self.x), math.floor(self.y + 0.01),
                          math.floor(self.z), math.floor(tgt["x"]),
                          math.floor(tgt["y"] + 0.01), math.floor(tgt["z"]), drop)
            self.path = p or None
            self.path_age = 0.0
        if self.path:
            self.path_age += dt
            while self.path:
                wx, wy, wz = self.path[0]
                if (abs(wy - self.y) < 1.2
                        and math.hypot(wx + 0.5 - self.x, wz + 0.5 - self.z) < WP_RADIUS):
                    self.path.pop(0)
                else:
                    break
            if not self.path:
                self.path = None
            elif self.path_age > PATH_TTL:
                self.path = None
                self.path_t = 0.0                     # stale: re-request at once
        if self.path:
            wx, _, wz = self.path[0]
            ax, az = wx + 0.5 - self.x, wz + 0.5 - self.z
            if math.hypot(ax, az) > 0.05:
                self.target_yaw = math.atan2(-ax, -az)
        else:
            self.target_yaw = math.atan2(-dx, -dz)

    def _drop_ahead_ok(self, view, ax, az, tgt):
        max_drop = CHASE_DROP_DEEP if tgt and tgt["y"] < self.y - 1.5 else CHASE_DROP
        y = math.floor(self.y)
        for m in range(2, max_drop + 2):
            b = view.get_block(ax, y - m, az)
            if b == WATER:
                return False
            if is_solid(b):
                return True
        return False

    # --- water movement ---------------------------------------------------------
    def _swim(self, dt, view, tgt, daylight, bites):
        self.timer -= dt
        if self.timer <= 0:
            self.target_yaw = self.yaw + (random.random() - 0.5) * 3.0
            self.timer = 1.5 + random.random() * 2.5

        dive = 0.0
        chasing = False
        if self.hostile and tgt is not None:
            dx, dz = tgt["x"] - self.x, tgt["z"] - self.z
            dist = math.hypot(dx, dz)
            night = daylight < 0.35
            aggressive = (not self.t.get("night_hunter")) or night or self.anger_t > 0
            rng = (DETECT_NIGHT if night and self.t.get("night_hunter") else DETECT) \
                if aggressive else DAY_DEFEND
            if dist < rng:
                chasing = True
                self.target_yaw = math.atan2(-dx, -dz)
                gap = (tgt["y"] + 0.9) - (self.y + self.t["bh"] * 0.5)
                if abs(gap) > 0.35:
                    dive = max(-self.t["speed"], min(self.t["speed"], gap))
                self._try_attack(tgt, math.hypot(dx, tgt["y"] - self.y, dz), bites)
            elif not aggressive and dist < DAY_AVOID:
                self.target_yaw = math.atan2(dx, dz)
        self.chasing = chasing

        dy = self.target_yaw - self.yaw
        while dy > math.pi:
            dy -= 2 * math.pi
        while dy < -math.pi:
            dy += 2 * math.pi
        self.yaw += max(-TURN * dt, min(TURN * dt, dy))

        fx, fz = -math.sin(self.yaw), -math.cos(self.yaw)
        spd = self.t["speed"]
        self.kbx *= max(0.0, 1 - dt * 4)
        self.kbz *= max(0.0, 1 - dt * 4)
        nx = self.x + (fx * spd + self.kbx) * dt
        nz = self.z + (fz * spd + self.kbz) * dt
        if view.get_block(math.floor(nx), math.floor(self.y), math.floor(nz)) == WATER:
            self.x, self.z = nx, nz
        else:
            self.target_yaw = self.yaw + 2.4
            self.timer = min(self.timer, 0.4)

        self.bob += dt
        vy = dive if dive != 0 else math.sin(self.bob * 0.8) * 0.35
        ny = self.y + vy * dt
        if (view.get_block(math.floor(self.x), math.floor(ny), math.floor(self.z)) == WATER
                and view.get_block(math.floor(self.x), math.floor(ny + self.t["bh"]),
                                   math.floor(self.z)) == WATER):
            self.y = ny
        self.moving = True


class WorldSim:
    """All creatures of one world. tick() advances them against the composed
    block view and returns what the room needs to hear about."""

    def __init__(self, store, gen, wid: str, village=None):
        self.view = BlockView(store, gen, wid)
        self.store = store
        self.wid = wid
        self.village = village                        # {x, z, radius} or None
        self.creatures: dict[str, Creature] = {}
        self.spawn_timer = 2.0
        self._wild_n = itertools.count(1)
        self.dirty = False                            # persistent state changed

    # --- lifecycle ---------------------------------------------------------------
    def load_persistent(self, creatures: dict):
        for cid, rec in (creatures or {}).items():
            t = rec.get("t")
            if t not in TYPES or cid in self.creatures:
                continue
            c = Creature(cid, t, rec["x"], rec["y"], rec["z"])
            hp = rec.get("hp")
            if isinstance(hp, (int, float)) and hp > 0:
                c.hp = int(hp)
            if TYPES[t].get("villager") and self.village:
                c.home = (self.village["x"] + 0.5, self.village["z"] + 0.5,
                          self.village["radius"])
            self.creatures[cid] = c

    def persistent_dict(self) -> dict:
        return {c.nid: {"t": c.kind, "x": round(c.x, 2), "y": round(c.y, 2),
                        "z": round(c.z, 2), "hp": c.hp}
                for c in self.creatures.values() if c.nid.startswith("c")}

    def hatch(self, cid, kind, x, y, z):
        if kind not in TYPES or len(self.creatures) >= MAX_MOBS + MAX_MOBS:
            return False
        c = Creature(cid, kind, x, y, z)
        if TYPES[kind].get("villager") and self.village:
            c.home = (self.village["x"] + 0.5, self.village["z"] + 0.5,
                      self.village["radius"])
        self.creatures[cid] = c
        # A squid out of water doesn't last long (dies with the usual puff).
        if c.aquatic and self.view.get_block(
                math.floor(x), math.floor(y + c.t["bh"] * 0.5), math.floor(z)) != WATER:
            c.hp = 0
        self.dirty = True
        return True

    def hurt(self, nid, dmg, dx, dz):
        c = self.creatures.get(nid)
        if not c or c.t.get("villager"):              # villagers are neighbours
            return
        c.hurt(dmg, dx, dz)
        self.dirty = self.dirty or nid.startswith("c")

    def blast_kill(self, x, y, z, r=4.5):
        for c in self.creatures.values():
            yc = c.t["bh"] * 0.5 if c.aquatic else (c.t["legH"] + c.t["bh"]) * 0.5
            if math.hypot(c.x - (x + 0.5), c.y + yc - (y + 0.5),
                          c.z - (z + 0.5)) < r:
                c.hp = 0
                self.dirty = self.dirty or c.nid.startswith("c")

    # --- spawning ------------------------------------------------------------------
    def _find_land_spot(self, ax, az):
        ang = random.random() * math.pi * 2
        dist = SPAWN_MIN + random.random() * (SPAWN_MAX - SPAWN_MIN)
        x = math.floor(ax + math.cos(ang) * dist)
        z = math.floor(az + math.sin(ang) * dist)
        for y in range(WORLD_Y - 1, 1, -1):
            b = self.view.get_block(x, y, z)
            if is_solid(b):
                return (x + 0.5, y + 1, z + 0.5) if b == GRASS else None
        return None

    def _find_water_spot(self, ax, az):
        ang = random.random() * math.pi * 2
        dist = SPAWN_MIN + random.random() * (SPAWN_MAX - SPAWN_MIN)
        x = math.floor(ax + math.cos(ang) * dist)
        z = math.floor(az + math.sin(ang) * dist)
        wl = worldgen.WATER_LEVEL
        if (self.view.get_block(x, wl - 1, z) == WATER
                and self.view.get_block(x, wl - 2, z) == WATER):
            return (x + 0.5, wl - 1.2, z + 0.5)
        return None

    def _villagers_wanted(self, players):
        v = self.village
        if not v or not players:
            return 0
        near = min(math.hypot(p["x"] - v["x"], p["z"] - v["z"]) for p in players)
        return VILLAGER_TARGET if near < v["radius"] + VILLAGE_NEARBY else 0

    def _spawn_villager(self, players, kind=None):
        v = self.village
        if not v or self._villagers_wanted(players) == 0:
            return False
        ang = random.random() * math.pi * 2
        d = 2 + random.random() * (v["radius"] - 6)
        x = math.floor(v["x"] + math.cos(ang) * d)
        z = math.floor(v["z"] + math.sin(ang) * d)
        for y in range(WORLD_Y - 1, 1, -1):
            b = self.view.get_block(x, y, z)
            if not is_solid(b):
                continue
            if b != GRASS and b != COBBLE:            # roofs/farm rows: no
                return False
            sx, sy, sz = x + 0.5, y + 1, z + 0.5
            if any(math.hypot(sx - p["x"], sz - p["z"]) < 5 for p in players):
                return False
            kind = kind or random.choice(VILLAGER_KEYS)
            c = Creature(f"w{next(self._wild_n)}", kind, sx, sy, sz)
            c.home = (v["x"] + 0.5, v["z"] + 0.5, v["radius"])
            self.creatures[c.nid] = c
            return True
        return False

    def _spawn_type(self, kind, ax, az, daylight, peaceful, players):
        t = TYPES[kind]
        if t.get("villager"):
            return self._spawn_villager(players, kind)
        if peaceful and t.get("hostile"):
            return False
        if t.get("night") and daylight >= 0.35:
            return False
        spot = (self._find_water_spot(ax, az) if t.get("aquatic")
                else self._find_land_spot(ax, az))
        if not spot:
            return False
        c = Creature(f"w{next(self._wild_n)}", kind, *spot)
        self.creatures[c.nid] = c
        return True

    def _try_spawn(self, ax, az, daylight, peaceful, players):
        night = daylight < 0.35
        if WATER_KEYS and random.random() < 0.25:
            self._spawn_type(random.choice(WATER_KEYS), ax, az, daylight,
                             peaceful, players)
            return
        pool = [k for k in LAND_KEYS
                if (night or not TYPES[k].get("night"))
                and not (peaceful and TYPES[k].get("hostile"))]
        if pool:
            self._spawn_type(random.choice(pool), ax, az, daylight,
                             peaceful, players)

    def clear_wild(self):
        """Drop every non-persistent creature (testing / parent control)."""
        for nid in [n for n in self.creatures if not n.startswith("c")]:
            del self.creatures[nid]

    # --- the tick --------------------------------------------------------------------
    def tick(self, dt, players, peaceful, daylight, wildlife=True):
        """players: [{'pid', 'x', 'y', 'z'}]. Returns dict with 'snapshot',
        'bites' [(pid, amount, x, z, kind)] and 'deaths' [(x, y, z, kind)]."""
        bites, deaths = [], []
        budget = [1]                                  # one A* per tick, all mobs

        wild = [c for c in self.creatures.values()
                if not c.nid.startswith("c") and not c.t.get("villager")]
        villagers = [c for c in self.creatures.values()
                     if c.t.get("villager") and not c.nid.startswith("c")]
        self.spawn_timer -= dt
        if wildlife and players and self.spawn_timer <= 0 and len(self.creatures) < MAX_MOBS:
            v_short = len(villagers) < self._villagers_wanted(players)
            short = len(wild) < TARGET_MOBS
            self.spawn_timer = (0.8 + random.random() * 1.2) if (short or v_short) \
                else (2.5 + random.random() * 3)
            anchor = random.choice(players)
            if v_short:
                self._spawn_villager(players)
            elif short:
                self._try_spawn(anchor["x"], anchor["z"], daylight, peaceful, players)

        targets = [] if peaceful else players
        for nid in list(self.creatures.keys()):
            c = self.creatures[nid]
            tgt = None
            if c.hostile and targets:
                tgt = min(targets,
                          key=lambda p: math.hypot(p["x"] - c.x, p["z"] - c.z))
            if c.hp > 0:
                c.update(dt, self.view, tgt, daylight, bites, budget)
            if c.hp <= 0:
                deaths.append((round(c.x, 2), round(c.y + 0.4, 2),
                               round(c.z, 2), c.kind))
                del self.creatures[nid]
                if nid.startswith("c"):
                    self.store.remove_creature(self.wid, nid)
                    self.dirty = True
                continue
            # Wild creatures despawn once far from every player; placed never.
            if not nid.startswith("c") and players:
                near = min(math.hypot(p["x"] - c.x, p["z"] - c.z) for p in players)
                if near > DESPAWN or c.y < -6:
                    del self.creatures[nid]

        return {"snapshot": self.snapshot(), "bites": bites, "deaths": deaths}

    def snapshot(self):
        return [{"i": c.nid, "t": c.kind,
                 "x": round(c.x, 2), "y": round(c.y, 2), "z": round(c.z, 2),
                 "w": round(c.yaw, 2),
                 "s": 1 if c.moving or c.aquatic else 0,
                 "h": 1 if c.hurt_flash > 0 else 0,
                 "c": 1 if c.chasing else 0}
                for c in self.creatures.values()]

    def checkpoint(self):
        """Persist placed creatures — their positions drift every tick, so the
        sim loop calls this on a cadence (and once more when the room empties).
        Cheap: it only rewrites a small dict and marks the world dirty; the
        write-behind flusher owns the disk."""
        d = self.persistent_dict()
        if d or self.dirty:
            self.dirty = False
            self.store.set_creatures(self.wid, d)
