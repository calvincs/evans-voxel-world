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
import { Gear } from './gear.js';
import {
  buildAtlasTexture, BLOCKS, HOTBAR, ALL_BLOCKS, ATLAS_COLS, TILE_PX, blockColor, WATER,
} from './blocks.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// The signed-in user: { uid, username, name, color }. Set by the auth flow.
let currentUser = null;

// Character colour palette (mirrors accounts.DEFAULT_COLORS on the server).
const COLOR_PALETTE = [
  0x3aa657, 0xff6b6b, 0x4db6ff, 0xffd24d, 0xb084ff, 0x55d98a, 0xff9f40, 0xff7ad9,
];
const hex = (c) => '#' + (Number(c) >>> 0).toString(16).padStart(6, '0');

// Small JSON request helper that surfaces HTTP errors (with FastAPI's `detail`).
async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res, data = null;
  try {
    res = await fetch(url, opts);
    try { data = await res.json(); } catch (_) {}
  } catch (_) {
    return { ok: false, status: 0, data: null };
  }
  return { ok: res.ok, status: res.status, data };
}

async function fetchMe() {
  const { ok, data } = await req('GET', '/api/me');
  return ok && data ? data.user : null;
}

// --- Sign in / create account ------------------------------------------------
function buildSwatches(container, initial, onPick) {
  container.innerHTML = '';
  COLOR_PALETTE.forEach((c) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c === initial ? ' sel' : '');
    sw.style.background = hex(c);
    sw.onclick = () => {
      container.querySelectorAll('.swatch').forEach((s) => s.classList.remove('sel'));
      sw.classList.add('sel');
      onPick(c);
    };
    container.appendChild(sw);
  });
}

// Show the auth panel and resolve with the user once they sign in / register.
async function showAuth() {
  // Existing accounts populate the sign-in picker so kids just pick their name.
  const accountsRes = await req('GET', '/api/users');
  const accounts = (accountsRes.data && accountsRes.data.users) || [];

  return new Promise((resolve) => {
    const auth = $('auth');
    const tabLogin = $('tab-login'), tabReg = $('tab-register');
    const pickRow = $('auth-pick-row'), select = $('auth-select'), dot = $('auth-dot');
    const userEl = $('auth-user'), passEl = $('auth-pass');
    const colorRow = $('auth-color-row'), submit = $('auth-submit'), err = $('auth-error');
    let mode = 'login';
    let color = COLOR_PALETTE[0];
    buildSwatches($('auth-colors'), color, (c) => { color = c; });

    // Fill the account picker (option value = username, label = display name).
    select.innerHTML = '';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = a.username; opt.textContent = a.name;
      opt.dataset.color = a.color;
      select.appendChild(opt);
    }
    const syncDot = () => {
      const opt = select.selectedOptions[0];
      dot.style.background = hex(opt ? opt.dataset.color : COLOR_PALETTE[0]);
    };
    select.onchange = syncDot;
    syncDot();

    const hasAccounts = accounts.length > 0;
    tabLogin.disabled = !hasAccounts;
    tabLogin.title = hasAccounts ? '' : 'No accounts yet — create one first';

    const setMode = (m) => {
      if (m === 'login' && !hasAccounts) m = 'register';    // nothing to sign into yet
      mode = m;
      tabLogin.classList.toggle('active', m === 'login');
      tabReg.classList.toggle('active', m === 'register');
      // Sign in = account picker; Create account = free-text username + colour.
      pickRow.classList.toggle('hidden', m !== 'login');
      userEl.classList.toggle('hidden', m !== 'register');
      colorRow.classList.toggle('hidden', m !== 'register');
      submit.textContent = m === 'register' ? 'Create account ▶' : 'Sign in ▶';
      err.textContent = '';
    };
    tabLogin.onclick = () => setMode('login');
    tabReg.onclick = () => setMode('register');

    const doSubmit = async () => {
      const username = mode === 'login' ? select.value : userEl.value.trim();
      const password = passEl.value;
      if (!username) { err.textContent = 'Pick an account or create one.'; return; }
      if (!password) { err.textContent = 'Enter your password.'; return; }
      submit.disabled = true;
      const url = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body = mode === 'register' ? { username, password, color } : { username, password };
      const { ok, data } = await req('POST', url, body);
      submit.disabled = false;
      if (ok && data) { auth.classList.add('hidden'); resolve(data.user); }
      else err.textContent = (data && data.detail) || 'Something went wrong — try again.';
    };
    submit.onclick = doSubmit;
    userEl.onkeydown = (e) => { if (e.key === 'Enter') passEl.focus(); };
    passEl.onkeydown = (e) => { if (e.key === 'Enter') doSubmit(); };

    setMode(hasAccounts ? 'login' : 'register');
    auth.classList.remove('hidden');
    (hasAccounts ? passEl : userEl).focus();
  });
}

