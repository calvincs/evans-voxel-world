// Ambient wildlife: land animals (pigs, sheep, cows, wolves, chickens, spiders)
// that wander on grass, plus squid that swim in lakes and oceans, plus the
// villagers (farmer, smith, elder, kid) who live around the generated village
// and keep to it. Creatures spawn near the player, amble/swim with a little
// AI, and despawn when far away. Hostiles hunt: they chase, hop down holes,
// and pathfind around corners.
// Client-side and ambient — they don't drop items or sync across multiplayer.

import * as THREE from 'three';
import { DIM } from './engine/constants.js';
import { isSolid, GRASS, WATER, COBBLE } from './blocks.js';
import * as audio from './audio.js';

// Each animal picks a body plan (shape) and its colours/sizes/speed. `aquatic`
// marks water-only creatures. When /static/textures/mob_<type>.png exists it is
// used as the skin and overrides the flat colours (see loadMobSkins).
const TYPES = {
  pig:     { shape: 'quad',    body: 0xe89bb0, head: 0xe07a96, w: 0.62, bh: 0.5,  l: 0.9,  legH: 0.32, legW: 0.16, hd: 0.4,  speed: 1.5, hp: 8 },
  sheep:   { shape: 'quad',    body: 0xeae7dc, head: 0xd6c6ad, w: 0.62, bh: 0.6,  l: 0.8,  legH: 0.34, legW: 0.15, hd: 0.34, speed: 1.2, hp: 8 },
  cow:     { shape: 'quad',    body: 0x6e4b34, head: 0x4a3322, w: 0.72, bh: 0.62, l: 1.0,  legH: 0.42, legW: 0.18, hd: 0.42, speed: 1.1, hp: 10 },
  wolf:    { shape: 'quad',    body: 0x9b9b9b, head: 0x8b8b8b, w: 0.48, bh: 0.48, l: 0.92, legH: 0.44, legW: 0.14, hd: 0.34, speed: 2.5, tail: true, hp: 12, hostile: true, attack: 2, nightHunter: true },
  chicken: { shape: 'chicken', body: 0xffffff, head: 0xf2f2f2, w: 0.34, bh: 0.32, l: 0.4,  legH: 0.24, legW: 0.07, hd: 0.24, speed: 1.5, foot: 0xe6a020, comb: 0xd23b3b, hp: 4 },
  spider:  { shape: 'spider',  body: 0x2a2320, head: 0x1c1614, w: 0.7,  bh: 0.34, l: 0.7,  legH: 0.3,  legW: 0.07, hd: 0.4,  speed: 2.2, eye: 0xb03030, night: true, hp: 8, hostile: true, attack: 1, nightHunter: true },
  squid:   { shape: 'squid',   aquatic: true, body: 0x7a2a5a, head: 0x7a2a5a, w: 0.5, bh: 0.66, l: 0.5, legW: 0.09, speed: 1.1, hp: 8, hostile: true, attack: 1, nightHunter: true },
  // The villagers — a mixed folk who spawn around the generated village and
  // wander it (see Mobs.village / _spawnVillager). `hat` adds a brim + crown.
  farmer:  { shape: 'biped', villager: true, body: 0x7d5a36, head: 0xdca575, w: 0.5,  bh: 0.72, l: 0.32, legH: 0.45, legW: 0.13, hd: 0.36, speed: 1.2, hp: 10, hat: 0xd8b04a },
  smith:   { shape: 'biped', villager: true, body: 0x4d4a55, head: 0xc98d5f, w: 0.54, bh: 0.75, l: 0.34, legH: 0.46, legW: 0.14, hd: 0.38, speed: 1.1, hp: 12 },
  elder:   { shape: 'biped', villager: true, body: 0xd9d2c4, head: 0xc9a17e, w: 0.5,  bh: 0.7,  l: 0.32, legH: 0.42, legW: 0.13, hd: 0.36, speed: 0.7, hp: 8, hat: 0xefefef },
  kid:     { shape: 'biped', villager: true, body: 0x4f7dc9, head: 0xdca575, w: 0.38, bh: 0.5,  l: 0.26, legH: 0.3,  legW: 0.1,  hd: 0.3,  speed: 2.0, hp: 6 },
};
const TYPE_KEYS = Object.keys(TYPES);
const LAND_KEYS = TYPE_KEYS.filter((k) => !TYPES[k].aquatic && !TYPES[k].villager);
const WATER_KEYS = TYPE_KEYS.filter((k) => TYPES[k].aquatic);
const VILLAGER_KEYS = TYPE_KEYS.filter((k) => TYPES[k].villager);

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

