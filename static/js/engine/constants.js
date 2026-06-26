// World dimensions, filled in from the server's /api/config at boot.
export const DIM = { CX: 16, CZ: 16, WY: 64, water: 22 };

export function setDims(cfg) {
  DIM.CX = cfg.chunkX;
  DIM.CZ = cfg.chunkZ;
  DIM.WY = cfg.worldY;
  DIM.water = cfg.waterLevel;
}

// Flat index inside a chunk's block array.
export const idx = (x, y, z) => x + DIM.CX * (z + DIM.CZ * y);

// How far (in chunks) we keep the world loaded around the player.
export const RENDER_DISTANCE = 5;