async function ensureLoggedIn() {
  currentUser = await fetchMe();
  if (!currentUser) currentUser = await showAuth();
  return currentUser;
}

// --- Profile editor ----------------------------------------------------------
function renderWho() {
  if (!currentUser) return;
  const dot = $('who-dot'), name = $('who-name');
  if (dot) dot.style.background = hex(currentUser.color);
  if (name) name.textContent = currentUser.name;
}

function openProfile() {
  const panel = $('profile');
  const nameEl = $('prof-name'), passEl = $('prof-pass'), err = $('prof-error');
  let color = currentUser.color;
  nameEl.value = currentUser.name || '';
  passEl.value = '';
  err.textContent = '';
  buildSwatches($('prof-colors'), color, (c) => { color = c; });
  panel.classList.remove('hidden');
  $('prof-cancel').onclick = () => panel.classList.add('hidden');
  $('prof-save').onclick = async () => {
    const body = { name: nameEl.value.trim() || currentUser.name, color };
    if (passEl.value) body.newPassword = passEl.value;
    const { ok, data } = await req('POST', '/api/profile', body);
    if (ok && data) { currentUser = data.user; panel.classList.add('hidden'); renderWho(); }
    else err.textContent = (data && data.detail) || 'Could not save.';
  };
}

// --- World history / rewind --------------------------------------------------
function fullTime(ts) {
  try { return new Date(ts * 1000).toLocaleString(); } catch (_) { return ''; }
}

async function openHistory(wid, name) {
  const panel = $('history'), listEl = $('hist-list');
  $('hist-title').textContent = 'Snapshots — ' + name;
  $('hist-close').onclick = () => panel.classList.add('hidden');
  panel.classList.remove('hidden');
  listEl.innerHTML = '<p class="loading">Loading…</p>';
  const { data } = await req('GET', `/api/worlds/${wid}/snapshots`);
  const snaps = (data && data.snapshots) || [];
  const canRevert = !!(data && data.canRevert);
  listEl.innerHTML = '';
  if (!snaps.length) {
    listEl.innerHTML = '<p class="empty">No snapshots yet — they’re captured automatically as you play.</p>';
    return;
  }
  for (const s of snaps) {
    const row = document.createElement('div'); row.className = 'hist-row';
    const info = document.createElement('div'); info.className = 'hist-info';
    const when = document.createElement('span'); when.className = 'hist-when';
    when.textContent = timeAgo(s.ts); info.appendChild(when);
    const meta = document.createElement('span'); meta.className = 'hist-meta';
    meta.textContent = `${s.editCount} edit${s.editCount === 1 ? '' : 's'}`
      + (s.label ? ` · ${s.label}` : '') + ` · ${fullTime(s.ts)}`;
    info.appendChild(meta); row.appendChild(info);
    if (canRevert) {
      const btn = document.createElement('button'); btn.className = 'hist-revert';
      btn.textContent = '⤺ Rewind here';
      btn.onclick = async () => {
        if (!confirm(`Rewind "${name}" to ${timeAgo(s.ts)}?\n\n`
          + `Everyone in the world will be sent back to the menu, and any edits made `
          + `after this point will be removed. A backup of the current state is saved first, `
          + `so you can undo this.`)) return;
        btn.disabled = true; btn.textContent = 'Rewinding…';
        const { ok } = await req('POST', `/api/worlds/${wid}/revert`, { snapshotId: s.id });
        if (ok) { panel.classList.add('hidden'); toast('⤺ World rewound to ' + timeAgo(s.ts), 4000); }
        else { btn.disabled = false; btn.textContent = '⤺ Rewind here'; toast('Could not rewind.', 3000); }
      };
      row.appendChild(btn);
    }
    listEl.appendChild(row);
  }
}

