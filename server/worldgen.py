"""
Voxel terrain generation for EvansGame.

Pure-Python Perlin noise (no numpy / external deps) so the project installs
with just FastAPI + uvicorn. Terrain is generated deterministically per chunk
from a seed, which means chunk borders always line up and trees that straddle
two chunks stamp identically from either side.

Coordinate system (shared with the JS client, see static/js/engine/chunk.js):
    A chunk is CHUNK_X * CHUNK_Z columns, WORLD_Y blocks tall.
    Flat index: idx = x + CHUNK_X * (z + CHUNK_Z * y)
"""

import collections
import math
import random

# --- World dimensions (must match the client) --------------------------------
CHUNK_X = 16
CHUNK_Z = 16
WORLD_Y = 64

# --- Block ids (must match static/js/blocks.js) -------------------------------
AIR = 0
GRASS = 1
DIRT = 2
STONE = 3
WOOD = 4
LEAVES = 5
SAND = 6
WATER = 7
PLANKS = 8
GLASS = 9
BRICK = 10
COBBLE = 11
SNOW = 12
PUMPKIN = 13
WOOL_RED = 16
WOOL_BLUE = 17
GLOWSTONE = 20
PUMPKIN_LIT = 24

# --- Terrain shape knobs ------------------------------------------------------
WATER_LEVEL = 22
BASE_HEIGHT = 24
AMPLITUDE = 14
TERRAIN_SCALE = 0.012   # smaller -> larger, smoother hills
SNOW_LINE = 30          # peaks above this get snow caps

# --- Village knobs --------------------------------------------------------------
VILLAGE_RADIUS = 24     # ground disc that gets levelled (feathered at the rim)
VILLAGE_CORE = 19       # fully-flat inner disc; every structure fits inside it

# How many freshly generated chunks to keep cached per seed. Terrain is
# deterministic, so a cache hit is exact. 512 * 16 KB ~= 8 MB per active world.
CHUNK_CACHE_MAX = 512


class Perlin:
    """Ken Perlin's 'improved noise', 2D."""

    def __init__(self, seed: int = 1337):
        rnd = random.Random(seed)
        perm = list(range(256))
        rnd.shuffle(perm)
        self.perm = perm + perm  # doubled to avoid index wrapping math

    @staticmethod
    def _fade(t: float) -> float:
        return t * t * t * (t * (t * 6 - 15) + 10)

    @staticmethod
    def _lerp(a: float, b: float, t: float) -> float:
        return a + t * (b - a)

    @staticmethod
    def _grad(h: int, x: float, y: float) -> float:
        h &= 7
        u = x if h < 4 else y
        v = y if h < 4 else x
        return (u if (h & 1) == 0 else -u) + (v if (h & 2) == 0 else -v)

    def noise2(self, x: float, y: float) -> float:
        xi = math.floor(x)
        yi = math.floor(y)
        X = xi & 255
        Y = yi & 255
        xf = x - xi
        yf = y - yi
        u = self._fade(xf)
        v = self._fade(yf)
        p = self.perm
        aa = p[p[X] + Y]
        ab = p[p[X] + Y + 1]
        ba = p[p[X + 1] + Y]
        bb = p[p[X + 1] + Y + 1]
        x1 = self._lerp(self._grad(aa, xf, yf), self._grad(ba, xf - 1, yf), u)
        x2 = self._lerp(self._grad(ab, xf, yf - 1), self._grad(bb, xf - 1, yf - 1), u)
        return self._lerp(x1, x2, v)  # roughly [-1, 1]

    def fbm(self, x: float, y: float, octaves: int = 4,
            lacunarity: float = 2.0, gain: float = 0.5) -> float:
        amp = 1.0
        freq = 1.0
        total = 0.0
        norm = 0.0
        for _ in range(octaves):
            total += amp * self.noise2(x * freq, y * freq)
            norm += amp
            amp *= gain
            freq *= lacunarity
        return total / norm


def _idx(x: int, y: int, z: int) -> int:
    return x + CHUNK_X * (z + CHUNK_Z * y)


