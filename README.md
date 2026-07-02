# Evan's Voxel World

A little blocky voxel sandbox game, built from scratch for Evan. A FastAPI
backend generates and saves the world; a custom voxel engine in the browser
(on top of Three.js for the WebGL plumbing) does the rendering, physics, and
block editing.

## Play

```bash
./run.sh
```

Then open **http://localhost:8000** and click to play.

(First launch makes a virtualenv and installs FastAPI + uvicorn — takes a few
seconds. After that it starts instantly.)

## Controls

| Input | Action |
|-------|--------|
| `W A S D` | move |
| Mouse | look |
| `Space` | jump |
| `Shift` | run |
| Left click | break a block |
| Right click | place a block |
| `1`–`8` / scroll | choose a hotbar block |
| `E` | inventory (pick any block) |
| `V` | first / third-person view |
| `M` | music on/off |
| `🎙️` / hold `T` | join voice / talk |
| `Esc` | pause |

## How it works

```
server/
  main.py       FastAPI: auth + world menu API + per-world chunks / edits / player
  worldgen.py   Perlin-noise terrain (hills, water, beaches, trees)
  storage.py    multi-world saves — one file per world in data/worlds/
  accounts.py   users + login sessions (stdlib PBKDF2 hashing, no extra deps)
  snapshots.py  per-world rewind history in data/snapshots/
static/
  index.html, css/
  js/
    blocks.js          block catalogue + procedural texture atlas
    main.js            bootstrap + game loop + HUD
    engine/
      constants.js     world dimensions
      renderer.js      scene, camera, sky, lights
      chunk.js         face-culling mesher (the heart of the voxel engine)
      world.js         chunk streaming + block get/set
      player.js        controls, physics/collision, block raycasting
    vendor/three.module.js
```

### Accounts

On launch you **sign in or create an account** (username + password). Accounts
live in `data/users.json` — passwords are salted and hashed with PBKDF2 (no
plaintext, no extra libraries), and login sessions are cookies stored in
`data/sessions.json`. From the menu you can open **⚙ Profile** to change your
display name, pick your character color, or set a new password. Only you (while
signed in) can edit your own profile.

### Worlds

After signing in you get a **menu** to create a new named world or load one you
can see. Each world is one file in `data/worlds/<id>.json` holding its name, a
random **seed**, owner, visibility, the player's last position, and only the
blocks players changed. Terrain is regenerated deterministically from the seed,
so the whole world is reproduced exactly from that tiny file.

- **Ownership** — whoever creates a world owns it. Only the owner can rename it,
  change its visibility, delete it (🗑), or rewind it.
- **Public / private** — worlds are **public** by default (everyone on the LAN
  sees them); toggle the 🌐/🔒 button to make one private (only you see it).
- **Claim** — worlds created before accounts existed show as *Unclaimed*; press
  **Claim** to become their owner.

### Rewind (snapshots)