function badge(cls, text) {
  const b = document.createElement('span');
  b.className = 'badge' + (cls ? ' ' + cls : '');
  b.textContent = text;
  return b;
}

// --- Connection monitor ------------------------------------------------------
// Polls the server's health. If it goes away we freeze the game and show a
// blocking "Disconnected" screen (so no further unsaved edits happen); only
// once the server answers again can you go back to the world menu.
let offline = false;
let healthFails = 0;
let healthTimer = null;

async function pingHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return res.ok;
  } catch (_) { return false; }
}
function scheduleHealth(delay) { clearTimeout(healthTimer); healthTimer = setTimeout(runHealthCheck, delay); }
async function runHealthCheck() {
  const ok = await pingHealth();
  if (offline) {                       // overlay is up; track when we can return
    setReconnectUI(ok);
    scheduleHealth(2000);
    return;
  }
  if (ok) healthFails = 0;
  else if (++healthFails >= 2) markOffline();   // two misses = disconnected
  scheduleHealth(healthFails > 0 ? 1500 : 5000);  // recheck quickly after a miss
}
function startConnectionMonitor() {
  const back = $('disc-back');
  if (back) back.onclick = () => location.reload();   // server's up -> reload to the menu
  runHealthCheck();
}
function connectionCheckNow() { scheduleHealth(0); }   // e.g. when the WebSocket drops
function setReconnectUI(ok) {
  const s = $('disc-status'), back = $('disc-back');
  if (s) {
    s.textContent = ok ? '✓ Reconnected — your work is safe.' : 'Still disconnected. Trying to reconnect…';
    s.classList.toggle('ok', ok);
  }
  if (back) back.disabled = !ok;
}
function markOffline() {
  if (offline) return;
  offline = true;
  healthFails = 0;
  if (document.pointerLockElement) document.exitPointerLock();
  setReconnectUI(false);
  $('disconnected').classList.remove('hidden');
}

let assets = { textures: [], audio: {} };   // which optional override files exist

async function main() {
  startConnectionMonitor();
  try { assets = await (await fetch('/api/assets')).json(); } catch (_) {}
  audio.prefetchOverrides(assets.audio);

  // Demo / kiosk: skip the login screen with a shared guest account, then jump
  // into a world. ?demo&w=<id> targets a specific world; otherwise the most
  // recent (or a fresh "Demo").
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    await req('POST', '/api/auth/guest');       // guest session so world APIs work
    currentUser = await fetchMe();
    let id = params.get('w');
    if (!id) {
      const { data } = await req('GET', '/api/worlds');
      id = (data && data.worlds && data.worlds[0]?.id)
        || (await req('POST', '/api/worlds', { name: 'Demo' })).data.world.id;
    }
    return startGame(id, true);
  }

  await ensureLoggedIn();                        // gate: sign in / create account
  const worldId = await chooseWorld();
  startGame(worldId, false);
}

