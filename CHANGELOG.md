# Change Log

A running log of the hardening & polish pass (started 2026-07-02), newest first.
Each entry maps to one commit, so any change can be reverted on its own with
`git revert <commit>`.

## 2026-07-05 — Doors! 🚪

**Why:** houses need doors — a way in for you, and NOT for the wolves. Until
now a base was either sealed shut or open to the night.

**What changed:**
- New **Door** in the inventory: place one and a proper two-block-tall door
  stands up facing you (plank boards, brass handle, a little window up top).
- **Click a door to swing it open or shut** — any held item works, both
  halves move together, with a wooden creak / thunk. A first-time tip toast
  explains it.
- **Closed doors are solid and creatures can't open them** — the server's
  creature AI treats a shut door as wall, so wolves and spiders stay outside
  (they walk through open ones, so close up at night!).
- Open doors are real doorways: the panel swings against the jamb, you walk
  straight through, and your aim passes through the opening — only clicking
  the swung panel closes it. Doors render as thin panels (a new
  float-precision chunk sub-mesh on the same atlas material — no new shader).
- Breaking either half removes the whole door; explosions never leave half a
  door floating. Door state is ordinary block edits, so doors persist, sync
  to friends, and rewind with snapshots.
- Tests: 2 new pure-Python AI scenarios (closed blocks a wolf / open lets it
  through) and a browser suite (placement, orientation, click-to-toggle,
  walk-through, panel-only aiming, server persistence, pair-breaking).

## 2026-07-05 — Daytime stops paying for night lights (and mute means idle)

**Why:** every pixel on screen computed all 8 glowstone point-lights all day
long, even though they only shine after dark — the pool was kept "visible at
intensity 0" because toggling it used to recompile shaders and hitch right at
nightfall. And with the sound muted, the audio engine kept synthesizing wind
and ambience at zero volume, forever.

**What changed:**
- Both shader variants (lights on / lights off) are compiled once behind the
  loading screen, so the glow-light pool can now really switch off by day and
  on at dusk — nightfall is a cache hit, never a compile hitch. Daytime (most
  of a session) renders with no point-light loop at all; night looks exactly
  as before. Verified headless: zero new shader programs across day↔night.
- Muting the sound now parks the AudioContext (unless voice chat is active),
  so 🔇 also means "no audio CPU". Sound effects aren't even synthesized
  while muted. Unmute picks everything back up instantly.
- The coordinates/clock readout rebuilds ~4×/s instead of every frame, and
  the who's-talking highlight only touches the page when a state flips.

## 2026-07-05 — Stop re-doing work that never changes (scene & minimap)

**Why:** each frame recomputed things that are static — matrices for chunk
meshes that never move, a starfield drawn invisibly all day, and ~170 little
minimap tile draws for a picture that changes only when a block does.

**What changed:**
- Chunk meshes, creature/character body parts (everything except the swinging
  limbs and turning heads), name tags, mine overlays and debris freeze their
  local matrices — three.js stops recomposing them 60×/s.
- The starfield is skipped entirely while fully transparent (all day).
- The minimap composes its chunk tiles onto one layer canvas, rebuilt only
  when a tile or the visible window changes; each frame draws a single image
  plus the markers. Its measured cost dropped ~40× — same map, same pixels.

## 2026-07-05 — Old machines: adapt when WebGL runs on the CPU

**Why:** profiling showed that on old or blacklisted GPUs, Chrome quietly runs
WebGL on a software rasterizer (SwiftShader) — every pixel becomes CPU work,
which is exactly the "high CPU, poor performance" seen on older machines.

**What changed:**
- The game now detects a software WebGL renderer at boot and, only then,
  turns off MSAA antialiasing and renders at 1:1 device pixels. Machines with
  real GPUs are pixel-for-pixel unchanged.
- Measured headless (which uses SwiftShader, standing in for those machines):
  25 → 39 fps with the full perf pass, in the same scene.

## 2026-07-02 — The monster trap (new mine mode)

**Why:** the mine modes could hurt people and friendly animals — there was no
way to defend a base against the night's wolves and spiders without also
endangering pigs, villagers, or a sibling.

