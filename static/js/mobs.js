// Ambient wildlife: land animals (pigs, sheep, cows, wolves, chickens, spiders)
// that wander on grass, plus squid that swim in lakes and oceans. They spawn
// near the player, amble/swim with a little AI, and despawn when far away.
// Client-side and ambient — they don't fight, drop items, or sync across
// multiplayer; they're just life in the world.

import * as THREE from 'three';
import { DIM } from './engine/constants.js';
import { isSolid, GRASS, WATER } from './blocks.js';
import * as audio from './audio.js';

// Each animal picks a body plan (shape) and its colours/sizes/speed. `aquatic`
// marks water-only creatures. When /static/textures/mob_<type>.png exists it is
// used as the skin and overrides the flat colours (see loadMobSkins).
const TYPES = {
  pig:     { shape: 'quad',    body: 0xe89bb0, head: 0xe07a96, w: 0.62, bh: 0.5,  l: 0.9,  legH: 0.32, legW: 0.16, hd: 0.4,  speed: 1.5, hp: 8 },
  sheep:   { shape: 'quad',    body: 0xeae7dc, head: 0xd6c6ad, w: 0.62, bh: 0.6,  l: 0.8,  legH: 0.34, legW: 0.15, hd: 0.34, speed: 1.2, hp: 8 },
  cow:     { shape: 'quad',    body: 0x6e4b34, head: 0x4a3322, w: 0.72, bh: 0.62, l: 1.0,  legH: 0.42, legW: 0.18, hd: 0.42, speed: 1.1, hp: 10 },
  wolf:    { shape: 'quad',    body: 0x9b9b9b, head: 0x8b8b8b, w: 0.48, bh: 0.48, l: 0.92, legH: 0.44, legW: 0.14, hd: 0.34, speed: 2.5, tail: true, hp: 12, hostile: true, attack: 2 },
  chicken: { shape: 'chicken', body: 0xffffff, head: 0xf2f2f2, w: 0.34, bh: 0.32, l: 0.4,  legH: 0.24, legW: 0.07, hd: 0.24, speed: 1.5, foot: 0xe6a020, comb: 0xd23b3b, hp: 4 },
  spider:  { shape: 'spider',  body: 0x2a2320, head: 0x1c1614, w: 0.7,  bh: 0.34, l: 0.7,  legH: 0.3,  legW: 0.07, hd: 0.4,  speed: 2.2, eye: 0xb03030, night: true, hp: 8, hostile: true, attack: 1 },
  squid:   { shape: 'squid',   aquatic: true, body: 0x7a2a5a, head: 0x7a2a5a, w: 0.5, bh: 0.66, l: 0.5, legW: 0.09, speed: 1.1, hp: 8, hostile: true, attack: 1 },
};
const TYPE_KEYS = Object.keys(TYPES);
const LAND_KEYS = TYPE_KEYS.filter((k) => !TYPES[k].aquatic);
const WATER_KEYS = TYPE_KEYS.filter((k) => TYPES[k].aquatic);

const GRAVITY = 24, TURN = 2.2;
const TARGET_MOBS = 8;      // population kept alive around the player
const SPAWN_MIN = 12, SPAWN_MAX = 26, DESPAWN = 42;

// Combat tuning.
const DETECT = 11;          // hostile aggro range (blocks)
const ATTACK_RANGE = 1.7;   // how close a hostile must be to land a hit
const ATTACK_INTERVAL = 1.0;// seconds between a mob's hits
const PLAYER_REACH = 3.4;   // how far the player's swing reaches a creature
const PLAYER_DMG = 4;       // damage per swing

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

// A limb/tentacle: a box hanging below a pivot group placed at the joint, so the
// group can be rotated to swing it.
function makeLimb(w, h, d, mat, x, pivotY, z) {
  const g = new THREE.Group();
  g.position.set(x, pivotY, z);
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.y = -h / 2;
  g.add(m);
  return g;
}

function addEyes(head, hd, spread, mat) {
  for (const sx of [-spread, spread]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.02), mat);
    eye.position.set(sx, hd * 0.1, -hd / 2 - 0.005);
    head.add(eye);
  }
}

