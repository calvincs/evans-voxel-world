// Creature RENDERER. The server simulates every creature (server/creatures.py)
// and streams ~10 Hz snapshots per world; this file turns them into animated
// bodies, exactly like remoteplayers.js does for other players. All players
// therefore see the same animals in the same places, and nothing depends on
// any client's tab being visible.
//
// What stays client-side:
//   - bodies, materials, skins, walk animation, hurt flash, death puffs
//   - aim-picking for the player's swing (damage is applied by the server)
//   - villager chatter (poking a villager is a local, harmless interaction)
//   - "local" creatures (spawnAt) — dummies for tests/screenshots that never
//     touch the network; blastKill only ever affects these
//
// The type table keeps the physical dimensions purely for building bodies and
// pacing leg swings; the authoritative copy (speeds, hp, temperament) lives in
// server/creatures.py.

import * as THREE from 'three';
import * as audio from './audio.js';

const TYPES = {
  pig:     { shape: 'quad',    body: 0xe89bb0, head: 0xe07a96, w: 0.62, bh: 0.5,  l: 0.9,  legH: 0.32, legW: 0.16, hd: 0.4,  speed: 1.5, hp: 8 },
  sheep:   { shape: 'quad',    body: 0xeae7dc, head: 0xd6c6ad, w: 0.62, bh: 0.6,  l: 0.8,  legH: 0.34, legW: 0.15, hd: 0.34, speed: 1.2, hp: 8 },
  cow:     { shape: 'quad',    body: 0x6e4b34, head: 0x4a3322, w: 0.72, bh: 0.62, l: 1.0,  legH: 0.42, legW: 0.18, hd: 0.42, speed: 1.1, hp: 10 },
  wolf:    { shape: 'quad',    body: 0x9b9b9b, head: 0x8b8b8b, w: 0.48, bh: 0.48, l: 0.92, legH: 0.44, legW: 0.14, hd: 0.34, speed: 2.5, tail: true, hp: 12 },
  chicken: { shape: 'chicken', body: 0xffffff, head: 0xf2f2f2, w: 0.34, bh: 0.32, l: 0.4,  legH: 0.24, legW: 0.07, hd: 0.24, speed: 1.5, foot: 0xe6a020, comb: 0xd23b3b, hp: 4 },
  spider:  { shape: 'spider',  body: 0x2a2320, head: 0x1c1614, w: 0.7,  bh: 0.34, l: 0.7,  legH: 0.3,  legW: 0.07, hd: 0.4,  speed: 2.2, eye: 0xb03030, hp: 8 },
  squid:   { shape: 'squid',   aquatic: true, body: 0x7a2a5a, head: 0x7a2a5a, w: 0.5, bh: 0.66, l: 0.5, legW: 0.09, speed: 1.1, hp: 8 },
  farmer:  { shape: 'biped', villager: true, body: 0x7d5a36, head: 0xdca575, w: 0.5,  bh: 0.72, l: 0.32, legH: 0.45, legW: 0.13, hd: 0.36, speed: 1.2, hp: 10, hat: 0xd8b04a },
  smith:   { shape: 'biped', villager: true, body: 0x4d4a55, head: 0xc98d5f, w: 0.54, bh: 0.75, l: 0.34, legH: 0.46, legW: 0.14, hd: 0.38, speed: 1.1, hp: 12 },
  elder:   { shape: 'biped', villager: true, body: 0xd9d2c4, head: 0xc9a17e, w: 0.5,  bh: 0.7,  l: 0.32, legH: 0.42, legW: 0.13, hd: 0.36, speed: 0.7, hp: 8, hat: 0xefefef },
  kid:     { shape: 'biped', villager: true, body: 0x4f7dc9, head: 0xdca575, w: 0.38, bh: 0.5,  l: 0.26, legH: 0.3,  legW: 0.1,  hd: 0.3,  speed: 2.0, hp: 6 },
};
const TYPE_KEYS = Object.keys(TYPES);

const PLAYER_REACH = 3.4;   // how far the player's swing reaches a creature
const PLAYER_DMG = 4;       // damage per swing (server clamps to this too)

