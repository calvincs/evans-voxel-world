// Block catalogue + texture atlas for the voxel engine.
//
// Block ids MUST match server/worldgen.py. Each block maps its top / side /
// bottom faces to a tile in a small texture atlas. Tiles are drawn
// procedurally (pixel-art) so the game needs no external image files — but if
// a matching PNG exists in /static/textures/<name>.png it is used instead,
// which is how AI-generated art gets dropped in later.

import * as THREE from 'three';

export const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, WOOD = 4, LEAVES = 5,
             SAND = 6, WATER = 7, PLANKS = 8, GLASS = 9, BRICK = 10, COBBLE = 11,
             SNOW = 12, PUMPKIN = 13, GOLD = 14, DIAMOND = 15,
             WOOL_RED = 16, WOOL_BLUE = 17, TNT = 18, FLINT = 19, GLOWSTONE = 20,
             MOSSY = 21, MARBLE = 22, RAINBOW = 23;

// Contraption blocks (see gear.js). A Firestone strike changes their state,
// which is just a block swap — so it persists and syncs like any other edit.
export const PUMPKIN_LIT = 24;                                // jack-o'-lantern
export const PROX_OFF = 25, PROX_OTHERS = 26, PROX_ALL = 27;  // proximity mine modes
// Elevators: ten consecutive ids per direction; the id itself encodes the set
// travel distance (1..10), which the block texture displays. The 11th strike
// switches to the next direction and restarts at 1. Vertical: up <-> down.
// Horizontal: forward -> right -> back -> left (relative to the rider's facing
// when they board — the arrow on the block matches: ⬆ the way you look, ➡
// your right, and so on).
export const ELEV_UP = 30, ELEV_SIDE = 40, ELEV_DOWN = 50, ELEV_SIDE_REV = 60,
             ELEV_SIDE_R = 70, ELEV_SIDE_L = 80, ELEV_MAX = 10;
export const ELEV_BASES = [ELEV_UP, ELEV_SIDE, ELEV_DOWN, ELEV_SIDE_REV,
                           ELEV_SIDE_R, ELEV_SIDE_L];
// The base id of an elevator block (its direction family), or 0 if not one.
export const elevBase = (b) => {
  for (const base of ELEV_BASES) if (b >= base && b < base + ELEV_MAX) return base;
  return 0;
};
export const elevCount = (b) => { const base = elevBase(b); return base ? b - base + 1 : 0; };
export const isProx = (b) => b === PROX_OFF || b === PROX_OTHERS || b === PROX_ALL;

// Tools live in the hotbar but are never placed as world blocks. Firestone
// strikes blocks: lights TNT and pumpkins, arms mines, sets elevators.
export const FIRESTONE = 100;
const TOOLS = new Set([FIRESTONE]);
export const isTool = (b) => TOOLS.has(b);

// Atlas layout: 8x16 grid of 16px tiles (grew a row block for the four
// elevator-direction counter sets; still plenty of room).
export const ATLAS_COLS = 8, ATLAS_ROWS = 16, TILE_PX = 16;

// tile name -> atlas slot index (col = i%COLS, row = floor(i/COLS))
const TILE = {
  grass_top: 0, grass_side: 1, dirt: 2, stone: 3,
  sand: 4, wood_top: 5, wood_side: 6, leaves: 7,
  water: 8, planks: 9, glass: 10, brick: 11,
  cobble: 12, snow: 13, pumpkin_top: 14, pumpkin_side: 15,
  gold: 16, diamond: 17, wool_red: 18, wool_blue: 19,
  tnt_side: 20, tnt_top: 21, flint: 22, firestone: 23, glowstone: 24,
  mossy: 25, marble: 26, rainbow: 27,
  pumpkin_lit: 28, prox_off: 29, prox_others: 30, prox_all: 31,
};
// Elevator counter tiles: 32..41 up, 42..51 side-forward, 52..61 down,
// 62..71 side-back, 72..81 side-right, 82..91 side-left.
for (let i = 1; i <= ELEV_MAX; i++) {
  TILE[`elev_up_${i}`] = 31 + i;
  TILE[`elev_side_${i}`] = 41 + i;
  TILE[`elev_down_${i}`] = 51 + i;
  TILE[`elev_side_rev_${i}`] = 61 + i;
  TILE[`elev_side_r_${i}`] = 71 + i;
  TILE[`elev_side_l_${i}`] = 81 + i;
}