// --- body-plan builders: each adds meshes to `group` and returns the list of
//     animated limbs (legs/tentacles), front-to-back where it matters. ---------
function buildQuad(t, mats, group) {
  const body = new THREE.Mesh(new THREE.BoxGeometry(t.w, t.bh, t.l), mats.body);
  body.position.y = t.legH + t.bh / 2;
  group.add(body);

  const head = new THREE.Mesh(new THREE.BoxGeometry(t.hd, t.hd, t.hd), mats.head);
  head.position.set(0, t.legH + t.bh * 0.75, -t.l / 2 - t.hd * 0.3);
  addEyes(head, t.hd, 0.1, mats.eye);
  group.add(head);

  if (t.tail) {
    const tail = new THREE.Mesh(new THREE.BoxGeometry(t.legW, t.legW, t.hd * 0.8), mats.leg);
    tail.position.set(0, t.legH + t.bh * 0.7, t.l / 2 + t.hd * 0.25);
    group.add(tail);
  }

  const legs = [];
  const lx = t.w / 2 - t.legW / 2, lz = t.l / 2 - t.legW;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const g = makeLimb(t.legW, t.legH, t.legW, mats.leg, sx * lx, t.legH, sz * lz);
    group.add(g); legs.push(g);
  }
  return legs;
}

function buildChicken(t, mats, group) {
  const foot = new THREE.MeshLambertMaterial({ color: t.foot });

  const body = new THREE.Mesh(new THREE.BoxGeometry(t.w, t.bh, t.l), mats.body);
  body.position.y = t.legH + t.bh / 2;
  group.add(body);

  const head = new THREE.Mesh(new THREE.BoxGeometry(t.hd, t.hd, t.hd), mats.head);
  head.position.set(0, t.legH + t.bh + t.hd * 0.25, -t.l / 2 - t.hd * 0.05);
  addEyes(head, t.hd, 0.09, mats.eye);
  const beak = new THREE.Mesh(new THREE.BoxGeometry(t.hd * 0.45, t.hd * 0.3, t.hd * 0.4), foot);
  beak.position.set(0, -t.hd * 0.1, -t.hd / 2 - t.hd * 0.1);
  head.add(beak);
  const comb = new THREE.Mesh(new THREE.BoxGeometry(t.hd * 0.18, t.hd * 0.28, t.hd * 0.55),
    new THREE.MeshLambertMaterial({ color: t.comb }));
  comb.position.set(0, t.hd * 0.55, 0.02);
  head.add(comb);
  group.add(head);

  // stubby wings flat against the sides
  for (const sx of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(t.legW, t.bh * 0.8, t.l * 0.7), mats.body);
    wing.position.set(sx * (t.w / 2 + 0.005), t.legH + t.bh / 2, 0);
    group.add(wing);
  }

  const legs = [];
  for (const sx of [-1, 1]) {
    const g = makeLimb(t.legW, t.legH, t.legW, foot, sx * t.w * 0.22, t.legH, 0);
    group.add(g); legs.push(g);
  }
  return legs;
}

function buildSpider(t, mats, group) {
  // Two body lumps: a round abdomen at the back, a smaller head at the front.
  const abd = new THREE.Mesh(new THREE.BoxGeometry(t.w * 0.8, t.bh, t.l * 0.7), mats.body);
  abd.position.set(0, t.legH, t.l * 0.22);
  group.add(abd);
  const ceph = new THREE.Mesh(new THREE.BoxGeometry(t.w * 0.55, t.bh * 0.9, t.l * 0.5), mats.head);
  ceph.position.set(0, t.legH, -t.l * 0.25);
  group.add(ceph);
  // a cluster of little red eyes on the front
  const eyeMat = new THREE.MeshBasicMaterial({ color: t.eye });
  for (const sx of [-0.09, -0.03, 0.03, 0.09]) {
    const e = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.02), eyeMat);
    e.position.set(sx, t.legH + t.bh * 0.18, -t.l * 0.5);
    group.add(e);
  }
  // 8 legs (4 per side), splayed out and down from the body sides
  const legs = [];
  const len = t.legH * 1.7;
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      g.position.set(sx * t.w * 0.4, t.legH + t.bh * 0.25, (-1.3 + i * 0.85) * (t.l * 0.26));
      const seg = new THREE.Mesh(new THREE.BoxGeometry(t.legW, len, t.legW), mats.leg);
      seg.position.set(sx * len * 0.34, -len * 0.34, 0);   // shift so it juts sideways+down
      seg.rotation.z = sx * 0.95;
      g.add(seg);
      group.add(g); legs.push(g);
    }
  }
  return legs;
}

