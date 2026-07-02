"""
Per-world state snapshots (the "rewind" history).

A world's terrain is deterministic from its seed, so the only thing that changes
is the player's `edits` map (plus their saved position). A snapshot is therefore
just a cheap copy of `edits` + `player` at a moment in time. They live outside
the world file so the world's frequent atomic re-writes stay small:

    data/snapshots/<wid>/<snapid>.json  ->  {id, ts, editCount, edits, player, label}

Snapshots are captured opportunistically while a world is being played (see
WorldStore.maybe_snapshot) and pruned into a rolling window: everything from the
last day is kept, older ones are thinned to one per hour for a week, then dropped.
"""

import json
import os
import random
import re
import threading
import time

DAY = 24 * 3600
WEEK = 7 * DAY

# Snapshot ids are "<unix ts>_<hex suffix>" (see _new_id). Anything else —
# especially anything with path separators — never touches the filesystem.
_SNAPID_RE = re.compile(r"[0-9]+_[0-9a-f]+")


def _now() -> int:
    return int(time.time())


class SnapshotStore:
    def __init__(self, dir_path: str):
        self.dir = dir_path
        self._lock = threading.Lock()
        # Cache of each world's newest snapshot timestamp, so the edit hot-path
        # (maybe_snapshot -> last_ts) doesn't re-scan every snapshot file.
        self._last_ts: dict[str, int] = {}
        os.makedirs(self.dir, exist_ok=True)

    # --- paths ----------------------------------------------------------------
    def _wdir(self, wid: str) -> str:
        return os.path.join(self.dir, wid)

    def _path(self, wid: str, snapid: str) -> str:
        return os.path.join(self._wdir(wid), f"{snapid}.json")

    def _new_id(self, wid: str) -> str:
        # Sortable by time, with a short random suffix to avoid same-second clashes.
        for _ in range(1000):
            sid = f"{_now()}_{random.randrange(16**4):04x}"
            if not os.path.exists(self._path(wid, sid)):
                return sid
        return f"{_now()}_{random.randrange(16**6):06x}"

    # --- capture / read -------------------------------------------------------
    def capture(self, wid: str, edits: dict, player, label: str = "",
                mines: dict | None = None, meta: dict | None = None) -> dict:
        wdir = self._wdir(wid)
        os.makedirs(wdir, exist_ok=True)
        snap = {
            "id": self._new_id(wid),
            "ts": _now(),
            "editCount": len(edits or {}),
            "edits": dict(edits or {}),
            "player": player,
            # Mine ownership travels with the state it belongs to, so a rewind
            # can't leave an armed mine that no longer knows its owner.
            "mines": dict(mines or {}),
            # Enough world metadata (seed above all) to rebuild the world file
            # from this snapshot alone if it's ever lost or corrupted.
            "world": dict(meta) if meta else None,
            "label": label,
        }
        with self._lock:
            tmp = self._path(wid, snap["id"]) + ".tmp"
            with open(tmp, "w") as f:
                json.dump(snap, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._path(wid, snap["id"]))
        self._last_ts[wid] = snap["ts"]
        self.prune(wid)
        return snap

    def _all(self, wid: str) -> list[dict]:
        """Lightweight metadata for every snapshot (no edits payload), newest first."""
        wdir = self._wdir(wid)
        if not os.path.isdir(wdir):
            return []
        out = []
        for fn in os.listdir(wdir):
            if not fn.endswith(".json") or fn.endswith(".tmp"):
                continue
            try:
                path = os.path.join(wdir, fn)
                with open(path) as f:
                    s = json.load(f)
                # ts has 1-second resolution; captures in the same second (e.g.
                # an auto snapshot racing a session-end one) tie-break on file
                # mtime so "newest" is the one actually written last.
                out.append({"id": s["id"], "ts": s["ts"],
                            "editCount": s.get("editCount", len(s.get("edits", {}))),
                            "label": s.get("label", ""),
                            "_mt": os.stat(path).st_mtime_ns})
            except (json.JSONDecodeError, OSError, KeyError):
                continue
        out.sort(key=lambda s: (s["ts"], s["_mt"]), reverse=True)
        for s in out:
            del s["_mt"]
        return out

    def list(self, wid: str) -> list[dict]:
        return self._all(wid)

    def last_ts(self, wid: str) -> int:
        """Newest snapshot time, cached in memory (only scans disk the first time
        we're asked about a world this run)."""
        if wid not in self._last_ts:
            snaps = self._all(wid)
            self._last_ts[wid] = snaps[0]["ts"] if snaps else 0
        return self._last_ts[wid]

    def get(self, wid: str, snapid: str) -> dict | None:
        if not isinstance(snapid, str) or not _SNAPID_RE.fullmatch(snapid):
            return None                  # client-supplied id: no path traversal
        path = self._path(wid, snapid)
        if not os.path.exists(path):
            return None
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None

    def newest_rebuildable(self, wid: str) -> dict | None:
        """Newest snapshot carrying world metadata (a seed at minimum), i.e. one
        the world file can be reconstructed from. Snapshots from before metadata
        existed are skipped — they can restore edits but not recreate a file."""
        for s in self._all(wid):
            snap = self.get(wid, s["id"])
            if snap and (snap.get("world") or {}).get("seed") is not None:
                return snap
        return None

    # --- housekeeping ---------------------------------------------------------
    def prune(self, wid: str):
        """Rolling window: keep all snapshots from the last day; between one day
        and one week old keep only the newest per hour; drop anything older."""
        snaps = self._all(wid)          # newest first
        now = _now()
        keep, seen_hours = set(), set()
        for s in snaps:
            age = now - s["ts"]
            if age <= DAY:
                keep.add(s["id"])
            elif age <= WEEK:
                bucket = s["ts"] // 3600
                if bucket not in seen_hours:
                    seen_hours.add(bucket)
                    keep.add(s["id"])
            # older than a week: not kept
        with self._lock:
            for s in snaps:
                if s["id"] not in keep:
                    try:
                        os.remove(self._path(wid, s["id"]))
                    except OSError:
                        pass

    def delete_world(self, wid: str):
        """Remove all snapshots for a world (called when the world is deleted)."""
        self._last_ts.pop(wid, None)
        wdir = self._wdir(wid)
        if not os.path.isdir(wdir):
            return
        with self._lock:
            for fn in os.listdir(wdir):
                try:
                    os.remove(os.path.join(wdir, fn))
                except OSError:
                    pass
            try:
                os.rmdir(wdir)
            except OSError:
                pass