// Blocks that emit light (rendered with an emissive glow material and fed to
// the night-time point-light pool).
export const isGlow = (b) => b === GLOWSTONE || b === PUMPKIN_LIT;

// Representative colour per block, for break-dust particles.
const BLOCK_COLOR = {
  [GRASS]: 0x5fae3a, [DIRT]: 0x8a5a3b, [STONE]: 0x888888, [WOOD]: 0x6e4a28,
  [LEAVES]: 0x3f7d2e, [SAND]: 0xddca8c, [WATER]: 0x2f6fd6, [PLANKS]: 0xc19a5b,
  [GLASS]: 0xcfe0ff, [BRICK]: 0xa43b2a, [COBBLE]: 0x7e7e7e, [SNOW]: 0xeef3fa,
  [PUMPKIN]: 0xe08a2a, [GOLD]: 0xf1c92e, [DIAMOND]: 0x56d6d6, [WOOL_RED]: 0xc63f3f,
  [WOOL_BLUE]: 0x3f59c6, [TNT]: 0xc0392b, [FLINT]: 0x3b3f47, [GLOWSTONE]: 0xffcb52,
  [PUMPKIN_LIT]: 0xffb63e, [PROX_OFF]: 0x6f7683, [PROX_OTHERS]: 0xd7b23e, [PROX_ALL]: 0xd0503e,
};
for (let i = 0; i < ELEV_MAX; i++) {
  BLOCK_COLOR[ELEV_UP + i] = 0x7f93a8;
  BLOCK_COLOR[ELEV_DOWN + i] = 0x7f93a8;
  BLOCK_COLOR[ELEV_SIDE + i] = 0xa8937f;
  BLOCK_COLOR[ELEV_SIDE_REV + i] = 0xa8937f;
  BLOCK_COLOR[ELEV_SIDE_R + i] = 0xa8937f;
  BLOCK_COLOR[ELEV_SIDE_L + i] = 0xa8937f;
}
export const blockColor = (b) => BLOCK_COLOR[b] ?? 0xaaaaaa;