function buildSquid(t, mats, group) {
  const mantle = new THREE.Mesh(new THREE.BoxGeometry(t.w, t.bh, t.l), mats.body);
  mantle.position.y = t.bh / 2;
  group.add(mantle);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(t.w * 0.66, t.bh * 0.4, t.l * 0.66), mats.body);
  cap.position.y = t.bh + t.bh * 0.14;
  group.add(cap);
  // big dark eyes on the sides
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x101018 });
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.06), eyeMat);
    e.position.set(sx * (t.w / 2 + 0.005), t.bh * 0.55, -t.l * 0.18);
    group.add(e);
  }
  // tentacles hang from the underside in a ring
  const legs = [];
  const N = 8, len = t.bh * 0.95;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const g = makeLimb(t.legW, len, t.legW, mats.leg,
      Math.cos(a) * t.w * 0.28, 0.02, Math.sin(a) * t.l * 0.28);
    group.add(g); legs.push(g);
  }
  return legs;
}

const BUILDERS = { quad: buildQuad, chicken: buildChicken, spider: buildSpider, squid: buildSquid };

class Mob {
  constructor(scene, type, x, y, z) {
    this.scene = scene;
    const t = TYPES[type]; this.t = t; this.type = type;
    this.shape = t.shape;
    this.aquatic = !!t.aquatic;
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.targetYaw = this.yaw;
    this.onGround = false;
    this.walking = false;
    this.moving = false;
    this.curSpeed = 0;
    this.timer = 1 + Math.random() * 2;
    this.phase = 0;
    this.bob = Math.random() * 10;

    this.hp = t.hp || 6;
    this.hostile = !!t.hostile;
    this.attackCd = 0;
    this.hurtFlash = 0;
    this.chasing = false;        // was chasing last frame (gates the growl)
    this.kbx = 0; this.kbz = 0;  // knockback impulse, decays over time

    this.group = new THREE.Group();
    const skin = SKIN[type];
    const bodyCol = new THREE.Color(t.body);
    const legCol = bodyCol.clone().multiplyScalar(0.8);
    // With a skin, the texture carries the colour (white tint) and limbs are
    // shaded a touch darker; without one, fall back to the flat body/head hues.
    const mats = {
      body: skin ? new THREE.MeshLambertMaterial({ map: skin })
        : new THREE.MeshLambertMaterial({ color: bodyCol }),
      head: skin ? new THREE.MeshLambertMaterial({ map: skin })
        : new THREE.MeshLambertMaterial({ color: t.head }),
      leg: skin ? new THREE.MeshLambertMaterial({ map: skin, color: 0xcccccc })
        : new THREE.MeshLambertMaterial({ color: legCol }),
      eye: new THREE.MeshBasicMaterial({ color: 0x1a1a1a }),
    };
    this.legs = BUILDERS[t.shape](t, mats, this.group);
    // Lambert materials whose emissive we pulse red on a hit.
    this.flashMats = [mats.body, mats.head, mats.leg];

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    scene.add(this.group);
  }

  // Body-centre point in world space (for hit tests and knock feedback).
  center(out) {
    const yc = this.aquatic ? this.t.bh * 0.5 : (this.t.legH + this.t.bh) * 0.5;
    return (out || new THREE.Vector3()).set(this.pos.x, this.pos.y + yc, this.pos.z);
  }

  // `dir` (optional, unit-ish vector) knocks the creature away from the blow —
  // without it a wolf just stands in your face trading hits.
  hurt(dmg, dir) {
    this.hp -= dmg;
    this.hurtFlash = 0.14;
    if (dir) {
      this.kbx = dir.x * 7; this.kbz = dir.z * 7;
      if (!this.aquatic && this.onGround) this.vel.y = Math.max(this.vel.y, 4.5);
    }
    for (const m of this.flashMats) if (m.emissive) m.emissive.setHex(0x661111);
  }

