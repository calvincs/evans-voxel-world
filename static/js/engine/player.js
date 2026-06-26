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

// Forward vector from yaw/pitch (matches the camera's YXZ orientation).
function lookDir(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  return out.set(-cp * Math.sin(yaw), Math.sin(pitch), -cp * Math.cos(yaw));
}

export class Player {
  constructor(camera, world, scene, dom, spawn) {
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

    this.mobile = false;          // set true to use touch controls
    this.touchMove = { x: 0, y: 0 };  // joystick: x=strafe, y=forward (-1..1)
    this.wantJump = false;        // virtual jump button held
    this.stepDist = 0;            // distance accumulator for footstep sounds
    this.shakeTime = 0;           // camera-shake timer (explosions)

    // Third-person view: 0 = first person, 1 = behind the character.
    this.view = 0;
    this.character = new Character(scene, 0x3aa657);
    this.character.setVisible(false);
    this._dir = new THREE.Vector3();
    this._speed = 0;

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
        this.selectBlock(n === 0 ? 9 : n - 1);
      }
      if (e.code === 'KeyV') this.toggleView();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || this.mobile) return;
      if (e.button === 0) this._break();
      else if (e.button === 2) this._place();
    });
    // Scroll to change the selected block.
    document.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.selectBlock(this.selected + (e.deltaY > 0 ? 1 : -1));
    }, { passive: true });
  }

  _forward() {
    const f = new THREE.Vector3();
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

    const f = this._forward();
    const right = new THREE.Vector3().crossVectors(f, UP).normalize();
    let wish = new THREE.Vector3();
    if (this.keys.has('KeyW')) wish.add(f);
    if (this.keys.has('KeyS')) wish.sub(f);
    if (this.keys.has('KeyD')) wish.add(right);
    if (this.keys.has('KeyA')) wish.sub(right);
    // Touch joystick contributes too (y = forward, x = strafe).
    wish.addScaledVector(f, this.touchMove.y);
    wish.addScaledVector(right, this.touchMove.x);

    const speed = this.keys.has('ShiftLeft') ? SPRINT : SPEED;
    if (wish.lengthSq() > 1) wish.normalize();   // cap diagonal/over-input
    wish.multiplyScalar(speed);
    this.vel.x = wish.x;
    this.vel.z = wish.z;

    if ((this.keys.has('Space') || this.wantJump) && this.onGround) {
      this.vel.y = JUMP;
      this.onGround = false;
    }

    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -50) this.vel.y = -50;

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
    if (this.onGround && horiz > 0.5) {
      this.stepDist += horiz * dt;
      if (this.stepDist > 1.9) { audio.playStep(); this.stepDist = 0; }
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
    const origin = new THREE.Vector3(this.pos.x, this.pos.y + EYE, this.pos.z);
    const dir = lookDir(this.yaw, this.pitch, new THREE.Vector3());

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

  _break() {
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
    if (held === FIRESTONE) {                  // light TNT instead of placing
      if (this.world.getBlock(r.hit.x, r.hit.y, r.hit.z) === TNT) {
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
    this.yaw = 0;
    this.pitch = 0;
    this.frozen = true;
  }

  // Current state for persistence.
  state() {
    return {
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      yaw: this.yaw, pitch: this.pitch, selected: this.selected,
    };
  }
}