class WorldGenerator:
    def __init__(self, seed: int = 1337, village: bool = False):
        self.seed = seed
        self.village_enabled = village   # only worlds created with the flag get one
        self._plan = None                # lazy village plan (see _plan_village)
        self.perlin = Perlin(seed)
        # (cx, cz) -> immutable base-terrain bytes (no edits applied).
        self._chunk_cache: "collections.OrderedDict[tuple, bytes]" = collections.OrderedDict()

    def height_at(self, wx: int, wz: int) -> int:
        n = self.perlin.fbm(wx * TERRAIN_SCALE, wz * TERRAIN_SCALE, octaves=4)
        h = int(BASE_HEIGHT + n * AMPLITUDE)
        return max(1, min(WORLD_Y - 1, h))

    def surface_at(self, wx: int, wz: int) -> int:
        """Effective surface height including village levelling and rooftops —
        what a spawn point must clear, as opposed to raw terrain height."""
        plan = self._village_plan()
        if plan:
            pad = plan["pads"].get((wx, wz))
            if pad is not None:
                return max(pad, plan["col_top"].get((wx, wz), pad))
        return self.height_at(wx, wz)

    def village_info(self):
        """Centre/size of this world's village for the client (or None)."""
        plan = self._village_plan()
        if not plan:
            return None
        return {"x": plan["center"][0], "z": plan["center"][1],
                "radius": VILLAGE_RADIUS, "ground": plan["ground"]}

    def _hash(self, wx: int, wz: int, salt: int) -> int:
        h = (wx * 374761393 + wz * 668265263 + (self.seed + salt) * 40503) & 0xFFFFFFFF
        return (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF

    def _tree_at(self, wx: int, wz: int) -> bool:
        """Deterministic pseudo-random tree placement on a column."""
        return (self._hash(wx, wz, 0) % 100) < 2   # ~2% of eligible columns

    def _pumpkin_at(self, wx: int, wz: int) -> bool:
        return (self._hash(wx, wz, 99) % 1000) < 4  # ~0.4% of grass columns

    def generate_chunk(self, cx: int, cz: int) -> bytearray:
        """Base terrain for a chunk, as a fresh mutable bytearray the caller can
        overlay edits onto. Cached per (cx, cz) since generation is deterministic
        and CPU-heavy; the returned copy is always safe to mutate."""
        cached = self._chunk_cache.get((cx, cz))
        if cached is not None:
            self._chunk_cache.move_to_end((cx, cz))   # mark most-recently-used
            return bytearray(cached)
        blocks = self._build_chunk(cx, cz)
        self._chunk_cache[(cx, cz)] = bytes(blocks)    # store pristine, immutable
        if len(self._chunk_cache) > CHUNK_CACHE_MAX:
            self._chunk_cache.popitem(last=False)      # evict least-recently-used
        return blocks

    def _build_chunk(self, cx: int, cz: int) -> bytearray:
        blocks = bytearray(CHUNK_X * CHUNK_Z * WORLD_Y)  # zero == AIR
        base_x = cx * CHUNK_X
        base_z = cz * CHUNK_Z
        plan = self._village_plan()
        pads = plan["pads"] if plan else {}

        # Surface height for every column we touch, including a 2-block margin so
        # trees straddling the border resolve identically from either chunk. Each
        # height is a 4-octave fbm, and the three passes below all need it, so we
        # compute it once here instead of ~3x per column. Village columns use the
        # levelled pad height instead of raw terrain.
        heights = {}
        for wz in range(base_z - 2, base_z + CHUNK_Z + 2):
            for wx in range(base_x - 2, base_x + CHUNK_X + 2):
                pad = pads.get((wx, wz))
                heights[(wx, wz)] = pad if pad is not None else self.height_at(wx, wz)

        # 1) Ground column + water fill.
        for lz in range(CHUNK_Z):
            for lx in range(CHUNK_X):
                wx = base_x + lx
                wz = base_z + lz
                height = heights[(wx, wz)]

                for y in range(height + 1):
                    if y == height:
                        if (wx, wz) in pads and height > WATER_LEVEL:
                            block = GRASS         # village green, even up high
                        elif height <= WATER_LEVEL:
                            block = SAND          # beaches / lakebed
                        elif height >= SNOW_LINE:
                            block = SNOW          # snowy peaks
                        else:
                            block = GRASS
                    elif y >= height - 3:
                        block = DIRT if height > WATER_LEVEL else SAND
                    else:
                        block = STONE
                    blocks[_idx(lx, y, lz)] = block

                # Fill water from the surface up to sea level.
                if height < WATER_LEVEL:
                    for y in range(height + 1, WATER_LEVEL + 1):
                        blocks[_idx(lx, y, lz)] = WATER

        # 2) Trees. Scan a 2-block margin so canopies that spill across the
        #    chunk border still get stamped into this chunk. The village keeps
        #    its clearing.
        for wz in range(base_z - 2, base_z + CHUNK_Z + 2):
            for wx in range(base_x - 2, base_x + CHUNK_X + 2):
                if (wx, wz) in pads or not self._tree_at(wx, wz):
                    continue
                height = heights[(wx, wz)]
                if height <= WATER_LEVEL:        # no trees in water
                    continue
                self._stamp_tree(blocks, base_x, base_z, wx, wz, height)

        # 3) The odd pumpkin sitting on grassy ground (fun to stumble on).
        for lz in range(CHUNK_Z):
            for lx in range(CHUNK_X):
                wx, wz = base_x + lx, base_z + lz
                if (wx, wz) in pads:
                    continue                     # the farm grows the village's
                height = heights[(wx, wz)]
                if not (WATER_LEVEL < height < SNOW_LINE):
                    continue
                if not self._pumpkin_at(wx, wz):
                    continue
                top = height + 1
                if top < WORLD_Y and blocks[_idx(lx, top, lz)] == AIR:
                    blocks[_idx(lx, top, lz)] = PUMPKIN

        # 4) Village structures that overlap this chunk.
        if plan:
            bb = plan["bbox"]
            if not (bb[2] < base_x or bb[0] >= base_x + CHUNK_X or
                    bb[3] < base_z or bb[1] >= base_z + CHUNK_Z):
                for (wx, wy, wz), b in plan["blocks"].items():
                    if (base_x <= wx < base_x + CHUNK_X and
                            base_z <= wz < base_z + CHUNK_Z and 0 <= wy < WORLD_Y):
                        blocks[_idx(wx - base_x, wy, wz - base_z)] = b

        return blocks

    def _stamp_tree(self, blocks, base_x, base_z, wx, wz, ground):
        trunk_h = 4 + ((wx * 31 + wz * 17) & 1)  # 4 or 5 tall

        def put(x, y, z, block, overwrite=True):
            lx = x - base_x
            lz = z - base_z
            if 0 <= lx < CHUNK_X and 0 <= lz < CHUNK_Z and 0 <= y < WORLD_Y:
                i = _idx(lx, y, lz)
                if overwrite or blocks[i] == AIR:
                    blocks[i] = block

        top = ground + trunk_h
        # Leaf canopy: a chunky blob around the top of the trunk.
        for dy in range(-2, 2):
            r = 2 if dy < 0 else 1
            for dz in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if abs(dx) == r and abs(dz) == r and r == 2:
                        continue  # round the corners a bit
                    put(wx + dx, top + dy, wz + dz, LEAVES, overwrite=False)
        # Trunk last so it shows through the leaves.
        for i in range(trunk_h + 1):
            put(wx, ground + i, wz, WOOD)

    # --- Village -----------------------------------------------------------------
    # Every new world gets one village near spawn: a levelled disc of ground with
    # a well and cobble plaza at the centre, a ring of buildings of varying
    # complexity facing it (two-storey hall, gabled houses, simple huts, a pumpkin
    # farm), cobble paths from each door, and glowstone lamp posts. The plan is
    # computed once, purely from the seed, and stamped into whichever chunks it
    # overlaps — so it assembles identically no matter which chunk loads first.

    def _village_plan(self):
        if not self.village_enabled:
            return None
        if self._plan is None:
            self._plan = self._build_village_plan()
        return self._plan

    def _find_village_site(self):
        """First acceptably flat, dry, snow-free disc near the origin; failing
        that, the flattest valid candidate. Deterministic per seed."""
        samples = [(0, 0)] + [(int(math.cos(a) * r), int(math.sin(a) * r))
                              for r in (8, 15) for a in
                              (i * math.pi / 3 for i in range(6))]
        best = None
        cands = [(int(math.cos(a) * r), int(math.sin(a) * r))
                 for r in range(16, 97, 8) for a in
                 (i * math.pi / 4 for i in range(8))]
        for sx, sz in cands:
            hs = [self.height_at(sx + dx, sz + dz) for dx, dz in samples]
            if min(hs) <= WATER_LEVEL + 1 or max(hs) >= SNOW_LINE:
                continue
            spread = max(hs) - min(hs)
            ground = sorted(hs)[len(hs) // 2]
            if spread <= 3:
                return sx, sz, ground
            if best is None or spread < best[3]:
                best = (sx, sz, ground, spread)
        if best and best[3] <= 8:
            return best[:3]
        return None                          # ocean/mountain seed: no village

    def _build_village_plan(self):
        site = self._find_village_site()
        if site is None:
            return None
        cx, cz, g = site
        rng = random.Random((self.seed * 2654435761 + 97531) & 0xFFFFFFFF)

        # Level the ground: flat at `g` across the core, feathered back into the
        # natural terrain across the rim so the village sits in a gentle bowl/rise.
        pads = {}
        for dz in range(-VILLAGE_RADIUS, VILLAGE_RADIUS + 1):
            for dx in range(-VILLAGE_RADIUS, VILLAGE_RADIUS + 1):
                dist = math.hypot(dx, dz)
                if dist > VILLAGE_RADIUS:
                    continue
                wx, wz = cx + dx, cz + dz
                if dist <= VILLAGE_CORE:
                    pads[(wx, wz)] = g
                else:
                    t = (dist - VILLAGE_CORE) / (VILLAGE_RADIUS - VILLAGE_CORE)
                    pads[(wx, wz)] = round(g + (self.height_at(wx, wz) - g) * t)

        B = {}   # (wx, wy, wz) -> block

        # Plaza: a cobbled circle with the well in the middle.
        self._stamp_well(B, cx, cz, g)
        for dz in range(-3, 4):
            for dx in range(-3, 4):
                if math.hypot(dx, dz) <= 3.4 and not (abs(dx) <= 1 and abs(dz) <= 1):
                    B.setdefault((cx + dx, g, cz + dz), COBBLE)

        # Buildings on a ring around the plaza, doors facing inward, no overlaps.
        kinds = ["hall", "house", "house", "hut", "hut", "farm"]
        rng.shuffle(kinds)
        sizes = {"hall": (9, 7), "house": (7, 6), "hut": (5, 5), "farm": (7, 5)}
        stamps = {"hall": self._stamp_hall, "house": self._stamp_house,
                  "hut": self._stamp_hut, "farm": self._stamp_farm}
        placed = []
        for i, kind in enumerate(kinds):
            ang = math.radians(i * 60 + rng.uniform(-14, 14))
            w, d = sizes[kind]
            for dist in (10, 12, 14):
                bx = cx + int(round(math.cos(ang) * dist))
                bz = cz + int(round(math.sin(ang) * dist))
                x0, z0 = bx - w // 2, bz - d // 2
                rect = (x0 - 2, z0 - 2, x0 + w + 1, z0 + d + 1)
                if any(not (rect[2] < p[0] or rect[0] > p[2] or
                            rect[3] < p[1] or rect[1] > p[3]) for p in placed):
                    continue                          # bumped a neighbour: move out
                placed.append(rect)
                face = self._face_toward(bx, bz, cx, cz)
                door = stamps[kind](B, x0, z0, g, face, rng)
                if door:
                    self._stamp_path(B, door[0], door[1], cx, cz, g)
                break

        # Lamp posts between the paths so the plaza glows at night.
        for a in (45, 135, 225, 315):
            lx = cx + int(round(math.cos(math.radians(a)) * 7))
            lz = cz + int(round(math.sin(math.radians(a)) * 7))
            if (lx, g + 1, lz) not in B:
                for y in range(g + 1, g + 4):
                    B[(lx, y, lz)] = WOOD
                B[(lx, g + 4, lz)] = GLOWSTONE

        # Tallest stamped block per column (spawn safety: never drop a player
        # inside a roof).
        col_top = {}
        for (wx, wy, wz), b in B.items():
            if b != AIR:
                col_top[(wx, wz)] = max(col_top.get((wx, wz), 0), wy)

        xs = [k[0] for k in pads]
        zs = [k[1] for k in pads]
        return {"center": (cx, cz), "ground": g, "pads": pads, "blocks": B,
                "col_top": col_top,
                "bbox": (min(xs), min(zs), max(xs), max(zs))}

    @staticmethod
    def _face_toward(bx, bz, cx, cz):
        """Which side of a building at (bx,bz) faces the plaza at (cx,cz)."""
        dx, dz = cx - bx, cz - bz
        if abs(dx) >= abs(dz):
            return "e" if dx > 0 else "w"
        return "s" if dz > 0 else "n"

    @staticmethod
    def _door_cell(x0, z0, w, d, face):
        if face == "w":
            return x0, z0 + d // 2
        if face == "e":
            return x0 + w - 1, z0 + d // 2
        if face == "n":
            return x0 + w // 2, z0
        return x0 + w // 2, z0 + d - 1

    @staticmethod
    def _outward(face):
        return {"w": (-1, 0), "e": (1, 0), "n": (0, -1), "s": (0, 1)}[face]

    def _stamp_path(self, B, px, pz, cx, cz, g):
        """Cobble path from a doorstep to the plaza: straight in x, then in z.
        setdefault so paths never carve through floors already stamped."""
        x, z = px, pz
        while x != cx:
            B.setdefault((x, g, z), COBBLE)
            x += 1 if cx > x else -1
        while z != cz:
            B.setdefault((x, g, z), COBBLE)
            z += 1 if cz > z else -1

    def _stamp_well(self, B, cx, cz, g):
        for dz in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dz == 0:
                    B[(cx, g + 1, cz)] = WATER   # water up to the rim
                    B[(cx, g, cz)] = WATER       # ...and a block deep
                else:
                    B[(cx + dx, g + 1, cz + dz)] = COBBLE
        for dx, dz in ((-1, -1), (1, -1), (-1, 1), (1, 1)):   # corner posts + roof
            B[(cx + dx, g + 2, cz + dz)] = WOOD
            B[(cx + dx, g + 3, cz + dz)] = WOOD
        for dz in (-1, 0, 1):
            for dx in (-1, 0, 1):
                B[(cx + dx, g + 4, cz + dz)] = PLANKS

    def _stamp_hut(self, B, x0, z0, g, face, rng):
        """Complexity 1: one room, plank walls, flat roof, a window, a lantern."""
        w = d = 5
        for z in range(z0, z0 + d):
            for x in range(x0, x0 + w):
                B[(x, g, z)] = PLANKS                       # floor
                B[(x, g + 3, z)] = PLANKS                   # flat roof
                edge = x in (x0, x0 + w - 1) or z in (z0, z0 + d - 1)
                corner = x in (x0, x0 + w - 1) and z in (z0, z0 + d - 1)
                if edge:
                    for y in (g + 1, g + 2):
                        B[(x, y, z)] = WOOD if corner else PLANKS
        dx, dz = self._door_cell(x0, z0, w, d, face)
        B[(dx, g + 1, dz)] = AIR
        B[(dx, g + 2, dz)] = AIR
        # One window on each side wall, and a jack-o'-lantern glowing inside.
        for side in "nsew":
            if side == face:
                continue
            wx, wz = self._door_cell(x0, z0, w, d, side)
            B[(wx, g + 2, wz)] = GLASS
        ox, oz = self._outward(face)
        B[(dx - ox * (w - 2), g + 1, dz - oz * (d - 2))] = PUMPKIN_LIT
        return dx + ox, dz + oz

    def _stamp_house(self, B, x0, z0, g, face, rng):
        """Complexity 2: cobble-trimmed plank house with glass windows, a gabled
        roof with eaves, a brick chimney, and glowstone under the ridge."""
        w, d = 7, 6
        for z in range(z0, z0 + d):
            for x in range(x0, x0 + w):
                edge = x in (x0, x0 + w - 1) or z in (z0, z0 + d - 1)
                corner = x in (x0, x0 + w - 1) and z in (z0, z0 + d - 1)
                B[(x, g, z)] = COBBLE if edge else PLANKS   # floor w/ stone sill
                if edge:
                    for y in range(g + 1, g + 4):
                        B[(x, y, z)] = WOOD if corner else PLANKS
        # Windows: two per long wall, one per gable wall.
        for x in (x0 + 2, x0 + w - 3):
            B[(x, g + 2, z0)] = GLASS
            B[(x, g + 2, z0 + d - 1)] = GLASS
        for z in (z0 + d // 2,):
            B[(x0, g + 2, z)] = GLASS
            B[(x0 + w - 1, g + 2, z)] = GLASS
        dx, dz = self._door_cell(x0, z0, w, d, face)
        B[(dx, g + 1, dz)] = AIR
        B[(dx, g + 2, dz)] = AIR
        # Gabled roof, ridge along x, one block of eaves all round.
        for s in range((d + 2) // 2 + 1):
            y = g + 4 + s
            zlo, zhi = z0 - 1 + s, z0 + d - s
            if zlo > zhi:
                break
            for x in range(x0 - 1, x0 + w + 1):
                B[(x, y, zlo)] = PLANKS
                if zhi != zlo:
                    B[(x, y, zhi)] = PLANKS
            for z in range(zlo + 1, zhi):                   # close the gable ends
                B[(x0, y, z)] = PLANKS
                B[(x0 + w - 1, y, z)] = PLANKS
        B[(x0 + 1, g + 4, z0 + 1)] = BRICK                  # chimney
        B[(x0 + 1, g + 5, z0 + 1)] = BRICK
        B[(x0 + 1, g + 6, z0 + 1)] = BRICK
        B[(x0 + w // 2, g + 4, z0 + d // 2)] = GLOWSTONE    # ceiling light
        return dx + self._outward(face)[0], dz + self._outward(face)[1]

    def _stamp_hall(self, B, x0, z0, g, face, rng):
        """Complexity 3: the big two-storey meeting hall — cobble base, brick
        upper floor, wool banners by the double door, lots of windows."""
        w, d = 9, 7
        for z in range(z0, z0 + d):
            for x in range(x0, x0 + w):
                edge = x in (x0, x0 + w - 1) or z in (z0, z0 + d - 1)
                corner = x in (x0, x0 + w - 1) and z in (z0, z0 + d - 1)
                B[(x, g, z)] = COBBLE                       # stone floor
                B[(x, g + 5, z)] = PLANKS                   # roof deck
                if edge:
                    for y in range(g + 1, g + 5):
                        if corner:
                            B[(x, y, z)] = WOOD
                        else:
                            B[(x, y, z)] = COBBLE if y <= g + 2 else BRICK
        # Window pairs on every wall, both storeys.
        for x in (x0 + 2, x0 + w - 3):
            for y in (g + 2, g + 4):
                B[(x, y, z0)] = GLASS
                B[(x, y, z0 + d - 1)] = GLASS
        for z in (z0 + 2, z0 + d - 3):
            for y in (g + 2, g + 4):
                B[(x0, y, z)] = GLASS
                B[(x0 + w - 1, y, z)] = GLASS
        # Grand door: two wide, two tall, wool banners either side.
        dx, dz = self._door_cell(x0, z0, w, d, face)
        ox, oz = self._outward(face)
        sx, sz = (0, 1) if ox else (1, 0)                   # sideways along the wall
        for o in (0, 1):
            B[(dx + sx * o, g + 1, dz + sz * o)] = AIR
            B[(dx + sx * o, g + 2, dz + sz * o)] = AIR
        for o, wool in ((-1, WOOL_RED), (2, WOOL_BLUE)):
            B[(dx + sx * o, g + 2, dz + sz * o)] = wool
            B[(dx + sx * o, g + 3, dz + sz * o)] = wool
        B[(x0 + w // 2 - 1, g + 4, z0 + d // 2)] = GLOWSTONE
        B[(x0 + w // 2 + 1, g + 4, z0 + d // 2)] = GLOWSTONE
        return dx + ox, dz + oz

    def _stamp_farm(self, B, x0, z0, g, face, rng):
        """Complexity 1.5: fenced pumpkin patch with an irrigation channel."""
        w, d = 7, 5
        for z in range(z0, z0 + d):
            for x in range(x0, x0 + w):
                edge = x in (x0, x0 + w - 1) or z in (z0, z0 + d - 1)
                if edge:
                    B[(x, g + 1, z)] = WOOD                 # low fence
                elif z == z0 + d // 2:
                    B[(x, g, z)] = WATER                    # channel, dug in
                else:
                    B[(x, g, z)] = DIRT                     # tilled rows
                    if rng.random() < 0.45:
                        B[(x, g + 1, z)] = PUMPKIN
        dx, dz = self._door_cell(x0, z0, w, d, face)
        B[(dx, g + 1, dz)] = AIR                            # gate gap
        ox, oz = self._outward(face)
        return dx + ox, dz + oz