**What changed:**
- New **🟢 monster trap** mode (green eye, block 28): only hostile creatures —
  wolves, spiders, squid, the ones that can take your health — set it off.
  Players (owner or not) and friendly creatures walk over it safely.
- Strikes now cycle in **escalating danger**: off → monster trap → watch
  others (yellow) → watch EVERYONE (red) → off. A kid's first strike gives
  the safest, most useful defensive mine.
- Sensing rule enforced server-side like the other modes (live forever once
  armed, survives rejoins). Chain reactions unchanged — any mode still
  detonates when caught in a blast.
- Tests: 3 new pure-Python scenarios (pig ignored, strangers ignored, wolf
  fires it) and a browser T5 (pig walks the sensor, owner stands on it, wolf
  blows it), plus strike-count updates for the new cycle. Full suite green.

## 2026-07-02 — Mines stay live forever (server-watched)

**Why:** mine sensors lived in whichever browser was nearby. Leave the world
and nobody was watching your minefield; come back and each mine re-ran its
5-second arming blink as you approached — a "supposedly live" mine could be
walked over safely for 5 seconds, and creatures couldn't trip anything while
no player was close.

**What changed:**
- **The server watches every armed mine** (`server/creatures.py mines_tick`,
  in the same 10 Hz loop as the creatures): fresh arms honour the 5-second
  delay, and after that a mine is live *forever* — across rejoins, empty
  worlds, and rewinds — until defused or destroyed. A mine the server has
  never seen before (armed in an earlier session) is live immediately.
- **Ownership is enforced server-side by name**: an OTHERS-mine never fires
  on the player who armed it, no matter when they come back; an EVERYONE-mine
  fires on anyone, owner included. Creatures always count. (The HTTP edit
  fallback now records the owner too — it used to drop it.)
- When a mine trips, the server tells ONE client to run the explosion, so
  craters and chain reactions stay exactly as they were (client-computed,
  like TNT). The background tick now also runs fuses, so a hidden tab still
  detonates what it's told to.
- The client kept only the strike handling and the local arming blink — the
  1 Hz orphan-adoption scan, the client-side sensor, and the now-unused
  mine-block index are gone.