// What a poked villager says — a little personality per sort.
const VILLAGER_LINES = {
  farmer: ['🌾 "The pumpkins are coming along nicely!"',
           '🌾 "A bit of rain would do the crops good."',
           '🌾 "Mind the farm rows, please!"'],
  smith:  ['⚒️ "Careful with that TNT around here, friend."',
           '⚒️ "Fine stone in these hills. Fine stone."',
           '⚒️ "Built anything good lately?"'],
  elder:  ['👴 "When I was young, these hills were half as tall…"',
           '👴 "Zzz… oh! Didn\'t see you there."',
           '👴 "The wolves come out at night. Light the lanterns."'],
  kid:    ['🧒 "Wanna race to the well?"',
           '🧒 "I\'m not scared of wolves. Mostly."',
           '🧒 "Watch me jump off the roof! …maybe later."'],
};

// Optional AI-generated skins live at /static/textures/mob_<type>.png. When one
// exists it's loaded once and shared by every mob of that type; otherwise the
// mob keeps its flat colours, so no art is required.
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

// Box geometries are identical for every mob of a type, so they're built once
// and shared. Never dispose these.
const GEO_CACHE = new Map();
function box(w, h, d) {
  const k = `${w},${h},${d}`;
  let g = GEO_CACHE.get(k);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); GEO_CACHE.set(k, g); }
  return g;
}

// A limb/tentacle: a box hanging below a pivot group placed at the joint, so the
// group can be rotated to swing it.
function makeLimb(w, h, d, mat, x, pivotY, z) {
  const g = new THREE.Group();
  g.position.set(x, pivotY, z);
  const m = new THREE.Mesh(box(w, h, d), mat);
  m.position.y = -h / 2;
  g.add(m);
  return g;
}

function addEyes(head, hd, spread, mat) {
  for (const sx of [-spread, spread]) {
    const eye = new THREE.Mesh(box(0.06, 0.06, 0.02), mat);
    eye.position.set(sx, hd * 0.1, -hd / 2 - 0.005);
    head.add(eye);
  }
}

// --- body-plan builders: each adds meshes to `group` and returns the list of
//     animated limbs (legs/tentacles), front-to-back where it matters. ---------
function buildQuad(t, mats, group) {
  const body = new THREE.Mesh(box(t.w, t.bh, t.l), mats.body);
  body.position.y = t.legH + t.bh / 2;
  group.add(body);

  const head = new THREE.Mesh(box(t.hd, t.hd, t.hd), mats.head);
  head.position.set(0, t.legH + t.bh * 0.75, -t.l / 2 - t.hd * 0.3);
  addEyes(head, t.hd, 0.1, mats.eye);
  group.add(head);

  if (t.tail) {
    const tail = new THREE.Mesh(box(t.legW, t.legW, t.hd * 0.8), mats.leg);
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

  const body = new THREE.Mesh(box(t.w, t.bh, t.l), mats.body);
  body.position.y = t.legH + t.bh / 2;
  group.add(body);

  const head = new THREE.Mesh(box(t.hd, t.hd, t.hd), mats.head);
  head.position.set(0, t.legH + t.bh + t.hd * 0.25, -t.l / 2 - t.hd * 0.05);
  addEyes(head, t.hd, 0.09, mats.eye);
  const beak = new THREE.Mesh(box(t.hd * 0.45, t.hd * 0.3, t.hd * 0.4), foot);
  beak.position.set(0, -t.hd * 0.1, -t.hd / 2 - t.hd * 0.1);
  head.add(beak);
  const comb = new THREE.Mesh(box(t.hd * 0.18, t.hd * 0.28, t.hd * 0.55),
    new THREE.MeshLambertMaterial({ color: t.comb }));
  comb.position.set(0, t.hd * 0.55, 0.02);
  head.add(comb);
  group.add(head);

  // stubby wings flat against the sides
  for (const sx of [-1, 1]) {
    const wing = new THREE.Mesh(box(t.legW, t.bh * 0.8, t.l * 0.7), mats.body);
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
  const abd = new THREE.Mesh(box(t.w * 0.8, t.bh, t.l * 0.7), mats.body);
  abd.position.set(0, t.legH, t.l * 0.22);
  group.add(abd);
  const ceph = new THREE.Mesh(box(t.w * 0.55, t.bh * 0.9, t.l * 0.5), mats.head);
  ceph.position.set(0, t.legH, -t.l * 0.25);
  group.add(ceph);
  // a cluster of little red eyes on the front
  const eyeMat = new THREE.MeshBasicMaterial({ color: t.eye });
  for (const sx of [-0.09, -0.03, 0.03, 0.09]) {
    const e = new THREE.Mesh(box(0.045, 0.045, 0.02), eyeMat);
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
      const seg = new THREE.Mesh(box(t.legW, len, t.legW), mats.leg);
      seg.position.set(sx * len * 0.34, -len * 0.34, 0);   // shift so it juts sideways+down
      seg.rotation.z = sx * 0.95;
      g.add(seg);
      group.add(g); legs.push(g);
    }
  }
  return legs;
}

function buildSquid(t, mats, group) {
  const mantle = new THREE.Mesh(box(t.w, t.bh, t.l), mats.body);
  mantle.position.y = t.bh / 2;
  group.add(mantle);
  const cap = new THREE.Mesh(box(t.w * 0.66, t.bh * 0.4, t.l * 0.66), mats.body);
  cap.position.y = t.bh + t.bh * 0.14;
  group.add(cap);
  // big dark eyes on the sides
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x101018 });
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(box(0.1, 0.13, 0.06), eyeMat);
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

