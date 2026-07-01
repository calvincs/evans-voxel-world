// Friendly wandering animals (pigs, sheep, cows). Simple blocky quadrupeds
// that spawn on grass near the player, amble around with a little AI, and
// despawn when far away. Client-side and ambient — they don't fight, drop
// items, or (yet) sync across multiplayer; they're just life in the world.

import * as THREE from 'three';
import { DIM } from './engine/constants.js';
import { isSolid, GRASS } from './blocks.js';

const TYPES = {
  pig:   { body: 0xe89bb0, head: 0xe07a96, w: 0.62, bh: 0.5,  l: 0.9, legH: 0.32, legW: 0.16, hd: 0.4,  speed: 1.5 },
  sheep: { body: 0xeae7dc, head: 0xd6c6ad, w: 0.62, bh: 0.6,  l: 0.8, legH: 0.34, legW: 0.15, hd: 0.34, speed: 1.2 },
  cow:   { body: 0x6e4b34, head: 0x4a3322, w: 0.72, bh: 0.62, l: 1.0, legH: 0.42, legW: 0.18, hd: 0.42, speed: 1.1 },
};
const TYPE_KEYS = Object.keys(TYPES);

const GRAVITY = 24, TURN = 2.2;
const MAX_MOBS = 8, SPAWN_MIN = 12, SPAWN_MAX = 26, DESPAWN = 42;

// Optional AI-generated skins live at /static/textures/mob_<type>.png. When one
// exists it's loaded once and shared by every mob of that type; otherwise the
// mob keeps its flat colours, so no art is required. `loadMobSkins` is handed
// the list of available texture names (from /api/assets) to avoid 404 probes.
const SKIN = {};   // type -> THREE.Texture
export function loadMobSkins(available = []) {
  const have = new Set(available);
  const loader = new THREE.TextureLoader();
  for (const type of TYPE_KEYS) {
    const name = `mob_${type}`;
    if (SKIN[type] || !have.has(name)) continue;
    const tex = loader.load(`/static/textures/${name}.png`);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    SKIN[type] = tex;
  }
}

class Mob {
  constructor(scene, type, x, y, z) {
    this.scene = scene;
    const t = TYPES[type]; this.t = t;
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.targetYaw = this.yaw;
    this.onGround = false;
    this.walking = false;
    this.timer = 1 + Math.random() * 2;
    this.phase = 0;

    this.group = new THREE.Group();
    const skin = SKIN[type];
    const bodyCol = new THREE.Color(t.body);
    const legCol = bodyCol.clone().multiplyScalar(0.8);

    // With a skin, the texture carries the colour (white tint) and legs are just
    // shaded a touch darker; without one, fall back to the flat body/head hues.
    const bodyMat = skin ? new THREE.MeshLambertMaterial({ map: skin })
      : new THREE.MeshLambertMaterial({ color: bodyCol });
    const headMat = skin ? new THREE.MeshLambertMaterial({ map: skin })
      : new THREE.MeshLambertMaterial({ color: t.head });
    const legMat = skin ? new THREE.MeshLambertMaterial({ map: skin, color: 0xcccccc })
      : new THREE.MeshLambertMaterial({ color: legCol });

    const body = new THREE.Mesh(new THREE.BoxGeometry(t.w, t.bh, t.l), bodyMat);
    body.position.y = t.legH + t.bh / 2;
    this.group.add(body);

    const head = new THREE.Mesh(new THREE.BoxGeometry(t.hd, t.hd, t.hd), headMat);
    head.position.set(0, t.legH + t.bh * 0.75, -t.l / 2 - t.hd * 0.3);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    for (const sx of [-0.1, 0.1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.02), eyeMat);
      eye.position.set(sx, t.hd * 0.1, -t.hd / 2 - 0.005);
      head.add(eye);
    }
    this.group.add(head);