const GRAVITY = 24, TURN = 2.2;
const TARGET_MOBS = 8;      // wild population kept alive around the player
const SPAWN_MIN = 12, SPAWN_MAX = 26, DESPAWN = 42;
const VILLAGER_TARGET = 4;  // villagers about, while the player is in town
const VILLAGE_NEARBY = 24;  // how far past the village edge they still spawn

// Combat tuning. Night hunters (wolf, spider, squid) are only truly
// aggressive after dark — with extended senses — or for a while after being
// hit; by day they're docile, drifting away from players and only snapping
// when crowded.
const DETECT = 11;          // aggro range (blocks) — day (angered) baseline
const DETECT_NIGHT = 18;    // night hunters sense much farther after dark
const DAY_DEFEND = 2.5;     // docile daytime hunters still snap this close
const DAY_AVOID = 7;        // ...and drift away from players inside this
const ANGER_TIME = 12;      // seconds a hit keeps a docile hunter aggressive
const MAX_MOBS = 48;        // hard cap so spawn eggs can't melt the machine
const ATTACK_RANGE = 1.7;   // how close a hostile must be to land a hit
const ATTACK_INTERVAL = 1.0;// seconds between a mob's hits
const PLAYER_REACH = 3.4;   // how far the player's swing reaches a creature
const PLAYER_DMG = 4;       // damage per swing

// Hunting smarts (hostiles only) and prey nerves.
const CHASE_DROP = 3;       // blocks a hunter will hop down while chasing
const CHASE_DROP_DEEP = 8;  // ...when the prey is below it (pits, stairwells)
const PATH_INTERVAL = 0.6;  // min seconds between pathfinder calls per mob
const PATH_NODES = 400;     // A* expansion budget per call
const PATH_TTL = 5;         // seconds a computed path stays trusted. Walls are
                            // static: expiring a path mid-doorway used to hand
                            // control back to straight-line steering, which
                            // drove the hunter into the wall again — a stable
                            // oscillation right outside the opening.
const WP_RADIUS = 0.55;     // how close counts as "arrived" at a waypoint
const FLEE_TIME = 2.5;      // seconds a grazer bolts after taking a hit
// One A* per rendered frame across ALL mobs: three wolves at a pit rim used to
// re-path in the same frame and stutter the night's most exciting moment.
let pathBudget = 1;

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

// Box geometries are identical for every mob of a type, so they're built once
// and shared — hatching a pile of spawn eggs used to upload (and later
// dispose) a fresh set of GPU buffers per creature. Never dispose these.
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