// Villagers: legs, tunic body, swinging arms, and a head that can wear a hat
// (straw brim for the farmer, white shock of hair for the elder).
function buildBiped(t, mats, group) {
  const limbs = [];
  for (const sx of [-1, 1]) {                                 // legs
    const g = makeLimb(t.legW, t.legH, t.legW, mats.leg, sx * t.w * 0.18, t.legH, 0);
    group.add(g); limbs.push(g);
  }
  const body = new THREE.Mesh(box(t.w, t.bh, t.l), mats.body);
  body.position.y = t.legH + t.bh / 2;
  group.add(body);
  for (const sx of [-1, 1]) {                                 // arms at the shoulders
    const g = makeLimb(t.legW, t.bh * 0.85, t.legW, mats.leg,
      sx * (t.w / 2 + t.legW / 2 + 0.01), t.legH + t.bh - 0.02, 0);
    group.add(g); limbs.push(g);
  }
  const head = new THREE.Mesh(box(t.hd, t.hd, t.hd), mats.head);
  head.position.set(0, t.legH + t.bh + t.hd / 2, 0);
  addEyes(head, t.hd, 0.09, mats.eye);
  group.add(head);
  if (t.hat) {
    const hatMat = new THREE.MeshLambertMaterial({ color: t.hat });
    const brim = new THREE.Mesh(box(t.hd * 1.5, t.hd * 0.12, t.hd * 1.5), hatMat);
    brim.position.y = t.hd * 0.46;
    head.add(brim);
    const crown = new THREE.Mesh(box(t.hd * 0.85, t.hd * 0.3, t.hd * 0.85), hatMat);
    crown.position.y = t.hd * 0.64;
    head.add(crown);
  }
  return limbs;   // [legL, legR, armL, armR]
}

const BUILDERS = { quad: buildQuad, chicken: buildChicken, spider: buildSpider, squid: buildSquid, biped: buildBiped };

