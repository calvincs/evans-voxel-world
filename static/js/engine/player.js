// First-person player: pointer-lock mouse-look, WASD + gravity/jump with
// AABB-vs-voxel collision, and a DDA raycast for targeting blocks to break or
// place.

import * as THREE from 'three';
import { isSolid, AIR, WATER, HOTBAR, TNT, FIRESTONE, isTool, blockColor } from '../blocks.js';
import * as audio from '../audio.js';
import { Character } from './character.js';

const HALF_W = 0.3;      // player is 0.6 wide
const HEIGHT = 1.8;      // and 1.8 tall
const EYE = 1.62;        // eye offset from the feet
const SPEED = 5.2;
const SPRINT = 8.5;
const GRAVITY = 26;
const JUMP = 8.8;
const REACH = 6;
const THIRD_DIST = 4.0;  // third-person camera distance
const UP = new THREE.Vector3(0, 1, 0);

// Water physics: sink slowly, hold Space (or the jump button) to swim up.
const SWIM_GRAVITY = 5;
const SWIM_SINK_MAX = -2.2;  // terminal sink speed
const SWIM_UP = 4.5;         // upward swim speed — enough to breach and climb out
const SWIM_DRAG = 0.65;      // horizontal speed factor in water

// Health returns once you've been out of danger for a moment (kid-friendly).
const REGEN_DELAY = 10;      // seconds without taking damage before healing starts
const REGEN_INTERVAL = 5;    // seconds per +1 heart thereafter

// Held break/place repeat while the button stays down (hold-to-mine).
const ACT_FIRST_REPEAT = 0.3;
const ACT_REPEAT = 0.25;

// Forward vector from yaw/pitch (matches the camera's YXZ orientation).
function lookDir(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  return out.set(-cp * Math.sin(yaw), Math.sin(pitch), -cp * Math.cos(yaw));
}

