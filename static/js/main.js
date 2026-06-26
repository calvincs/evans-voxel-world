// EvansGame bootstrap.
//
// Flow: show the world menu -> the player picks or creates a named world ->
// startGame() builds everything scoped to that world id and runs the loop.

import * as THREE from 'three';
import { createRenderer } from './engine/renderer.js';
import { setDims } from './engine/constants.js';
import { World } from './engine/world.js';
import { Player } from './engine/player.js';
import { Sky } from './engine/sky.js';
import { setupTouchControls } from './touch.js';
import * as audio from './audio.js';
import { Net } from './net.js';
import { RemotePlayers } from './remoteplayers.js';
import {
  buildAtlasTexture, BLOCKS, HOTBAR, ATLAS_COLS, TILE_PX,
} from './blocks.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

function playerName() {
  const el = $('player-name');
  let name = (el && el.value.trim()) || localStorage.getItem('evanName') || '';
  if (!name) name = 'Player' + Math.floor(10 + Math.random() * 90);
  localStorage.setItem('evanName', name);
  return name.slice(0, 20);
}
const jpost = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then((r) => r.json());

async function main() {
  audio.prefetchOverrides();

  // Demo / kiosk: skip the menu, jump into a world. ?demo&w=<id> targets a
  // specific world; otherwise the most recent (or a fresh "Demo").
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    let id = params.get('w');
    if (!id) {
      const { worlds } = await (await fetch('/api/worlds')).json();
      id = worlds[0]?.id || (await jpost('/api/worlds', { name: 'Demo' })).world.id;
    }
    return startGame(id, true);
  }

  const worldId = await chooseWorld();
  startGame(worldId, false);
}

// --- World menu --------------------------------------------------------------
function chooseWorld() {
  return new Promise((resolve) => {
    const menu = $('menu');
    const list = $('world-list');
    const nameInput = $('world-name');

    const pn = $('player-name');                 // remember the player's name
    pn.value = localStorage.getItem('evanName') || '';
    pn.oninput = () => localStorage.setItem('evanName', pn.value.trim());

    const create = async () => {
      const name = nameInput.value.trim();
      const { world } = await jpost('/api/worlds', { name: name || 'New World' });
      resolve(world.id);
    };
    $('create-world').onclick = create;
    nameInput.onkeydown = (e) => { if (e.key === 'Enter') create(); };

    const refresh = async () => {
      const { worlds } = await (await fetch('/api/worlds')).json();
      list.innerHTML = '';
      if (worlds.length === 0) {
        list.innerHTML = '<p class="empty">No worlds yet — name one and hit Create!</p>';
        nameInput.focus();
        return;
      }
      for (const w of worlds) {
        const row = document.createElement('div');
        row.className = 'world-row';
        row.innerHTML =
          `<div class="world-info">
             <span class="world-name"></span>
             <span class="world-meta">${w.edits} edit${w.edits === 1 ? '' : 's'} · ${timeAgo(w.lastPlayed)}</span>
           </div>
           <button class="world-play">Play ▶</button>
           <button class="world-del" title="Delete world">🗑</button>`;
        row.querySelector('.world-name').textContent = w.name;
        const go = () => resolve(w.id);
        row.querySelector('.world-info').onclick = go;
        row.querySelector('.world-play').onclick = go;
        row.querySelector('.world-del').onclick = async (e) => {
          e.stopPropagation();
          if (confirm(`Delete "${w.name}"? This can't be undone.`)) {
            await fetch(`/api/worlds/${w.id}`, { method: 'DELETE' });
            refresh();
          }
        };
        list.appendChild(row);
      }
    };
    menu.classList.remove('hidden');
    refresh();
  });
}