- Tests: 7 new pure-Python mine scenarios (owner exemption, pre-armed
  liveness, delay, EVERYONE mode, creature trips, defusal); `test_mines.py`
  and `test_mine_ownership.py` rewritten for real-time server sensing —
  including the exact reported case: armed mine → leave → rejoin → live
  immediately, still owner-safe. The rewrite surfaced that test arenas must
  now be persisted to the server (client-only platforms are phantoms the
  server's pigs fall through).

## 2026-07-02 — Water finds its level

**Why:** placed water just froze wherever it was clicked — even floating in
mid-air. Pouring water into a hole should fill the deepest part first.

**What changed (`static/js/engine/world.js`):**
- Water now settles: it flows down and sideways freely, and rises only
  through water it's already part of (never up a dry wall). On any
  disturbance — pouring a block, breaking a block next to or under water, a
  TNT crater — the pond finds every cell it can reach and redistributes into
  the lowest ones, nearest-first. So a poured block streams to the deepest
  cell, basins fill layer by layer, wells stack from the bottom, a breached
  pond drains along your channel, and a column falls when its floor breaks.
- Volume is conserved exactly: one placed block is one block of water,
  through every animated frame of the flow (moves apply a few per frame, so
  you see it run). Separate pools further down a hole are treated as
  occupied ground — new water rests on top of them.
- The infinite "refill" behaviour is now reserved for water genuinely
  connected to the world's water table: breaking into the sea or a lake
  (surface at sea level) still floods the gap for free, but a kid's own
  poured pool below sea level no longer turns infinite when they dig at it.
- Settling runs only on the client that caused the disturbance and syncs to
  everyone (and the server's creatures) as ordinary edit batches, exactly
  like the existing dam-breach flood.
- New `tools/test_water.py` — five headless scenarios (deepest-cell pour,
  layer fill, well stacking, breach draining, floor-break fall) with volume
  checks; wired into the suite. It caught one real planner bug before ship:
  water falling toward a separate pocket below tried to occupy it instead of
  resting on top.

## 2026-07-02 — Review close-out: last hardening + tablet polish

**Why:** five small items from the original review were still open, plus two
bits of polish worth having.

**What changed:**
- **Voice signaling hardened** (`server/main.py`): WebRTC messages are now
  rebuilt from whitelisted fields (never forwarded verbatim), size-capped
  (SDP ≤ 25 KB, ICE ≤ 2 KB) and rate-limited — the last open item from the
  security review.
- **Tablet onboarding**: the pause screen now shows touch instructions on
  touch devices (🕹️ walk, drag to look, ⛏ break, 🧱 place…) instead of
  "W A S D" and "Esc"; the place button glyph changed from ◼ to 🧱; the
  top-bar buttons grow to 48px with breathing room on touch screens.
- **Account files locked down**: `users.json` (password hashes) and
  `sessions.json` (login tokens) are now written owner-only (0600), and
  existing files are tightened on load.
- **Full-world egg feedback**: hatching an egg when the world already holds
  its 64 placed creatures now explains itself ("🥚 This world is full of
  creatures!") instead of silently doing nothing.
- **Weak-GPU lighting**: touch devices get 4 glowstone point lights instead
  of 8 — every lit pixel pays for each light, and tablets felt it.
- **Minimap creatures**: creatures now appear as dots — gold villagers, soft
  white animals, and bright red for a hunter that's locked onto someone.
- **Sun/moon in the HUD**: the clock now carries ☀️ / 🌄 / 🌙 — a night
  warning that doesn't require reading the time.

## 2026-07-02 — Creatures move to the server

**Why:** the first cut of shared creatures made one player's browser the
simulator. That browser could be throttled in a hidden tab, freeze on the
death screen, or leave mid-chase — degrading the world for everyone else.

**What changed:**
- **The server now runs every creature's brain** (`server/creatures.py` — a
  faithful Python port of the client AI: wander, day/night hunter temperament,
  A* corner pathfinding with the doorway fix, cliff/water sense, grazer
  flight, villagers keeping to town, squid depth-chase). A 10 Hz loop in
  `server/main.py` simulates each world that has players and streams
  snapshots, death effects, and bites; sims park (with a final checkpoint)
  when their world empties.
- **Clients are pure renderers** — `static/js/mobs.js` keeps only bodies,
  animation, hurt flashes, villager chatter, and aim-picking; a swing sends
  "I hit creature X" and the server applies it. No owner election, no client
  streaming, no dependence on anyone's tab.
- Creatures read the real world server-side (terrain + edits composed per
  chunk, invalidated as blocks change), so a TNT crater instantly changes
  where a wolf can walk. Day/night on the server matches the client sky
  formula exactly.
- Persistence is now trivially safe: hatch/death update the world file
  immediately; positions checkpoint every 5 s server-side.
- New localhost-only `POST /api/admin/wildlife` pauses/rescues automatic wild
  spawning (parent switch; the tests use it to keep arenas deterministic).
- Tests: new `tools/test_creature_ai.py` — 19 pure-Python AI scenario checks
  (pit pursuit, doorway pathing, squid dive, flee, temperament, eggs, bite
  routing) that run in seconds with no browser, replacing the retired
  `test_mob_ai.py`. The two-player sync test now proves the stream survives a
  player leaving; the village test observes real server-spawned villagers.
  Full suite green.

## 2026-07-02 — Shared, persistent creatures

**Why:** creatures were simulated per-browser — two kids in the same world
were chased by different, mutually invisible wolves, and egg-hatched creatures
evaporated 42 blocks away or on any reload.

**What changed:**
- **One shared world of creatures.** The first player in a world becomes its
  "sim owner": their client runs all the creature AI and streams positions
  ~10×/sec; everyone else renders that stream (same interpolation as remote
  players). If the owner leaves, the server promotes the next player, who
  takes over from exactly where the stream left off. Solo play is unchanged —
  you're just the owner of a room of one.
- **Placed creatures persist.** Hatching a spawn egg now goes through the
  server: the creature gets a permanent id, is saved in the world file
  (position checkpointed every few seconds), appears for every player, is
  included in snapshots/rewind and corruption rebuilds, and never
  distance-despawns. Kill it and it's gone for good. A room full of wolves is
  still full of wolves tomorrow.
- **Hostiles hunt the nearest player**, not just the simulating one, and wild
  animals now spawn around (and despawn away from) *all* players. A bite on
  another player is routed to their client; a swing by a non-owner is routed
  to the owner (with instant local feedback). Explosions kill the same
  creatures for everyone. The Peaceful toggle now applies live for the whole
  room.
- **The world doesn't freeze with its owner.** The simulation keeps ticking on
  the death screen, and a background timer keeps it (and the stream) alive
  when the owner's tab is hidden — discovered the hard way: Chrome pauses
  rendering loops in background tabs.
- New `tools/test_mob_sync.py` — a real two-player test (two pages in one
  headless Chrome): same wolf in the same place on both screens, mirror-side
  kills, owner handoff, and full leave/rejoin persistence. 10 checks, wired
  into `tools/run_game_tests.sh` (self-launching tests got their own ports so
  they can't collide with the shared suite instance).

## 2026-07-02 — Docs match reality

- README/run.sh said the game runs at `http://localhost:8000`; it's
  `https://localhost:8765` (HTTPS by default).
- README still promised the removed 2-second mine defuse window; mines trip
  instantly now, and the text says so.
- The second-instance advice now recommends `EVANS_DATA_DIR` (full isolation)
  instead of `EVANS_WORLDS_DIR`, which silently shared accounts/sessions/
  snapshots between instances.
- New sections: password rescue, backups & systemd service, minimap,
  Peaceful toggle, ambience/master-mute, night counter, villager chatter.

## 2026-07-02 — A world that sounds alive

**Why:** the game had music and effect sounds but no *atmosphere* — and no
gentle way of telling you things (a friend joining, the sun coming up).

**What changed (`static/js/audio.js` + hooks in `main.js`):**
- Ambient soundscape, fully synthesized: soft wind (a touch stronger after
  dark), scattered birdsong by day, the classic three-pulse cricket chirp at
  night — all panned randomly around you, all silenced by the master mute.
- The generative music now follows the sun: after dark it drops an octave,
  thins out and darkens — calm, a little mysterious. A soft dotted-eighth
  echo voice gives the melody depth day and night.
- Notification chimes: a rising two-note when a friend joins (with a "👋
  Evan joined!" toast), falling when they leave, and a little three-note
  sunrise fanfare.

## 2026-07-02 — Villagers talk, dawn counts, hunters corner smarter

**Why:** the only thing you could *do* with a villager was hit them. Nights
passed without acknowledgement. And a long-standing bug: a hunting wolf could
end up orbiting outside a doorway forever instead of walking through it.

**What changed:**
- Poking a villager no longer hurts them — they turn to face you and say
  something in character ("🌾 The pumpkins are coming along nicely!", "🧒
  Wanna race to the well?"). Four voices, three lines each (`mobs.js`).
- At sunrise, if you actually lived through the night (30+ seconds of dark),
  a toast counts it: "🌅 Night 12 survived!" with a tiny fanfare. A fun
  counter, not a progression system — kept per world on the device.
- Hunter pathfinding fixes: sliding along a wall now counts as "stuck" (the
  cue that asks the pathfinder for a route), computed paths through static
  walls stay trusted for 5s instead of 2, an expired path re-requests
  immediately instead of blundering straight-line, and at most one A* runs
  per frame across all mobs (night sieges no longer stutter).
- Mob body-part geometries are now built once and shared by every creature of
  a type — hatching a pile of spawn eggs used to upload and dispose a fresh
  set of GPU buffers per animal (`mobs.js`); a small name-tag material leak
  on player join/leave is also fixed (`engine/character.js`).
- Test-harness fix: `test_mob_ai.py` now waits for every chunk under its
  arenas to stream in before building them. Blocks placed into unloaded
  chunks were silently dropped, which is what actually made the wall-doorway
  scenario fail on the first run after a fresh boot.

## 2026-07-02 — Minimap

**Why:** no way to find your way home (or find your sibling) in a big world.

**What changed (new `static/js/minimap.js` + wiring):**
- A circular map sits in the top-right corner with you at the centre. It
  rotates with you, so "up" is always the way you're facing.
- Shows the terrain of every loaded chunk (highest block's colour, shaded by
  height), an orange ring around the village, and other players as dots in
  their character colours.
- Tap the map (or press N) to cycle: big → small → hidden. Map tiles rebuild
  automatically as the world is edited (a few per frame, no hitches).
- Verified with a real screenshot + smoke test (now 20 checks).

## 2026-07-02 — Smoother frames while building

**Why:** three measurable stutter sources. (1) The mine "adoption" scan read
~23,000 blocks in a single frame, every second, in every world — even with no
mines anywhere: a metronomic hitch. (2) Breaching a dam applied up to 4096
water edits in one frame: one big hitch at the most fun moment. (3) Every
block read built a lookup string — thousands of throwaway allocations per
frame under collision, mob AI and camera probes.

**What changed:**
- Mine blocks are now indexed as chunks load/edit (same pattern as glowstone
  lights), so the adoption pass checks a handful of known positions instead
  of scanning a volume (`static/js/engine/world.js`, `static/js/gear.js`).
- Water flood-fills drain ~300 cells per frame — the water visibly rushes in
  over a few frames instead of hitching one; the result is still persisted
  and relayed as one batch.
- `getBlock` remembers the last chunk it touched (voxel reads are extremely
  local), skipping the string-key Map lookup on nearly every call.
- Stability: the day/night clock is now derived from the server-anchored wall
  clock every frame — a backgrounded tab used to come back minutes behind,
  with its wolves out of sync with everyone else's. And after a reconnect,
  refetched chunks that didn't change are no longer remeshed (a Wi-Fi blip
  used to cost seconds of rebuilding identical geometry).
- New `tools/run_game_tests.sh` — runs the whole headless gameplay suite
  (mob AI, mines, mine ownership, village) plus the UI smoke test against an
  isolated server. Note: `test_mob_ai`'s wall-doorway scenario was already
  failing before this change (verified via stash) — fix tracked separately.

## 2026-07-02 — The inventory shows what you're doing

**Why:** block names lived only in hover tooltips (invisible on a tablet), and
which hotbar slot a pick landed in was invisible state. Contraption messages
were compressed adult English shown for 2.5 seconds.

**What changed:**
- The inventory (E / 🎒) now has a mini hotbar showing the destination slot —
  tap a slot to switch, tap blocks to fill several slots in one visit (the
  panel stays open; Done/E closes). A readout names the block under your
  pointer or the one you just picked (`static/js/main.js`, `index.html`,
  `style.css`).
- Mine and elevator toasts rewritten for a young reader ("💣 Mine ON — it will
  never blow up on YOU. Live in 5 seconds!"), and contraption toasts stay up
  a second longer (`static/js/gear.js`).
- Smoke test grew to 16 checks (inventory flow exercised end-to-end).

## 2026-07-02 — Peaceful is one tap away, in-game

**Why:** night interrupts building every few minutes, and the only escape
hatch (the Peaceful toggle) was buried on the world menu — you had to quit
the game to reach it.

**What changed (`static/index.html`, `static/js/main.js`):**
- The pause screen (Esc / ⏸) now has the owner's 🕊️/⚔️ Peaceful toggle. It
  applies instantly — hostiles calm down without a reload. Other players in
  the world pick it up on their next join.
- Smoke test grew to 11 checks (peaceful toggle exercised in a real browser).

## 2026-07-02 — No more silent failures on the menu, and a mute that mutes

**Why (menu):** if loading a world failed, the error only went to the console —
the menu just sat there dead. And an expired session made the world list say
"No worlds yet" (terrifying) while the Create button silently did nothing.

**Why (sound):** the 🔊/🔇 button only stopped the music. The scary sounds — the
wolf growl in the dark — kept playing, exactly what a kid mutes to avoid. The
choice also reset on every reload.

**What changed (`static/js/main.js`, `static/js/audio.js`):**
- A failed world load now shows the "Couldn't start" panel with a ↩ Try again
  button; picking a world shows "Loading world…" immediately.
- An expired session returns to the sign-in screen instead of lying about your
  worlds; a failed world-list load says so and retries.
- 🔇 now mutes music AND all sound effects (voice chat intentionally stays on,
  so muting the game never cuts a kid off from their sibling). The setting
  persists across reloads.
- New `tools/test_smoke.py` — real-browser smoke test (isolated server +
  headless Chrome): boots the demo world, exercises the mute button, and
  proves a bogus world shows the error panel. 8 checks.

## 2026-07-02 — Forgotten passwords are no longer a dead end

**Why:** a kid who forgot their password was hard-locked out — the game had no
recovery path at all, and no way to even see what you were typing.

**What changed:**
- New 👁 show-password button on the sign-in and profile password fields
  (`static/index.html`, `static/js/main.js`, `static/css/style.css`).
- New `tools/reset_password.py` — parent rescue, run on the host machine:
  `tools/reset_password.py evan` (prompts) or `... evan newpass`. Talks to the
  running server so the reset is live instantly; if the server is down it
  edits `data/users.json` directly.
- New `POST /api/admin/reset-password` endpoint that only accepts requests
  from localhost — kids' tablets can never reach it (verified: LAN requests
  get 403).

## 2026-07-02 — Backups, auto-restart, snapshot housekeeping

**Why:** snapshots protect against bad edits, not a dying disk — and a server
crash used to take the game down until someone restarted it by hand. Also,
snapshots of worlds nobody plays (and stale `.tmp` files from torn writes)
were never cleaned up.

**What changed:**
- New `tools/backup.sh` — tars `data/` into `backups/` (or `EVANS_BACKUP_DIR`,
  ideally another drive) and keeps the newest 14. One cron line makes it
  nightly; instructions are in the script.
- New `tools/evansgame.service` — a systemd user unit so the game starts on
  boot and restarts itself after a crash. Install instructions inside.
- Startup sweep (`server/snapshots.py`): removes torn `.tmp` snapshot files,
  applies the retention window to idle worlds, and *reports* orphaned snapshot
  dirs without ever deleting them.
- Retention now always keeps a world's newest snapshot no matter how old — it
  is the rebuild source if the world file is ever corrupted.
- `tools/test_storage.py` grew to 22 checks (prune/sweep coverage).

## 2026-07-02 — Corrupt worlds heal themselves

**Why:** if a world file ever failed to parse (e.g. after a power cut), the
world silently vanished from the menu — and its snapshots were unreachable,
because rewinding needed the very file that broke. Recovery meant hand-editing
JSON.

**What changed:**
- Snapshots now also store the world's metadata (seed, name, owner, settings)
  and the armed-mine ownership map, so a snapshot alone can reconstruct the
  whole world file (`server/snapshots.py`, `server/storage.py`).
- A corrupt world file is quarantined as `<id>.json.corrupt-<time>` (never
  deleted) and the world is rebuilt automatically from its newest snapshot,
  with loud log lines describing what happened.
- Rewinding now restores mine ownership too; rewinding to an old snapshot
  prunes stale mine entries instead of leaving them behind.
- Two snapshots taken in the same second now order correctly (file-mtime
  tie-break) so "newest" is really the newest.
- The HTTP edit/player endpoints now reject writes during a rewind, matching
  the multiplayer path — a stray edit can no longer land inside a restore.
- New: `tools/test_storage.py` — 19 unit checks over the persistence layer
  (the first tests for the code that guards the save data).

## 2026-07-02 — Crash-safe saves

**Why:** worlds, accounts, sessions and snapshots were written with an atomic
rename, which protects against a *process* crash — but not a power cut. On
power loss the filesystem can commit the rename before the file's data blocks
reach the disk, leaving a zero-length world file (all of a world's edits gone).

**What changed:**
- `server/storage.py`, `server/accounts.py`, `server/snapshots.py` — every
  persistence write now does `flush()` + `os.fsync()` before the atomic rename.
  Worlds flush at most once per second, so the extra fsync cost is negligible.