// --- tiny voxel A* for hunters ----------------------------------------------
// Moves: the four compass steps, a one-block climb, or a drop of up to
// `maxDrop` blocks. Water is impassable (land hunters don't swim; the squid
// has its own senses). Expansion is budgeted, and when the budget runs out
// the path leads to the reachable cell nearest the goal, so a partial answer
// still closes distance. Returns [{x,y,z}, ...] starting just after `s`.
function findPath(world, sx, sy, sz, tx, ty, tz, maxDrop) {
  const solid = (x, y, z) => isSolid(world.getBlock(x, y, z));
  const water = (x, y, z) => world.getBlock(x, y, z) === WATER;
  // A cell a hunter can occupy: open, dry, with a floor under it.
  const stand = (x, y, z) => !solid(x, y, z) && !water(x, y, z) && solid(x, y - 1, z);
  const h = (x, y, z) => Math.abs(x - tx) + Math.abs(y - ty) + Math.abs(z - tz);

  const start = { x: sx, y: sy, z: sz, g: 0, f: h(sx, sy, sz), prev: null };
  const open = [start];
  const seen = new Map([[`${sx},${sy},${sz}`, start]]);
  let best = start;

  for (let n = 0; n < PATH_NODES && open.length; n++) {
    let bi = 0;                       // linear pick is fine at this queue size
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (h(cur.x, cur.y, cur.z) < h(best.x, best.y, best.z)) best = cur;
    if (cur.x === tx && cur.z === tz && Math.abs(cur.y - ty) <= 1) { best = cur; break; }

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, nz = cur.z + dz;
      let ny = null, cost = 1;
      if (stand(nx, cur.y, nz)) ny = cur.y;                        // level walk
      else if (!solid(nx, cur.y, nz) && !water(nx, cur.y, nz)) {   // open, no floor: a drop?
        for (let m = 1; m <= maxDrop + 1; m++) {
          const b = world.getBlock(nx, cur.y - m, nz);
          if (b === WATER) break;
          if (isSolid(b)) { if (m >= 2) { ny = cur.y - m + 1; cost = 1 + (m - 1) * 0.4; } break; }
        }
      } else if (!solid(cur.x, cur.y + 1, cur.z) && stand(nx, cur.y + 1, nz)) {
        ny = cur.y + 1; cost = 1.4;                                // one-block climb
      }
      if (ny === null) continue;
      const key = `${nx},${ny},${nz}`;
      const g = cur.g + cost;
      const old = seen.get(key);
      if (old && old.g <= g) continue;
      const node = { x: nx, y: ny, z: nz, g, f: g + h(nx, ny, nz), prev: cur };
      seen.set(key, node);
      open.push(node);
    }
  }

  const path = [];
  for (let n = best; n && n.prev; n = n.prev) path.push({ x: n.x, y: n.y, z: n.z });
  path.reverse();
  return path;
}

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
    this.fleeT = 0;              // grazer panic timer after taking a hit
    this.angerT = 0;             // a hit makes a docile hunter aggressive a while
    this.home = null;            // villagers: {x,z,r} they wander back toward
    this.path = null;            // hunter's current waypoint list (block coords)
    this.pathT = 0;              // cooldown between pathfinder calls
    this.pathAge = 0;            // how long we've trusted the current path
    this.stuckT = 0;             // seconds of no progress while hunting

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
    if (this.hostile) this.angerT = ANGER_TIME;   // poking a docile hunter wakes it
    if (dir) {
      this.kbx = dir.x * 7; this.kbz = dir.z * 7;
      if (!this.aquatic && this.onGround) this.vel.y = Math.max(this.vel.y, 4.5);
      // Grazers bolt away from the blow; hunters are already coming for you.
      if (!this.hostile && !this.aquatic) {
        this.fleeT = FLEE_TIME;
        this.walking = true;
        this.timer = FLEE_TIME;
        this.targetYaw = Math.atan2(-dir.x, -dir.z);
      }
    }
    for (const m of this.flashMats) if (m.emissive) m.emissive.setHex(0x661111);
  }

  // Bite the target if in range and off cooldown. A local player is hurt
  // directly; a remote player's bite is routed to their own client by the sim
  // owner (biteRemote -> Mobs.onBite -> server -> that player).
  _tryAttack(tgt, dist) {
    if (!tgt || dist > ATTACK_RANGE || this.attackCd > 0) return;
    if (tgt.local) {
      const p = tgt.local;
      if (p.locked && !p.frozen && !p.dead) {
        p.hurt(this.t.attack || 1, { from: this.pos, source: this.type });
        this.attackCd = ATTACK_INTERVAL;
      }
    } else if (this.biteRemote) {
      this.biteRemote(tgt.pid, this.t.attack || 1, this.pos, this.type);
      this.attackCd = ATTACK_INTERVAL;
    }
  }

  _chooseAction() {
    if (this.fleeT > 0) { this.walking = true; this.timer = 0.5; return; }   // still bolting
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

  update(dt, world, tgt, daylight = 1) {
    if (this.angerT > 0) this.angerT -= dt;
    if (this.aquatic) this._swim(dt, world, tgt, daylight);
    else this._walk(dt, world, tgt, daylight);
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
  // Hostiles home in on a nearby player and bite; they'll hop down into holes
  // and pathfind around corners to reach you. Night hunters only do this
  // after dark (with long senses) or while angered — by day they shy away
  // from players and snap only when crowded. Grazers bolt for a bit when hit.
  _walk(dt, world, tgt, daylight = 1) {
    this.timer -= dt;
    if (this.timer <= 0) this._chooseAction();
    if (this.fleeT > 0) this.fleeT -= dt;

    let chasing = false;
    if (this.hostile && tgt) {
      const dx = tgt.pos.x - this.pos.x, dz = tgt.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      const night = daylight < 0.35;
      const aggressive = !this.t.nightHunter || night || this.angerT > 0;
      const range = aggressive ? (night && this.t.nightHunter ? DETECT_NIGHT : DETECT) : DAY_DEFEND;
      if (dist < range) {
        chasing = true;
        this.walking = true;
        this._steerChase(dt, world, tgt, dx, dz);
        // Bite range is 3-D so a wolf on the rim of your pit can't nip you
        // through two blocks of floor.
        this._tryAttack(tgt, Math.hypot(dx, tgt.pos.y - this.pos.y, dz));
      } else if (!aggressive && dist < DAY_AVOID) {
        this.walking = true;                     // daylight: sidle away instead
        this.targetYaw = Math.atan2(dx, dz);
      }
    }
    if (chasing && !this.chasing) audio.playGrowl(this.pos);   // fair warning!
    this.chasing = chasing;
    if (!chasing) { this.path = null; this.stuckT = 0; }

    // Villagers keep to their village: a stride past the edge turns homeward.
    if (this.home && this.walking && !chasing) {
      const hx = this.home.x - this.pos.x, hz = this.home.z - this.pos.z;
      if (Math.hypot(hx, hz) > this.home.r) this.targetYaw = Math.atan2(-hx, -hz);
    }

    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw += Math.max(-TURN * dt, Math.min(TURN * dt, dy));

    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let speed = this.walking ? this.t.speed * (chasing ? 1.15 : this.fleeT > 0 ? 1.6 : 1) : 0;
    // A hunter brakes into sharp turns: a tight corner (doorway, pit rim)
    // needs a pivot, not an orbit that sails past the opening.
    if (chasing && Math.abs(dy) > 0.8) speed *= 0.35;

    if (this.walking) {
      const ax = Math.floor(this.pos.x + fx * 0.7), az = Math.floor(this.pos.z + fz * 0.7);
      const groundAhead = isSolid(world.getBlock(ax, Math.floor(this.pos.y - 0.4), az)) ||
                          isSolid(world.getBlock(ax, Math.floor(this.pos.y - 1.2), az));
      // Water counts as a cliff: land animals shouldn't stroll into lakes (and
      // wolves can't chase you in where you out-swim them).
      const waterAhead = world.getBlock(ax, Math.floor(this.pos.y + 0.1), az) === WATER ||
                         world.getBlock(ax, Math.floor(this.pos.y - 0.4), az) === WATER;
      // A hunter walks off the edge when there's dry footing within reach.
      const dropOk = chasing && !waterAhead && !groundAhead && this._dropAheadOk(world, ax, az, tgt);
      if ((waterAhead || !groundAhead) && !dropOk) {
        speed = 0;
        // A grazer turns away (and keeps sprinting if it's mid-flight); a
        // hunter holds the rim, locked on, until the pathfinder finds a way.
        if (!chasing) { this.walking = this.fleeT > 0; this.timer = 0.4; this.targetYaw = this.yaw + 2.2; }
      }
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

    const px = this.pos.x, pz = this.pos.z;
    let bumped = false;
    if (this._stepMove(world, 'x', this.vel.x * dt)) { if (!chasing) this.targetYaw = this.yaw + 1.5; this.vel.x = 0; bumped = true; }
    if (this._stepMove(world, 'z', this.vel.z * dt)) { if (!chasing) this.targetYaw = this.yaw + 1.5; this.vel.z = 0; bumped = true; }
    const hitY = this._moveAxis(world, 'y', this.vel.y * dt);
    if (hitY) { this.onGround = this.vel.y < 0; this.vel.y = 0; } else this.onGround = false;

    // No progress while hunting on foot (a wall, a corner, a too-deep rim)
    // charges the stuck timer — that's the pathfinder's cue in _steerChase.
    // A wall bump counts even if the other axis still slides: gliding along a
    // wall face past the doorway used to keep stuckT at zero forever, so the
    // pathfinder never fired and the hunter orbited outside the opening.
    if (chasing && this.onGround) {
      const moved = Math.hypot(this.pos.x - px, this.pos.z - pz);
      if (bumped || moved < this.t.speed * dt * 0.35) this.stuckT += dt;
      else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    }

    this.curSpeed = speed;
    this.moving = speed > 0 && this.onGround;
  }

  // Direct pursuit with a fallback brain: aim straight at the player, and when
  // that stops closing distance, buy a path from A* and follow its waypoints
  // until they're consumed or go stale.
  _steerChase(dt, world, tgt, dx, dz) {
    this.pathT -= dt;
    if (this.stuckT > 0.35 && this.pathT <= 0 && this.onGround && pathBudget > 0) {
      pathBudget--;
      this.pathT = PATH_INTERVAL;
      const drop = tgt.pos.y < this.pos.y - 1.5 ? CHASE_DROP_DEEP : CHASE_DROP;
      const p = findPath(world,
        Math.floor(this.pos.x), Math.floor(this.pos.y + 0.01), Math.floor(this.pos.z),
        Math.floor(tgt.pos.x), Math.floor(tgt.pos.y + 0.01), Math.floor(tgt.pos.z), drop);
      this.path = p.length ? p : null;
      this.pathAge = 0;
    }
    if (this.path) {
      this.pathAge += dt;
      while (this.path.length) {   // consume waypoints as we arrive on them
        const wp = this.path[0];
        if (Math.abs(wp.y - this.pos.y) < 1.2 &&
            Math.hypot(wp.x + 0.5 - this.pos.x, wp.z + 0.5 - this.pos.z) < WP_RADIUS) this.path.shift();
        else break;
      }
      if (!this.path.length) {
        this.path = null;
      } else if (this.pathAge > PATH_TTL) {
        // Stale (the player has probably moved) — but don't fall back to
        // straight-line blundering: ask for a fresh path right away.
        this.path = null;
        this.pathT = 0;
      }
    }
    if (this.path) {
      const wp = this.path[0], wx = wp.x + 0.5 - this.pos.x, wz = wp.z + 0.5 - this.pos.z;
      if (Math.hypot(wx, wz) > 0.05) this.targetYaw = Math.atan2(-wx, -wz);
    } else {
      this.targetYaw = Math.atan2(-dx, -dz);   // face the target
    }
  }

  // A hunter jumps down a hole when there's dry footing within reach — and it
  // reaches farther when its prey is somewhere below the rim.
  _dropAheadOk(world, ax, az, tgt) {
    const maxDrop = tgt && tgt.pos.y < this.pos.y - 1.5 ? CHASE_DROP_DEEP : CHASE_DROP;
    const y = Math.floor(this.pos.y);
    for (let m = 2; m <= maxDrop + 1; m++) {
      const b = world.getBlock(ax, y - m, az);
      if (b === WATER) return false;
      if (isSolid(b)) return true;
    }
    return false;
  }

  // Water movement: drift on a heading, turn back at the water's edge, and bob
  // up and down while staying fully submerged. A hunting squid also chases
  // depth: it dives or rises toward the player instead of holding spawn depth.
  // Like the land hunters, squid only hunt at night (with long senses) or
  // when angered; by day they glide away from swimmers unless crowded.
  _swim(dt, world, tgt, daylight = 1) {
    this.timer -= dt;
    if (this.timer <= 0) { this.targetYaw = this.yaw + (Math.random() - 0.5) * 3.0; this.timer = 1.5 + Math.random() * 2.5; }

    // Home toward a nearby target (still confined to water) and bite if close.
    let dive = 0;
    if (this.hostile && tgt) {
      const dx = tgt.pos.x - this.pos.x, dz = tgt.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      const night = daylight < 0.35;
      const aggressive = !this.t.nightHunter || night || this.angerT > 0;
      const range = aggressive ? (night && this.t.nightHunter ? DETECT_NIGHT : DETECT) : DAY_DEFEND;
      if (dist < range) {
        this.targetYaw = Math.atan2(-dx, -dz);
        // Close the depth gap between body centre and the target's chest.
        const gap = (tgt.pos.y + 0.9) - (this.pos.y + this.t.bh * 0.5);
        if (Math.abs(gap) > 0.35) dive = Math.max(-this.t.speed, Math.min(this.t.speed, gap));
        this._tryAttack(tgt, Math.hypot(dx, tgt.pos.y - this.pos.y, dz));
      } else if (!aggressive && dist < DAY_AVOID) {
        this.targetYaw = Math.atan2(dx, dz);     // daylight: glide away instead
      }
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

    // Vertical: chase depth while hunting, else a gentle bob — either way both
    // bottom and top of the body stay in water so it never breaches the
    // surface or sinks into the floor.
    this.bob += dt;
    const vy = dive !== 0 ? dive : Math.sin(this.bob * 0.8) * 0.35;
    const ny = this.pos.y + vy * dt;
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
    this.spawnTimer = 2;
    this.peaceful = false;    // per-world toggle: hostiles neither spawn nor attack
    this.village = null;      // {x,z,radius} from the world config, when it has one
    this.msg = msg;           // toast callback (villager chatter)
    // Creature sync. One client per world — the "sim owner" — runs all the AI
    // and streams snapshots; everyone else mirrors its stream, so every player
    // sees the same creatures in the same places. Solo play is just being the
    // owner of a room of one.
    this.role = 'owner';      // 'owner' simulates; 'mirror' renders the stream
    this.net = null;          // set by main.js in multiplayer
    this.remotes = null;      // other players: spawn anchors + hostile targets
    this.peers = 0;           // players besides us (stream only when > 0)
    this.onBite = null;       // (pid, amount, x, z, source) -> relay to victim
    this._nid = 1;            // wild-creature id counter
    loadMobSkins(textures);   // use any /static/textures/mob_<type>.png that exist
  }

  _wildId() {
    return `w${(this._nid++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  }

  update(dt, player, daylight = 1) {
    if (this.role === 'mirror') { this._updateMirror(dt); return; }
    pathBudget = 1;           // one A* per frame, shared by every hunter
    const playerPos = player.pos;
    // Everyone connected is an anchor (spawn placement, despawn distance) and
    // — unless peaceful — a target: the sim owner hunts for the whole room.
    const anchors = [playerPos];
    const targets = this.peaceful ? [] : [{ pos: playerPos, local: player }];
    if (this.remotes) {
      for (const [pid, r] of this.remotes.players) {
        anchors.push(r.cur);
        if (!this.peaceful) targets.push({ pos: r.cur, pid });
      }
    }
    this._biteRemote ||= (pid, amount, pos, type) =>
      this.onBite && this.onBite(pid, amount, pos.x, pos.z, type);
    // Keep the world populated: top up toward the target counts, refilling
    // faster while we're short (e.g. just after something was killed or
    // wandered off). Villagers have their own quota, active while the player
    // is in or near their village. Placed (persistent) creatures never count
    // toward the wild population.
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const vCount = this.mobs.reduce((n, m) => n + (m.t.villager && !m.cid ? 1 : 0), 0);
      const pCount = this.mobs.reduce((n, m) => n + (m.cid ? 1 : 0), 0);
      const vShort = vCount < this._villagersWanted(playerPos);
      const short = this.mobs.length - vCount - pCount < TARGET_MOBS;
      this.spawnTimer = (short || vShort) ? 0.8 + Math.random() * 1.2 : 2.5 + Math.random() * 3;
      // Wild spawns anchor to a random player, so nobody's surroundings are
      // empty just because the sim owner wandered elsewhere.
      const anchor = anchors[Math.floor(Math.random() * anchors.length)];
      if (vShort) this._spawnVillager(playerPos);
      else if (short) this._trySpawn(anchor, daylight);
    }
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      m.biteRemote = this._biteRemote;
      // A placed creature whose ground isn't streamed in yet stands still
      // rather than falling through terrain that doesn't exist here.
      const frozen = m.cid && !this.world.ready(m.pos.x, m.pos.z);
      if (!frozen) {
        let tgt = null, tb = Infinity;
        if (m.hostile) {
          for (const c of targets) {
            const d = Math.hypot(c.pos.x - m.pos.x, c.pos.z - m.pos.z);
            if (d < tb) { tb = d; tgt = c; }
          }
        }
        m.update(dt, this.world, tgt, daylight);
      }
      if (m.hp <= 0) {   // killed — puff of its body colour, remove, and reseed
        this.world.spawnBreakBurst(m.pos.x, m.pos.y + 0.4, m.pos.z, m.t.body);
        audio.playMobDeath({ x: m.pos.x, y: m.pos.y + 0.4, z: m.pos.z });
        m.dispose(); this.mobs.splice(i, 1);
        if (m.cid && this.net) this.net.sendMobGone(m.cid);   // retire for good
        // Wild creatures get replaced elsewhere; player-hatched ones don't.
        if (!m.noReseed) this._reseed(m.type, playerPos, daylight);
        continue;
      }
      // Wild creatures despawn once far from EVERY player; placed ones never.
      if (!m.cid) {
        let near = Infinity;
        for (const a of anchors) near = Math.min(near, m.pos.distanceTo(a));
        if (near > DESPAWN || m.pos.y < -6) { m.dispose(); this.mobs.splice(i, 1); }
      }
    }
    this._netSync();
  }

  // Stream the room's creatures (~10 Hz, only with peers to hear it) and
  // checkpoint persistent ones (~every 5 s). No-ops cleanly when offline.
  _netSync() {
    if (!this.net || !this.net.connected) return;
    const now = performance.now();
    if (this.peers > 0) {
      this.net.sendMobs(this.mobs.map((m) => ({
        i: m.nid, t: m.type,
        x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2),
        w: +m.yaw.toFixed(2), s: m.moving ? 1 : 0, h: m.hurtFlash > 0 ? 1 : 0,
      })), now);
    }
    const creatures = {};
    let any = false;
    for (const m of this.mobs) {
      if (!m.cid) continue;
      any = true;
      creatures[m.cid] = { t: m.type, x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2),
                           z: +m.pos.z.toFixed(2), hp: m.hp };
    }
    if (any) this.net.sendMobPersist(creatures, now);
  }

  // Mirror mode: no AI — every creature follows the sim owner's stream with
  // the same interpolation remote players use.
  _updateMirror(dt) {
    const k = Math.min(1, dt * 10);
    for (const m of this.mobs) {
      if (m.mtgt) {
        m.pos.lerp(m.mtgt, k);
        let dy = (m.myaw ?? m.yaw) - m.yaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        m.yaw += dy * k;
        m.moving = !!m.ms;
        m.curSpeed = m.ms ? m.t.speed : 0;
      }
      if (m.hurtFlash > 0) {
        m.hurtFlash -= dt;
        if (m.hurtFlash <= 0) {
          for (const mat of m.flashMats) if (mat.emissive) mat.emissive.setHex(0x000000);
        }
      }
      m._animate(dt);
      m.group.position.copy(m.pos);
      m.group.rotation.y = m.yaw;
    }
  }

  // The sim owner's stream is the truth: create what's new, retarget what
  // exists, drop whatever it no longer mentions.
  applySnapshot(list) {
    if (this.role !== 'mirror') return;
    const seen = new Set();
    for (const e of list) {
      seen.add(e.i);
      let m = this.mobs.find((x) => x.nid === e.i);
      if (!m) {
        if (!TYPES[e.t]) continue;
        m = new Mob(this.scene, e.t, e.x, e.y, e.z);
        m.nid = e.i;
        if (e.i[0] === 'c') { m.cid = e.i; m.noReseed = true; }
        m.mtgt = new THREE.Vector3(e.x, e.y, e.z);
        this.mobs.push(m);
      }
      if (!m.mtgt) m.mtgt = new THREE.Vector3(e.x, e.y, e.z);
      m.mtgt.set(e.x, e.y, e.z);
      m.myaw = e.w;
      m.ms = e.s;
      if (e.h && m.hurtFlash <= 0) {
        m.hurtFlash = 0.14;
        for (const mat of m.flashMats) if (mat.emissive) mat.emissive.setHex(0x661111);
      }
    }
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      if (!seen.has(this.mobs[i].nid)) {
        this.mobs[i].dispose();
        this.mobs.splice(i, 1);
      }
    }
  }

  // 'owner' simulates (solo play included); 'mirror' renders the stream.
  // Becoming mirror discards local creatures (the stream is the truth now);
  // becoming owner adopts the mirrored ones and simulates on from exactly
  // where the stream left them.
  setRole(role) {
    if (role === this.role) return;
    this.role = role;
    if (role === 'mirror') this.clear();
    else this.spawnTimer = 2;             // fresh owner: resume population upkeep
  }

  // The player swung: damage the nearest creature within reach and roughly in
  // front of the camera. Returns true if one was hit (so the block break is
  // skipped in favour of the attack). Villagers are neighbours, not targets —
  // a swing at one just gets their attention (and a line of chatter).
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
    if (this.role === 'mirror') {
      // Instant local feedback; the sim owner applies the real damage.
      audio.playMobHit({ x: best.pos.x, y: best.pos.y + 0.4, z: best.pos.z });
      best.hurtFlash = 0.14;
      for (const mat of best.flashMats) if (mat.emissive) mat.emissive.setHex(0x661111);
      if (this.net) this.net.sendMobHit(best.nid, PLAYER_DMG, dir.x, dir.z);
      return true;
    }
    best.hurt(PLAYER_DMG, dir);                  // knocked back along the swing
    audio.playMobHit({ x: best.pos.x, y: best.pos.y + 0.4, z: best.pos.z });
    return true;
  }

  // A mirror player's swing, delivered to us (the sim owner) by the server.
  applyRemoteHit(id, dmg, dx, dz) {
    if (this.role === 'mirror') return;
    const m = this.mobs.find((x) => x.nid === id);
    if (!m || m.t.villager) return;
    m.hurt(dmg, { x: dx, z: dz });
    audio.playMobHit({ x: m.pos.x, y: m.pos.y + 0.4, z: m.pos.z });
  }

  // A poked villager turns to face you and says something in character.
  _villagerChat(m, origin) {
    m.targetYaw = Math.atan2(origin.x - m.pos.x, origin.z - m.pos.z) + Math.PI;
    m.walking = false;
    m.timer = Math.max(m.timer, 1.5);            // pause to chat
    if (m.chatCd && m.chatCd > performance.now()) return;
    m.chatCd = performance.now() + 2500;
    const lines = VILLAGER_LINES[m.type] || [];
    if (lines.length) this.msg(lines[Math.floor(Math.random() * lines.length)]);
  }

  // An explosion at a block position: creatures caught in the blast die on the
  // spot (their removal + reseed happens in the next update pass). Mirrors do
  // nothing — the sim owner receives the same explosion (locally or as a
  // relayed fx) and applies the authoritative kills.
  blastKill(x, y, z, r = 4.5) {
    if (this.role === 'mirror') return;
    const c = new THREE.Vector3();
    for (const m of this.mobs) {
      m.center(c);
      if (c.distanceTo({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }) < r) m.hurt(9999);
    }
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

  // How many villagers should be about: full house while the player is in or
  // near the village, none once they've left it far behind.
  _villagersWanted(playerPos) {
    const v = this.village;
    if (!v) return 0;
    const dist = Math.hypot(playerPos.x - v.x, playerPos.z - v.z);
    return dist < v.radius + VILLAGE_NEARBY ? VILLAGER_TARGET : 0;
  }

  // Place one villager (random sort unless given) somewhere in the village —
  // on grass, a path, or a floor, but never a roof. Returns true if spawned.
  _spawnVillager(playerPos, type = null) {
    const v = this.village;
    if (!v || this._villagersWanted(playerPos) === 0) return false;
    const ang = Math.random() * Math.PI * 2;
    const d = 2 + Math.random() * (v.radius - 6);
    const x = Math.floor(v.x + Math.cos(ang) * d);
    const z = Math.floor(v.z + Math.sin(ang) * d);
    for (let y = DIM.WY - 1; y > 1; y--) {
      const b = this.world.getBlock(x, y, z);
      if (!isSolid(b)) continue;
      // Grass and cobble mark the village ground; anything else (a roof, the
      // farm rows, the well) is no place to appear. Try again next tick.
      if (b !== GRASS && b !== COBBLE) return false;
      const spot = { x: x + 0.5, y: y + 1, z: z + 0.5 };
      if (Math.hypot(spot.x - playerPos.x, spot.z - playerPos.z) < 5) return false;
      const kind = type || VILLAGER_KEYS[Math.floor(Math.random() * VILLAGER_KEYS.length)];
      const m = new Mob(this.scene, kind, spot.x, spot.y, spot.z);
      m.nid = this._wildId();
      m.home = { x: v.x + 0.5, z: v.z + 0.5, r: v.radius };
      this.mobs.push(m);
      return true;
    }
    return false;
  }

  // Try to place one mob of `type` away from the player. Returns true if spawned.
  _spawnType(type, playerPos, daylight) {
    const t = TYPES[type];
    if (t.villager) return this._spawnVillager(playerPos, type);
    if (this.peaceful && t.hostile) return false;      // friendly animals only
    if (t.night && daylight >= 0.35) return false;     // nocturnal, and it's daytime
    const spot = t.aquatic ? this._findWaterSpot(playerPos) : this._findLandSpot(playerPos);
    if (!spot) return false;
    const m = new Mob(this.scene, type, spot.x, spot.y, spot.z);
    m.nid = this._wildId();
    this.mobs.push(m);
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
    m.nid = this._wildId();
    this.mobs.push(m);
    return m;
  }

  // Hatch a creature from a spawn egg at cell (x,y,z) — the empty cell the
  // player clicked toward. Water creatures must hatch into water; hatched on
  // dry land they perish on the spot (with the usual puff). Player-hatched
  // creatures never reseed the wild population when they die, and a hard cap
  // keeps egg-spamming from melting the machine.
  spawnFromEgg(type, x, y, z) {
    const t = TYPES[type];
    if (!t || this.mobs.length >= MAX_MOBS) return false;
    const m = new Mob(this.scene, type, x + 0.5, y, z + 0.5);
    m.nid = this._wildId();
    m.noReseed = true;
    if (t.villager && this.village) {
      m.home = { x: this.village.x + 0.5, z: this.village.z + 0.5, r: this.village.radius };
    }
    this.mobs.push(m);
    if (t.aquatic && this.world.getBlock(x, Math.floor(y + t.bh * 0.5), z) !== WATER) {
      m.hurt(9999);            // a squid out of water doesn't last long
    }
    return true;
  }

  // Gameplay hatch (a spawn egg was used). Online it goes through the server,
  // so it appears for everyone and persists with the world; offline it just
  // spawns locally like before.
  hatchEgg(type, x, y, z) {
    if (!TYPES[type] || this.mobs.length >= MAX_MOBS) return false;
    if (this.net && this.net.connected) {
      this.net.sendHatch(type, x + 0.5, y, z + 0.5);
      return true;             // instantiated when the server echoes mobhatch
    }
    return this.spawnFromEgg(type, x, y, z);
  }

  // Server echo of a hatch: bring it to life (owner) or show it (mirror).
  hatchFromNet(cid, type, x, y, z) {
    if (!TYPES[type] || this.mobs.find((m) => m.nid === cid)) return;
    if (this.role === 'mirror') {
      const m = new Mob(this.scene, type, x, y, z);
      m.nid = cid; m.cid = cid; m.noReseed = true;
      m.mtgt = new THREE.Vector3(x, y, z);
      this.mobs.push(m);
      return;
    }
    if (!this.spawnFromEgg(type, Math.floor(x), y, Math.floor(z))) return;
    const m = this.mobs[this.mobs.length - 1];
    m.nid = cid;
    m.cid = cid;
  }

  // Owner-side load of the world's persistent creatures (from /config), so a
  // room full of wolves is still full of wolves after everyone left.
  loadPersistent(creatures) {
    for (const [cid, c] of Object.entries(creatures || {})) {
      if (!TYPES[c.t] || this.mobs.find((m) => m.nid === cid)) continue;
      const m = new Mob(this.scene, c.t, c.x, c.y, c.z);
      m.nid = cid; m.cid = cid; m.noReseed = true;
      if (Number.isFinite(c.hp) && c.hp > 0) m.hp = c.hp;
      if (m.t.villager && this.village) {
        m.home = { x: this.village.x + 0.5, z: this.village.z + 0.5, r: this.village.radius };
      }
      this.mobs.push(m);
    }
  }

  removeById(id) {
    const i = this.mobs.findIndex((m) => m.nid === id);
    if (i >= 0) { this.mobs[i].dispose(); this.mobs.splice(i, 1); }
  }

  clear() {
    for (const m of this.mobs) m.dispose();
    this.mobs = [];
  }
}