export class Player {
  constructor(camera, world, scene, dom, spawn, color = 0x3aa657) {
    this.camera = camera;
    this.world = world;
    this.dom = dom;
    this.pos = new THREE.Vector3(spawn.x, spawn.y, spawn.z); // feet position
    this.vel = new THREE.Vector3();
    this.yaw = spawn.yaw || 0;
    this.pitch = spawn.pitch || 0;
    this.onGround = false;
    this.locked = false;
    this.frozen = true;           // held still until spawn chunk loads
    this.keys = new Set();
    this.selected = spawn.selected || 0;   // index into HOTBAR
    this.onBreakPlace = null;     // optional callback(kind)
    this.onEngage = null;         // optional callback when controls engage

    // Health / combat.
    this.maxHp = 10;
    this.hp = 10;
    this.hurtCd = 0;              // brief invulnerability after a hit
    this.dead = false;
    this.sinceHurt = 0;          // seconds since last damage (gates regen)
    this.regenAccum = 0;         // progress toward the next regenerated heart
    this.mobs = null;            // set by main.js; lets a swing hit creatures
    this.onHurt = null;          // callback(hp, maxHp)
    this.onHeal = null;          // callback(hp, maxHp) on regen tick
    this.onDeath = null;         // callback() when hp hits 0
    this.onPause = null;         // callback() when touch controls ask to pause
    this.onStrike = null;        // callback(x,y,z,block) for Firestone strikes; true = handled
    this.lastDamage = null;      // what hit us last ('wolf', 'blast', …) for the death screen
    this.kb = new THREE.Vector3();  // knockback impulse, decays over time
    this.inWater = false;
    this._wasInWater = false;

    this.mobile = false;          // set true to use touch controls
    this.touchMove = { x: 0, y: 0 };  // joystick: x=strafe, y=forward (-1..1)
    this.wantJump = false;        // virtual jump button held
    this.stepDist = 0;            // distance accumulator for footstep sounds
    this.shakeTime = 0;           // camera-shake timer (explosions)

    // Third-person view: 0 = first person, 1 = behind the character.
    this.view = 0;
    this.character = new Character(scene, color);
    this.character.setVisible(false);
    this._dir = new THREE.Vector3();
    this._speed = 0;

    // Hold-to-mine / hold-to-place state.
    this._holdBreak = false;
    this._holdPlace = false;
    this._actT = 0;

    // Scratch vectors: the movement/targeting path runs every frame, so avoid
    // allocating in it (GC hitches on tablets).
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._rayOrigin = new THREE.Vector3();
    this._rayDir = new THREE.Vector3();

    // Wireframe highlight on the targeted block.
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    this.highlight = new THREE.LineSegments(
      edges, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
    this.highlight.visible = false;
    scene.add(this.highlight);

    this._bindInput();
  }

  // Engage controls from a user gesture: pointer-lock on desktop, or just
  // start playing on touch devices (where pointer-lock doesn't apply).
  engage() {
    audio.resume();
    if (this.mobile) {
      this.locked = true;
      if (this.onEngage) this.onEngage();
    } else {
      this.dom.requestPointerLock();
    }
  }

  applyLook(dx, dy) {
    this.yaw -= dx * 0.0024;
    this.pitch -= dy * 0.0024;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  selectBlock(i) {
    this.selected = ((i % HOTBAR.length) + HOTBAR.length) % HOTBAR.length;
  }

  toggleView() {
    this.view = this.view ? 0 : 1;
    this.character.setVisible(this.view === 1);
  }

  _bindInput() {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.locked && !this.mobile) this.applyLook(e.movementX, e.movementY);
    });
    document.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= HOTBAR.length) this.selectBlock(n - 1);
      }
      if (e.code === 'KeyV') this.toggleView();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || this.mobile) return;
      if (e.button === 0) this.beginBreak();
      else if (e.button === 2) this.beginPlace();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.endBreak();
      else if (e.button === 2) this.endPlace();
    });
    // Scroll to change the selected block.
    document.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.selectBlock(this.selected + (e.deltaY > 0 ? 1 : -1));
    }, { passive: true });
  }

  // Hold-to-mine / hold-to-place: act now, then repeat while held (see update).
  beginBreak() { this._break(); this._holdBreak = true; this._actT = ACT_FIRST_REPEAT; }
  endBreak() { this._holdBreak = false; }
  beginPlace() { this._place(); this._holdPlace = true; this._actT = ACT_FIRST_REPEAT; }
  endPlace() { this._holdPlace = false; }

  _forward() {
    const f = this._fwd;
    this.camera.getWorldDirection(f);
    f.y = 0;
    return f.normalize();
  }

  collides() {
    const eps = 0.001;
    const minX = Math.floor(this.pos.x - HALF_W + eps);
    const maxX = Math.floor(this.pos.x + HALF_W - eps);
    const minY = Math.floor(this.pos.y + eps);
    const maxY = Math.floor(this.pos.y + HEIGHT - eps);
    const minZ = Math.floor(this.pos.z - HALF_W + eps);
    const maxZ = Math.floor(this.pos.z + HALF_W - eps);
    for (let y = minY; y <= maxY; y++)
      for (let z = minZ; z <= maxZ; z++)
        for (let x = minX; x <= maxX; x++)
          if (isSolid(this.world.getBlock(x, y, z))) return true;
    return false;
  }

  _moveAxis(axis, amount) {
    const STEP = 0.1;
    let remaining = amount;
    while (Math.abs(remaining) > 1e-9) {
      const s = Math.max(-STEP, Math.min(STEP, remaining));
      this.pos[axis] += s;
      if (this.collides()) { this.pos[axis] -= s; return true; }
      remaining -= s;
    }
    return false;
  }

  update(dt) {
    // Don't simulate until the ground beneath spawn is actually loaded,
    // otherwise the player falls through a not-yet-streamed world.
    if (this.frozen) {
      if (this.world.ready(this.pos.x, this.pos.z)) this.frozen = false;
      else { this._syncCamera(); return; }
    }
    dt = Math.min(dt, 0.05); // clamp big hitches so we never tunnel
    if (this.hurtCd > 0) this.hurtCd -= dt;

    // Regenerate health after staying out of danger long enough.
    this.sinceHurt += dt;
    if (!this.dead && this.hp < this.maxHp && this.sinceHurt >= REGEN_DELAY) {
      this.regenAccum += dt;
      if (this.regenAccum >= REGEN_INTERVAL) {
        this.regenAccum -= REGEN_INTERVAL;
        this.hp = Math.min(this.maxHp, this.hp + 1);
        if (this.onHeal) this.onHeal(this.hp, this.maxHp);
      }
    }

    // Are we in water? (feet or eye — either makes swim physics apply)
    const feetIn = this.world.getBlock(Math.floor(this.pos.x),
      Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z)) === WATER;
    const eyeIn = this.world.getBlock(Math.floor(this.pos.x),
      Math.floor(this.pos.y + EYE), Math.floor(this.pos.z)) === WATER;
    this.inWater = feetIn || eyeIn;
    if (this.inWater && !this._wasInWater && this.vel.y < -3) audio.playSplash();
    this._wasInWater = this.inWater;

    const f = this._forward();
    const right = this._right.crossVectors(f, UP).normalize();
    const wish = this._wish.set(0, 0, 0);
    if (this.keys.has('KeyW')) wish.add(f);
    if (this.keys.has('KeyS')) wish.sub(f);
    if (this.keys.has('KeyD')) wish.add(right);
    if (this.keys.has('KeyA')) wish.sub(right);
    // Touch joystick contributes too (y = forward, x = strafe).
    wish.addScaledVector(f, this.touchMove.y);
    wish.addScaledVector(right, this.touchMove.x);

    let speed = this.keys.has('ShiftLeft') ? SPRINT : SPEED;
    if (this.inWater) speed *= SWIM_DRAG;
    if (wish.lengthSq() > 1) wish.normalize();   // cap diagonal/over-input
    wish.multiplyScalar(speed);
    // Knockback rides on top of walk input and fades quickly.
    this.kb.multiplyScalar(Math.max(0, 1 - dt * 6));
    this.vel.x = wish.x + this.kb.x;
    this.vel.z = wish.z + this.kb.z;

    const wantUp = this.keys.has('Space') || this.wantJump;
    if (wantUp && this.onGround) {
      this.vel.y = JUMP;
      this.onGround = false;
    }

    if (this.inWater) {
      // Swim: slow sink by default, hold jump to rise (and breach at the top).
      // A real jump from the bottom keeps its impulse (normal gravity) so you
      // can still hop out of knee-deep water.
      if (wantUp) {
        this.vel.y = this.vel.y > SWIM_UP ? this.vel.y - GRAVITY * dt
          : Math.min(this.vel.y + 30 * dt, SWIM_UP);
      } else {
        this.vel.y -= SWIM_GRAVITY * dt;
        if (this.vel.y < SWIM_SINK_MAX) this.vel.y = SWIM_SINK_MAX;
      }
    } else {
      this.vel.y -= GRAVITY * dt;
      if (this.vel.y < -50) this.vel.y = -50;
    }

    if (this._moveAxis('x', this.vel.x * dt)) this.vel.x = 0;
    if (this._moveAxis('z', this.vel.z * dt)) this.vel.z = 0;
    const hitY = this._moveAxis('y', this.vel.y * dt);
    if (hitY) {
      this.onGround = this.vel.y < 0;
      this.vel.y = 0;
    } else {
      this.onGround = false;
    }

    // Footstep sounds, paced by ground distance travelled.
    const horiz = Math.hypot(this.vel.x, this.vel.z);
    this._speed = horiz;
    if (this.onGround && !this.inWater && horiz > 0.5) {
      this.stepDist += horiz * dt;
      if (this.stepDist > 1.9) { audio.playStep(); this.stepDist = 0; }
    }

    // Repeat break/place while the button is held (mouse or touch).
    if (this._holdBreak || this._holdPlace) {
      this._actT -= dt;
      if (this._actT <= 0) {
        this._actT = ACT_REPEAT;
        if (this._holdBreak) this._break(); else this._place();
      }
    }

    if (this.shakeTime > 0) this.shakeTime = Math.max(0, this.shakeTime - dt * 2.5);

    // Fell out of the world (shouldn't happen) -> respawn up high.
    if (this.pos.y < -10) {
      this.pos.set(this.pos.x, 60, this.pos.z);
      this.vel.set(0, 0, 0);
    }

    this._syncCamera(dt);
    this._updateHighlight();
  }

  shake(amount) {
    this.shakeTime = Math.max(this.shakeTime, amount);
  }

  _syncCamera(dt = 0) {
    const eyeX = this.pos.x, eyeY = this.pos.y + EYE, eyeZ = this.pos.z;
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    if (this.view === 1) {
      // Third person: orbit behind the head, pulled in if a wall is in the way.
      this.character.setTransform(this.pos.x, this.pos.y, this.pos.z, this.yaw);
      this.character.animate(dt, this.onGround ? this._speed : 0, this.pitch);
      lookDir(this.yaw, this.pitch, this._dir);
      let dist = THIRD_DIST;
      const step = 0.25;
      for (let d = step; d <= THIRD_DIST; d += step) {
        if (isSolid(this.world.getBlock(
          Math.floor(eyeX - this._dir.x * d),
          Math.floor(eyeY - this._dir.y * d),
          Math.floor(eyeZ - this._dir.z * d)))) { dist = d - step; break; }
      }
      dist = Math.max(0.6, dist);
      this.camera.position.set(
        eyeX - this._dir.x * dist, eyeY - this._dir.y * dist, eyeZ - this._dir.z * dist);
    } else {
      this.camera.position.set(eyeX, eyeY, eyeZ);
    }

    if (this.shakeTime > 0) {
      const a = 0.35 * this.shakeTime;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camera.position.z += (Math.random() - 0.5) * a;
    }
  }

  // Fast voxel traversal (Amanatides & Woo). Returns the first targetable
  // block and the empty cell just before it (where a new block would go).
  raycast() {
    // Always cast from the player's eye along the look direction, so block
    // targeting is identical in first and third person.
    const origin = this._rayOrigin.set(this.pos.x, this.pos.y + EYE, this.pos.z);
    const dir = lookDir(this.yaw, this.pitch, this._rayDir);

    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (dir.x || 1e-9));
    const tDeltaY = Math.abs(1 / (dir.y || 1e-9));
    const tDeltaZ = Math.abs(1 / (dir.z || 1e-9));
    const boundary = (o, s) => s > 0 ? Math.floor(o) + 1 - o : o - Math.floor(o);
    let tMaxX = boundary(origin.x, stepX) * tDeltaX;
    let tMaxY = boundary(origin.y, stepY) * tDeltaY;
    let tMaxZ = boundary(origin.z, stepZ) * tDeltaZ;

    let px = x, py = y, pz = z;
    let t = 0;
    while (t <= REACH) {
      const b = this.world.getBlock(x, y, z);
      if (b !== AIR && b !== WATER) {
        return { hit: { x, y, z }, prev: { x: px, y: py, z: pz } };
      }
      px = x; py = y; pz = z;
      if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
      else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += tDeltaY; }
      else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
    }
    return null;
  }

  _updateHighlight() {
    const r = this.raycast();
    if (r) {
      this.highlight.visible = true;
      this.highlight.position.set(r.hit.x + 0.5, r.hit.y + 0.5, r.hit.z + 0.5);
    } else {
      this.highlight.visible = false;
    }
  }

  // Take damage, with a short invulnerability window so several mobs can't
  // instantly gang-nuke you. opts.from (a position) adds knockback away from
  // the attacker; opts.source ('wolf', 'blast', …) feeds the death screen.
  hurt(dmg, opts = {}) {
    if (this.dead || this.hurtCd > 0) return;
    this.hp = Math.max(0, this.hp - dmg);
    this.hurtCd = 0.5;
    this.sinceHurt = 0;          // taking damage restarts the regen clock
    this.regenAccum = 0;
    if (opts.source) this.lastDamage = opts.source;
    if (opts.from) {
      const dx = this.pos.x - opts.from.x, dz = this.pos.z - opts.from.z;
      const d = Math.hypot(dx, dz) || 1;
      this.kb.set((dx / d) * 6, 0, (dz / d) * 6);
      if (this.onGround) this.vel.y = Math.max(this.vel.y, 4);   // a little pop
    }
    audio.playHurt();
    if (this.onHurt) this.onHurt(this.hp, this.maxHp);
    if (this.hp <= 0) { this.dead = true; if (this.onDeath) this.onDeath(); }
  }

  _break() {
    // A swing hits a creature you're facing within reach before it breaks a block.
    if (this.mobs) {
      const origin = this._rayOrigin.set(this.pos.x, this.pos.y + EYE, this.pos.z);
      const dir = lookDir(this.yaw, this.pitch, this._rayDir);
      if (this.mobs.playerAttack(origin, dir)) {
        if (this.onBreakPlace) this.onBreakPlace('break');
        return;
      }
    }
    const r = this.raycast();
    if (!r) return;
    const broken = this.world.getBlock(r.hit.x, r.hit.y, r.hit.z);
    this.world.setBlock(r.hit.x, r.hit.y, r.hit.z, AIR);
    this.world.spawnBreakBurst(r.hit.x, r.hit.y, r.hit.z, blockColor(broken));
    audio.playBreak();
    if (this.onBreakPlace) this.onBreakPlace('break');
  }

  _place() {
    const r = this.raycast();
    if (!r) return;

    const held = HOTBAR[this.selected];
    if (held === FIRESTONE) {                  // strike the target block
      const b = this.world.getBlock(r.hit.x, r.hit.y, r.hit.z);
      if (this.onStrike && this.onStrike(r.hit.x, r.hit.y, r.hit.z, b)) return;
      if (b === TNT) {
        this.world.igniteTNT(r.hit.x, r.hit.y, r.hit.z);
      } else {
        audio.playIgnite();                    // just a spark
      }
      return;
    }
    if (isTool(held)) return;                  // other tools don't place

    const { x, y, z } = r.prev;
    // Don't entomb yourself: skip if the new block intersects the player AABB.
    const overlapX = x + 1 > this.pos.x - HALF_W && x < this.pos.x + HALF_W;
    const overlapZ = z + 1 > this.pos.z - HALF_W && z < this.pos.z + HALF_W;
    const overlapY = y + 1 > this.pos.y && y < this.pos.y + HEIGHT;
    if (overlapX && overlapY && overlapZ) return;

    this.world.setBlock(x, y, z, HOTBAR[this.selected]);
    audio.playPlace();
    if (this.onBreakPlace) this.onBreakPlace('place');
  }

  // Drop the player back at a spawn point and let them settle onto the ground.
  respawn(spawn) {
    this.pos.set(spawn.x, spawn.y, spawn.z);
    this.vel.set(0, 0, 0);
    this.kb.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.frozen = true;
    this.hp = this.maxHp;
    this.dead = false;
    this.hurtCd = 0;
    this.sinceHurt = 0;
    this.regenAccum = 0;
    this.shakeTime = 0;
    this.lastDamage = null;
    this._holdBreak = this._holdPlace = false;
  }

  // Current state for persistence.
  state() {
    return {
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      yaw: this.yaw, pitch: this.pitch, selected: this.selected,
      hotbar: [...HOTBAR],
    };
  }

  // Position-only state for the ~12Hz network stream; reuses one object so the
  // render loop doesn't allocate every frame.
  posState() {
    const s = this._posState || (this._posState = {});
    s.x = this.pos.x; s.y = this.pos.y; s.z = this.pos.z;
    s.yaw = this.yaw; s.pitch = this.pitch;
    return s;
  }
}