// One rendered creature: a body, an interpolation target, and a hurt flash.
class Mob {
  constructor(scene, type, x, y, z) {
    this.scene = scene;
    const t = TYPES[type]; this.t = t; this.type = type;
    this.shape = t.shape;
    this.aquatic = !!t.aquatic;
    this.pos = new THREE.Vector3(x, y, z);
    this.yaw = 0;
    this.moving = false;
    this.curSpeed = 0;
    this.phase = 0;
    this.hp = t.hp || 6;        // meaningful for LOCAL dummies only
    this.hurtFlash = 0;
    this.mtgt = null;           // synced mobs: latest streamed position
    this.myaw = 0;
    this.ms = 0;
    this.mc = 0;                // chasing flag last frame (growl edge)

    this.group = new THREE.Group();
    const skin = SKIN[type];
    const bodyCol = new THREE.Color(t.body);
    const legCol = bodyCol.clone().multiplyScalar(0.8);
    // With a skin, the texture carries the colour (white tint) and limbs are
    // shaded a touch darker; without one, fall back to the flat body/head hues.
    // Villagers are the exception: their skin texture is clothing, so the head
    // keeps its flat face colour (fabric-textured faces look wrong).
    const mats = {
      body: skin ? new THREE.MeshLambertMaterial({ map: skin })
        : new THREE.MeshLambertMaterial({ color: bodyCol }),
      head: skin && !t.villager ? new THREE.MeshLambertMaterial({ map: skin })
        : new THREE.MeshLambertMaterial({ color: t.head }),
      leg: skin ? new THREE.MeshLambertMaterial({ map: skin, color: 0xcccccc })
        : new THREE.MeshLambertMaterial({ color: legCol }),
      eye: new THREE.MeshBasicMaterial({ color: 0x1a1a1a }),
    };
    this.legs = BUILDERS[t.shape](t, mats, this.group);
    // Only the limb pivot GROUPS animate; every mesh is rigid relative to its
    // parent. Freeze their local matrices so a dozen nodes per creature stop
    // recomposing each frame (world matrices still follow the moving group).
    this.group.traverse((o) => {
      if (o !== this.group && !o.isGroup) { o.matrixAutoUpdate = false; o.updateMatrix(); }
    });
    // Lambert materials whose emissive we pulse red on a hit.
    this.flashMats = [mats.body, mats.head, mats.leg];

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    scene.add(this.group);
  }

  // Body-centre point in world space (for hit tests).
  center(out) {
    const yc = this.aquatic ? this.t.bh * 0.5 : (this.t.legH + this.t.bh) * 0.5;
    return (out || new THREE.Vector3()).set(this.pos.x, this.pos.y + yc, this.pos.z);
  }

  flash() {
    this.hurtFlash = 0.14;
    for (const m of this.flashMats) if (m.emissive) m.emissive.setHex(0x661111);
  }

  // Local dummies only (tests/screenshots); synced damage is the server's job.
  hurt(dmg) {
    this.hp -= dmg;
    this.flash();
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
    } else if (this.shape === 'biped') {
      legs[0].rotation.x = sw; legs[1].rotation.x = -sw;      // legs
      legs[2].rotation.x = -sw * 0.7; legs[3].rotation.x = sw * 0.7;  // arms counter-swing
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
    // Geometries are shared across all mobs (GEO_CACHE) — dispose materials only.
    this.group.traverse((o) => { if (o.material) o.material.dispose(); });
  }
}

export class Mobs {
  constructor(scene, world, textures = [], msg = () => {}) {
    this.scene = scene;
    this.world = world;
    this.mobs = [];
    this.msg = msg;             // toast callback (villager chatter)
    this.net = null;            // set by main.js; hits/hatches go to the server
    this.peaceful = false;      // mirrored for UI state; the server enforces it
    loadMobSkins(textures);
  }