// --- World menu --------------------------------------------------------------
function chooseWorld() {
  return new Promise((resolve) => {
    const menu = $('menu');
    const list = $('world-list');
    const nameInput = $('world-name');

    renderWho();
    $('profile-open').onclick = openProfile;
    $('logout').onclick = async () => { await req('POST', '/api/auth/logout'); location.reload(); };

    const create = async () => {
      const name = nameInput.value.trim();
      const { data } = await req('POST', '/api/worlds', { name: name || 'New World' });
      if (data && data.world) resolve(data.world.id);
    };
    $('create-world').onclick = create;
    nameInput.onkeydown = (e) => { if (e.key === 'Enter') create(); };

    const refresh = async () => {
      const { data } = await req('GET', '/api/worlds');
      const worlds = (data && data.worlds) || [];
      list.innerHTML = '';
      if (worlds.length === 0) {
        list.innerHTML = '<p class="empty">No worlds yet — name one and hit Create!</p>';
        nameInput.focus();
        return;
      }
      for (const w of worlds) {
        const row = document.createElement('div');
        row.className = 'world-row';

        const info = document.createElement('div');
        info.className = 'world-info';
        const nm = document.createElement('span');
        nm.className = 'world-name'; nm.textContent = w.name;
        info.appendChild(nm);
        const badges = document.createElement('div');
        badges.className = 'world-badges';
        badges.appendChild(badge(w.public ? 'public' : 'private',
          w.public ? '🌐 Public' : '🔒 Private'));
        if (w.mine) badges.appendChild(badge('mine', '★ Yours'));
        else if (w.unclaimed) badges.appendChild(badge('unclaimed', 'Unclaimed'));
        else if (w.ownerName) badges.appendChild(badge('', 'by ' + w.ownerName));
        info.appendChild(badges);
        const meta = document.createElement('span');
        meta.className = 'world-meta';
        meta.textContent = `${w.edits} edit${w.edits === 1 ? '' : 's'} · ${timeAgo(w.lastPlayed)}`;
        info.appendChild(meta);
        info.onclick = () => resolve(w.id);
        row.appendChild(info);

        const play = document.createElement('button');
        play.className = 'world-play'; play.textContent = 'Play ▶';
        play.onclick = (e) => { e.stopPropagation(); resolve(w.id); };
        row.appendChild(play);

        if (w.mine) {
          const hist = document.createElement('button');
          hist.className = 'world-hist'; hist.title = 'Snapshots / rewind'; hist.textContent = '⏱';
          hist.onclick = (e) => { e.stopPropagation(); openHistory(w.id, w.name); };
          row.appendChild(hist);

          const ren = document.createElement('button');
          ren.className = 'world-hist'; ren.title = 'Rename world'; ren.textContent = '✏️';
          ren.onclick = async (e) => {
            e.stopPropagation();
            const name = prompt('New name for this world:', w.name);
            if (name && name.trim()) {
              await req('POST', `/api/worlds/${w.id}/rename`, { name: name.trim() });
              refresh();
            }
          };
          row.appendChild(ren);

          const pea = document.createElement('button');
          pea.className = 'world-hist';
          pea.title = w.peaceful
            ? 'Peaceful is ON — animals are all friendly. Tap for normal.'
            : 'Peaceful is OFF — wolves & spiders can attack. Tap for peaceful.';
          pea.textContent = w.peaceful ? '🕊️' : '⚔️';
          pea.onclick = async (e) => {
            e.stopPropagation();
            await req('POST', `/api/worlds/${w.id}/peaceful`, { peaceful: !w.peaceful });
            refresh();
          };
          row.appendChild(pea);

          const vis = document.createElement('button');
          vis.className = 'world-hist';
          vis.title = w.public ? 'Make private' : 'Make public';
          vis.textContent = w.public ? '🌐' : '🔒';
          vis.onclick = async (e) => {
            e.stopPropagation();
            await req('POST', `/api/worlds/${w.id}/visibility`, { public: !w.public });
            refresh();
          };
          row.appendChild(vis);

          const del = document.createElement('button');
          del.className = 'world-del'; del.title = 'Delete world'; del.textContent = '🗑';
          del.onclick = async (e) => {
            e.stopPropagation();
            if (confirm(`Delete "${w.name}"? This can't be undone.`)) {
              await req('DELETE', `/api/worlds/${w.id}`);
              refresh();
            }
          };
          row.appendChild(del);
        } else if (w.unclaimed) {
          const claim = document.createElement('button');
          claim.className = 'world-claim'; claim.title = 'Become the owner'; claim.textContent = 'Claim';
          claim.onclick = async (e) => {
            e.stopPropagation();
            await req('POST', `/api/worlds/${w.id}/claim`);
            refresh();
          };
          row.appendChild(claim);
        }
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
  if (cfg.serverNow) sky.syncTo(cfg.serverNow);   // everyone shares the same night
  const atlas = await buildAtlasTexture(assets.textures);

  const world = new World(scene, atlas, worldId);
  const spawn = cfg.player || cfg.spawn;
  const myColor = currentUser ? currentUser.color : 0x3aa657;
  const player = new Player(camera, world, scene, canvas, spawn, myColor);
  player.mobile = isTouch;
  player.onBreakPlace = () => flashCrosshair();
  // Camera shake from an explosion, scaled by how close it was.
  const feltShake = (x, y, z) => {
    const d = Math.hypot(player.pos.x - (x + 0.5), player.pos.y - (y + 0.5), player.pos.z - (z + 0.5));
    if (d < 16) player.shake(0.9 * (1 - d / 16));
  };
  // Caught in a blast: lose health, scaled by how close you were (up to 8 at
  // point-blank, nothing past ~6 blocks). The long fuse gives you time to flee.
  const BLAST_HURT_R = 6;
  const blastHurt = (x, y, z) => {
    const d = Math.hypot(player.pos.x - (x + 0.5), (player.pos.y + 0.9) - (y + 0.5), player.pos.z - (z + 0.5));
    if (d < BLAST_HURT_R) {
      player.hurt(Math.ceil((1 - d / BLAST_HURT_R) * 8),
        { from: { x: x + 0.5, z: z + 0.5 }, source: 'blast' });
    }
  };
  const blastFelt = (x, y, z) => { feltShake(x, y, z); blastHurt(x, y, z); };
  // Any local explosion (TNT or mine): shake + hurt the player, and creatures
  // caught in the blast die outright. (mobs is defined just below.)
  world.onExplosion = (x, y, z) => { blastFelt(x, y, z); mobs.blastKill(x, y, z); };

  if (isTouch) setupTouchControls(player);
  // Restore the player's customized hotbar (saved with their position).
  if (cfg.player && Array.isArray(cfg.player.hotbar)) {
    cfg.player.hotbar.slice(0, HOTBAR.length).forEach((b, i) => { if (BLOCKS[b]) HOTBAR[i] = b; });
  }
  buildHotbar(atlas.image, player);
  world.update(spawn.x, spawn.z);   // preload spawn chunks

  const mobs = new Mobs(scene, world, assets.textures);   // wandering animals (+ optional skins)
  mobs.peaceful = !!cfg.peaceful;                         // world toggle: friendly animals only
  player.mobs = mobs;                                     // let a swing hit creatures

  // Health HUD + damage feedback + death.
  let dead = false;
  const healthEl = $('health'), hurtEl = $('hurt');
  const renderHealth = (hp = player.hp, max = player.maxHp) => {
    let s = '';
    for (let i = 0; i < max; i++) s += `<span class="heart${i < hp ? '' : ' off'}">❤</span>`;
    healthEl.innerHTML = s;
  };
  renderHealth();
  let hurtTimer = null;
  player.onHurt = (hp, max) => {
    renderHealth(hp, max);
    hurtEl.classList.add('show');
    clearTimeout(hurtTimer);
    hurtTimer = setTimeout(() => hurtEl.classList.remove('show'), 160);
    player.shake(0.5);
  };
  player.onHeal = (hp, max) => renderHealth(hp, max);   // slow out-of-combat regen
  const DEATH_MSG = {
    wolf: 'A wolf got you!', spider: 'A spider got you!', squid: 'A squid got you!',
    blast: 'You got caught in an explosion!',
  };
  player.onDeath = () => {
    dead = true;
    if (document.pointerLockElement) document.exitPointerLock();
    renderHealth(0, player.maxHp);
    $('dead-msg').textContent = DEATH_MSG[player.lastDamage] || 'A creature got you.';
    $('dead').classList.remove('hidden');
  };
  // Respawn in place at the world spawn — no page reload (which used to drop
  // you back exactly where you died, sometimes straight into the same wolf).
  $('dead-rejoin').onclick = () => {
    $('dead').classList.add('hidden');
    player.respawn(cfg.spawn);
    renderHealth();
    dead = false;
    player.engage();
  };

  // Multiplayer: stream our position and apply others' edits + movements.
  const remotes = new RemotePlayers(scene);

  // Contraption blocks: jack-o'-lanterns, proximity mines, elevators. The
  // Firestone routes strikes here first; TNT stays with player/world.
  const gear = new Gear(world, player, mobs, remotes, atlas.image, (m) => toast(m, 2500));
  player.onStrike = (x, y, z, b) => gear.strike(x, y, z, b);
  const myName = currentUser ? currentUser.name : 'Player';
  const roster = new Map();       // id -> { name }
  const voiceIds = new Set();     // ids currently in voice
  const rosterEls = new Map();    // id -> roster row element (for speaking highlight)
  const net = new Net(worldId, myName, {
    onWelcome: (id, players) => {
      // The welcome roster is authoritative: rebuild from scratch so players
      // who left while we were disconnected don't linger as frozen ghosts.
      remotes.clear(); roster.clear();
      players.forEach((p) => { remotes.add(p); roster.set(p.id, { name: p.name }); });
      renderRoster();
    },
    onReconnect: () => {
      // Edits broadcast while the socket was down are gone for good — refetch
      // the loaded chunks so our world matches the server again.
      world.refreshAll();
      voice.rejoin();               // old pid's peer links are orphaned
      renderRoster();
    },
    onJoin: (p) => { remotes.add(p); roster.set(p.id, { name: p.name }); renderRoster(); },
    onLeave: (id) => {
      remotes.remove(id); roster.delete(id); voiceIds.delete(id);
      voice.handle({ sub: 'leave', from: id });   // tear down their voice peer too
      renderRoster();
    },
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
        blastFelt(m.x, m.y, m.z);
        mobs.blastKill(m.x, m.y, m.z);   // remote blasts kill our creatures too
      } else if (m.kind === 'ignite') {
        audio.playIgnite({ x: m.x + 0.5, y: m.y + 0.5, z: m.z + 0.5 });
      }
    },
    onVoice: (m) => voice.handle(m),
    onReverted: () => {
      // The owner rewound this world — freeze, tell the player, and return to
      // the menu with the restored state loaded fresh on reload.
      offline = true;                       // stop the loop / any further edits
      if (document.pointerLockElement) document.exitPointerLock();
      toast('⤺ This world was rewound to an earlier point — returning to the menu…', 3500);
      setTimeout(() => location.reload(), 1600);
    },
  });
  world.net = net;
  net.onDown = () => connectionCheckNow();   // socket dropped -> check the server now

  // Proximity voice chat (WebRTC). Peer audio is positioned by where that
  // player is, via remotes' interpolated positions.
  const voice = new Voice(net, () => net.myId, (id) => {
    const r = remotes.players.get(id);
    return r ? r.cur : null;
  });
  voice.onRoster = (id, inVoice) => { if (inVoice) voiceIds.add(id); else voiceIds.delete(id); renderRoster(); };
  voice.onState = () => { updateVoiceButton(); renderRoster(); };
  voice.onPeerState = (id, state) => {
    const name = (roster.get(id) || {}).name || `Player ${id}`;
    if (state === 'connected') toast(`🔊 Voice connected to ${name}`, 2500);
    else if (state === 'failed') {
      toast(`⚠️ Voice couldn't reach ${name}. Your Wi-Fi may block device-to-device — try turning off AP/guest isolation on the router.`, 8000);
    }
  };
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
    const avail = voice.available();
    btn.classList.toggle('joined', voice.enabled && !voice.transmitting);
    btn.classList.toggle('live', voice.enabled && voice.transmitting);
    btn.classList.toggle('unavailable', !avail && !voice.enabled);
    btn.title = (!avail && !voice.enabled)
      ? 'Voice needs HTTPS — you appear to be on an insecure connection'
      : voice.enabled ? 'In voice — tap to leave · hold T to talk'
        : 'Join voice chat — your browser will ask for the mic';
    // Always show the Talk button once in voice; show a faint hint otherwise.
    talk.classList.toggle('hidden', false);
    talk.textContent = voice.enabled ? '🗣️ Talk' : '🎙️ Hold T to talk';
    talk.classList.toggle('ghost', !voice.enabled);
    talk.classList.toggle('talking', voice.transmitting);
  }

  // Join voice on demand (asks for the mic). Returns true if we're in voice.
  let talkHeld = false;
  async function ensureVoice() {
    if (voice.enabled) return true;
    audio.resume();
    if (!voice.available()) {
      toast('🎙️ Voice needs a secure (HTTPS) connection. Open the game at https://… — see the README.', 5500);
      return false;
    }
    const ok = await voice.enable();
    if (ok) toast("🎙️ You're in voice — hold T to talk. Everyone else must join (🎙️) too.", 4500);
    else toast('🎙️ Microphone blocked — allow mic access in your browser, then try again.', 5000);
    updateVoiceButton();
    return ok;
  }
  async function beginTalk() {
    if (talkHeld) return;
    talkHeld = true;
    if (voice.enabled) { voice.startTalk(); return; }
    const ok = await ensureVoice();   // first T press auto-joins + prompts for mic
    if (ok && talkHeld) voice.startTalk(); else talkHeld = false;
  }
  function endTalk() { talkHeld = false; voice.stopTalk(); }

  function setupVoiceButton(v) {
    const btn = $('voice'), talk = $('talk');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (v.enabled) { v.leave(); toast('🎙️ Left voice.', 1500); }
      else await ensureVoice();
      updateVoiceButton();
    });
    const down = (e) => { e.preventDefault(); e.stopPropagation(); beginTalk(); };
    const up = (e) => { e.preventDefault(); endTalk(); };
    talk.addEventListener('pointerdown', down);
    talk.addEventListener('pointerup', up);
    talk.addEventListener('pointercancel', up);
    talk.addEventListener('pointerleave', up);
    document.addEventListener('keydown', (e) => { if (e.code === 'KeyT' && !e.repeat && !typing()) beginTalk(); });
    document.addEventListener('keyup', (e) => { if (e.code === 'KeyT') endTalk(); });
    updateVoiceButton();
  }

  window.game = { world, player, sky, remotes, net, voice, mobs, gear };

  // Swap the menu for the play screen.
  $('menu').classList.add('hidden');
  document.body.classList.add('in-game');       // reveal the HUD / hotbar / controls
  const overlay = $('overlay');
  $('title').textContent = cfg.name;
  overlay.classList.remove('hidden');

  // Owner-only "Snapshots" button on the pause screen (rewind this world).
  const snapBtn = $('snapshots');
  if (cfg.mine) {
    snapBtn.classList.remove('hidden');
    snapBtn.onclick = (e) => { e.stopPropagation(); openHistory(worldId, cfg.name); };
  } else {
    snapBtn.classList.add('hidden');
  }

  const prevOnEngage = player.onEngage;
  player.onEngage = () => { overlay.classList.add('hidden'); if (prevOnEngage) prevOnEngage(); };
  player.onPause = () => overlay.classList.remove('hidden');   // touch ⏸ button
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
  }
  function pickBlock(block) {
    HOTBAR[player.selected] = block;            // load it into the active slot
    updateHotbarSlot(player.selected, atlasImg);
    toast(BLOCKS[block].name, 1500);            // names are tooltip-only otherwise
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
      // Esc closes without relocking, which is a pause — show the overlay so
      // the player isn't stranded on an empty screen with no pointer lock.
      closeInventory(false);
      if (!isTouch) overlay.classList.remove('hidden');
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
  const coordsEl = $('coords');
  const underwaterEl = $('underwater');
  let lastCoords = '';
  function loop() {
    requestAnimationFrame(loop);
    if (offline || dead) { renderer.render(scene, camera); return; }   // frozen while disconnected / dead
    // Clamp dt: after a backgrounded tab getDelta() returns the whole absence
    // (minutes!), which would drive physics substeps for millions of iterations.
    const dt = Math.min(clock.getDelta(), 0.1);
    player.update(dt);
    audio.setListener(player.pos.x, player.pos.y + 1.62, player.pos.z, player.yaw);
    sky.update(dt, player.pos);
    world.update(player.pos.x, player.pos.z, dt, sky.daylight);
    mobs.update(dt, player, sky.daylight);
    gear.update(dt);                  // mines + elevators (after player & mobs)

    // Multiplayer sync.
    if (player.locked) net.sendPos(player.posState(), performance.now());
    remotes.update(dt);
    voice.update();
    // Reflect who's talking on characters + roster.
    remotes.players.forEach((_, id) => remotes.setSpeaking(id, voice.isSpeaking(id)));
    updateRosterSpeaking();

    // Blue wash when the eye is inside water (the surrounding water faces are
    // culled, so this is what makes being submerged read as underwater).
    const submerged = world.getBlock(Math.floor(player.pos.x),
      Math.floor(player.pos.y + 1.62), Math.floor(player.pos.z)) === WATER;
    underwaterEl.classList.toggle('on', submerged);

    if (player.selected !== lastSel) {
      highlightSlot(player.selected);
      // Name the block you just switched to (tooltips don't exist on touch).
      if (lastSel !== -1) toast(BLOCKS[HOTBAR[player.selected]].name, 1200);
      lastSel = player.selected;
    }
    // Only touch the DOM when the shown text actually changes (most frames it
    // doesn't — coords are whole numbers and the clock ticks once a minute).
    const cstr =
      `x ${player.pos.x.toFixed(0)}  y ${player.pos.y.toFixed(0)}  z ${player.pos.z.toFixed(0)}  ·  ${sky.clock()}`;
    if (cstr !== lastCoords) { coordsEl.textContent = cstr; lastCoords = cstr; }

    renderer.render(scene, camera);
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

    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = i + 1;          // 1..8
    slot.appendChild(key);
    slot.addEventListener('click', (e) => { e.stopPropagation(); player.selectBlock(i); });
    bar.appendChild(slot);
  });
  highlightSlot(0);
}

// Redraw one hotbar slot's icon (after the inventory changes its block).
function updateHotbarSlot(i, atlasCanvas) {
  const slot = document.querySelectorAll('#hotbar .slot')[i];
  if (!slot) return;
  slot.title = BLOCKS[HOTBAR[i]].name;   // the slot owns the tooltip, not the canvas
  drawBlockIcon(slot.querySelector('canvas'), atlasCanvas, HOTBAR[i], 36);
}

function highlightSlot(i) {
  document.querySelectorAll('#hotbar .slot').forEach((s, n) =>
    s.classList.toggle('active', n === i));
}

let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
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
