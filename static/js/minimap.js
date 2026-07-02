// Corner minimap: a top-down view of the loaded world with you at the centre.
// The map rotates with you, so "up" is always the way you're facing — walk
// toward the top of the map and you walk toward what it shows.
//
// Each loaded chunk contributes one 16×16 tile (the colour of the highest
// block per column, shaded by height). Tiles rebuild lazily (a few per frame)
// when their chunk loads or is edited; the per-frame cost is one rotated
// drawImage of the composed world canvas plus the markers.
//
// Markers: white arrow = you; coloured dots = other players; orange ring =
// the village; small dots = creatures (gold villagers, red = a hunter that's
// locked on). Tap the map (or press N) to cycle big → small → hidden.

import { DIM, RENDER_DISTANCE } from './engine/constants.js';
import { AIR, blockColor } from './blocks.js';

const key = (cx, cz) => `${cx},${cz}`;
const floorDiv = (a, b) => Math.floor(a / b);

const SIZES = [140, 96, 0];          // css px; 0 = hidden
const BLOCK_PX = 3;                  // display pixels per block (backing store)

export class MiniMap {
  constructor(world, player, remotes, mobs, canvas, village) {
    this.world = world;
    this.player = player;
    this.remotes = remotes;
    this.mobs = mobs;
    this.canvas = canvas;
    this.village = village || null;  // {x, z, radius} or null
    this.ctx = canvas.getContext('2d');
    this.tiles = new Map();          // "cx,cz" -> {canvas, ver}
    this.sizeIdx = 0;
    this._applySize();

    canvas.addEventListener('click', (e) => { e.stopPropagation(); this.cycle(); });
    document.addEventListener('keydown', (e) => {
      const a = document.activeElement;
      if (e.code === 'KeyN' && !e.repeat && !(a && a.tagName === 'INPUT')) this.cycle();
    });
  }

  cycle() {
    this.sizeIdx = (this.sizeIdx + 1) % SIZES.length;
    this._applySize();
  }

  _applySize() {
    const s = SIZES[this.sizeIdx];
    this.canvas.style.display = s ? 'block' : 'none';
    if (s) { this.canvas.style.width = `${s}px`; this.canvas.style.height = `${s}px`; }
  }

  // One 16×16 colour tile for a chunk: highest non-air block per column,
  // brightened toward the sky so hills and craters read at a glance.
  _buildTile(chunk) {
    const { CX, CZ, WY } = DIM;
    let t = this.tiles.get(key(chunk.cx, chunk.cz));
    if (!t) {
      const cv = document.createElement('canvas');
      cv.width = CX; cv.height = CZ;
      t = { canvas: cv };
      this.tiles.set(key(chunk.cx, chunk.cz), t);
    }
    const ctx = t.canvas.getContext('2d');
    const img = ctx.createImageData(CX, CZ);
    const d = img.data;
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        let y = WY - 1, b = AIR;
        for (; y >= 0; y--) {
          b = chunk.getLocal(x, y, z);
          if (b !== AIR) break;
        }
        const i = (z * CX + x) * 4;
        if (b === AIR) { d[i + 3] = 0; continue; }     // empty column: transparent
        const c = blockColor(b);
        const f = 0.55 + 0.45 * (y / WY);              // height shading
        d[i] = ((c >> 16) & 255) * f;
        d[i + 1] = ((c >> 8) & 255) * f;
        d[i + 2] = (c & 255) * f;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    chunk.mapDirty = false;
  }

  update() {
    if (!SIZES[this.sizeIdx]) return;                  // hidden
    const { CX, CZ } = DIM;
    const world = this.world, p = this.player;

    // Rebuild a few stale tiles per frame; drop tiles for evicted chunks.
    let budget = 4;
    for (const chunk of world.chunks.values()) {
      if (budget <= 0) break;
      const k = key(chunk.cx, chunk.cz);
      if (chunk.mapDirty !== false || !this.tiles.has(k)) {
        this._buildTile(chunk);
        budget--;
      }
    }
    if (this.tiles.size > world.chunks.size + 16) {    // prune after eviction
      for (const k of this.tiles.keys()) {
        if (!world.chunks.has(k)) this.tiles.delete(k);
      }
    }

    const ctx = this.ctx;
    const S = this.canvas.width;                       // square backing store
    const half = S / 2;
    ctx.clearRect(0, 0, S, S);

    // Circular map: clip, then rotate the world under the player so the top
    // of the map is the direction the player faces (yaw 0 looks toward -z).
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10, 16, 28, 0.55)';
    ctx.fill();
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(half, half);
    ctx.rotate(p.yaw);
    ctx.scale(BLOCK_PX, BLOCK_PX);
    ctx.translate(-p.pos.x, -p.pos.z);

    const ccx = floorDiv(p.pos.x, CX), ccz = floorDiv(p.pos.z, CZ);
    const R = RENDER_DISTANCE + 1;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const t = this.tiles.get(key(ccx + dx, ccz + dz));
        if (t) ctx.drawImage(t.canvas, (ccx + dx) * CX, (ccz + dz) * CZ);
      }
    }

    // Village ring (helps a lost kid find the way back to town).
    if (this.village) {
      ctx.strokeStyle = 'rgba(255, 158, 40, 0.9)';
      ctx.lineWidth = 1.2 / BLOCK_PX;
      ctx.beginPath();
      ctx.arc(this.village.x, this.village.z, Math.max(3, this.village.radius * 0.5), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Creatures: red = a hunter that's locked on (worth glancing at, at
    // night!), gold = villagers, soft white = everything else.
    for (const m of this.mobs.mobs) {
      ctx.fillStyle = m.mc ? '#ff4040'
        : m.t.villager ? '#ffd24d' : 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.arc(m.pos.x, m.pos.z, (m.mc ? 2.6 : 1.7) / BLOCK_PX, 0, Math.PI * 2);
      ctx.fill();
    }

    // Other players, in their character colours.
    for (const r of this.remotes.players.values()) {
      ctx.fillStyle = '#' + (r.color ?? 0xffffff).toString(16).padStart(6, '0');
      ctx.beginPath();
      ctx.arc(r.cur.x, r.cur.z, 2.4 / BLOCK_PX, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // You: a fixed arrow at the centre, always pointing up (the map turns).
    ctx.save();
    ctx.translate(half, half);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Rim.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(half, half, half - 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}