export const BLOCKS = {
  [GRASS]:  { name: 'Grass',  top: TILE.grass_top, side: TILE.grass_side, bottom: TILE.dirt },
  [DIRT]:   { name: 'Dirt',   top: TILE.dirt,      side: TILE.dirt,       bottom: TILE.dirt },
  [STONE]:  { name: 'Stone',  top: TILE.stone,     side: TILE.stone,      bottom: TILE.stone },
  [WOOD]:   { name: 'Wood',   top: TILE.wood_top,  side: TILE.wood_side,  bottom: TILE.wood_top },
  [LEAVES]: { name: 'Leaves', top: TILE.leaves,    side: TILE.leaves,     bottom: TILE.leaves },
  [SAND]:   { name: 'Sand',   top: TILE.sand,      side: TILE.sand,       bottom: TILE.sand },
  [WATER]:  { name: 'Water',  top: TILE.water,     side: TILE.water,      bottom: TILE.water },
  [PLANKS]: { name: 'Planks', top: TILE.planks,    side: TILE.planks,     bottom: TILE.planks },
  [GLASS]:  { name: 'Glass',  top: TILE.glass,     side: TILE.glass,      bottom: TILE.glass },
  [BRICK]:  { name: 'Brick',  top: TILE.brick,     side: TILE.brick,      bottom: TILE.brick },
  [COBBLE]: { name: 'Cobble', top: TILE.cobble,    side: TILE.cobble,     bottom: TILE.cobble },
  [SNOW]:   { name: 'Snow',   top: TILE.snow,      side: TILE.snow,       bottom: TILE.snow },
  [PUMPKIN]:{ name: 'Pumpkin',top: TILE.pumpkin_top, side: TILE.pumpkin_side, bottom: TILE.pumpkin_top },
  [GOLD]:   { name: 'Gold',   top: TILE.gold,      side: TILE.gold,       bottom: TILE.gold },
  [DIAMOND]:{ name: 'Diamond',top: TILE.diamond,   side: TILE.diamond,    bottom: TILE.diamond },
  [WOOL_RED]: { name: 'Red Wool',  top: TILE.wool_red,  side: TILE.wool_red,  bottom: TILE.wool_red },
  [WOOL_BLUE]:{ name: 'Blue Wool', top: TILE.wool_blue, side: TILE.wool_blue, bottom: TILE.wool_blue },
  [TNT]:      { name: 'TNT',       top: TILE.tnt_top,   side: TILE.tnt_side,  bottom: TILE.tnt_top },
  [FLINT]:    { name: 'Flint',     top: TILE.flint,     side: TILE.flint,     bottom: TILE.flint },
  [GLOWSTONE]:{ name: 'Glowstone', top: TILE.glowstone, side: TILE.glowstone, bottom: TILE.glowstone },
  [MOSSY]:    { name: 'Mossy Cobble', top: TILE.mossy,  side: TILE.mossy,   bottom: TILE.mossy },
  [MARBLE]:   { name: 'Marble',    top: TILE.marble,    side: TILE.marble,   bottom: TILE.marble },
  [RAINBOW]:  { name: 'Rainbow',   top: TILE.rainbow,   side: TILE.rainbow,  bottom: TILE.rainbow },
  [PUMPKIN_LIT]: { name: "Jack-o'-Lantern", top: TILE.pumpkin_top, side: TILE.pumpkin_lit, bottom: TILE.pumpkin_top },
  [PROX_OFF]:    { name: 'Proximity Mine (off)',      top: TILE.prox_off,    side: TILE.prox_off,    bottom: TILE.prox_off },
  [PROX_OTHERS]: { name: 'Proximity Mine (others)',   top: TILE.prox_others, side: TILE.prox_others, bottom: TILE.prox_others },
  [PROX_ALL]:    { name: 'Proximity Mine (EVERYONE)', top: TILE.prox_all,    side: TILE.prox_all,    bottom: TILE.prox_all },
  [FIRESTONE]:{ name: 'Firestone (magic striker)', top: TILE.firestone, side: TILE.firestone, bottom: TILE.firestone },
};
for (let i = 1; i <= ELEV_MAX; i++) {
  const t = (name) => ({ top: TILE[`${name}_${i}`], side: TILE[`${name}_${i}`],
                         bottom: TILE[`${name}_${i}`] });
  BLOCKS[ELEV_UP + i - 1] = { name: `Up Elevator (${i})`, ...t('elev_up') };
  BLOCKS[ELEV_DOWN + i - 1] = { name: `Down Elevator (${i})`, ...t('elev_down') };
  BLOCKS[ELEV_SIDE + i - 1] = { name: `Side Elevator (forward ${i})`, ...t('elev_side') };
  BLOCKS[ELEV_SIDE_R + i - 1] = { name: `Side Elevator (right ${i})`, ...t('elev_side_r') };
  BLOCKS[ELEV_SIDE_REV + i - 1] = { name: `Side Elevator (back ${i})`, ...t('elev_side_rev') };
  BLOCKS[ELEV_SIDE_L + i - 1] = { name: `Side Elevator (left ${i})`, ...t('elev_side_l') };
}

// Transparent for face-culling purposes (a face is drawn against these).
const TRANSPARENT = new Set([AIR, WATER, GLASS, LEAVES]);
export const isTransparent = (b) => TRANSPARENT.has(b);

// Solid for physics / collision (everything you can stand on).
export const isSolid = (b) => b !== AIR && b !== WATER;

// The hotbar: 8 slots, keys 1..8 (and scroll). Swap any block in via the
// inventory (E). This array is mutated when you pick a block from there.
export const HOTBAR = [
  GRASS, DIRT, STONE, COBBLE, PLANKS, WOOD, GLASS, GLOWSTONE,
];

// Everything available in the inventory picker (E) — no crafting, every block
// (including the former "craft" specials) is simply available. Water is
// placeable too: the mesher/transparency handle it anywhere, so kids can build
// pools. Elevators appear once (distance 1) and jack-o'-lanterns aren't listed
// at all — Firestone strikes re-tune the former and light the latter.
export const ALL_BLOCKS = [
  GRASS, DIRT, STONE, COBBLE, MOSSY, MARBLE, PLANKS, WOOD, LEAVES, SAND,
  SNOW, BRICK, GLASS, WATER, GLOWSTONE, GOLD, DIAMOND, PUMPKIN,
  WOOL_RED, WOOL_BLUE, RAINBOW, TNT, PROX_OFF, ELEV_UP, ELEV_SIDE,
  FLINT, FIRESTONE,
];

// --- Procedural pixel-art tiles ---------------------------------------------
// Deterministic per-pixel noise so textures look the same every run.
function hash(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 8) / 0xFFFFFF; // 0..1
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return `rgb(${r},${g},${b})`;
}

