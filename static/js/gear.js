// Contraption blocks driven by the Firestone striker (TNT ignition stays in
// world.igniteTNT):
//
//   🎃 Pumpkins — a strike lights the carved face (jack-o'-lantern, a real
//      light source at night); another strike snuffs it.
//   💣 Proximity mines — strikes cycle OFF → watch-OTHERS → watch-EVERYONE →
//      OFF. Arming takes 5s (time to walk away); when something wanders close
//      the mine blinks for 2s — strike it in time to defuse, or it blows like
//      TNT (creatures caught in the blast die outright).
//   ⬆➡ Elevators — strikes set the travel distance (1..10, wrapping back to
//      1); the number is painted on the block. Stand on one and it glides out;
//      step off and it comes home and lands.
//
// State changes are ordinary block swaps (persisted + relayed), so friends see
// mine modes and elevator counts. Timers and platform motion run only on the
// client that struck/rode the block, mirroring how TNT fuses work.

import * as THREE from 'three';
import * as audio from './audio.js';
import {
  AIR, PUMPKIN, PUMPKIN_LIT, PROX_OFF, PROX_OTHERS, PROX_ALL,
  ELEV_UP, ELEV_SIDE, ELEV_DOWN, ELEV_SIDE_REV, ELEV_SIDE_R, ELEV_SIDE_L,
  ELEV_MAX, elevBase, elevCount, isProx,
  isSolid, BLOCKS, ATLAS_COLS, TILE_PX,
} from './blocks.js';

const key = (x, y, z) => `${x},${y},${z}`;

// Per-direction elevator behavior: display arrow, how many 90° clockwise turns
// from the rider's facing a horizontal one glides (0 fwd, 1 right, 2 back,
// 3 left), and what the 11th strike switches to.
const ELEV_INFO = {
  [ELEV_UP]:       { arrow: '⬆', kind: 'up',   turn: 0, next: ELEV_DOWN,
                     nextMsg: '⬇ Flipped! Elevator now goes DOWN — set to 1' },
  [ELEV_DOWN]:     { arrow: '⬇', kind: 'down', turn: 0, next: ELEV_UP,
                     nextMsg: '⬆ Flipped! Elevator now goes UP — set to 1' },
  [ELEV_SIDE]:     { arrow: '⬆', kind: 'side', turn: 0, next: ELEV_SIDE_R,
                     nextMsg: '➡ Switched! Now glides to your RIGHT — set to 1' },
  [ELEV_SIDE_R]:   { arrow: '➡', kind: 'side', turn: 1, next: ELEV_SIDE_REV,
                     nextMsg: '⬇ Switched! Now glides BACKWARD — set to 1' },
  [ELEV_SIDE_REV]: { arrow: '⬇', kind: 'side', turn: 2, next: ELEV_SIDE_L,
                     nextMsg: '⬅ Switched! Now glides to your LEFT — set to 1' },
  [ELEV_SIDE_L]:   { arrow: '⬅', kind: 'side', turn: 3, next: ELEV_SIDE,
                     nextMsg: '⬆ Switched! Now glides FORWARD (where you look) — set to 1' },
};

const MINE_ARM_DELAY = 5;    // seconds from arming strike to a live sensor
const MINE_DEFUSE = 2;       // seconds from trip to boom
const MINE_RANGE = 2.5;      // trigger distance from the block centre
const ELEV_SPEED = 2.5;      // platform speed, blocks/second
const RIDE_GRACE = 0.5;      // seconds off the platform before it heads home
const STAND_DELAY = 0.25;    // stand this long on an elevator to launch it
                             // (so walking across one doesn't set it off)

