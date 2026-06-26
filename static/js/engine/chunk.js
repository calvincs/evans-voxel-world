// A single chunk: holds its block array and turns it into renderable geometry.
//
// Meshing is classic face-culling: for every block we emit a quad only on the
// sides that face a transparent neighbour. Neighbour lookups go through
// world.getBlock so faces are correctly culled across chunk borders.

import * as THREE from 'three';
import { DIM, idx } from './constants.js';
import { BLOCKS, AIR, WATER, isTransparent, isGlow, tileUV } from '../blocks.js';

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

    const addFace = (buf, face, wx, y, wz, slot) => {
      const { u0, u1, v0, v1 } = tileUV(slot);
      const base = buf.pos.length / 3;
      for (const [dx, dy, dz, ul, vl] of face.corners) {
        buf.pos.push(wx + dx, y + dy, wz + dz);
        buf.norm.push(face.n[0], face.n[1], face.n[2]);
        buf.uv.push(u0 + ul * (u1 - u0), v0 + vl * (v1 - v0));
      }
      buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    for (let y = 0; y < DIM.WY; y++) {
      for (let z = 0; z < DIM.CZ; z++) {
        for (let x = 0; x < DIM.CX; x++) {
          const block = this.data[idx(x, y, z)];
          if (block === AIR) continue;
          const def = BLOCKS[block];
          if (!def) continue;
          const wx = baseX + x, wz = baseZ + z;
          const buf = block === WATER ? water : (isGlow(block) ? glow : opaque);

          for (const face of FACES) {
            const nb = world.getBlock(wx + face.n[0], y + face.n[1], wz + face.n[2]);
            // Draw the face only against a transparent, different neighbour.
            if (!isTransparent(nb) || nb === block) continue;
            addFace(buf, face, wx, y, wz, def[face.tile]);
          }
        }
      }
    }

    this._swapMesh(world, 'opaqueMesh', opaque, world.materials.opaque);
    this._swapMesh(world, 'waterMesh', water, world.materials.water);
    this._swapMesh(world, 'glowMesh', glow, world.materials.glow);
    this.dirty = false;
  }

  _swapMesh(world, key, buf, material) {
    if (this[key]) {
      world.scene.remove(this[key]);
      this[key].geometry.dispose();
      this[key] = null;
    }
    if (buf.idx.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.norm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    geo.setIndex(buf.idx);
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = true;
    this[key] = mesh;
    world.scene.add(mesh);
  }

  dispose(world) {
    for (const key of ['opaqueMesh', 'waterMesh', 'glowMesh']) {
      if (this[key]) {
        world.scene.remove(this[key]);
        this[key].geometry.dispose();
        this[key] = null;
      }
    }
  }
}
