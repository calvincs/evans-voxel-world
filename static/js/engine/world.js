// The world: owns all loaded chunks, streams them from the server around the
// player, and is the single source of truth for "what block is at (x,y,z)".

import * as THREE from 'three';
import { DIM, RENDER_DISTANCE } from './constants.js';
import { Chunk } from './chunk.js';
import { AIR, STONE, TNT, GLOWSTONE } from '../blocks.js';
import * as audio from '../audio.js';

const key = (cx, cz) => `${cx},${cz}`;
const floorDiv = (a, b) => Math.floor(a / b);

const FUSE = 1.0;          // seconds a TNT ticks before it blows
const BLAST_RADIUS = 3.4;  // block radius destroyed

// Glowstone lighting.
const GLOW_LIGHTS = 8;     // pool of point lights shared by nearest glowstones
const GLOW_RANGE = 18;     // only glowstones within this (horizontal) cast light
const GLOW_LIGHT_DIST = 14;// point-light reach
const GLOW_LIGHT_POWER = 9;// peak point-light intensity at night
const GLOW_COLOR = 0xffca6a;

export class World {
  constructor(scene, atlas, worldId) {
    this.scene = scene;
    this.worldId = worldId;
    this.base = `/api/worlds/${worldId}`;   // all requests are world-scoped
    this.chunks = new Map();
    this.pending = new Set();
    this.net = null;          // set in multiplayer; edits go over the socket

    // TNT state.
    this.fuses = [];          // [{x,y,z,key,t,mesh}]
    this.fuseKeys = new Set();
    this.particles = [];      // [{points,vel,life,maxLife}]
    this.onExplosion = null;  // optional callback(x,y,z) e.g. for camera shake
    this._primeGeo = new THREE.BoxGeometry(1.06, 1.06, 1.06);
    this._primeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });

    this.materials = {
      opaque: new THREE.MeshLambertMaterial({
        map: atlas,
        alphaTest: 0.5,          // cuts the holes in leaves / glass
      }),
      water: new THREE.MeshLambertMaterial({
        map: atlas,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      // Glowstone: same texture, but self-illuminated so it shines in the dark.
      // emissiveIntensity is driven each frame (night + flame flicker).
      glow: new THREE.MeshLambertMaterial({
        map: atlas,
        emissive: 0xffffff,
        emissiveMap: atlas,
        emissiveIntensity: 0.6,
      }),
    };

    // Glowstone light sources. We track every glowstone position and let a
    // small pool of point lights follow the nearest ones to the player, so the
    // light count stays bounded no matter how many are placed.
    this.glowKeys = new Set();   // "x,y,z" of every loaded glowstone
    this._glowT = 0;
    this._px = 0; this._pz = 0;
    this.glowLights = [];
    for (let i = 0; i < GLOW_LIGHTS; i++) {
      const L = new THREE.PointLight(GLOW_COLOR, 0, GLOW_LIGHT_DIST, 1.7);
      L.visible = false;
      this.scene.add(L);
      this.glowLights.push(L);
    }
  }

  getChunk(cx, cz) { return this.chunks.get(key(cx, cz)); }

  // Absolute-coordinate block read. Out-of-world bottom reads as solid so the
  // world floor doesn't render a face; above the world is open air.
  getBlock(wx, wy, wz) {
    if (wy < 0) return STONE;
    if (wy >= DIM.WY) return AIR;
    const cx = floorDiv(wx, DIM.CX), cz = floorDiv(wz, DIM.CZ);
    const chunk = this.chunks.get(key(cx, cz));
    if (!chunk) return AIR;
    return chunk.getLocal(wx - cx * DIM.CX, wy, wz - cz * DIM.CZ);
  }

  // Place/break a block. Marks the owning chunk (and any border neighbours)
  // dirty, and by default persists the edit to the server.
  setBlock(wx, wy, wz, block, persist = true) {
    if (wy < 0 || wy >= DIM.WY) return;
    const cx = floorDiv(wx, DIM.CX), cz = floorDiv(wz, DIM.CZ);
    const chunk = this.chunks.get(key(cx, cz));
    if (!chunk) return;
    const lx = wx - cx * DIM.CX, lz = wz - cz * DIM.CZ;
    const prev = chunk.getLocal(lx, wy, lz);
    chunk.setLocal(lx, wy, lz, block);

    // Keep the glowstone light index in sync.
    const gk = `${wx},${wy},${wz}`;
    if (block === GLOWSTONE) this.glowKeys.add(gk);
    else if (prev === GLOWSTONE) this.glowKeys.delete(gk);

    this._markDirty(cx, cz);
    if (lx === 0) this._markDirty(cx - 1, cz);
    if (lx === DIM.CX - 1) this._markDirty(cx + 1, cz);
    if (lz === 0) this._markDirty(cx, cz - 1);
    if (lz === DIM.CZ - 1) this._markDirty(cx, cz + 1);

    if (persist) {
      // In multiplayer the server persists + relays via the socket; otherwise
      // POST the edit ourselves.
      if (this.net && this.net.connected) {
        this.net.sendEdit(wx, wy, wz, block);
      } else {
        fetch(`${this.base}/edit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: wx, y: wy, z: wz, block }),
        }).catch(() => {/* offline is fine; world still works locally */});
      }
    }
  }

  _markDirty(cx, cz) {
    const c = this.chunks.get(key(cx, cz));
    if (c) c.dirty = true;
  }

  async _loadChunk(cx, cz) {
    const k = key(cx, cz);
    if (this.chunks.has(k) || this.pending.has(k)) return;
    this.pending.add(k);
    try {
      const res = await fetch(`${this.base}/chunk/${cx}/${cz}`);
      const json = await res.json();
      const bin = atob(json.data);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      this.chunks.set(k, new Chunk(cx, cz, data));
      this._scanGlow(cx, cz, data, true);   // index any glowstones in this chunk
      // Neighbours can now cull their shared border faces.
      this._markDirty(cx - 1, cz); this._markDirty(cx + 1, cz);
      this._markDirty(cx, cz - 1); this._markDirty(cx, cz + 1);
    } catch (e) {
      console.warn('chunk load failed', cx, cz, e);
    } finally {
      this.pending.delete(k);
    }
  }

  // Called every frame: stream chunks in around the player, evict far ones,
  // and rebuild a few dirty meshes. Budgets keep frame times smooth.
  update(px, pz, dt = 0, daylight = 1) {
    this._px = px; this._pz = pz;
    this._updateEffects(dt);
    this._updateGlow(daylight, dt);
    const ccx = floorDiv(px, DIM.CX), ccz = floorDiv(pz, DIM.CZ);

    // Request nearest-first.
    const wanted = [];
    for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++)
      for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > RENDER_DISTANCE * RENDER_DISTANCE) continue;
        wanted.push({ cx: ccx + dx, cz: ccz + dz, d2 });
      }
    wanted.sort((a, b) => a.d2 - b.d2);

    let loadBudget = 3;
    for (const w of wanted) {
      if (loadBudget <= 0) break;
      const k = key(w.cx, w.cz);
      if (!this.chunks.has(k) && !this.pending.has(k)) {
        this._loadChunk(w.cx, w.cz);
        loadBudget--;
      }
    }

    // Evict chunks outside the keep radius.
    const keep = RENDER_DISTANCE + 1;
    for (const [k, chunk] of this.chunks) {
      if (Math.abs(chunk.cx - ccx) > keep || Math.abs(chunk.cz - ccz) > keep) {
        this._scanGlow(chunk.cx, chunk.cz, chunk.data, false);  // un-index glowstones
        chunk.dispose(this);
        this.chunks.delete(k);
      }
    }

    // Rebuild dirty meshes, nearest first, a few per frame.
    let buildBudget = 4;
    const dirty = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) {
        const dx = chunk.cx - ccx, dz = chunk.cz - ccz;
        dirty.push({ chunk, d2: dx * dx + dz * dz });
      }
    }
    dirty.sort((a, b) => a.d2 - b.d2);
    for (const { chunk } of dirty) {
      if (buildBudget <= 0) break;
      chunk.build(this);
      buildBudget--;
    }
  }

  // Drop every loaded chunk so the world re-streams from scratch (used after
  // resetting to a fresh world, without a full page reload).
  clearAll() {
    for (const chunk of this.chunks.values()) chunk.dispose(this);
    this.chunks.clear();
    this.pending.clear();
    for (const f of this.fuses) this.scene.remove(f.mesh);
    for (const p of this.particles) { this.scene.remove(p.points); p.points.geometry.dispose(); }
    this.fuses = []; this.fuseKeys.clear(); this.particles = [];
    this.glowKeys.clear();
    for (const L of this.glowLights) { L.visible = false; L.intensity = 0; }
  }

  // --- Glowstone lighting ---------------------------------------------------
  // Add/remove every glowstone in a chunk's data to/from the light index.
  _scanGlow(cx, cz, data, add) {
    const { CX, CZ } = DIM;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== GLOWSTONE) continue;
      const x = i % CX;
      const z = Math.floor(i / CX) % CZ;
      const y = Math.floor(i / (CX * CZ));
      const k = `${cx * CX + x},${y},${cz * CZ + z}`;
      if (add) this.glowKeys.add(k); else this.glowKeys.delete(k);
    }
  }

  _updateGlow(daylight, dt) {
    this._glowT += dt;
    const t = this._glowT;
    // Smooth flame-like flicker (~0.8 .. 1.05), several incommensurate sines.
    const flick = 0.92
      + 0.06 * Math.sin(t * 11.0)
      + 0.045 * Math.sin(t * 17.3 + 1.3)
      + 0.03 * Math.sin(t * 6.7 + 0.6);
    const night = Math.min(1, Math.max(0, 1 - daylight * 1.1));   // 0 day .. 1 night

    // The block's own glow: faint by day, blazing + flickering at night.
    this.materials.glow.emissiveIntensity = 0.3 + night * 0.95 * flick;

    const lights = this.glowLights;
    if (night < 0.03 || this.glowKeys.size === 0) {
      for (const L of lights) { L.visible = false; L.intensity = 0; }
      return;
    }
    // Hand the light pool to the nearest glowstones (horizontal distance).
    const px = this._px, pz = this._pz;
    const near = [];
    for (const kk of this.glowKeys) {
      const c = kk.split(',');
      const gx = +c[0], gy = +c[1], gz = +c[2];
      const dx = gx + 0.5 - px, dz = gz + 0.5 - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 <= GLOW_RANGE * GLOW_RANGE) near.push({ gx, gy, gz, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < lights.length; i++) {
      const L = lights[i];
      if (i < near.length) {
        const g = near[i];
        L.position.set(g.gx + 0.5, g.gy + 0.5, g.gz + 0.5);
        const ph = (g.gx * 7 + g.gy * 13 + g.gz * 5) % 7;          // per-light phase
        const lf = 0.82 + 0.16 * Math.sin(t * 9 + ph) + 0.08 * Math.sin(t * 15 + ph * 1.7);
        L.intensity = night * lf * GLOW_LIGHT_POWER;
        L.visible = true;
      } else {
        L.visible = false; L.intensity = 0;
      }
    }
  }

  // --- TNT ------------------------------------------------------------------
  // Light a TNT block: it flashes for a moment, then explodes.
  igniteTNT(x, y, z, fuse = FUSE) {
    const k = `${x},${y},${z}`;
    if (this.fuseKeys.has(k)) return;          // already primed
    if (this.getBlock(x, y, z) !== TNT) return;
    this.fuseKeys.add(k);
    const mesh = new THREE.Mesh(this._primeGeo, this._primeMat);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.scene.add(mesh);
    this.fuses.push({ x, y, z, key: k, t: fuse, mesh });
    audio.playIgnite();
  }

  _explode(x, y, z) {
    audio.playExplosion();
    if (this.onExplosion) this.onExplosion(x, y, z);
    this._spawnParticles(x, y, z);

    const R = Math.ceil(BLAST_RADIUS), R2 = BLAST_RADIUS * BLAST_RADIUS;
    const removed = [];
    for (let dx = -R; dx <= R; dx++)
      for (let dy = -R; dy <= R; dy++)
        for (let dz = -R; dz <= R; dz++) {
          if (dx * dx + dy * dy + dz * dz > R2) continue;
          const bx = x + dx, by = y + dy, bz = z + dz;
          if (by < 0) continue;
          const b = this.getBlock(bx, by, bz);
          if (b === AIR) continue;
          if (b === TNT && !(dx === 0 && dy === 0 && dz === 0)) {
            this.igniteTNT(bx, by, bz, 0.1 + Math.random() * 0.15);  // chain reaction
            continue;
          }
          this.setBlock(bx, by, bz, AIR, false);
          removed.push({ x: bx, y: by, z: bz, block: AIR });
        }

    // Persist the whole crater in one request (or relay it in multiplayer).
    if (removed.length) {
      if (this.net && this.net.connected) {
        this.net.sendEdits(removed);
      } else {
        fetch(`${this.base}/edits`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edits: removed }),
        }).catch(() => {});
      }
    }
  }

  _spawnParticles(x, y, z) {
    const N = 36;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = x + 0.5; pos[i * 3 + 1] = y + 0.5; pos[i * 3 + 2] = z + 0.5;
      const sp = 3 + Math.random() * 6;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      vel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      vel[i * 3 + 1] = Math.abs(Math.cos(ph)) * sp + 2;
      vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xff8b2a, size: 0.35, transparent: true, depthWrite: false, fog: false });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.particles.push({ points, vel, life: 0.8, maxLife: 0.8 });
  }

  _updateEffects(dt) {
    if (dt <= 0) return;
    // Fuses: blink, then detonate.
    for (let i = this.fuses.length - 1; i >= 0; i--) {
      const f = this.fuses[i];
      f.t -= dt;
      f.mesh.visible = Math.floor(f.t * 12) % 2 === 0;
      if (f.t <= 0) {
        this.scene.remove(f.mesh);
        this.fuseKeys.delete(f.key);
        this.fuses.splice(i, 1);
        this._explode(f.x, f.y, f.z);
      }
    }
    // Debris particles: ballistic, fading.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      const arr = p.points.geometry.attributes.position.array;
      const n = p.vel.length / 3;
      for (let j = 0; j < n; j++) {
        p.vel[j * 3 + 1] -= 22 * dt;
        arr[j * 3] += p.vel[j * 3] * dt;
        arr[j * 3 + 1] += p.vel[j * 3 + 1] * dt;
        arr[j * 3 + 2] += p.vel[j * 3 + 2] * dt;
      }
      p.points.geometry.attributes.position.needsUpdate = true;
      p.points.material.opacity = Math.max(0, p.life / p.maxLife);
      if (p.life <= 0) {
        this.scene.remove(p.points);
        p.points.geometry.dispose();
        this.particles.splice(i, 1);
      }
    }
  }

  // Are all chunks immediately around a point loaded? Used to hold the player
  // in place until the ground under spawn exists.
  ready(px, pz) {
    const ccx = floorDiv(px, DIM.CX), ccz = floorDiv(pz, DIM.CZ);
    return this.chunks.has(key(ccx, ccz));
  }
}