function speckle(ctx, base, salt, jitter) {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const amt = Math.floor((hash(x, y, salt) - 0.5) * jitter);
      ctx.fillStyle = shade(base, amt);
      ctx.fillRect(x, y, 1, 1);
    }
}

// Shared pieces for the pumpkin / jack-o'-lantern and proximity-mine tiles.
function pumpkinBody(c) {
  speckle(c, '#e08a2a', 20, 18);
  c.fillStyle = shade('#b56a16', 0);                // vertical ridges
  for (let x = 2; x < 16; x += 4) c.fillRect(x, 0, 1, 16);
}
function pumpkinFace(c, col) {
  c.fillStyle = col;                                // carved face
  c.fillRect(3, 5, 2, 2); c.fillRect(11, 5, 2, 2);       // eyes
  c.fillRect(7, 6, 2, 2);                                // nose
  c.fillRect(4, 10, 8, 1); c.fillRect(4, 9, 1, 1);
  c.fillRect(11, 9, 1, 1); c.fillRect(6, 11, 1, 1); c.fillRect(9, 11, 1, 1);  // grin
}
function proxBody(c) {
  speckle(c, '#565c66', 70, 14);                    // gunmetal housing
  c.fillStyle = 'rgba(0,0,0,0.45)';                 // frame
  c.fillRect(0, 0, 16, 1); c.fillRect(0, 15, 16, 1);
  c.fillRect(0, 0, 1, 16); c.fillRect(15, 0, 1, 16);
  c.fillStyle = '#3a3f47';                          // sensor recess
  c.fillRect(4, 5, 8, 6);
}
function proxEye(c, col) {
  c.fillStyle = col;
  c.fillRect(6, 6, 4, 4);
  c.fillStyle = '#1c1c22';
  c.fillRect(7, 7, 2, 2);                           // pupil
}

// Tiny 3x5 digit font (drawn at 2x) for the elevator distance counters.
const DIGITS = [
  '111101101101111', '010110010010111', '111001111100111', '111001111001111',
  '101101111001001', '111100111001111', '111100111101111', '111001010010010',
  '111101111101111', '111101111001111',
];
function drawDigits(c, n, color) {
  const s = String(n);
  let x0 = Math.floor((16 - (s.length * 6 + (s.length - 1) * 2)) / 2);
  c.fillStyle = color;
  for (const ch of s) {
    const bits = DIGITS[+ch];
    for (let r = 0; r < 5; r++)
      for (let col = 0; col < 3; col++)
        if (bits[r * 3 + col] === '1') c.fillRect(x0 + col * 2, 6 + r * 2, 2, 2);
    x0 += 8;
  }
}

// A chunky pixel arrow (solid head + shaft) in the tile's top band (rows 1..5).
// Directions are the rider's: up = forward / the way you look, right = your
// right, and so on.
function drawArrow(c, dir, color) {
  c.fillStyle = color;
  if (dir === 'up') {
    c.fillRect(7, 1, 2, 1); c.fillRect(6, 2, 4, 1); c.fillRect(5, 3, 6, 1);
    c.fillRect(7, 4, 2, 2);
  } else if (dir === 'down') {
    c.fillRect(7, 1, 2, 2);
    c.fillRect(5, 3, 6, 1); c.fillRect(6, 4, 4, 1); c.fillRect(7, 5, 2, 1);
  } else if (dir === 'right') {
    c.fillRect(3, 3, 6, 1);                                        // shaft
    c.fillRect(9, 1, 1, 5); c.fillRect(10, 2, 1, 3); c.fillRect(11, 3, 1, 1);
  } else {                                                          // left
    c.fillRect(7, 3, 6, 1);
    c.fillRect(6, 1, 1, 5); c.fillRect(5, 2, 1, 3); c.fillRect(4, 3, 1, 1);
  }
}

