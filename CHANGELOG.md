# Change Log

A running log of the hardening & polish pass (started 2026-07-02), newest first.
Each entry maps to one commit, so any change can be reverted on its own with
`git revert <commit>`.

## 2026-07-02 — Crash-safe saves

**Why:** worlds, accounts, sessions and snapshots were written with an atomic
rename, which protects against a *process* crash — but not a power cut. On
power loss the filesystem can commit the rename before the file's data blocks
reach the disk, leaving a zero-length world file (all of a world's edits gone).

**What changed:**
- `server/storage.py`, `server/accounts.py`, `server/snapshots.py` — every
  persistence write now does `flush()` + `os.fsync()` before the atomic rename.
  Worlds flush at most once per second, so the extra fsync cost is negligible.
