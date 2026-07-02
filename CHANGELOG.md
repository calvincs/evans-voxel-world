# Change Log

A running log of the hardening & polish pass (started 2026-07-02), newest first.
Each entry maps to one commit, so any change can be reverted on its own with
`git revert <commit>`.

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