function timeAgo(unixSeconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// --- Game --------------------------------------------------------------------
async function startGame(worldId, demo) {
  const cfg = await (await fetch(`/api/worlds/${worldId}/config`)).json();
  setDims(cfg);

  const canvas = $('game');
  const { renderer, scene, camera } = createRenderer(canvas);
  const sky = new Sky(scene);
  const atlas = await buildAtlasTexture();

  const world = new World(scene, atlas, worldId);
  const spawn = cfg.player || cfg.spawn;
  const player = new Player(camera, world, scene, canvas, spawn);
  player.mobile = isTouch;
  player.onBreakPlace = () => flashCrosshair();
  world.onExplosion = () => player.shake(0.9);

  if (isTouch) setupTouchControls(player);
  buildHotbar(atlas.image, player);
  world.update(spawn.x, spawn.z);   // preload spawn chunks

  // Multiplayer: stream our position and apply others' edits + movements.
  const remotes = new RemotePlayers(scene);
  const net = new Net(worldId, playerName(), {
    onWelcome: (id, players) => players.forEach((p) => remotes.add(p)),
    onJoin: (p) => remotes.add(p),
    onLeave: (id) => remotes.remove(id),
    onPos: (m) => remotes.setPos(m),
    onEdit: (m) => world.setBlock(m.x, m.y, m.z, m.block, false),
    onEdits: (edits) => edits.forEach((e) => world.setBlock(e.x, e.y, e.z, e.block, false)),
  });
  world.net = net;
  window.game = { world, player, sky, remotes, net };

  // Swap the menu for the play screen.
  $('menu').classList.add('hidden');
  const overlay = $('overlay');
  $('title').textContent = cfg.name;
  overlay.classList.remove('hidden');

  const prevOnEngage = player.onEngage;
  player.onEngage = () => { overlay.classList.add('hidden'); if (prevOnEngage) prevOnEngage(); };
  overlay.addEventListener('click', () => player.engage());
  $('play').addEventListener('click', (e) => { e.stopPropagation(); player.engage(); });
  $('worlds').addEventListener('click', (e) => { e.stopPropagation(); location.reload(); });
  document.addEventListener('pointerlockchange', () => {
    if (!isTouch) overlay.classList.toggle('hidden', document.pointerLockElement === canvas);
  });

  // Persist player position to this world.
  const savePlayer = (beacon = false) => {
    const url = `${world.base}/player`;
    const body = JSON.stringify(player.state());
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, keepalive: true }).catch(() => {});
    }
  };
  setInterval(() => { if (player.locked) savePlayer(); }, 5000);
  window.addEventListener('beforeunload', () => savePlayer(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePlayer(true);
  });

  if (demo) { player.mobile = true; player.engage(); }

  const clock = new THREE.Clock();
  let lastSel = -1;
  function loop() {
    const dt = clock.getDelta();
    player.update(dt);
    sky.update(dt, player.pos);
    world.update(player.pos.x, player.pos.z, dt, sky.daylight);

    // Multiplayer sync.
    if (player.locked) net.sendPos(player.state(), performance.now());
    remotes.update(dt);

    if (player.selected !== lastSel) { highlightSlot(player.selected); lastSel = player.selected; }
    $('coords').textContent =
      `x ${player.pos.x.toFixed(0)}  y ${player.pos.y.toFixed(0)}  z ${player.pos.z.toFixed(0)}  ·  ${sky.clock()}`;

    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();
}

// --- HUD ---------------------------------------------------------------------
function buildHotbar(atlasCanvas, player) {
  const bar = $('hotbar');
  bar.innerHTML = '';
  HOTBAR.forEach((block, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.title = BLOCKS[block].name;

    const icon = document.createElement('canvas');
    icon.width = icon.height = 36;
    const ctx = icon.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const t = BLOCKS[block].side;
    const sx = (t % ATLAS_COLS) * TILE_PX;
    const sy = Math.floor(t / ATLAS_COLS) * TILE_PX;
    ctx.drawImage(atlasCanvas, sx, sy, TILE_PX, TILE_PX, 0, 0, 36, 36);
    slot.appendChild(icon);

    if (i < 10) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = (i + 1) % 10;
      slot.appendChild(key);
    }
    slot.addEventListener('click', (e) => { e.stopPropagation(); player.selectBlock(i); });
    bar.appendChild(slot);
  });
  highlightSlot(0);
}

function highlightSlot(i) {
  document.querySelectorAll('#hotbar .slot').forEach((s, n) =>
    s.classList.toggle('active', n === i));
}

let flashTimer = null;
function flashCrosshair() {
  const c = $('crosshair');
  c.classList.add('hit');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => c.classList.remove('hit'), 90);
}

main().catch((e) => {
  console.error(e);
  $('menu').innerHTML = `<div class="panel"><h1>Couldn't start</h1><p>${e}</p></div>`;
  $('menu').classList.remove('hidden');
});
