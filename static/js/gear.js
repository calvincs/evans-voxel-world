// Contraption blocks driven by the Firestone striker (TNT ignition stays in
// world.igniteTNT):
//
//   🎃 Pumpkins — a strike lights the carved face (jack-o'-lantern, a real
//      light source at night); another strike snuffs it.
//   💣 Proximity mines — strikes cycle OFF → watch-OTHERS → watch-EVERYONE →
//      OFF. Arming takes 5s (time to walk away); when something wanders close
//      a live mine blows instantly: half a TNT's crater, but the full TNT
//      lethal radius for creatures and players (sensing and blast damage are
//      pure distance — walls don't shield). A mine never fires on the player
//      who armed it. Explosions chain both ways: a blast sets off nearby
//      mines and TNT alike.
//   ⬆➡ Elevators — strikes set the travel distance (1..10, wrapping back to
//      1); the number is painted on the block. Stand on one and it glides out;
//      step off and it comes home and lands.
//
// State changes are ordinary block swaps (persisted + relayed), so friends see
// mine modes and elevator counts. Timers and platform motion run only on the
// client that struck/rode the block, mirroring how TNT fuses work — except
// that armed mine blocks nobody is watching (after a reload, or a friend's)
// get adopted by whichever client comes near, so a minefield keeps working
// across sessions.

import * as THREE from 'three';
import * as audio from './audio.js';
import { DIM } from './engine/constants.js';
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
  [ELEV_UP]:       { arrow: '⬆', kind: 'up',   word: 'up', turn: 0, next: ELEV_DOWN,
                     nextMsg: '⬇ Flipped! Now it goes DOWN — starting at 1' },
  [ELEV_DOWN]:     { arrow: '⬇', kind: 'down', word: 'down', turn: 0, next: ELEV_UP,
                     nextMsg: '⬆ Flipped! Now it goes UP — starting at 1' },
  [ELEV_SIDE]:     { arrow: '⬆', kind: 'side', word: 'forward', turn: 0, next: ELEV_SIDE_R,
                     nextMsg: '➡ Now it glides to your RIGHT — starting at 1' },
  [ELEV_SIDE_R]:   { arrow: '➡', kind: 'side', word: 'to your right', turn: 1, next: ELEV_SIDE_REV,
                     nextMsg: '⬇ Now it glides BACKWARD — starting at 1' },
  [ELEV_SIDE_REV]: { arrow: '⬇', kind: 'side', word: 'backward', turn: 2, next: ELEV_SIDE_L,
                     nextMsg: '⬅ Now it glides to your LEFT — starting at 1' },
  [ELEV_SIDE_L]:   { arrow: '⬅', kind: 'side', word: 'to your left', turn: 3, next: ELEV_SIDE,
                     nextMsg: '⬆ Now it glides FORWARD, the way you look — starting at 1' },
};

