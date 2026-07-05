// A single chunk: holds its block array and turns it into renderable geometry.
//
// Meshing is classic face-culling: for every block we emit a quad only on the
// sides that face a transparent neighbour. Neighbour lookups go through
// world.getBlock so faces are correctly culled across chunk borders.

import * as THREE from 'three';
import { DIM, idx } from './constants.js';
import {
  BLOCKS, AIR, WATER, isTransparent, isGlow, tileUV,
  isDoor, DOOR_X_CLOSED, DOOR_Z_CLOSED, DOOR_X_OPEN, DOOR_Z_OPEN,
} from '../blocks.js';

// Per-face geometry: outward normal, which block tile to use, and the 4 corner
// offsets each tagged with its (uLocal, vLocal) so textures sit upright.
const FACES = [
  { n: [1, 0, 0],  tile: 'side',   corners: [[1,0,1,0,0],[1,0,0,1,0],[1,1,0,1,1],[1,1,1,0,1]] },
  { n: [-1, 0, 0], tile: 'side',   corners: [[0,0,0,0,0],[0,0,1,1,0],[0,1,1,1,1],[0,1,0,0,1]] },
  { n: [0, 1, 0],  tile: 'top',    corners: [[0,1,1,0,0],[1,1,1,1,0],[1,1,0,1,1],[0,1,0,0,1]] },
  { n: [0, -1, 0], tile: 'bottom', corners: [[0,0,0,0,0],[1,0,0,1,0],[1,0,1,1,1],[0,0,1,0,1]] },
  { n: [0, 0, 1],  tile: 'side',   corners: [[0,0,1,0,0],[1,0,1,1,0],[1,1,1,1,1],[0,1,1,0,1]] },
  { n: [0, 0, -1], tile: 'side',   corners: [[1,0,0,0,0],[0,0,0,1,0],[0,1,0,1,1],[1,1,0,0,1]] },
];

// Texture extent (u, v) of each FACES entry for a box of size (dx, dy, dz) —
// so a thin door edge shows a thin strip of the tile, not the whole picture.
const FACE_EXT = [
  (d) => [d[2], d[1]], (d) => [d[2], d[1]],   // ±x faces: u spans z, v spans y
  (d) => [d[0], d[2]], (d) => [d[0], d[2]],   // ±y: u spans x, v spans z
  (d) => [d[0], d[1]], (d) => [d[0], d[1]],   // ±z: u spans x, v spans y
];

// Door panels are thin sub-cell boxes: closed panels sit centred across the
// cell; open panels swing against the cell edge, leaving the doorway clear.
// [minX, minY, minZ, maxX, maxY, maxZ], cell-relative.
const DOOR_PANEL = {
  [DOOR_X_CLOSED]: [0, 0, 0.44, 1, 1, 0.56],
  [DOOR_Z_CLOSED]: [0.44, 0, 0, 0.56, 1, 1],
  [DOOR_X_OPEN]:   [0, 0, 0, 0.12, 1, 1],     // swung to the west jamb
  [DOOR_Z_OPEN]:   [0, 0, 0, 1, 1, 0.12],     // swung to the north jamb
};

export class Chunk {
  constructor(cx, cz, data) {
    this.cx = cx;
    this.cz = cz;
    this.data = data; // Uint8Array, length CX*CZ*WY
    this.opaqueMesh = null;
    this.waterMesh = null;
    this.dirty = true;
  }

  getLocal(x, y, z) {
    if (y < 0 || y >= DIM.WY) return AIR;
    return this.data[idx(x, y, z)];
  }

  setLocal(x, y, z, block) {
    this.data[idx(x, y, z)] = block;
    this.dirty = true;
  }

