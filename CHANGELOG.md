# Change Log

A running log of the hardening & polish pass (started 2026-07-02), newest first.
Each entry maps to one commit, so any change can be reverted on its own with
`git revert <commit>`.

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