While a world is played the server quietly captures **snapshots** of its state
into `data/snapshots/<id>/`. The owner can open **⏱ Snapshots** (from the world
row or the in-game pause screen) to see a timeline and **rewind** the world to an
earlier point — handy for undoing a session of changes. Rewinding takes a safety
snapshot of the current state first (so it's itself undoable) and sends everyone
in that world back to the menu while the state is restored. Snapshots roll over
automatically: everything from the last day is kept, then thinned to one an hour
for a week, then dropped.

### Custom textures

Tiles are drawn procedurally, but if a `static/textures/<name>.png` (16×16)
exists it's used instead — e.g. `grass_top.png`, `stone.png`, `wood_side.png`.
This is how AI-generated art can be dropped in. See `tools/gen_assets.py`.

### Sound & music

Music and sound effects are **synthesized in the browser** (WebAudio), so the
game has sound with no files and works offline. A calm generative tune plays in
the background (toggle with the 🔊 button), plus break / place / footstep SFX.

To use **real** audio instead, drop files into `static/audio/` — `music.mp3`,
`break.wav`, `place.wav`, `step.wav` (`.mp3`/`.ogg`/`.wav` all work). Anything
present overrides the synthesized version. Free CC0 sources and details are in
`static/audio/README.txt`.

## Animals & inventory

Friendly **pigs, sheep and cows** wander the grass near you (ambient — they
don't fight or despawn your builds). They're client-side for now, so each player
sees their own; syncing them across multiplayer is a future step (`mobs.js`).

Press **E** for the **inventory** — a picker for *every* block (including ones
not on your hotbar). Click a block to load it into your currently-selected
hotbar slot. It's **creative**: blocks never run out, and everything (including
the specials like Mossy Cobble, Marble and Rainbow) is simply available — no
crafting needed. Add blocks in `static/js/blocks.js` (`ALL_BLOCKS`).

## Blocks, TNT & Firestone

The hotbar has lots of blocks (grass, stone, planks, wool, gold, diamond,
pumpkin, snow…). Three are special:

- **TNT** — place it like any block.
- **Firestone** (the flint-and-steel icon, last hotbar slot) — select it and
  **right-click a TNT block** to light it. It flashes, then **explodes** after
  about a second, blowing a crater in the terrain with debris, a boom, and a
  camera shake. TNT next to TNT **chain-reacts**.
- **Flint** — a decorative dark stone block.
- **Glowstone** — a warm ember-stone that **glows and gives off light at
  night**, with a gentle flame-like flicker. Place a few to light up a build
  after dark; nearby blocks are lit by real warm point-lights that follow the
  closest glowstones to you.

The Firestone strikes more than TNT (see `static/js/gear.js`):

- **Pumpkins** — strike one and its carved face lights up like a
  **jack-o'-lantern** (a real light source at night, like glowstone); strike it
  again to snuff it out.
- **Proximity Mine** — strikes cycle **off → watch others → watch EVERYONE →
  off**. Arming takes **5 seconds** (walk away!); when a creature or player
  wanders close it blinks for **2 seconds** — strike it in time to defuse, or
  it explodes like TNT. Creatures caught in the blast are gone on the spot;
  players get badly hurt. The yellow eye watches *other* players and animals;
  the red eye watches **you too**.
- **Elevators** — the **Up Elevator** (steel-blue) floats straight up when you
  stand on it; the **Side Elevator** (tan) glides sideways. Strikes set the
  travel distance **1–10**, shown right on the block, and the **11th strike
  switches direction** and restarts at 1: vertical flips **⬆ up / ⬇ down**
  (basement rides!), horizontal cycles **⬆ forward → ➡ right → ⬇ back → ⬅
  left** — all relative to the way *you* are facing when you hop on, matching
  the arrow painted on the block. Hop off and the block comes home and lands by
  itself. Returning platforms have a garage-door-style **safety sensor**: one
  will never land on (or in!) a player — it hovers overhead and waits for them
  to step aside.

Explosion size lives in `static/js/engine/world.js` (`BLAST_RADIUS`); glow
brightness/reach are `GLOW_LIGHT_POWER` / `GLOW_RANGE` in the same file.

## Playing together (LAN multiplayer)

Several people on the same Wi-Fi can share a world:

1. **One person hosts** — run `./run.sh`. It serves **HTTPS** on all interfaces
   (`0.0.0.0`), generating a self-signed cert the first time.
2. Find the host's local IP (`hostname -I` on Linux, e.g. `192.168.1.14`).
3. Everyone else opens **`https://<host-ip>:8765`** in their browser (accept the
   one-time "not secure" warning — it's the host's own cert), types their
   **name** in the menu, and picks the **same world**. You'll see each other's
   characters (with name tags) move around, a **who's-online list** in the
   corner, and blocks placed/broken by anyone — with **spatial sound** (you hear
   footsteps, breaking, and TNT booms louder when they're closer). Edits are
   saved to the host's world file.

Playing over the *internet* (not just LAN) needs port-forwarding or a tunnel on
the host — that's a network setup step outside the game.

The server relays positions, edits and effect events over a WebSocket per world
(`/api/worlds/<id>/ws`); see `server/main.py` and `static/js/net.js`.

### Voice chat (proximity, push-to-talk)

Click the **🎙️ button** (top-right) to join voice, then **hold `T`** (or hold
the on-screen **🗣️ Talk** button) to speak — push-to-talk, so no hot mic.
Voices get louder as players get closer and fade with distance (peer-to-peer
WebRTC; the WebSocket only carries the setup handshake). Whoever's talking is
highlighted green in the who's-online list and shows a speech bubble above their
character. Click 🎙️ again to leave voice.

Mic access needs HTTPS, which is **on by default** — a self-signed cert is made
automatically on first run. Each device just accepts the one-time "not secure"
warning. To run plain HTTP instead (no voice for other devices), use
`EVANS_HTTP=1 ./run.sh`. To use your own cert, set `EVANS_SSL_CERT` /
`EVANS_SSL_KEY`.

> Running a **second** server instance? Point it at a different data folder with
> `EVANS_WORLDS_DIR=/some/dir ./run.sh` so the two don't fight over the same
> world files.

## Tuning

- World size / render distance: `static/js/engine/constants.js`
- Terrain shape (hills, sea level, trees): `server/worldgen.py`
- New block types: add to `server/worldgen.py` **and** `static/js/blocks.js`
