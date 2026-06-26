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
SNOW = 12
PUMPKIN = 13

# --- Terrain shape knobs ------------------------------------------------------
WATER_LEVEL = 22
BASE_HEIGHT = 24
AMPLITUDE = 14
TERRAIN_SCALE = 0.012   # smaller -> larger, smoother hills
SNOW_LINE = 30          # peaks above this get snow caps


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
    def __init__(self, seed: int = 1337):
        self.seed = seed
        self.perlin = Perlin(seed)

    def height_at(self, wx: int, wz: int) -> int:
        n = self.perlin.fbm(wx * TERRAIN_SCALE, wz * TERRAIN_SCALE, octaves=4)
        h = int(BASE_HEIGHT + n * AMPLITUDE)
        return max(1, min(WORLD_Y - 1, h))

    def _hash(self, wx: int, wz: int, salt: int) -> int:
        h = (wx * 374761393 + wz * 668265263 + (self.seed + salt) * 40503) & 0xFFFFFFFF
        return (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF

    def _tree_at(self, wx: int, wz: int) -> bool:
        """Deterministic pseudo-random tree placement on a column."""
        return (self._hash(wx, wz, 0) % 100) < 2   # ~2% of eligible columns

    def _pumpkin_at(self, wx: int, wz: int) -> bool:
        return (self._hash(wx, wz, 99) % 1000) < 4  # ~0.4% of grass columns

    def generate_chunk(self, cx: int, cz: int) -> bytearray:
        blocks = bytearray(CHUNK_X * CHUNK_Z * WORLD_Y)  # zero == AIR
        base_x = cx * CHUNK_X
        base_z = cz * CHUNK_Z

        # 1) Ground column + water fill.
        for lz in range(CHUNK_Z):
            for lx in range(CHUNK_X):
                wx = base_x + lx
                wz = base_z + lz
                height = self.height_at(wx, wz)

                for y in range(height + 1):
                    if y == height:
                        if height <= WATER_LEVEL:
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
        #    chunk border still get stamped into this chunk.
        for wz in range(base_z - 2, base_z + CHUNK_Z + 2):
            for wx in range(base_x - 2, base_x + CHUNK_X + 2):
                if not self._tree_at(wx, wz):
                    continue
                height = self.height_at(wx, wz)
                if height <= WATER_LEVEL:        # no trees in water
                    continue
                self._stamp_tree(blocks, base_x, base_z, wx, wz, height)

        # 3) The odd pumpkin sitting on grassy ground (fun to stumble on).
        for lz in range(CHUNK_Z):
            for lx in range(CHUNK_X):
                wx, wz = base_x + lx, base_z + lz
                height = self.height_at(wx, wz)
                if not (WATER_LEVEL < height < SNOW_LINE):
                    continue
                if not self._pumpkin_at(wx, wz):
                    continue
                top = height + 1
                if top < WORLD_Y and blocks[_idx(lx, top, lz)] == AIR:
                    blocks[_idx(lx, top, lz)] = PUMPKIN

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