    this.legs = [];
    const lx = t.w / 2 - t.legW / 2, lz = t.l / 2 - t.legW;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const g = new THREE.Group();
      g.position.set(sx * lx, t.legH, sz * lz);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(t.legW, t.legH, t.legW), legMat);
      leg.position.y = -t.legH / 2;
      g.add(leg);
      this.group.add(g);
      this.legs.push(g);
    }

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    scene.add(this.group);
  }

  _chooseAction() {
    if (Math.random() < 0.45) { this.walking = true; this.targetYaw = Math.random() * Math.PI * 2; this.timer = 1.5 + Math.random() * 2.5; }
    else { this.walking = false; this.timer = 1 + Math.random() * 2.5; }
  }

  _collides(world) {
    const t = this.t, hw = t.w * 0.45, h = t.legH + t.bh, eps = 0.001;
    const x0 = Math.floor(this.pos.x - hw + eps), x1 = Math.floor(this.pos.x + hw - eps);
    const y0 = Math.floor(this.pos.y + eps), y1 = Math.floor(this.pos.y + h - eps);
    const z0 = Math.floor(this.pos.z - hw + eps), z1 = Math.floor(this.pos.z + hw - eps);
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (isSolid(world.getBlock(x, y, z))) return true;
    return false;
  }

  _moveAxis(world, axis, amount) {
    const STEP = 0.1;
    let rem = amount;
    while (Math.abs(rem) > 1e-9) {
      const s = Math.max(-STEP, Math.min(STEP, rem));
      this.pos[axis] += s;
      if (this._collides(world)) { this.pos[axis] -= s; return true; }
      rem -= s;
    }
    return false;
  }

  update(dt, world) {
    this.timer -= dt;
    if (this.timer <= 0) this._chooseAction();

    // Turn toward the target heading.
    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw += Math.max(-TURN * dt, Math.min(TURN * dt, dy));

    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let speed = this.walking ? this.t.speed : 0;

    // Don't walk off cliffs: if there's no ground just ahead, stop and turn.
    if (this.walking) {
      const ax = Math.floor(this.pos.x + fx * 0.7), az = Math.floor(this.pos.z + fz * 0.7);
      const groundAhead = isSolid(world.getBlock(ax, Math.floor(this.pos.y - 0.4), az)) ||
                          isSolid(world.getBlock(ax, Math.floor(this.pos.y - 1.2), az));
      if (!groundAhead) { this.walking = false; speed = 0; this.timer = 0.4; this.targetYaw = this.yaw + 2.2; }
    }

    this.vel.x = fx * speed;
    this.vel.z = fz * speed;
    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -40) this.vel.y = -40;

    if (this._moveAxis(world, 'x', this.vel.x * dt)) { this.targetYaw = this.yaw + 1.5; this.vel.x = 0; }
    if (this._moveAxis(world, 'z', this.vel.z * dt)) { this.targetYaw = this.yaw + 1.5; this.vel.z = 0; }
    const hitY = this._moveAxis(world, 'y', this.vel.y * dt);
    if (hitY) { this.onGround = this.vel.y < 0; this.vel.y = 0; } else this.onGround = false;

    // Leg animation (diagonal gait).
    const moving = speed > 0 && this.onGround;
    this.phase += dt * (2 + speed * 3) * (moving ? 1 : 0);
    const sw = Math.sin(this.phase) * (moving ? 0.6 : 0);
    this.legs[0].rotation.x = sw;  this.legs[3].rotation.x = sw;
    this.legs[1].rotation.x = -sw; this.legs[2].rotation.x = -sw;

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
}

export class Mobs {
  constructor(scene, world, textures = []) {
    this.scene = scene;
    this.world = world;
    this.mobs = [];
    this.spawnTimer = 2;
    loadMobSkins(textures);   // use any /static/textures/mob_<type>.png that exist
  }

  update(dt, playerPos) {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 2.5 + Math.random() * 3;
      if (this.mobs.length < MAX_MOBS) this._trySpawn(playerPos);
    }
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      m.update(dt, this.world);
      if (m.pos.distanceTo(playerPos) > DESPAWN || m.pos.y < -6) { m.dispose(); this.mobs.splice(i, 1); }
    }
  }

  _trySpawn(playerPos) {
    const ang = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const x = Math.floor(playerPos.x + Math.cos(ang) * dist);
    const z = Math.floor(playerPos.z + Math.sin(ang) * dist);
    // Find the surface; only spawn on grass.
    let surfaceY = null;
    for (let y = DIM.WY - 1; y > 1; y--) {
      const b = this.world.getBlock(x, y, z);
      if (isSolid(b)) { if (b === GRASS) surfaceY = y; break; }
    }
    if (surfaceY === null) return;
    const type = TYPE_KEYS[Math.floor(Math.random() * TYPE_KEYS.length)];
    this.mobs.push(new Mob(this.scene, type, x + 0.5, surfaceY + 1, z + 0.5));
  }

  // Spawn a specific animal at a spot (used for testing/screenshots).
  spawnAt(type, x, y, z) {
    const m = new Mob(this.scene, type, x, y, z);
    this.mobs.push(m);
    return m;
  }

  clear() {
    for (const m of this.mobs) m.dispose();
    this.mobs = [];
  }
}