  // Rebuild both meshes and (re)attach them to the scene.
  build(world) {
    const baseX = this.cx * DIM.CX;
    const baseZ = this.cz * DIM.CZ;

    const opaque = { pos: [], norm: [], uv: [], idx: [] };
    const water = { pos: [], norm: [], uv: [], idx: [] };
    const glow = { pos: [], norm: [], uv: [], idx: [] };
    // Door panels: thin sub-cell boxes with fractional coordinates, so they
    // get their own buffer with float positions (the others quantize to
    // integers). Same atlas material as opaque — no extra shader.
    const door = { pos: [], norm: [], uv: [], idx: [] };

    // Vertices are quantized to shrink heap + VRAM (~10 bytes/vertex vs 32):
    //   position -> chunk-local Uint8 (the mesh is offset to the chunk origin)
    //   normal   -> signed byte, ±127 ≈ ±1 (GPU-normalized)
    //   uv       -> Uint16, 0..65535 mapped to 0..1 (GPU-normalized)
    const addFace = (buf, face, x, y, z, slot) => {
      const { u0, u1, v0, v1 } = tileUV(slot);
      const base = buf.pos.length / 3;
      for (const [dx, dy, dz, ul, vl] of face.corners) {
        buf.pos.push(x + dx, y + dy, z + dz);
        buf.norm.push(face.n[0] * 127, face.n[1] * 127, face.n[2] * 127);
        buf.uv.push(
          Math.round((u0 + ul * (u1 - u0)) * 65535),
          Math.round((v0 + vl * (v1 - v0)) * 65535));
      }
      buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    // Emit all six faces of a sub-cell box (no culling — doors are few and
    // visible from every side). UVs scale with each face's real extent.
    const addBox = (buf, min, max, slot) => {
      const { u0, u1, v0, v1 } = tileUV(slot);
      const d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      for (let f = 0; f < FACES.length; f++) {
        const face = FACES[f];
        const [ue, ve] = FACE_EXT[f](d);
        const base = buf.pos.length / 3;
        for (const [cx, cy, cz, ul, vl] of face.corners) {
          buf.pos.push(cx ? max[0] : min[0], cy ? max[1] : min[1], cz ? max[2] : min[2]);
          buf.norm.push(face.n[0] * 127, face.n[1] * 127, face.n[2] * 127);
          buf.uv.push(
            Math.round((u0 + ul * ue * (u1 - u0)) * 65535),
            Math.round((v0 + vl * ve * (v1 - v0)) * 65535));
        }
        buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    };

    for (let y = 0; y < DIM.WY; y++) {
      for (let z = 0; z < DIM.CZ; z++) {
        for (let x = 0; x < DIM.CX; x++) {
          const block = this.data[idx(x, y, z)];
          if (block === AIR) continue;
          const def = BLOCKS[block];
          if (!def) continue;
          if (isDoor(block)) {
            // A door pair shares one id; the cell above another door of the
            // same kind is the top half (window tile), otherwise the bottom.
            const topHalf = y > 0 && this.data[idx(x, y - 1, z)] === block;
            const p = DOOR_PANEL[block];
            addBox(door,
              [x + p[0], y + p[1], z + p[2]], [x + p[3], y + p[4], z + p[5]],
              topHalf ? def.top : def.bottom);
            continue;
          }
          const wx = baseX + x, wz = baseZ + z;
          const buf = block === WATER ? water : (isGlow(block) ? glow : opaque);

          for (const face of FACES) {
            const nx = x + face.n[0], ny = y + face.n[1], nz = z + face.n[2];
            // In-chunk neighbours read straight from our own block array; only
            // faces on the six chunk borders fall through to world.getBlock,
            // which floors the coords, builds a "cx,cz" key and hits a Map. Most
            // of a chunk's ~90k neighbour checks are interior, so this avoids the
            // bulk of that string + map churn on every rebuild.
            const nb = (nx >= 0 && nx < DIM.CX && nz >= 0 && nz < DIM.CZ && ny >= 0 && ny < DIM.WY)
              ? this.data[idx(nx, ny, nz)]
              : world.getBlock(wx + face.n[0], y + face.n[1], wz + face.n[2]);
            // Draw the face only against a transparent, different neighbour.
            if (!isTransparent(nb) || nb === block) continue;
            // Positions are chunk-local (x,y,z); the mesh carries the offset.
            addFace(buf, face, x, y, z, def[face.tile]);
          }
        }
      }
    }

    this._swapMesh(world, 'opaqueMesh', opaque, world.materials.opaque);
    this._swapMesh(world, 'waterMesh', water, world.materials.water);
    this._swapMesh(world, 'glowMesh', glow, world.materials.glow);
    this._swapMesh(world, 'doorMesh', door, world.materials.opaque, true);
    this.dirty = false;
  }

  _swapMesh(world, key, buf, material, floatPos = false) {
    if (this[key]) {
      world.scene.remove(this[key]);
      this[key].geometry.dispose();
      this[key] = null;
    }
    if (buf.idx.length === 0) return;
    const geo = new THREE.BufferGeometry();
    // Quantized attributes (see addFace). Position stays Uint8, which assumes
    // chunk dims and WORLD_Y are <= 255 (currently 16 / 16 / 64); bump to
    // Uint16 here if a much taller world is ever configured. Door panels use
    // fractional coordinates, so their buffer keeps float positions.
    geo.setAttribute('position', floatPos
      ? new THREE.Float32BufferAttribute(buf.pos, 3)
      : new THREE.Uint8BufferAttribute(buf.pos, 3));
    geo.setAttribute('normal', new THREE.Int8BufferAttribute(buf.norm, 3, true));
    geo.setAttribute('uv', new THREE.Uint16BufferAttribute(buf.uv, 2, true));
    geo.setIndex(buf.idx);
    const mesh = new THREE.Mesh(geo, material);
    // Local positions are relative to this chunk's origin.
    mesh.position.set(this.cx * DIM.CX, 0, this.cz * DIM.CZ);
    // Chunk meshes never move — freeze the matrix so three.js doesn't
    // recompose and re-multiply it for every chunk on every frame.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    this[key] = mesh;
    world.scene.add(mesh);
  }

  dispose(world) {
    for (const key of ['opaqueMesh', 'waterMesh', 'glowMesh', 'doorMesh']) {
      if (this[key]) {
        world.scene.remove(this[key]);
        this[key].geometry.dispose();
        this[key] = null;
      }
    }
  }
}
