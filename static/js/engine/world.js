// The world: owns all loaded chunks, streams them from the server around the
// player, and is the single source of truth for "what block is at (x,y,z)".

import * as THREE from 'three';
import { DIM, RENDER_DISTANCE } from './constants.js';
import { Chunk } from './chunk.js';
import {
  AIR, STONE, WATER, TNT, isGlow, isProx,
  isSolid, isDoor, isDoorOpen, doorToggle, doorForYaw, blockColor,
} from '../blocks.js';
import * as audio from '../audio.js';

const key = (cx, cz) => `${cx},${cz}`;
const floorDiv = (a, b) => Math.floor(a / b);

const FUSE = 4.0;          // seconds a TNT ticks before it blows (time to run!)
const BLAST_RADIUS = 3.4;  // block radius destroyed

// Water settling: poured water runs downhill and pools from the bottom up,
// conserving volume — see _waterDisturb / _startSettle.
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const POND_MAX = 1500;     // biggest body we re-level (larger bodies act stable)
const BASIN_MAX = 4000;    // body + reachable air scanned per settle
const SEA_SCAN = 400;      // budget for the "connected to the sea?" check

// Glowstone lighting. Every lit fragment pays for each active point light, so
// weak (touch) GPUs get a smaller pool — mirroring the DPR cap in renderer.js.
const GLOW_LIGHTS = (typeof matchMedia !== 'undefined'
  && matchMedia('(pointer: coarse)').matches) ? 4 : 8;
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
    this._retryAt = new Map();   // failed chunk fetches back off instead of hammering
    this._gen = 0;               // bumped by clearAll so stale fetches get discarded
    // Voxel reads are extremely local (collision, mob AI, camera probes hit the
    // same chunk dozens of times in a row), so remember the last chunk touched
    // and skip the key-string + Map lookup when the next read lands in it.
    this._lastChunk = null;
    // Active water flood-fills, drained a slice per frame — a breached dam
    // fills over a few frames instead of hitching one (see _updateFloods).
    this._floods = [];
    // Ponds waiting to find their level, and the one currently flowing.
    this._settles = [];
    this._settlePending = [];

    // Ring of chunk offsets inside the render distance, sorted nearest-first.
    // Computed once — the per-frame streaming scan reuses it.
    this._ring = [];
    for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++)
      for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 <= RENDER_DISTANCE * RENDER_DISTANCE) this._ring.push({ dx, dz, d2 });
      }
    this._ring.sort((a, b) => a.d2 - b.d2);
    this._scanT = 0;
    this._lastCcx = null; this._lastCcz = null;

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
    this._time = 0;
    this._setupWaterFlow();

    // Glowstone light sources. We track every glowstone position and let a
    // small pool of point lights follow the nearest ones to the player, so the
    // light count stays bounded no matter how many are placed. The pool is
    // toggled visible as one group at nightfall and hidden again by day —
    // three.js keys shader programs on the active light count, so daytime
    // (most of a session) renders with a shader that has NO point-light loop
    // at all. Both program variants are prewarmed behind the loading screen
    // (main.js prewarmShaders), so the toggle never hitches mid-play.
    this.glow = new Map();       // "x,y,z" -> [gx, gy, gz] for every loaded glowstone
    this._glowT = 0;
    this._glowAssignT = 1;       // force an assignment on the first night frame
    this._glowDirty = true;
    this._glowSlots = new Array(GLOW_LIGHTS).fill(null);
    this._px = 0; this._pz = 0;
    this._lightsOn = false;
    this.glowLights = [];
    for (let i = 0; i < GLOW_LIGHTS; i++) {
      const L = new THREE.PointLight(GLOW_COLOR, 0, GLOW_LIGHT_DIST, 1.7);
      L.visible = false;
      this.scene.add(L);
      this.glowLights.push(L);
    }
  }

  // Give the water a gentle rolling surface so it reads as a living fluid rather
  // than a flat pane. A wave is applied to the top faces in-shader (driven by a
  // uTime uniform), so it costs nothing per frame beyond the uniform and never
  // touches the chunk geometry. The surface also sits slightly recessed so water
  // looks a touch below the block brim. Phase is by world x/z, so it stays
  // seamless across blocks and chunks.
  _setupWaterFlow() {
    const mat = this.materials.water;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: this._time };
      mat.userData.shader = shader;
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3( position );
         if ( normal.y > 0.5 ) {
           vec3 wpos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
           transformed.y -= 0.12;
           transformed.y += 0.05 * sin( uTime * 1.6 + wpos.x * 0.7 + wpos.z * 0.7 )
                          + 0.03 * sin( uTime * 2.3 + wpos.x * 0.3 - wpos.z * 0.5 );
         }`);
    };
  }

  getChunk(cx, cz) { return this.chunks.get(key(cx, cz)); }

  // Absolute-coordinate block read. Out-of-world bottom reads as solid so the
  // world floor doesn't render a face; above the world is open air.
  getBlock(wx, wy, wz) {
    if (wy < 0) return STONE;
    if (wy >= DIM.WY) return AIR;
    const cx = floorDiv(wx, DIM.CX), cz = floorDiv(wz, DIM.CZ);
    let chunk = this._lastChunk;
    if (!chunk || chunk.cx !== cx || chunk.cz !== cz) {
      chunk = this.chunks.get(key(cx, cz));
      if (chunk) this._lastChunk = chunk;
    }
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

    // Keep the glowing-block light index in sync (glowstone, jack-o'-lanterns).
    const gk = `${wx},${wy},${wz}`;
    if (isGlow(block)) { this.glow.set(gk, [wx, wy, wz]); this._glowDirty = true; }
    else if (isGlow(prev)) { this.glow.delete(gk); this._glowDirty = true; }

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
    // Water dynamics — only the client that made the edit runs them; everyone
    // else just receives the resulting batch. Breaking next to water lets it
    // move (refill from the sea, or drain downhill); placing water sends it
    // flowing to the deepest reachable spot.
    if (persist) {
      if (block === AIR) this._waterDisturb(wx, wy, wz);
      else if (block === WATER) this._schedSettle(wx, wy, wz);
    }
  }

  // Persist a batch of already-applied local edits (relay in multiplayer,
  // POST when offline) — the same pattern floods and settles use.
  _persistEdits(edits) {
    if (!edits.length) return;
    if (this.net && this.net.connected) {
      this.net.sendEdits(edits);
    } else {
      fetch(`${this.base}/edits`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
      }).catch(() => {});
    }
  }

  // --- Doors -----------------------------------------------------------------
  // A door is a PAIR of cells sharing one block id; these helpers keep the
  // pair in lock-step. State changes are plain block swaps, so they persist,
  // relay to friends, and rewind like any other edit.

  // The matching half of the door at (x,y,z): prefer below (we're the top).
  _doorPartnerY(x, y, z, b) {
    if (this.getBlock(x, y - 1, z) === b) return y - 1;
    if (this.getBlock(x, y + 1, z) === b) return y + 1;
    return null;
  }

  // Place a two-cell door standing on solid ground, facing the placer.
  placeDoor(x, y, z, yaw) {
    if (y < 1 || y + 1 >= DIM.WY) return false;
    if (this.getBlock(x, y, z) !== AIR || this.getBlock(x, y + 1, z) !== AIR) return false;
    if (!isSolid(this.getBlock(x, y - 1, z))) return false;   // needs a floor
    const id = doorForYaw(yaw);
    const edits = [{ x, y, z, block: id }, { x, y: y + 1, z, block: id }];
    for (const e of edits) this.setBlock(e.x, e.y, e.z, e.block, false);
    this._persistEdits(edits);
    return true;
  }

  // Swing a door open or shut (both halves together).
  toggleDoor(x, y, z) {
    const b = this.getBlock(x, y, z);
    if (!isDoor(b)) return false;
    const nb = doorToggle(b);
    const edits = [{ x, y, z, block: nb }];
    const py = this._doorPartnerY(x, y, z, b);
    if (py !== null) edits.push({ x, y: py, z, block: nb });
    for (const e of edits) this.setBlock(e.x, e.y, e.z, e.block, false);
    this._persistEdits(edits);
    audio.playDoor(isDoorOpen(nb), { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    return true;
  }

  // Break a door: both halves go, never leaving one floating.
  removeDoor(x, y, z) {
    const b = this.getBlock(x, y, z);
    if (!isDoor(b)) return false;
    const py = this._doorPartnerY(x, y, z, b);
    const cells = [[x, y, z]];
    if (py !== null) cells.push([x, py, z]);
    const edits = [];
    for (const [cx, cy, cz] of cells) {
      this.setBlock(cx, cy, cz, AIR, false);
      this.spawnBreakBurst(cx, cy, cz, blockColor(b));
      edits.push({ x: cx, y: cy, z: cz, block: AIR });
    }
    this._persistEdits(edits);
    return true;
  }

  // A cell next to water just opened up. Water connected to the world's water
  // table — the sea and lakes, whose surface sits at DIM.water — refills for
  // free (the ocean doesn't run dry). Anything else is finite: it settles,
  // conserving volume, like a real puddle.
  _waterDisturb(x, y, z) {
    let touches = false;
    for (const [dx, dy, dz] of N6) {
      if (this.getBlock(x + dx, y + dy, z + dz) === WATER) { touches = true; break; }
    }
    if (!touches) return;
    if (y <= DIM.water && this._connectsToSea(x, y, z)) {
      this._floodWater(x, y, z);
      return;
    }
    this._schedSettle(x, y, z);
  }

  // Breadth-first through the touching water, looking for a cell at sea-surface
  // height. Budgeted: a body too big to scan is treated as the water table too.
  _connectsToSea(x, y, z) {
    const seen = new Set();
    const q = [];
    const push = (nx, ny, nz) => {
      const k = `${nx},${ny},${nz}`;
      if (!seen.has(k) && this.getBlock(nx, ny, nz) === WATER) {
        seen.add(k);
        q.push([nx, ny, nz]);
      }
    };
    for (const [dx, dy, dz] of N6) push(x + dx, y + dy, z + dz);
    let qi = 0;
    while (qi < q.length) {
      const [cx, cy, cz] = q[qi++];
      if (cy === DIM.water) return true;
      if (seen.size > SEA_SCAN) return true;
      for (const [dx, dy, dz] of N6) push(cx + dx, cy + dy, cz + dz);
    }
    return false;
  }

  _schedSettle(x, y, z) {
    if (this._settlePending.length >= 32) return;   // a crater schedules plenty
    this._settlePending.push([x, y, z]);
  }

  // Still water fills a fresh gap that opens below sea level and touches water.
  // Not a flow simulation — it doesn't animate or level out; it just makes any
  // connected air region that "should" be underwater become water. The fill is
  // drained a slice per frame (_updateFloods) within loaded chunks (bounded),
  // then persisted + relayed in one batch. Triggered by a local break; other
  // clients just receive the batch.
  _floodWater(sx, sy, sz) {
    const WL = DIM.water;
    const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    if (sy > WL || this.getBlock(sx, sy, sz) !== AIR) return;
    // Only floods if the opened cell actually touches water.
    let touches = false;
    for (const [dx, dy, dz] of N)
      if (this.getBlock(sx + dx, sy + dy, sz + dz) === WATER) { touches = true; break; }
    if (!touches) return;
    const sk = `${sx},${sy},${sz}`;
    for (const f of this._floods)
      if (f.seen.has(sk)) return;                   // an active fill already covers it
    this._floods.push({
      seen: new Set([sk]), queue: [[sx, sy, sz]], qi: 0, filled: [], cap: 4096 });
  }

  // Re-level one pond: gather its connected water, find every cell that water
  // could reach without climbing (down and sideways freely, upward only
  // through water it is already part of — never up a dry wall), and
  // redistribute the same number of blocks into the lowest of those cells.
  // Poured water therefore streams to the deepest part of a hole, basins fill
  // layer by layer, and a breached pond drains along the channel you dug —
  // with volume conserved exactly. The diff is animated by _updateSettles.
  _startSettle(sx, sy, sz) {
    const k3 = (x, y, z) => `${x},${y},${z}`;
    const loaded = (x, z) => this.chunks.has(key(floorDiv(x, DIM.CX), floorDiv(z, DIM.CZ)));

    // The connected water body around the disturbance.
    const body = [];
    const bodySet = new Set();
    const seed = (x, y, z) => {
      const k = k3(x, y, z);
      if (!bodySet.has(k) && loaded(x, z) && this.getBlock(x, y, z) === WATER) {
        bodySet.add(k);
        body.push([x, y, z]);
      }
    };
    seed(sx, sy, sz);
    for (const [dx, dy, dz] of N6) seed(sx + dx, sy + dy, sz + dz);
    for (let i = 0; i < body.length && body.length <= POND_MAX; i++) {
      const [x, y, z] = body[i];
      for (const [dx, dy, dz] of N6) seed(x + dx, y + dy, z + dz);
    }
    if (!body.length || body.length > POND_MAX) return;   // nothing, or acts stable

    // Everywhere the water can reach, breadth-first so ties fill nearest-first.
    const seen = new Set(bodySet);
    const cand = [];
    const q = body.slice();
    const push = (x, y, z) => {
      if (y < 0 || y >= DIM.WY || !loaded(x, z)) return;
      const k = k3(x, y, z);
      if (seen.has(k)) return;
      const b = this.getBlock(x, y, z);
      if (b !== AIR && b !== WATER) return;
      seen.add(k);
      q.push([x, y, z]);
    };
    let qi = 0;
    while (qi < q.length && cand.length < BASIN_MAX) {
      const c = q[qi++];
      cand.push(c);
      const [x, y, z] = c;
      push(x, y - 1, z);                        // water always flows down…
      push(x + 1, y, z); push(x - 1, y, z);     // …and sideways…
      push(x, y, z + 1); push(x, y, z - 1);
      // …but rises only through water (pressure), never up a dry wall.
      if (this.getBlock(x, y, z) === WATER && this.getBlock(x, y + 1, z) === WATER) {
        push(x, y + 1, z);
      }
    }

    // The new pond: the V lowest reachable cells (stable sort keeps the
    // breadth-first nearest-first order within each layer). Water that isn't
    // part of this body — a separate pocket further down the same hole — is
    // passable but OCCUPIED: skip those cells so a poured block comes to rest
    // on top of it instead of trying to move into it.
    const V = body.length;
    const order = cand.map((c, i) => [c, i]);
    order.sort((a, b) => (a[0][1] - b[0][1]) || (a[1] - b[1]));
    const target = new Set();
    const fills = [];
    let taken = 0;
    for (let i = 0; i < order.length && taken < V; i++) {
      const c = order[i][0];
      const k = k3(c[0], c[1], c[2]);
      const mine = bodySet.has(k);
      if (!mine && this.getBlock(c[0], c[1], c[2]) === WATER) continue;  // foreign water
      target.add(k);
      taken++;
      if (!mine) fills.push(c);
    }
    if (!fills.length) return;                  // already at rest
    const drains = body.filter((c) => !target.has(k3(c[0], c[1], c[2])));
    fills.sort((a, b) => a[1] - b[1]);          // pour in bottom-up…
    drains.sort((a, b) => b[1] - a[1]);         // …taking from the old surface first
    this._settles.push({ fills, drains, i: 0, edits: [] });
  }

  // Animate the re-level a few blocks per frame — one drain paired with one
  // fill, so volume is conserved at every visible moment — then persist and
  // relay the whole move as a single batch.
  _updateSettles() {
    if (!this._settles.length) {
      if (!this._settlePending.length || this._floods.length) return;
      const [x, y, z] = this._settlePending.shift();
      this._startSettle(x, y, z);
      if (!this._settles.length) return;
    }
    const s = this._settles[0];
    let budget = 16;
    while (budget-- > 0 && s.i < s.fills.length) {
      const d = s.drains[s.i], f = s.fills[s.i];
      s.i++;
      // The world may have changed since this was planned — verify each move.
      if (this.getBlock(d[0], d[1], d[2]) !== WATER
          || this.getBlock(f[0], f[1], f[2]) !== AIR) continue;
      this.setBlock(d[0], d[1], d[2], AIR, false);
      this.setBlock(f[0], f[1], f[2], WATER, false);
      s.edits.push({ x: d[0], y: d[1], z: d[2], block: AIR },
                   { x: f[0], y: f[1], z: f[2], block: WATER });
    }
    if (s.i < s.fills.length) return;
    this._settles.shift();
    if (!s.edits.length) return;
    if (this.net && this.net.connected) this.net.sendEdits(s.edits);
    else {
      fetch(`${this.base}/edits`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: s.edits }),
      }).catch(() => {});
    }
  }

  // Drain active flood-fills a slice per frame. Breaching a big dam used to
  // apply up to 4096 edits in one synchronous frame — one visible hitch; now
  // the water visibly rushes in over a few frames instead.
  _updateFloods() {
    if (!this._floods.length) return;
    const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const WL = DIM.water;
    let budget = 300;                                // cells per frame, total
    for (let fi = this._floods.length - 1; fi >= 0 && budget > 0; fi--) {
      const f = this._floods[fi];
      while (f.qi < f.queue.length && f.filled.length < f.cap && budget > 0) {
        budget--;
        const [x, y, z] = f.queue[f.qi++];
        if (this.getBlock(x, y, z) !== AIR) continue;   // changed since queued
        this.setBlock(x, y, z, WATER, false);           // local; batch-sent below
        f.filled.push({ x, y, z, block: WATER });
        for (const [dx, dy, dz] of N) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (ny > WL) continue;                        // never rise above sea level
          const k = `${nx},${ny},${nz}`;
          if (f.seen.has(k)) continue;
          // Stay inside loaded chunks so we never write into ungenerated terrain.
          if (!this.chunks.has(key(floorDiv(nx, DIM.CX), floorDiv(nz, DIM.CZ)))) continue;
          if (this.getBlock(nx, ny, nz) !== AIR) continue;
          f.seen.add(k);
          f.queue.push([nx, ny, nz]);
        }
      }
      if (f.qi >= f.queue.length || f.filled.length >= f.cap) {
        this._floods.splice(fi, 1);
        if (!f.filled.length) continue;
        if (this.net && this.net.connected) this.net.sendEdits(f.filled);
        else fetch(`${this.base}/edits`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edits: f.filled }),
        }).catch(() => {});
      }
    }
  }

  _markDirty(cx, cz) {
    const c = this.chunks.get(key(cx, cz));
    if (c) { c.dirty = true; c.mapDirty = true; }   // mesh + minimap tile
  }

  async _loadChunk(cx, cz) {
    const k = key(cx, cz);
    if (this.chunks.has(k) || this.pending.has(k)) return;
    if ((this._retryAt.get(k) || 0) > performance.now()) return;
    this.pending.add(k);
    const gen = this._gen;
    try {
      const res = await fetch(`${this.base}/chunk/${cx}/${cz}`);
      // fetch() resolves on HTTP errors too — without these checks an error
      // body would be installed as block data (invisible-but-solid terrain).
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());   // raw block bytes
      if (data.length !== DIM.CX * DIM.CZ * DIM.WY)
        throw new Error(`bad chunk payload (${data.length} bytes)`);
      if (gen !== this._gen) return;        // world was reset while this was in flight
      this._retryAt.delete(k);
      this.chunks.set(k, new Chunk(cx, cz, data));
      this._indexChunk(cx, cz, data, true);   // index glowstones + mine blocks
      // Neighbours can now cull their shared border faces.
      this._markDirty(cx - 1, cz); this._markDirty(cx + 1, cz);
      this._markDirty(cx, cz - 1); this._markDirty(cx, cz + 1);
    } catch (e) {
      this._retryAt.set(k, performance.now() + 3000);   // back off, don't hammer
      console.warn('chunk load failed', cx, cz, e);
    } finally {
      this.pending.delete(k);
    }
  }

  // After a reconnect: refetch every loaded chunk in place, so edits that were
  // missed while the socket was down get applied (no visual blank-out — the old
  // mesh stands until the fresh data swaps in and rebuilds).
  refreshAll() {
    for (const chunk of this.chunks.values()) this._refetchChunk(chunk);
  }

  async _refetchChunk(chunk) {
    const gen = this._gen;
    try {
      const res = await fetch(`${this.base}/chunk/${chunk.cx}/${chunk.cz}`);
      if (!res.ok) return;
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length !== chunk.data.length || gen !== this._gen) return;
      if (!this.chunks.has(key(chunk.cx, chunk.cz))) return;   // evicted meanwhile
      // Unchanged bytes = nothing was missed for this chunk — skip the
      // re-index and the remesh. Reconnects refetch EVERY loaded chunk, so
      // without this a Wi-Fi blip cost seconds of rebuilding identical meshes.
      let same = true;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== chunk.data[i]) { same = false; break; }
      }
      if (same) return;
      this._indexChunk(chunk.cx, chunk.cz, chunk.data, false);
      chunk.data = data;
      this._indexChunk(chunk.cx, chunk.cz, data, true);
      chunk.dirty = true;
      chunk.mapDirty = true;
    } catch (_) { /* still offline — the health monitor owns that state */ }
  }

  // Called every frame: stream chunks in around the player, evict far ones,
  // and rebuild a few dirty meshes. Budgets keep frame times smooth.
  update(px, pz, dt = 0, daylight = 1) {
    this._px = px; this._pz = pz;
    this._time += dt;
    const ws = this.materials.water.userData.shader;
    if (ws) ws.uniforms.uTime.value = this._time;
    this._updateEffects(dt);
    this._updateFloods();
    this._updateSettles();
    this._updateGlow(daylight, dt);
    const ccx = floorDiv(px, DIM.CX), ccz = floorDiv(pz, DIM.CZ);

    // Streaming scan: the ring is precomputed and nearest-first, so this is
    // just key lookups — and with everything loaded it's pure churn, so only
    // rescan when the player crosses a chunk border or every few frames.
    const crossed = ccx !== this._lastCcx || ccz !== this._lastCcz;
    this._scanT = crossed ? 0 : (this._scanT + 1) % 6;
    if (crossed || this._scanT === 0) {
      this._lastCcx = ccx; this._lastCcz = ccz;
      let loadBudget = 3;
      for (const w of this._ring) {
        if (loadBudget <= 0) break;
        const k = key(ccx + w.dx, ccz + w.dz);
        if (!this.chunks.has(k) && !this.pending.has(k)) {
          this._loadChunk(ccx + w.dx, ccz + w.dz);
          loadBudget--;
        }
      }
      // Evict chunks outside the keep radius.
      const keep = RENDER_DISTANCE + 1;
      for (const [k, chunk] of this.chunks) {
        if (Math.abs(chunk.cx - ccx) > keep || Math.abs(chunk.cz - ccz) > keep) {
          this._indexChunk(chunk.cx, chunk.cz, chunk.data, false);  // un-index specials
          chunk.dispose(this);
          this.chunks.delete(k);
          if (this._lastChunk === chunk) this._lastChunk = null;
        }
      }
    }

    // Rebuild dirty meshes, nearest first, on a *time* budget: a fixed count
    // stalls low-end machines when TNT/water dirties a dozen chunks at once.
    let anyDirty = false;
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) { anyDirty = true; break; }
    }
    if (anyDirty) {
      const dirty = [];
      for (const chunk of this.chunks.values()) {
        if (chunk.dirty) {
          const dx = chunk.cx - ccx, dz = chunk.cz - ccz;
          dirty.push({ chunk, d2: dx * dx + dz * dz });
        }
      }
      dirty.sort((a, b) => a.d2 - b.d2);
      const deadline = performance.now() + 6;   // ms of meshing per frame, max
      for (const { chunk } of dirty) {
        chunk.build(this);                       // always at least one
        if (performance.now() > deadline) break;
      }
    }
  }

  // Drop every loaded chunk so the world re-streams from scratch (used after
  // resetting to a fresh world, without a full page reload).
  clearAll() {
    this._gen++;                 // in-flight fetches from the old world are stale now
    for (const chunk of this.chunks.values()) chunk.dispose(this);
    this.chunks.clear();
    this._lastChunk = null;
    this.pending.clear();
    this._retryAt.clear();
    this._floods = [];
    this._settles = [];
    this._settlePending = [];
    for (const f of this.fuses) this.scene.remove(f.mesh);
    for (const p of this.particles) {
      this.scene.remove(p.points);
      p.points.geometry.dispose();
      p.points.material.dispose();
    }
    this.fuses = []; this.fuseKeys.clear(); this.particles = [];
    this.glow.clear();
    this._glowDirty = true;
    this._glowSlots.fill(null);
    this._lightsOn = false;
    for (const L of this.glowLights) { L.intensity = 0; L.visible = false; }
  }

  // --- Block index (glowstone lights) -----------------------------------------
  // Add/remove a chunk's glowing blocks to/from the light index.
  _indexChunk(cx, cz, data, add) {
    const { CX, CZ } = DIM;
    for (let i = 0; i < data.length; i++) {
      if (!isGlow(data[i])) continue;
      const x = i % CX;
      const z = Math.floor(i / CX) % CZ;
      const y = Math.floor(i / (CX * CZ));
      const wx = cx * CX + x, wz = cz * CZ + z;
      const k = `${wx},${y},${wz}`;
      if (add) this.glow.set(k, [wx, y, wz]); else this.glow.delete(k);
      this._glowDirty = true;
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

    // Flip the whole pool together (exactly two shader variants: 0 lights or
    // all of them), with a little hysteresis so dusk doesn't flap the toggle.
    const lights = this.glowLights;
    const wantOn = this.glow.size > 0
      && (this._lightsOn ? night >= 0.02 : night >= 0.05);
    if (wantOn !== this._lightsOn) {
      this._lightsOn = wantOn;
      for (const L of lights) L.visible = wantOn;
    }
    if (!wantOn) return;         // daytime: no light work, no fragment cost
    // Hand the light pool to the nearest glowstones (horizontal distance).
    // Assignment only changes as the player moves, so recompute it a few times
    // a second instead of sorting every frame; flicker stays per-frame.
    this._glowAssignT += dt;
    if (this._glowDirty || this._glowAssignT >= 0.15) {
      this._glowAssignT = 0;
      this._glowDirty = false;
      const px = this._px, pz = this._pz;
      const near = [];
      for (const g of this.glow.values()) {
        const dx = g[0] + 0.5 - px, dz = g[2] + 0.5 - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 <= GLOW_RANGE * GLOW_RANGE) near.push({ g, d2 });
      }
      near.sort((a, b) => a.d2 - b.d2);
      for (let i = 0; i < lights.length; i++) {
        const g = i < near.length ? near[i].g : null;
        this._glowSlots[i] = g;
        if (g) lights[i].position.set(g[0] + 0.5, g[1] + 0.5, g[2] + 0.5);
      }
    }
    for (let i = 0; i < lights.length; i++) {
      const g = this._glowSlots[i];
      if (g) {
        const ph = (g[0] * 7 + g[1] * 13 + g[2] * 5) % 7;          // per-light phase
        const lf = 0.82 + 0.16 * Math.sin(t * 9 + ph) + 0.08 * Math.sin(t * 15 + ph * 1.7);
        lights[i].intensity = night * lf * GLOW_LIGHT_POWER;
      } else {
        lights[i].intensity = 0;
      }
    }
  }

  // --- TNT ------------------------------------------------------------------
  // Light an explosive block — TNT or a proximity mine: it flashes for a
  // moment, then explodes. The fuse set dedupes, so a mine that's both caught
  // in a blast and tripped by proximity still only goes off once.
  igniteTNT(x, y, z, fuse = FUSE) {
    const k = `${x},${y},${z}`;
    if (this.fuseKeys.has(k)) return;          // already primed
    const b = this.getBlock(x, y, z);
    if (b !== TNT && !isProx(b)) return;
    this.fuseKeys.add(k);
    // Mines are anti-creature, not anti-landscape: they carve only half a
    // TNT's crater, but their lethal blast (below) stays full size.
    const bscale = isProx(b) ? 0.5 : 1;
    const mesh = new THREE.Mesh(this._primeGeo, this._primeMat);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.fuses.push({ x, y, z, key: k, t: fuse, bscale, mesh });
    audio.playIgnite({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    if (this.net && this.net.connected) this.net.sendFx('ignite', x, y, z);
  }

  // `bscale` shrinks only the crater (block destruction) relative to a full
  // TNT blast — mines detonate at 0.5. Damage, shake, sound, and debris are
  // always full strength, and reach through walls: proximity is pure
  // distance, no line of sight.
  _explode(x, y, z, bscale = 1) {
    audio.playExplosion({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    if (this.onExplosion) this.onExplosion(x, y, z);
    this._spawnParticles(x, y, z);
    if (this.net && this.net.connected) this.net.sendFx('explode', x, y, z);

    const radius = BLAST_RADIUS * bscale;
    const R = Math.ceil(radius), R2 = radius * radius;
    const removed = [];
    for (let dx = -R; dx <= R; dx++)
      for (let dy = -R; dy <= R; dy++)
        for (let dz = -R; dz <= R; dz++) {
          if (dx * dx + dy * dy + dz * dz > R2) continue;
          const bx = x + dx, by = y + dy, bz = z + dz;
          if (by < 0) continue;
          const b = this.getBlock(bx, by, bz);
          if (b === AIR) continue;
          // Explosives caught in the blast go off themselves — TNT sets off
          // mines and mines set off TNT, in any combination.
          if ((b === TNT || isProx(b)) && !(dx === 0 && dy === 0 && dz === 0)) {
            this.igniteTNT(bx, by, bz, 0.1 + Math.random() * 0.15);  // chain reaction
            continue;
          }
          this.setBlock(bx, by, bz, AIR, false);
          removed.push({ x: bx, y: by, z: bz, block: AIR });
          // Doors are pairs: if the blast caught one half, take the other
          // too — never leave half a door hanging over the crater.
          if (isDoor(b)) {
            for (const py of [by - 1, by + 1]) {
              if (this.getBlock(bx, py, bz) === b) {
                this.setBlock(bx, py, bz, AIR, false);
                removed.push({ x: bx, y: py, z: bz, block: AIR });
              }
            }
          }
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
    // Water reacts to the crater: sea-connected water refloods it; a player's
    // pond next to the blast drains into the hole (settle). Repeated calls on
    // already-covered cells are cheap no-ops.
    for (const cell of removed) {
      this._waterDisturb(cell.x, cell.y, cell.z);
    }
  }

  _spawnParticles(x, y, z, opts = {}) {
    const N = opts.count ?? 36;
    const color = opts.color ?? 0xff8b2a;
    const size = opts.size ?? 0.35;
    const life = opts.life ?? 0.8;
    const spBase = opts.spBase ?? 3, spRand = opts.spRand ?? 6, up = opts.up ?? 2;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = x + 0.5; pos[i * 3 + 1] = y + 0.5; pos[i * 3 + 2] = z + 0.5;
      const sp = spBase + Math.random() * spRand;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      vel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      vel[i * 3 + 1] = Math.abs(Math.cos(ph)) * sp + up;
      vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color, size, transparent: true, depthWrite: false, fog: false });
    const points = new THREE.Points(geo, mat);
    points.matrixAutoUpdate = false;   // animation lives in the attribute, not the matrix
    this.scene.add(points);
    this.particles.push({ points, vel, life, maxLife: life });
  }

  // A small puff of block-coloured dust when a block breaks.
  spawnBreakBurst(x, y, z, color) {
    this._spawnParticles(x, y, z,
      { count: 12, color, size: 0.16, life: 0.5, spBase: 1.2, spRand: 3.5, up: 1.5 });
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
        this._explode(f.x, f.y, f.z, f.bscale);
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
        p.points.material.dispose();
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