// Elevator tile: metal pad, a direction arrow, and the set distance in big
// digits — "the count on the outside of the cube". Vertical elevators are
// steel-blue (green ⬆ / red ⬇); horizontal are tan with yellow arrows for the
// rider-relative glide direction (⬆ forward, ➡ right, ⬇ back, ⬅ left).
const ELEV_STYLE = {
  up:    { body: '#7f93a8', mark: '#8dffab', salt: 60,  arrow: 'up' },
  down:  { body: '#7f93a8', mark: '#ff8d7d', salt: 90,  arrow: 'down' },
  fwd:   { body: '#a8937f', mark: '#ffd34d', salt: 120, arrow: 'up' },
  right: { body: '#a8937f', mark: '#ffd34d', salt: 150, arrow: 'right' },
  back:  { body: '#a8937f', mark: '#ffd34d', salt: 180, arrow: 'down' },
  left:  { body: '#a8937f', mark: '#ffd34d', salt: 210, arrow: 'left' },
};
const elevatorTile = (n, kind) => (c) => {
  const st = ELEV_STYLE[kind];
  speckle(c, st.body, st.salt + n, 16);
  c.fillStyle = 'rgba(0,0,0,0.4)';                  // frame
  c.fillRect(0, 0, 16, 1); c.fillRect(0, 15, 16, 1);
  c.fillRect(0, 0, 1, 16); c.fillRect(15, 0, 1, 16);
  drawArrow(c, st.arrow, st.mark);
  drawDigits(c, n, '#ffffff');
};