const MINE_ARM_DELAY = 5;    // seconds from arming strike to a live sensor
const MINE_RANGE = 2.5;      // trigger distance from the block centre
const MINE_ADOPT_T = 1;      // seconds between orphaned-mine scans
const MINE_ADOPT_R = 16;     // horizontal radius scanned around the player
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
    this.owners = new Map();      // "x,y,z" -> name of who armed it (server-fed)
    this.myName = '';             // local account name (set from the config)
    this._adoptT = 0;             // countdown to the next orphaned-mine scan
    this.elevators = new Map();   // "ox,oy,oz" -> flying platform
    this._standKey = null;        // dwell tracking for elevator launch
    this._standT = 0;

    this._overlayGeo = new THREE.BoxGeometry(1.05, 1.05, 1.05);
    this._blockGeo = new THREE.BoxGeometry(1, 1, 1);
    this._armMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false });
    this._matCache = new Map();   // block id -> platform material
  }

  update(dt) {
    this._adoptOrphanMines(dt);
    this._updateMines(dt);
    this._updateElevators(dt);
  }

  // Seed mine ownership from the world config (called once on join).
  setOwners(map) {
    this.owners = new Map(Object.entries(map || {}));
  }

  // Track ownership as edits flow in: an armed mine carries its owner's name;
  // any other block written at that spot retires the record.
  noteEdit(x, y, z, block, owner) {
    const k = key(x, y, z);
    if (block === PROX_OTHERS || block === PROX_ALL) {
      if (owner) this.owners.set(k, owner);
    } else {
      this.owners.delete(k);
    }
  }

  // Mine sensors live in the client that armed them — so a page reload (or a
  // friend's mine) leaves armed-looking blocks nobody is watching. Any armed
  // mine block near the player with no local sensor gets adopted here, with
  // the full arming delay so a just-noticed mine never fires the instant you
  // (or its still-arming owner, in multiplayer) are spotted next to it.
  // (Two clients may both sense the same mine; the fuse dedup and the block
  // vanishing with the first crater keep a rare double boom harmless.)
  _adoptOrphanMines(dt) {
    this._adoptT -= dt;
    if (this._adoptT > 0) return;
    this._adoptT = MINE_ADOPT_T;
    const p = this.player.pos;
    const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
    const y0 = Math.max(0, py - 10), y1 = Math.min(DIM.WY - 1, py + 10);
    for (let x = px - MINE_ADOPT_R; x <= px + MINE_ADOPT_R; x++)
      for (let z = pz - MINE_ADOPT_R; z <= pz + MINE_ADOPT_R; z++)
        for (let y = y0; y <= y1; y++) {
          const b = this.world.getBlock(x, y, z);
          if ((b === PROX_OTHERS || b === PROX_ALL) && !this.mines.has(key(x, y, z))) {
            this._armMine(key(x, y, z), x, y, z, true);
          }
        }
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
        this.msg(`${info.arrow} Elevator: ${count + 1} blocks ${info.word}`);
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
    audio.playIgnite(pos);
    if (block === PROX_OFF) {
      this.world.setBlock(x, y, z, PROX_OTHERS);
      this.owners.set(k, this.myName);
      this._armMine(k, x, y, z);
      this.msg(`💣 Mine ON — it will never blow up on YOU. Live in ${MINE_ARM_DELAY} seconds!`);
    } else if (block === PROX_OTHERS) {
      this.world.setBlock(x, y, z, PROX_ALL);
      this.owners.set(k, this.myName);
      this._armMine(k, x, y, z);                       // arming restarts
      this.msg(`💣 DANGER mine — it can blow up on YOU too! Live in ${MINE_ARM_DELAY} seconds — run!`);
    } else {
      this._dropMine(k);
      this.owners.delete(k);
      this.world.setBlock(x, y, z, PROX_OFF);
      this.msg('💣 Mine turned off.');
    }
  }

  _armMine(k, x, y, z, quiet = false) {
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
    m.quiet = quiet;              // adopted silently — no "LIVE" toast
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
          if (!m.quiet) this.msg('💣 Mine is LIVE — careful!');
        }
      } else if (m.state === 'live') {
        if (this._proximity(m.x, m.y, m.z, b === PROX_ALL, this.owners.get(k)) < MINE_RANGE) {
          // No second chances: the sensor fires the charge on contact. Routed
          // through the shared fuse (at zero length) so a mine that's also
          // caught in someone else's blast can't detonate twice. The crater is
          // persisted + relayed; main.js's explosion hook applies player
          // damage and kills creatures caught in it.
          this._dropMine(k);
          this.world.igniteTNT(m.x, m.y, m.z, 0);
        }
      }
    }
  }

  // Nearest watched thing to the mine centre. Creatures always count. A mine
  // armed for OTHERS never counts its owner — local or remote, whoever's
  // client is running the sensor — while EVERYONE counts all players. Mines
  // with no owner on record (armed before ownership existed) fall back to the
  // old rule: the local player doesn't count.
  _proximity(x, y, z, includeAll, owner) {
    const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
    let best = Infinity;
    for (const mob of this.mobs.mobs) {
      best = Math.min(best, Math.hypot(mob.pos.x - cx, mob.pos.y + 0.4 - cy, mob.pos.z - cz));
    }
    for (const r of this.remotes.players.values()) {
      if (!includeAll && owner && r.name === owner) continue;   // the owner is safe
      best = Math.min(best, Math.hypot(r.cur.x - cx, r.cur.y + 0.9 - cy, r.cur.z - cz));
    }
    if (includeAll || (owner && owner !== this.myName)) {
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