  // Deal damage to the player if in range and off cooldown.
  _tryAttack(player, dist) {
    if (dist <= ATTACK_RANGE && this.attackCd <= 0 &&
        player && player.locked && !player.frozen && !player.dead) {
      player.hurt(this.t.attack || 1, { from: this.pos, source: this.type });
      this.attackCd = ATTACK_INTERVAL;
    }
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

  // Horizontal move that can climb a single-block step, the way the player gets
  // up a ledge by jumping. Returns true if still blocked after trying to step.
  _stepMove(world, axis, amount) {
    if (!this._moveAxis(world, axis, amount)) return false;   // moved freely
    if (!this.onGround) return true;                          // can't step mid-air
    const startY = this.pos.y;
    this.pos.y += 1.0;                                        // hop up one block…
    if (this._collides(world)) { this.pos.y = startY; return true; }   // no headroom
    if (this._moveAxis(world, axis, amount)) { this.pos.y = startY; return true; } // step too tall
    return false;                                            // stepped up; gravity settles it
  }

  _inWater(world, x, y, z) {
    return world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === WATER;
  }

  update(dt, world, player) {
    if (this.aquatic) this._swim(dt, world, player);
    else this._walk(dt, world, player);
    this._animate(dt);
    if (this.attackCd > 0) this.attackCd -= dt;
    if (this.hurtFlash > 0) {
      this.hurtFlash -= dt;
      if (this.hurtFlash <= 0) for (const m of this.flashMats) if (m.emissive) m.emissive.setHex(0x000000);
    }
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
  }

  // Land movement: wander, gravity + voxel collision, don't walk off cliffs.
  // Hostiles instead home in on a nearby player and bite.
  _walk(dt, world, player) {
    this.timer -= dt;
    if (this.timer <= 0) this._chooseAction();

    let chasing = false;
    if (this.hostile && player) {
      const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < DETECT) {
        chasing = true;
        this.walking = true;
        this.targetYaw = Math.atan2(-dx, -dz);   // face the player
        this._tryAttack(player, dist);
      }
    }
    if (chasing && !this.chasing) audio.playGrowl(this.pos);   // fair warning!
    this.chasing = chasing;

    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw += Math.max(-TURN * dt, Math.min(TURN * dt, dy));

    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let speed = this.walking ? this.t.speed * (chasing ? 1.15 : 1) : 0;

    if (this.walking) {
      const ax = Math.floor(this.pos.x + fx * 0.7), az = Math.floor(this.pos.z + fz * 0.7);
      const groundAhead = isSolid(world.getBlock(ax, Math.floor(this.pos.y - 0.4), az)) ||
                          isSolid(world.getBlock(ax, Math.floor(this.pos.y - 1.2), az));
      // Water counts as a cliff: land animals shouldn't stroll into lakes (and
      // wolves can't chase you in where you out-swim them).
      const waterAhead = world.getBlock(ax, Math.floor(this.pos.y + 0.1), az) === WATER ||
                         world.getBlock(ax, Math.floor(this.pos.y - 0.4), az) === WATER;
      // Don't walk off cliffs — but a chasing hostile just stops at the edge
      // instead of turning away, so it stays locked on.
      if (!groundAhead || waterAhead) { speed = 0; if (!chasing) { this.walking = false; this.timer = 0.4; this.targetYaw = this.yaw + 2.2; } }
    }

    // Knockback fades fast; it rides on top of the walk velocity.
    this.kbx *= Math.max(0, 1 - dt * 6); this.kbz *= Math.max(0, 1 - dt * 6);
    this.vel.x = fx * speed + this.kbx;
    this.vel.z = fz * speed + this.kbz;
    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -40) this.vel.y = -40;
    // Fell in anyway (knockback, collapsing shoreline)? Float up so it can
    // paddle out instead of trudging along the lakebed.
    if (world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.2), Math.floor(this.pos.z)) === WATER) {
      this.vel.y = Math.max(this.vel.y, 1.5);
    }

    if (this._stepMove(world, 'x', this.vel.x * dt)) { if (!chasing) this.targetYaw = this.yaw + 1.5; this.vel.x = 0; }
    if (this._stepMove(world, 'z', this.vel.z * dt)) { if (!chasing) this.targetYaw = this.yaw + 1.5; this.vel.z = 0; }
    const hitY = this._moveAxis(world, 'y', this.vel.y * dt);
    if (hitY) { this.onGround = this.vel.y < 0; this.vel.y = 0; } else this.onGround = false;

    this.curSpeed = speed;
    this.moving = speed > 0 && this.onGround;
  }

  // Water movement: drift on a heading, turn back at the water's edge, and bob
  // up and down while staying fully submerged.
  _swim(dt, world, player) {
    this.timer -= dt;
    if (this.timer <= 0) { this.targetYaw = this.yaw + (Math.random() - 0.5) * 3.0; this.timer = 1.5 + Math.random() * 2.5; }

    // Home toward a nearby player (still confined to water) and bite if close.
    if (this.hostile && player) {
      const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
      if (Math.hypot(dx, dz) < DETECT) this.targetYaw = Math.atan2(-dx, -dz);
      this._tryAttack(player, Math.hypot(dx, player.pos.y - this.pos.y, dz));
    }

    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw += Math.max(-TURN * dt, Math.min(TURN * dt, dy));

    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const spd = this.t.speed;
    this.kbx *= Math.max(0, 1 - dt * 4); this.kbz *= Math.max(0, 1 - dt * 4);
    const nx = this.pos.x + (fx * spd + this.kbx) * dt, nz = this.pos.z + (fz * spd + this.kbz) * dt;
    // Only advance into water; a wall of terrain or the shore turns it around.
    if (this._inWater(world, nx, this.pos.y, nz)) { this.pos.x = nx; this.pos.z = nz; }
    else { this.targetYaw = this.yaw + 2.4; this.timer = Math.min(this.timer, 0.4); }

    // Gentle vertical drift, but keep both bottom and top of the body in water
    // so it never breaches the surface or sinks into the floor.
    this.bob += dt;
    const ny = this.pos.y + Math.sin(this.bob * 0.8) * 0.35 * dt;   // gentle rise/sink
    if (this._inWater(world, this.pos.x, ny, this.pos.z) &&
        this._inWater(world, this.pos.x, ny + this.t.bh, this.pos.z)) {
      this.pos.y = ny;
    }

    this.curSpeed = spd;
    this.moving = true;
  }

  _animate(dt) {
    // Squid tentacles always undulate, even while hovering.
    if (this.shape === 'squid') {
      this.phase += dt * 3;
      for (let i = 0; i < this.legs.length; i++)
        this.legs[i].rotation.x = 0.15 + Math.sin(this.phase + i * 0.7) * 0.28;
      return;
    }
    const moving = this.moving;
    this.phase += dt * (2 + this.curSpeed * 3) * (moving ? 1 : 0);
    const sw = Math.sin(this.phase) * (moving ? 0.6 : 0);
    const legs = this.legs;
    if (this.shape === 'chicken') {
      legs[0].rotation.x = sw; legs[1].rotation.x = -sw;
    } else if (this.shape === 'spider') {
      for (let i = 0; i < legs.length; i++)
        legs[i].rotation.x = Math.sin(this.phase + i * 0.8) * 0.22 * (moving ? 1 : 0.25);
    } else { // quad: diagonal gait
      legs[0].rotation.x = sw; legs[3].rotation.x = sw;
      legs[1].rotation.x = -sw; legs[2].rotation.x = -sw;
    }
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
    this.peaceful = false;    // per-world toggle: hostiles neither spawn nor attack
    loadMobSkins(textures);   // use any /static/textures/mob_<type>.png that exist
  }

  update(dt, player, daylight = 1) {
    const playerPos = player.pos;
    // In peaceful mode mobs never see the player, which disables chase + bite.
    const target = this.peaceful ? null : player;
    // Keep the world populated: top up toward the target count, refilling faster
    // while we're short (e.g. just after something was killed or wandered off).
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const short = this.mobs.length < TARGET_MOBS;
      this.spawnTimer = short ? 0.8 + Math.random() * 1.2 : 2.5 + Math.random() * 3;
      if (short) this._trySpawn(playerPos, daylight);
    }
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      m.update(dt, this.world, target);
      if (m.hp <= 0) {   // killed — puff of its body colour, remove, and reseed
        this.world.spawnBreakBurst(m.pos.x, m.pos.y + 0.4, m.pos.z, m.t.body);
        audio.playMobDeath({ x: m.pos.x, y: m.pos.y + 0.4, z: m.pos.z });
        m.dispose(); this.mobs.splice(i, 1);
        this._reseed(m.type, playerPos, daylight);   // replacement appears elsewhere
        continue;
      }
      if (m.pos.distanceTo(playerPos) > DESPAWN || m.pos.y < -6) { m.dispose(); this.mobs.splice(i, 1); }
    }
  }

  // The player swung: damage the nearest creature within reach and roughly in
  // front of the camera. Returns true if one was hit (so the block break is
  // skipped in favour of the attack).
  playerAttack(origin, dir) {
    let best = null, bestDist = Infinity;
    const c = new THREE.Vector3();
    for (const m of this.mobs) {
      m.center(c);
      const dist = c.distanceTo(origin);
      if (dist > PLAYER_REACH || dist < 1e-3) continue;
      c.sub(origin).multiplyScalar(1 / dist);   // unit vector toward the mob
      if (c.dot(dir) < 0.72) continue;           // within ~44° of the look direction
      if (dist < bestDist) { bestDist = dist; best = m; }
    }
    if (!best) return false;
    best.hurt(PLAYER_DMG, dir);                  // knocked back along the swing
    audio.playMobHit({ x: best.pos.x, y: best.pos.y + 0.4, z: best.pos.z });
    return true;
  }

  // A random grass surface a comfortable distance from the player, or null.
  _findLandSpot(playerPos) {
    const ang = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const x = Math.floor(playerPos.x + Math.cos(ang) * dist);
    const z = Math.floor(playerPos.z + Math.sin(ang) * dist);
    for (let y = DIM.WY - 1; y > 1; y--) {
      const b = this.world.getBlock(x, y, z);
      if (isSolid(b)) return b === GRASS ? { x: x + 0.5, y: y + 1, z: z + 0.5 } : null;
    }
    return null;
  }

  // A random spot in deep-enough water a distance from the player, or null.
  _findWaterSpot(playerPos) {
    const ang = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const x = Math.floor(playerPos.x + Math.cos(ang) * dist);
    const z = Math.floor(playerPos.z + Math.sin(ang) * dist);
    const wl = DIM.water;
    // Two blocks of water below the surface gives room to swim.
    if (this.world.getBlock(x, wl - 1, z) === WATER && this.world.getBlock(x, wl - 2, z) === WATER)
      return { x: x + 0.5, y: wl - 1.2, z: z + 0.5 };
    return null;
  }

  // Try to place one mob of `type` away from the player. Returns true if spawned.
  _spawnType(type, playerPos, daylight) {
    const t = TYPES[type];
    if (this.peaceful && t.hostile) return false;      // friendly animals only
    if (t.night && daylight >= 0.35) return false;     // nocturnal, and it's daytime
    const spot = t.aquatic ? this._findWaterSpot(playerPos) : this._findLandSpot(playerPos);
    if (!spot) return false;
    this.mobs.push(new Mob(this.scene, type, spot.x, spot.y, spot.z));
    return true;
  }

  _trySpawn(playerPos, daylight) {
    const night = daylight < 0.35;
    // A quarter of the time try the water, otherwise a random eligible land type.
    if (WATER_KEYS.length && Math.random() < 0.25) {
      this._spawnType(WATER_KEYS[Math.floor(Math.random() * WATER_KEYS.length)], playerPos, daylight);
      return;
    }
    const pool = LAND_KEYS.filter((k) => (night || !TYPES[k].night)
      && !(this.peaceful && TYPES[k].hostile));
    if (pool.length) this._spawnType(pool[Math.floor(Math.random() * pool.length)], playerPos, daylight);
  }

  // Replace a killed creature elsewhere on the map so the population holds — the
  // same species when it can spawn right now, otherwise any eligible one.
  _reseed(type, playerPos, daylight) {
    if (this.mobs.length >= TARGET_MOBS) return;
    if (!this._spawnType(type, playerPos, daylight)) this._trySpawn(playerPos, daylight);
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