const TILE_PAINTERS = {
  dirt: (c) => speckle(c, '#8a5a3b', 1, 40),
  grass_top: (c) => speckle(c, '#5fae3a', 2, 40),
  stone: (c) => speckle(c, '#888888', 3, 36),
  sand: (c) => speckle(c, '#ddca8c', 4, 28),
  grass_side: (c) => {
    speckle(c, '#8a5a3b', 1, 40);                 // dirt body
    for (let x = 0; x < 16; x++) {
      const lip = 3 + Math.floor(hash(x, 0, 9) * 3);
      for (let y = 0; y < lip; y++) {
        c.fillStyle = shade('#5fae3a', Math.floor((hash(x, y, 2) - 0.5) * 40));
        c.fillRect(x, y, 1, 1);
      }
    }
  },
  wood_top: (c) => {
    speckle(c, '#b5894e', 5, 24);
    c.strokeStyle = shade('#7a5a30', 0);
    c.beginPath(); c.arc(8, 8, 5, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(8, 8, 2.5, 0, Math.PI * 2); c.stroke();
  },
  wood_side: (c) => {
    speckle(c, '#6e4a28', 6, 26);
    for (let x = 1; x < 16; x += 4) {
      c.fillStyle = shade('#4f3318', 0);
      c.fillRect(x, 0, 1, 16);
    }
  },
  planks: (c) => {
    speckle(c, '#c19a5b', 9, 22);
    c.fillStyle = shade('#8a6a36', -10);
    for (let y = 0; y < 16; y += 4) c.fillRect(0, y, 16, 1);
    for (let y = 0; y < 16; y += 4) c.fillRect((y % 8) ? 8 : 4, y, 1, 4);
  },
  brick: (c) => {
    speckle(c, '#a43b2a', 10, 22);
    c.fillStyle = '#cabfa6';                       // mortar
    for (let y = 0; y < 16; y += 4) c.fillRect(0, y, 16, 1);
    for (let y = 0; y < 16; y += 8) { c.fillRect(8, y, 1, 4); }
    for (let y = 4; y < 16; y += 8) { c.fillRect(0, y, 1, 4); c.fillRect(15, y, 1, 4); }
  },
  cobble: (c) => {
    speckle(c, '#7e7e7e', 3, 18);
    c.fillStyle = '#5a5a5a';
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        if (hash(x, y, 12) > 0.86) c.fillRect(x, y, 1, 1);
  },
  leaves: (c) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        if (hash(x, y, 7) > 0.82) continue;        // gaps -> see-through
        c.fillStyle = shade('#3f7d2e', Math.floor((hash(x, y, 8) - 0.5) * 60));
        c.fillRect(x, y, 1, 1);
      }
  },
  water: (c) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        c.fillStyle = shade('#2f6fd6', Math.floor((hash(x, y, 11) - 0.5) * 30));
        c.fillRect(x, y, 1, 1);
      }
  },
  glass: (c) => {
    c.clearRect(0, 0, 16, 16);                     // mostly see-through
    c.fillStyle = 'rgba(200,225,240,0.9)';         // frame
    c.fillRect(0, 0, 16, 1); c.fillRect(0, 15, 16, 1);
    c.fillRect(0, 0, 1, 16); c.fillRect(15, 0, 1, 16);
    c.fillStyle = 'rgba(220,240,255,0.8)';         // diagonal glint
    for (let i = 3; i < 12; i++) c.fillRect(i, i, 1, 1);
  },
  snow: (c) => speckle(c, '#eef3fa', 14, 14),
  gold: (c) => {
    speckle(c, '#f1c92e', 16, 26);
    c.fillStyle = 'rgba(255,255,255,0.9)';         // a few shiny pixels
    for (let i = 0; i < 6; i++) c.fillRect(2 + (i * 3) % 12, 2 + (i * 5) % 12, 1, 1);
  },
  diamond: (c) => {
    speckle(c, '#56d6d6', 17, 22);
    c.fillStyle = 'rgba(255,255,255,0.85)';        // facet highlights
    for (let i = 2; i < 14; i += 4) { c.fillRect(i, i, 2, 1); c.fillRect(14 - i, i, 1, 2); }
  },
  wool_red: (c) => speckle(c, '#c63f3f', 18, 18),
  wool_blue: (c) => speckle(c, '#3f59c6', 19, 18),
  pumpkin_top: (c) => {
    speckle(c, '#e08a2a', 20, 22);
    c.fillStyle = '#6e4a18';                        // stem
    c.fillRect(7, 6, 2, 4);
  },
  pumpkin_side: (c) => { pumpkinBody(c); pumpkinFace(c, '#3a2408'); },
  pumpkin_lit: (c) => {
    pumpkinBody(c);
    c.fillStyle = 'rgba(255,214,110,0.35)';         // warm halo behind the face
    c.fillRect(2, 4, 12, 9);
    pumpkinFace(c, '#ffe27a');                      // the carved face glows
  },
  prox_off: (c) => { proxBody(c); c.fillStyle = '#20242a'; c.fillRect(5, 7, 6, 2); },  // eye shut
  prox_others: (c) => { proxBody(c); proxEye(c, '#ffd34d'); },   // yellow: watches others
  prox_all: (c) => {
    proxBody(c); proxEye(c, '#ff5340');             // red: watches EVERYONE
    c.fillStyle = 'rgba(255,90,60,0.8)';            // warning ticks in the corners
    c.fillRect(2, 2, 2, 1); c.fillRect(12, 2, 2, 1);
    c.fillRect(2, 13, 2, 1); c.fillRect(12, 13, 2, 1);
  },
  tnt_side: (c) => {
    speckle(c, '#c0392b', 30, 16);                  // red body
    c.fillStyle = '#efe7cf';                        // cream label band
    c.fillRect(0, 5, 16, 6);
    c.fillStyle = '#7a2018';                        // "TNT" letters
    const letterT = (x) => { c.fillRect(x, 6, 3, 1); c.fillRect(x + 1, 6, 1, 4); };
    const letterN = (x) => {
      c.fillRect(x, 6, 1, 4); c.fillRect(x + 2, 6, 1, 4);
      c.fillRect(x + 1, 7, 1, 1); c.fillRect(x + 1, 8, 1, 1);
    };
    letterT(1); letterN(6); letterT(11);
  },
  tnt_top: (c) => {
    speckle(c, '#a8302a', 31, 14);
    c.fillStyle = '#2f2f2f';                        // fuse hole
    c.beginPath(); c.arc(8, 8, 3, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#caa15a';                        // fuse stub
    c.fillRect(7, 7, 2, 2);
  },
  flint: (c) => {
    speckle(c, '#3b3f47', 32, 20);                  // dark blue-grey stone
    c.fillStyle = '#23262b';
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        if (hash(x, y, 33) > 0.78) c.fillRect(x, y, 1, 1);   // chipped facets
  },
  glowstone: (c) => {
    speckle(c, '#a87b36', 40, 22);                  // warm amber stone base
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const h = hash(x, y, 41);
        if (h > 0.86) { c.fillStyle = '#fff3b0'; c.fillRect(x, y, 1, 1); }      // bright cores
        else if (h > 0.70) { c.fillStyle = '#ffcb52'; c.fillRect(x, y, 1, 1); } // warm glow
      }
    c.fillStyle = '#ffe488';                        // a few larger embers
    c.fillRect(3, 3, 2, 2); c.fillRect(10, 9, 2, 2); c.fillRect(7, 11, 2, 2);
    c.fillStyle = '#fff3b0';
    c.fillRect(4, 4, 1, 1); c.fillRect(11, 10, 1, 1);
  },
  mossy: (c) => {
    speckle(c, '#7e7e7e', 3, 18);                   // cobble grey base
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        if (hash(x, y, 55) > 0.68) {
          c.fillStyle = shade('#4a7a3a', Math.floor((hash(x, y, 56) - 0.5) * 36));
          c.fillRect(x, y, 1, 1);
        }
  },
  marble: (c) => {
    speckle(c, '#e9e9f0', 50, 8);                   // near-white
    c.strokeStyle = 'rgba(150,150,170,0.55)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(2, 3); c.lineTo(7, 8); c.lineTo(5, 14); c.stroke();
    c.beginPath(); c.moveTo(11, 1); c.lineTo(9, 7); c.lineTo(14, 13); c.stroke();
  },
  rainbow: (c) => {
    const cols = ['#e23b3b', '#e8862b', '#e8d23b', '#3fae3a', '#3f6fd6', '#9b3fd6'];
    const bh = 16 / cols.length;
    for (let i = 0; i < cols.length; i++) {
      c.fillStyle = cols[i];
      c.fillRect(0, Math.round(i * bh), 16, Math.ceil(bh) + 1);
    }
  },
  firestone: (c) => {
    c.clearRect(0, 0, 16, 16);                      // icon only (transparent bg)
    c.fillStyle = '#9aa0a8'; c.fillRect(3, 7, 9, 3);        // steel striker
    c.fillStyle = '#6f757d'; c.fillRect(3, 9, 9, 1);
    c.fillStyle = '#7a5a30'; c.fillRect(2, 9, 3, 4);        // handle
    c.fillStyle = '#2b2f36'; c.fillRect(9, 3, 4, 4);        // flint
    c.fillStyle = '#ffd34d';                               // sparks
    c.fillRect(12, 2, 1, 1); c.fillRect(13, 4, 1, 1); c.fillRect(11, 1, 1, 1);
  },
};
for (let i = 1; i <= ELEV_MAX; i++) {
  TILE_PAINTERS[`elev_up_${i}`] = elevatorTile(i, 'up');
  TILE_PAINTERS[`elev_down_${i}`] = elevatorTile(i, 'down');
  TILE_PAINTERS[`elev_side_${i}`] = elevatorTile(i, 'fwd');
  TILE_PAINTERS[`elev_side_r_${i}`] = elevatorTile(i, 'right');
  TILE_PAINTERS[`elev_side_rev_${i}`] = elevatorTile(i, 'back');
  TILE_PAINTERS[`elev_side_l_${i}`] = elevatorTile(i, 'left');
}