export class Gear {
  constructor(world, player, mobs, remotes, atlasCanvas, msg = () => {}) {
    this.world = world;
    this.player = player;
    this.mobs = mobs;
    this.remotes = remotes;
    this.atlas = atlasCanvas;
    this.msg = msg;
    this.mines = new Map();       // "x,y,z" -> mine state
    this.elevators = new Map();   // "ox,oy,oz" -> flying platform
    this._standKey = null;        // dwell tracking for elevator launch
    this._standT = 0;

    this._overlayGeo = new THREE.BoxGeometry(1.05, 1.05, 1.05);
    this._blockGeo = new THREE.BoxGeometry(1, 1, 1);
    this._armMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false });
    this._tripMat = new THREE.MeshBasicMaterial({
      color: 0xff4030, transparent: true, opacity: 0.55, depthWrite: false });
    this._matCache = new Map();   // block id -> platform material
  }

  update(dt) {
    this._updateMines(dt);
    this._updateElevators(dt);
  }

  // --- Firestone strikes ------------------------------------------------------
  // Returns true when the strike was handled (player falls back to TNT/spark).
  strike(x, y, z, block) {
    const pos = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    if (block === PUMPKIN) {
      this.world.setBlock(x, y, z, PUMPKIN_LIT);
      audio.playIgnite(pos);
      this.msg('🎃 Lit!');
      return true;
    }
    if (block === PUMPKIN_LIT) {
      this.world.setBlock(x, y, z, PUMPKIN);
      this.msg('🎃 Snuffed out.');
      return true;
    }
    if (isProx(block)) {
      this._strikeMine(x, y, z, block, pos);
      return true;
    }
    const count = elevCount(block);
    if (count > 0) {
      const info = ELEV_INFO[elevBase(block)];
      audio.playIgnite(pos);
      if (count < ELEV_MAX) {
        this.world.setBlock(x, y, z, block + 1);
        this.msg(`${info.arrow} Elevator set to ${count + 1}`);
      } else {
        // The 11th strike switches direction and restarts the count at 1.
        this.world.setBlock(x, y, z, info.next);
        this.msg(info.nextMsg);
      }
      return true;
    }
    return false;
  }

  // --- Proximity mines --------------------------------------------------------
  _strikeMine(x, y, z, block, pos) {
    const k = key(x, y, z);
    const mine = this.mines.get(k);
    audio.playIgnite(pos);
    if (mine && mine.state === 'tripped') {            // last-second save
      this._dropMine(k);
      this.world.setBlock(x, y, z, PROX_OFF);
      this.msg('💣 Phew — defused!');
      return;
    }
    if (block === PROX_OFF) {
      this.world.setBlock(x, y, z, PROX_OTHERS);
      this._armMine(k, x, y, z);
      this.msg(`💣 Armed for OTHERS — live in ${MINE_ARM_DELAY}s. Strike again: everyone. Twice: off.`);
    } else if (block === PROX_OTHERS) {
      this.world.setBlock(x, y, z, PROX_ALL);
      this._armMine(k, x, y, z);                       // arming restarts
      this.msg(`💣 Armed for EVERYONE — you too! Live in ${MINE_ARM_DELAY}s.`);
    } else {
      this._dropMine(k);
      this.world.setBlock(x, y, z, PROX_OFF);
      this.msg('💣 Disarmed.');
    }
  }

  _armMine(k, x, y, z) {
    let m = this.mines.get(k);
    if (!m) {
      const mesh = new THREE.Mesh(this._overlayGeo, this._armMat);
      mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
      this.world.scene.add(mesh);
      m = { x, y, z, mesh };
      this.mines.set(k, m);
    }
    m.state = 'arming';
    m.t = MINE_ARM_DELAY;
    m.tick = 0;
    m.mesh.material = this._armMat;
    m.mesh.visible = true;
  }

  _dropMine(k) {
    const m = this.mines.get(k);
    if (m) { this.world.scene.remove(m.mesh); this.mines.delete(k); }
  }

  _updateMines(dt) {
    for (const [k, m] of this.mines) {
      const b = this.world.getBlock(m.x, m.y, m.z);
      if (b !== PROX_OTHERS && b !== PROX_ALL) {       // broken or switched off
        this._dropMine(k);
        continue;
      }
      if (m.state === 'arming') {
        m.t -= dt;
        m.mesh.visible = Math.floor(m.t * 4) % 2 === 0;   // slow blink
        if (m.t <= 0) {
          m.state = 'live';
          m.mesh.visible = false;
          this.msg('💣 Mine is LIVE.');
        }
      } else if (m.state === 'live') {
        if (this._proximity(m.x, m.y, m.z, b === PROX_ALL) < MINE_RANGE) {
          m.state = 'tripped';
          m.t = MINE_DEFUSE;
          m.mesh.material = this._tripMat;
        }
      } else if (m.state === 'tripped') {
        m.t -= dt;
        m.mesh.visible = Math.floor(m.t * 10) % 2 === 0;  // frantic blink
        m.tick -= dt;
        if (m.tick <= 0) {
          m.tick = 0.33;
          audio.playIgnite({ x: m.x + 0.5, y: m.y + 0.5, z: m.z + 0.5 });
        }
        if (m.t <= 0) {
          this._dropMine(k);
          // TNT-sized boom: crater is persisted + relayed; main.js's explosion
          // hook applies player damage and kills creatures caught in it.
          this.world._explode(m.x, m.y, m.z);
        }
      }
    }
  }

  // Nearest watched thing to the mine centre: creatures and other players
  // always count; the local player only when the mine watches everyone.
  _proximity(x, y, z, includeSelf) {
    const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
    let best = Infinity;
    for (const mob of this.mobs.mobs) {
      best = Math.min(best, Math.hypot(mob.pos.x - cx, mob.pos.y + 0.4 - cy, mob.pos.z - cz));
    }
    for (const r of this.remotes.players.values()) {
      best = Math.min(best, Math.hypot(r.cur.x - cx, r.cur.y + 0.9 - cy, r.cur.z - cz));
    }
    if (includeSelf) {
      const p = this.player.pos;
      best = Math.min(best, Math.hypot(p.x - cx, p.y + 0.9 - cy, p.z - cz));
    }
    return best;
  }

  // --- Elevators ----------------------------------------------------------------
  _platformMaterial(blockId) {
    let mat = this._matCache.get(blockId);
    if (!mat) {
      const slot = BLOCKS[blockId].side;
      const cv = document.createElement('canvas');
      cv.width = cv.height = TILE_PX;
      cv.getContext('2d').drawImage(this.atlas,
        (slot % ATLAS_COLS) * TILE_PX, Math.floor(slot / ATLAS_COLS) * TILE_PX,
        TILE_PX, TILE_PX, 0, 0, TILE_PX, TILE_PX);
      const tex = new THREE.CanvasTexture(cv);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      mat = new THREE.MeshLambertMaterial({ map: tex });
      this._matCache.set(blockId, mat);
    }
    return mat;
  }

  // Launch when the player has stood on an elevator block for a moment.
  _maybeLaunch(dt) {
    const p = this.player;
    if (!p.onGround || p.dead) { this._standT = 0; this._standKey = null; return; }
    const bx = Math.floor(p.pos.x), bz = Math.floor(p.pos.z);
    const by = Math.floor(p.pos.y - 0.05);
    const b = this.world.getBlock(bx, by, bz);
    if (elevCount(b) === 0) { this._standT = 0; this._standKey = null; return; }
    const k = key(bx, by, bz);
    if (this.elevators.has(k)) return;
    if (this._standKey !== k) { this._standKey = k; this._standT = 0; }
    this._standT += dt;
    if (this._standT < STAND_DELAY) return;
    this._standKey = null;
    this._standT = 0;
    this._launch(bx, by, bz, b);
  }

  _launch(x, y, z, block) {
    const count = elevCount(block);
    const info = ELEV_INFO[elevBase(block)];
    const kind = info.kind;
    let max = 0;
    let dir = { x: 0, z: 0 };
    if (kind === 'up') {
      for (let i = 1; i <= count; i++) {
        if (isSolid(this.world.getBlock(x, y + i, z))) break;
        max = i;
      }
    } else if (kind === 'down') {
      for (let i = 1; i <= count; i++) {
        if (y - i < 0 || isSolid(this.world.getBlock(x, y - i, z))) break;
        max = i;
      }
    } else {
      // Sideways elevators travel relative to the way the rider is facing
      // when they board: forward, or turned 90° right / 180° back / 90° left.
      const fx = -Math.sin(this.player.yaw), fz = -Math.cos(this.player.yaw);
      dir = Math.abs(fx) > Math.abs(fz)
        ? { x: Math.sign(fx) || 1, z: 0 } : { x: 0, z: Math.sign(fz) || 1 };
      for (let t = 0; t < info.turn; t++) dir = { x: -dir.z, z: dir.x };  // 90° cw
      for (let i = 1; i <= count; i++) {
        const cx = x + dir.x * i, cz = z + dir.z * i;
        // Needs room for the block and the rider standing on it.
        if (isSolid(this.world.getBlock(cx, y, cz)) ||
            isSolid(this.world.getBlock(cx, y + 1, cz))) break;
        max = i;
      }
    }
    if (max <= 0) return;                        // nowhere to go — stays a block

    this.world.setBlock(x, y, z, AIR, false);    // lift out of the grid, locally
                                                 // only — the server keeps it in
                                                 // place until it lands
    const mesh = new THREE.Mesh(this._blockGeo, this._platformMaterial(block));
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.world.scene.add(mesh);
    this.elevators.set(key(x, y, z), {
      kind, id: block, dir, max,
      ox: x, oy: y, oz: z, x, y, z,
      progress: 0, offT: 0, state: 'out', mesh,
    });
    audio.playPlace({ x: x + 0.5, y: y + 1, z: z + 0.5 });
  }

  _updateElevators(dt) {
    this._maybeLaunch(dt);
    const p = this.player;
    for (const [k, e] of this.elevators) {
      // Is the local player standing on this platform?
      const top = e.y + 1;
      const riding = Math.abs(p.pos.x - (e.x + 0.5)) < 0.82 &&
                     Math.abs(p.pos.z - (e.z + 0.5)) < 0.82 &&
                     p.pos.y > top - 0.35 && p.pos.y < top + 0.45 &&
                     p.vel.y <= 0.01;
      if (riding) e.offT = 0; else e.offT += dt;
      if (e.offT > RIDE_GRACE && e.state !== 'return') e.state = 'return';

      // Where does it want to be next frame?
      const step = ELEV_SPEED * dt;
      let tx = e.x, ty = e.y, tz = e.z, tp = e.progress, arrived = false;
      if (e.state === 'out') {
        if (e.kind === 'up') {
          ty = Math.min(e.y + step, e.oy + e.max);
          arrived = ty >= e.oy + e.max;
        } else if (e.kind === 'down') {
          ty = Math.max(e.y - step, e.oy - e.max);
          arrived = ty <= e.oy - e.max;
        } else {
          tp = Math.min(e.progress + step, e.max);
          tx = e.ox + e.dir.x * tp;
          tz = e.oz + e.dir.z * tp;
          arrived = tp >= e.max;
        }
      } else if (e.state === 'return') {
        if (e.kind === 'up') {
          const landY = this._landY(e);
          ty = Math.max(e.y - step, landY);
          arrived = ty <= landY;
        } else if (e.kind === 'down') {
          const homeY = this._riseHomeY(e);
          ty = Math.min(e.y + step, homeY);
          arrived = ty >= homeY;
        } else {
          tp = Math.max(e.progress - step, 0);
          tx = e.ox + e.dir.x * tp;
          tz = e.oz + e.dir.z * tp;
          arrived = tp <= 0;
        }
      }

      // Garage-door safety sensor: never move into (or land on) a player —
      // hover right where we are and wait for them to step aside. Riders
      // standing on top don't count as "in the way".
      const moving = tx !== e.x || ty !== e.y || tz !== e.z;
      if (moving && this._playerInBox(tx, ty, tz, e.y)) {
        e.mesh.position.set(e.x + 0.5, e.y + 0.5, e.z + 0.5);
        if (riding) { p.pos.y = e.y + 1; p.vel.y = 0; p.onGround = true; }
        continue;                                    // paused; retry next frame
      }
      const dx = tx - e.x, dz = tz - e.z;
      e.x = tx; e.y = ty; e.z = tz; e.progress = tp;

      if (arrived) {
        if (e.state === 'return') {
          if (this._settle(k, e, Math.round(e.x), Math.round(e.y), Math.round(e.z))) continue;
          // Landing spot is occupied by a player — keep hovering, retry.
        } else {
          e.state = 'hold';
        }
      }

      e.mesh.position.set(e.x + 0.5, e.y + 0.5, e.z + 0.5);
      if (riding) {                                     // carry the rider along
        p.pos.x += dx;
        p.pos.z += dz;
        p.pos.y = e.y + 1;
        p.vel.y = 0;
        p.onGround = true;                              // so jumping off works
      }
    }
  }

  // Would a platform occupying cell (bx,by,bz) intersect a player's body?
  // Someone standing on top is a rider, not an obstacle — judged against the
  // platform's CURRENT top (topY + 1), not the candidate cell, so one frame of
  // travel can never reclassify a rider as blocking (the margin must not
  // depend on frame rate).
  _playerInBox(bx, by, bz, topY = by) {
    const test = (px, py, pz) => {
      if (py > topY + 0.65) return false;              // on top: riding
      return px > bx - 0.35 && px < bx + 1.35 &&
             pz > bz - 0.35 && pz < bz + 1.35 &&
             py + 1.8 > by && py < by + 1;
    };
    const p = this.player.pos;
    if (test(p.x, p.y, p.z)) return true;
    for (const r of this.remotes.players.values()) {
      if (test(r.cur.x, r.cur.y, r.cur.z)) return true;
    }
    return false;
  }

  // Where a returning up-elevator rests: the first level at or below it with
  // solid ground underneath (terrain may have changed while it flew).
  _landY(e) {
    let y = Math.floor(e.y + 0.001);
    while (y > 0 && !isSolid(this.world.getBlock(e.ox, y - 1, e.oz))) y--;
    return y;
  }

  // Where a returning down-elevator rests: back home at its origin, or just
  // below the first block that now caps the shaft above it.
  _riseHomeY(e) {
    for (let c = Math.floor(e.y) + 1; c <= e.oy; c++) {
      if (isSolid(this.world.getBlock(e.ox, c, e.oz))) return c - 1;
    }
    return e.oy;
  }

  // Turn the platform back into a world block. Returns false (and leaves it
  // hovering) if a player occupies the spot — the block must never entomb one.
  _settle(k, e, cx, cy, cz) {
    // If someone built into the landing cell while it flew, rest on top instead.
    let ty = cy;
    while (ty < cy + 5 && isSolid(this.world.getBlock(cx, ty, cz))) ty++;
    if (this._playerInBox(cx, ty, cz)) return false;
    this.world.scene.remove(e.mesh);
    this.elevators.delete(k);
    if (cx === e.ox && ty === e.oy && cz === e.oz) {
      this.world.setBlock(cx, ty, cz, e.id, false);    // never moved, server-side
    } else {
      this.world.setBlock(cx, ty, cz, e.id, true);
      this.world.setBlock(e.ox, e.oy, e.oz, AIR, true);
    }
    audio.playPlace({ x: cx + 0.5, y: ty + 0.5, z: cz + 0.5 });
    return true;
  }
}