  // Interpolate synced creatures toward the stream, animate everything, and
  // clean up local dummies that were killed by a blast.
  update(dt) {
    const k = Math.min(1, dt * 10);
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      if (m.mtgt) {
        const px = m.pos.x, pz = m.pos.z;
        m.pos.lerp(m.mtgt, k);
        let dy = m.myaw - m.yaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        m.yaw += dy * k;
        m.moving = !!m.ms;
        m.curSpeed = m.ms ? m.t.speed : 0;
        void px; void pz;
      }
      if (m.hurtFlash > 0) {
        m.hurtFlash -= dt;
        if (m.hurtFlash <= 0) {
          for (const mat of m.flashMats) if (mat.emissive) mat.emissive.setHex(0x000000);
        }
      }
      if (!m.mtgt && m.hp <= 0) {          // local dummy died (blast in a test)
        this.world.spawnBreakBurst(m.pos.x, m.pos.y + 0.4, m.pos.z, m.t.body);
        audio.playMobDeath({ x: m.pos.x, y: m.pos.y + 0.4, z: m.pos.z });
        m.dispose();
        this.mobs.splice(i, 1);
        continue;
      }
      m._animate(dt);
      m.group.position.copy(m.pos);
      m.group.rotation.y = m.yaw;
    }
  }

  // The server's stream is the truth: create what's new, retarget what exists,
  // drop whatever it no longer mentions. A creature that just started chasing
  // (the 'c' flag's rising edge) growls — fair warning before the bite.
  applySnapshot(list) {
    const seen = new Set();
    for (const e of list) {
      seen.add(e.i);
      let m = this.mobs.find((x) => x.nid === e.i);
      if (!m) {
        if (!TYPES[e.t]) continue;
        m = new Mob(this.scene, e.t, e.x, e.y, e.z);
        m.nid = e.i;
        m.mtgt = new THREE.Vector3(e.x, e.y, e.z);
        this.mobs.push(m);
      }
      m.mtgt.set(e.x, e.y, e.z);
      m.myaw = e.w;
      m.ms = e.s;
      if (e.c && !m.mc) audio.playGrowl(m.pos);
      m.mc = e.c;
      if (e.h && m.hurtFlash <= 0) m.flash();
    }
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      if (!m.mtgt || seen.has(m.nid)) continue;   // local dummies aren't streamed
      m.dispose();
      this.mobs.splice(i, 1);
    }
  }

  // A creature died server-side: puff + sound where it fell.
  onDeath(x, y, z, type) {
    const t = TYPES[type];
    this.world.spawnBreakBurst(x, y, z, t ? t.body : 0xaaaaaa);
    audio.playMobDeath({ x, y, z });
  }

  // The player swung: pick the nearest creature within reach and roughly in
  // front of the camera. Villagers are neighbours, not targets — a swing at
  // one just gets their attention. Synced creatures: instant local feedback,
  // damage applied by the server. Local dummies: direct damage (tests).
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
    if (best.t.villager) { this._villagerChat(best, origin); return true; }
    audio.playMobHit({ x: best.pos.x, y: best.pos.y + 0.4, z: best.pos.z });
    best.flash();
    if (best.mtgt) {
      if (this.net) this.net.sendMobHit(best.nid, PLAYER_DMG, dir.x, dir.z);
    } else {
      best.hurt(PLAYER_DMG);
    }
    return true;
  }

  // A poked villager turns to face you and says something in character.
  _villagerChat(m, origin) {
    m.yaw = Math.atan2(origin.x - m.pos.x, origin.z - m.pos.z) + Math.PI;
    if (m.chatCd && m.chatCd > performance.now()) return;
    m.chatCd = performance.now() + 2500;
    const lines = VILLAGER_LINES[m.type] || [];
    if (lines.length) this.msg(lines[Math.floor(Math.random() * lines.length)]);
  }

  // Explosions: the server kills synced creatures (it hears the same fx);
  // this only fells local dummies so tests and tools behave.
  blastKill(x, y, z, r = 4.5) {
    const c = new THREE.Vector3();
    for (const m of this.mobs) {
      if (m.mtgt) continue;
      m.center(c);
      if (c.distanceTo({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }) < r) m.hurt(9999);
    }
  }

  // A LOCAL dummy creature — never simulated or synced; used by the headless
  // tests (mine sensors read positions from this list) and screenshot tooling.
  spawnAt(type, x, y, z) {
    const m = new Mob(this.scene, type, x, y, z);
    this.mobs.push(m);
    return m;
  }

  // Gameplay hatch (a spawn egg was used): the server owns creation, so it
  // appears for everyone and persists with the world.
  hatchEgg(type, x, y, z) {
    if (!TYPES[type] || !this.net || !this.net.connected) return false;
    this.net.sendHatch(type, x + 0.5, y, z + 0.5);
    return true;
  }

  clear() {
    for (const m of this.mobs) m.dispose();
    this.mobs = [];
  }
}
