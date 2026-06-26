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
import { RemotePlayers, playerColor, SELF_COLOR } from './remoteplayers.js';
import { Voice } from './voice.js';
import { Mobs } from './mobs.js';
import {
  buildAtlasTexture, BLOCKS, HOTBAR, ALL_BLOCKS, CRAFT, ATLAS_COLS, TILE_PX, blockColor,
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
  // Camera shake from an explosion, scaled by how close it was.
  const feltShake = (x, y, z) => {
    const d = Math.hypot(player.pos.x - (x + 0.5), player.pos.y - (y + 0.5), player.pos.z - (z + 0.5));
    if (d < 16) player.shake(0.9 * (1 - d / 16));
  };
  world.onExplosion = (x, y, z) => feltShake(x, y, z);

  if (isTouch) setupTouchControls(player);
  buildHotbar(atlas.image, player);
  world.update(spawn.x, spawn.z);   // preload spawn chunks

  const mobs = new Mobs(scene, world);   // wandering animals

  // Multiplayer: stream our position and apply others' edits + movements.
  const remotes = new RemotePlayers(scene);
  const myName = playerName();
  const roster = new Map();       // id -> { name }
  const voiceIds = new Set();     // ids currently in voice
  const rosterEls = new Map();    // id -> roster row element (for speaking highlight)
  const net = new Net(worldId, myName, {
    onWelcome: (id, players) => { players.forEach((p) => { remotes.add(p); roster.set(p.id, { name: p.name }); }); renderRoster(); },
    onJoin: (p) => { remotes.add(p); roster.set(p.id, { name: p.name }); renderRoster(); },
    onLeave: (id) => { remotes.remove(id); roster.delete(id); voiceIds.delete(id); renderRoster(); },
    onPos: (m) => remotes.setPos(m),
    onEdit: (m) => {
      const pos = { x: m.x + 0.5, y: m.y + 0.5, z: m.z + 0.5 };
      if (m.block === 0) {
        const broken = world.getBlock(m.x, m.y, m.z);    // colour before removing
        world.setBlock(m.x, m.y, m.z, 0, false);
        world.spawnBreakBurst(m.x, m.y, m.z, blockColor(broken));
        audio.playBreak(pos);
      } else {
        world.setBlock(m.x, m.y, m.z, m.block, false);
        audio.playPlace(pos);
      }
    },
    onEdits: (edits) => edits.forEach((e) => world.setBlock(e.x, e.y, e.z, e.block, false)),
    onFx: (m) => {
      if (m.kind === 'explode') {
        audio.playExplosion({ x: m.x + 0.5, y: m.y + 0.5, z: m.z + 0.5 });
        world._spawnParticles(m.x, m.y, m.z);
        feltShake(m.x, m.y, m.z);
      } else if (m.kind === 'ignite') {
        audio.playIgnite({ x: m.x + 0.5, y: m.y + 0.5, z: m.z + 0.5 });
      }
    },
    onVoice: (m) => voice.handle(m),
  });
  world.net = net;

  // Proximity voice chat (WebRTC). Peer audio is positioned by where that
  // player is, via remotes' interpolated positions.
  const voice = new Voice(net, () => net.myId, (id) => {
    const r = remotes.players.get(id);
    return r ? r.cur : null;
  });
  voice.onRoster = (id, inVoice) => { if (inVoice) voiceIds.add(id); else voiceIds.delete(id); renderRoster(); };
  voice.onState = () => { updateVoiceButton(); renderRoster(); };
  setupVoiceButton(voice);

  // True while a text field (the name inputs on the menu) is focused, so game
  // hotkeys don't fire while typing.
  function typing() {
    const a = document.activeElement;
    return !!(a && a.tagName === 'INPUT');
  }

  function renderRoster() {
    const el = $('roster');
    el.innerHTML = '';
    rosterEls.clear();
    if (roster.size === 0) return;            // solo: keep it clean
    const rows = [{ id: net.myId, name: `${myName} (you)`, color: SELF_COLOR,
                    mic: voice.enabled, me: true }];
    for (const [id, info] of roster) rows.push({ id, name: info.name, color: playerColor(id), mic: voiceIds.has(id) });
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'row' + (r.me ? ' me' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = '#' + r.color.toString(16).padStart(6, '0');
      row.appendChild(dot);
      const nm = document.createElement('span'); nm.textContent = r.name; row.appendChild(nm);
      if (r.mic) { const mic = document.createElement('span'); mic.className = 'mic'; mic.textContent = '🎙️'; row.appendChild(mic); }
      el.appendChild(row);
      rosterEls.set(r.id, row);
    }
  }

  // Toggle the green "speaking" highlight on roster rows each frame.
  function updateRosterSpeaking() {
    rosterEls.forEach((row, id) => {
      const sp = id === net.myId ? voice.selfSpeaking : voice.isSpeaking(id);
      row.classList.toggle('speaking', !!sp);
    });
  }

  function updateVoiceButton() {
    const btn = $('voice'), talk = $('talk');
    btn.classList.toggle('joined', voice.enabled && !voice.transmitting);
    btn.classList.toggle('live', voice.enabled && voice.transmitting);
    btn.title = voice.enabled
      ? 'In voice — tap to leave (hold T or the Talk button to speak)'
      : 'Join voice chat (needs mic)';
    talk.classList.toggle('hidden', !voice.enabled);
    talk.classList.toggle('talking', voice.transmitting);
  }
  function setupVoiceButton(v) {
    const btn = $('voice'), talk = $('talk');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      audio.resume();
      if (!v.enabled) {
        if (!v.available()) {
          alert('Voice chat needs a secure connection (HTTPS), or play on the host machine via localhost. See the README to turn on HTTPS.');
          return;
        }
        if (!await v.enable()) { alert("Couldn't access the microphone (permission denied or no mic)."); return; }
      } else {
        v.leave();
      }
      updateVoiceButton();
    });
    // Hold-to-talk button (pointer events cover both touch and mouse).
    const down = (e) => { e.preventDefault(); e.stopPropagation(); v.startTalk(); };
    const up = (e) => { e.preventDefault(); v.stopTalk(); };
    talk.addEventListener('pointerdown', down);
    talk.addEventListener('pointerup', up);
    talk.addEventListener('pointercancel', up);
    talk.addEventListener('pointerleave', up);
    // Keyboard push-to-talk: hold T.
    document.addEventListener('keydown', (e) => { if (e.code === 'KeyT' && !e.repeat && v.enabled && !typing()) v.startTalk(); });
    document.addEventListener('keyup', (e) => { if (e.code === 'KeyT') v.stopTalk(); });
    updateVoiceButton();
  }

  window.game = { world, player, sky, remotes, net, voice, mobs };

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
  let inventoryOpen = false;
  document.addEventListener('pointerlockchange', () => {
    if (isTouch || inventoryOpen) return;   // inventory manages its own overlay
    overlay.classList.toggle('hidden', document.pointerLockElement === canvas);
  });

  // --- Inventory (E) ---------------------------------------------------------
  const atlasImg = atlas.image;
  buildInventory();
  function buildInventory() {
    const grid = $('inv-grid'); grid.innerHTML = '';
    for (const block of ALL_BLOCKS) {
      const item = document.createElement('div');
      item.className = 'inv-item'; item.title = BLOCKS[block].name;
      const cv = document.createElement('canvas'); cv.width = cv.height = 40;
      drawBlockIcon(cv, atlasImg, block, 40);
      item.appendChild(cv);
      item.addEventListener('click', () => pickBlock(block));
      grid.appendChild(item);
    }
    const craft = $('inv-craft'); craft.innerHTML = '';
    for (const r of CRAFT) {
      const item = document.createElement('div');
      item.className = 'craft-item'; item.title = 'Make ' + BLOCKS[r.out].name;
      const out = document.createElement('canvas'); out.width = out.height = 34;
      drawBlockIcon(out, atlasImg, r.out, 34); item.appendChild(out);
      const nm = document.createElement('div'); nm.className = 'craft-name';
      nm.textContent = BLOCKS[r.out].name; item.appendChild(nm);
      const rec = document.createElement('div'); rec.className = 'craft-recipe';
      r.inputs.forEach((inb, idx) => {
        const ic = document.createElement('canvas'); ic.width = ic.height = 16;
        drawBlockIcon(ic, atlasImg, inb, 16); rec.appendChild(ic);
        if (idx < r.inputs.length - 1) { const p = document.createElement('span'); p.textContent = '+'; rec.appendChild(p); }
      });
      item.appendChild(rec);
      item.addEventListener('click', () => pickBlock(r.out));
      craft.appendChild(item);
    }
  }
  function pickBlock(block) {
    HOTBAR[player.selected] = block;            // load it into the active slot
    updateHotbarSlot(player.selected, atlasImg);
    closeInventory(true);
  }
  function openInventory() {
    if (inventoryOpen) return;
    inventoryOpen = true;
    $('inventory').classList.remove('hidden');
    if (!isTouch && document.pointerLockElement === canvas) document.exitPointerLock();
  }
  function closeInventory(relock) {
    if (!inventoryOpen) return;
    inventoryOpen = false;
    $('inventory').classList.add('hidden');
    if (relock && !isTouch) canvas.requestPointerLock();
  }
  $('bag').addEventListener('click', (e) => { e.stopPropagation(); inventoryOpen ? closeInventory(true) : openInventory(); });
  $('inv-close').addEventListener('click', (e) => { e.stopPropagation(); closeInventory(true); });
  $('inventory').addEventListener('click', (e) => { if (e.target === $('inventory')) closeInventory(true); });
  document.addEventListener('keydown', (e) => {
    if (typing()) return;
    if (e.code === 'KeyE' && !e.repeat) {
      if (inventoryOpen) closeInventory(true);
      else if (player.locked) openInventory();
    } else if (e.code === 'Escape' && inventoryOpen) {
      closeInventory(false);
    }
  });

  // Music: 🔊 button + M hotkey.
  const musicBtn = $('music');
  const toggleMusicUI = () => { audio.resume(); musicBtn.textContent = audio.toggleMusic() ? '🔊' : '🔇'; };
  musicBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMusicUI(); });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.repeat && !typing()) toggleMusicUI();
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
    audio.setListener(player.pos.x, player.pos.y + 1.62, player.pos.z, player.yaw);
    sky.update(dt, player.pos);
    world.update(player.pos.x, player.pos.z, dt, sky.daylight);
    mobs.update(dt, player.pos);

    // Multiplayer sync.
    if (player.locked) net.sendPos(player.state(), performance.now());
    remotes.update(dt);
    voice.update();
    // Reflect who's talking on characters + roster.
    remotes.players.forEach((_, id) => remotes.setSpeaking(id, voice.isSpeaking(id)));
    updateRosterSpeaking();

    if (player.selected !== lastSel) { highlightSlot(player.selected); lastSel = player.selected; }
    $('coords').textContent =
      `x ${player.pos.x.toFixed(0)}  y ${player.pos.y.toFixed(0)}  z ${player.pos.z.toFixed(0)}  ·  ${sky.clock()}`;

    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();
}

// --- HUD ---------------------------------------------------------------------
// Draw a block's face icon from the atlas into a canvas.
function drawBlockIcon(canvas, atlasCanvas, block, size) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  const t = BLOCKS[block].side;
  ctx.drawImage(atlasCanvas, (t % ATLAS_COLS) * TILE_PX, Math.floor(t / ATLAS_COLS) * TILE_PX,
    TILE_PX, TILE_PX, 0, 0, size, size);
}

function buildHotbar(atlasCanvas, player) {
  const bar = $('hotbar');
  bar.innerHTML = '';
  HOTBAR.forEach((block, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.title = BLOCKS[block].name;

    const icon = document.createElement('canvas');
    icon.width = icon.height = 36;
    drawBlockIcon(icon, atlasCanvas, block, 36);
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

// Redraw one hotbar slot's icon (after the inventory changes its block).
function updateHotbarSlot(i, atlasCanvas) {
  const cv = document.querySelectorAll('#hotbar .slot canvas')[i];
  if (cv) { cv.title = BLOCKS[HOTBAR[i]].name; drawBlockIcon(cv, atlasCanvas, HOTBAR[i], 36); }
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