// Build the atlas texture. Uses /static/textures/<name>.png when present (only
// the names in `available`, so we never request a missing file), otherwise
// paints the procedural tile. Returns a Promise<THREE.Texture>.
export async function buildAtlasTexture(available = []) {
  const overrides = new Set(available);
  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_COLS * TILE_PX;
  atlas.height = ATLAS_ROWS * TILE_PX;
  const actx = atlas.getContext('2d');

  const loadOverride = (name) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `/static/textures/${name}.png`;
  });

  for (const [name, slot] of Object.entries(TILE)) {
    const col = slot % ATLAS_COLS, row = Math.floor(slot / ATLAS_COLS);
    const ox = col * TILE_PX, oy = row * TILE_PX;
    const img = overrides.has(name) ? await loadOverride(name) : null;
    if (img) {
      actx.imageSmoothingEnabled = false;
      actx.drawImage(img, ox, oy, TILE_PX, TILE_PX);
    } else {
      const tile = document.createElement('canvas');
      tile.width = TILE_PX; tile.height = TILE_PX;
      (TILE_PAINTERS[name] || ((c) => speckle(c, '#cc00cc', 0, 0)))(tile.getContext('2d'));
      actx.drawImage(tile, ox, oy);
    }
  }

  const tex = new THREE.CanvasTexture(atlas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// UV rect for a tile slot, with a tiny inset to avoid edge bleeding.
export function tileUV(slot) {
  const col = slot % ATLAS_COLS, row = Math.floor(slot / ATLAS_COLS);
  const inset = 0.5 / (ATLAS_COLS * TILE_PX);
  const u0 = col / ATLAS_COLS + inset;
  const u1 = (col + 1) / ATLAS_COLS - inset;
  // Atlas canvas is drawn top-down; CanvasTexture flips Y, so tile-top -> v1.
  const v1 = 1 - row / ATLAS_ROWS - inset;
  const v0 = 1 - (row + 1) / ATLAS_ROWS + inset;
  return { u0, u1, v0, v1 };
}
