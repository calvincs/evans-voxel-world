# Change Log

A running log of the hardening & polish pass (started 2026-07-02), newest first.
Each entry maps to one commit, so any change can be reverted on its own with
`git revert <commit>`.

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
