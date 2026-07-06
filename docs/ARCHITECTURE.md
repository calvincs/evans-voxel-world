# Architecture

How the game works under the hood, where things live in the code, and the
knobs to turn when modding it.

## Contents

- [The big picture](#the-big-picture)
- [Code map](#code-map)
- [The world model](#the-world-model)
- [Multiplayer](#multiplayer)
- [Server-side creatures](#server-side-creatures)
- [Custom textures](#custom-textures)
- [Custom audio](#custom-audio)
- [Tuning & modding](#tuning--modding)
- [Performance](#performance)
- [Testing](#testing)

## The big picture

A **FastAPI backend** generates and saves the world; a **custom voxel engine
in the browser** (on top of Three.js for the WebGL plumbing) does the
rendering, physics, and block editing. The split of responsibilities:

- **Server** — terrain generation, persistence, accounts, snapshots, the
  creature simulation, and relaying multiplayer state per world.
- **Client** — meshing, rendering, player physics/collision, input, HUD,
  sound synthesis, and voice chat (peer-to-peer WebRTC).

## Code map

```
server/
  main.py       FastAPI: auth + world menu API + per-world chunks / edits / player
  worldgen.py   Perlin-noise terrain (hills, water, beaches, trees)
  storage.py    multi-world saves — one file per world in data/worlds/
  accounts.py   users + login sessions (stdlib PBKDF2 hashing, no extra deps)
  snapshots.py  per-world rewind history in data/snapshots/
  creatures.py  server-side creature simulation (the mob "brains")
static/
  index.html, css/
  js/
    blocks.js          block catalogue + procedural texture atlas
    main.js            bootstrap + game loop + HUD
    gear.js            Firestone interactions (TNT, mines, elevators, …)
    mobs.js            creature rendering + client-side interpolation
    net.js             WebSocket client (positions, edits, effects)
    remoteplayers.js   other players' characters + name tags
    minimap.js         the rotating round minimap
    audio.js           WebAudio synth music/SFX + file overrides
    voice.js           push-to-talk proximity voice (WebRTC)
    touch.js           on-screen controls for tablets/phones
    engine/
      constants.js     world dimensions, render distance
      renderer.js      scene, camera, sky, lights
      chunk.js         face-culling mesher (the heart of the voxel engine)
      world.js         chunk streaming + block get/set
      player.js        controls, physics/collision, block raycasting
      character.js     the player character model
      sky.js           day/night cycle, sun/moon, stars
    vendor/three.module.js
tools/
  test_*.py            headless test suites (see Testing below)
  gen_assets.py        AI-generated art (banner, block tiles)
  gen_mob_texture.py   AI-generated mob skins
  backup.sh, make_cert.sh, reset_password.py, evansgame.service
```

## The world model

Each world is one file in `data/worlds/<id>.json` holding its name, a random
**seed**, owner, visibility, player positions, and **only the blocks players
changed**. Terrain is regenerated deterministically from the seed, so the
whole world is reproduced exactly from that tiny file.

Chunks travel from server to client as **raw block bytes** (gzip-compressed),
not JSON. Edits are indexed per chunk on the server, and saves are
write-behind: edits mark a world dirty and a background thread flushes at
most once a second.

Snapshots (`server/snapshots.py`) capture world state periodically into
`data/snapshots/<id>/` and power the owner's rewind timeline. See
[Player's Guide → Rewind](GAMEPLAY.md#rewind-snapshots).

## Multiplayer

The server relays positions, edits and effect events over one WebSocket per
world (`/api/worlds/<id>/ws`) — see `server/main.py` and `static/js/net.js`.
Voice chat is peer-to-peer WebRTC; the WebSocket only carries the setup
handshake (`static/js/voice.js`).

## Server-side creatures

**The server runs the creature brains** (`server/creatures.py`) and streams
~10 snapshots a second to every player in a world, so everyone sees the same
wolf in the same place. No player's browser matters: tabs can be hidden,
anyone can leave, and the world keeps living.

Wild animals spawn and wander-despawn near players; spawn-egg creatures
persist in the world file and are included in snapshots/rewind. Hostiles hunt
whichever player is nearest, and the AI treats a closed door as a wall.

## Custom textures

Tiles are drawn procedurally, but if a `static/textures/<name>.png` (16×16)
exists it's used instead — e.g. `grass_top.png`, `stone.png`,
`wood_side.png`. Mob skins work the same way: `mob_<type>.png`.

This is how AI-generated art is dropped in — see `tools/gen_assets.py` and
`tools/gen_mob_texture.py` (both need an OpenRouter API key via environment
variable; keys are never committed).

## Custom audio

Music and sound effects are synthesized in the browser (WebAudio,
`static/js/audio.js`), so the game works with no audio files at all. To use
real recordings instead, drop files into `static/audio/` — `music`, `break`,
`place`, `step` with an `.mp3`/`.ogg`/`.wav` extension. Anything present
overrides the synthesized version. Free CC0 sources and details are in
`static/audio/README.txt`.

## Tuning & modding

- **World size / render distance:** `static/js/engine/constants.js`
- **Terrain shape** (hills, sea level, trees): `server/worldgen.py`
- **New block types:** add to `server/worldgen.py` **and**
  `static/js/blocks.js` (`ALL_BLOCKS`)
- **Explosion size:** `BLAST_RADIUS` in `static/js/engine/world.js`
- **Glow brightness / reach:** `GLOW_LIGHT_POWER` / `GLOW_RANGE` in the same
  file
- **Creature stats** (speed, health, colors): `MOB_TYPES` in
  `static/js/mobs.js` and the matching logic in `server/creatures.py`

## Performance

The engine is tuned to run well on old, GPU-less machines (software WebGL).
[OPTIMIZATION-NOTES.md](OPTIMIZATION-NOTES.md) is the running record of what's
been done — quantized chunk geometry, binary transfer, write-behind saves,
frozen static matrices — and what's deliberately deferred (greedy meshing).

## Testing

Headless test suites live in `tools/` (`test_*.py`) and run against an
isolated server + headless Chrome — they never touch real save data.
`tools/run_game_tests.sh` runs the lot. `CHANGELOG.md` records what each
hardening pass changed and why, one commit per entry.
