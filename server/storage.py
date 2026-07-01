"""
Multi-world persistence.

Each world is one JSON file in data/worlds/<id>.json:

    {
      "id": "w_ab12cd",
      "name": "Evan's Castle",
      "seed": 482913,            # terrain regenerates identically from this
      "created": 1719300000,
      "lastPlayed": 1719300000,
      "owner": "u_ab12cd" | null,   # creator's uid; null = unclaimed (legacy)
      "ownerName": "Evan",          # cached display name for listings
      "public": true,               # false = only the owner sees / can play it
      "player": {x,y,z,yaw,pitch,selected} | null,
      "edits": { "x,y,z": block, ... }   # only the blocks the player changed
    }

Terrain itself is never stored — it is recreated deterministically from the
seed, so a world is fully reproducible from this tiny file. Worlds from the old
single-world format (data/world.json) are migrated on first run.
"""

import atexit
import json
import os
import random
import threading
import time

_LOCK = threading.Lock()
_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def _now() -> int:
    return int(time.time())


DEFAULT_SNAPSHOT_INTERVAL = 20 * 60   # seconds between automatic snapshots
FLUSH_INTERVAL = 1.0                  # seconds; max window of edits at risk on a hard crash


class WorldStore:
    def __init__(self, dir_path: str, legacy_path: str | None = None,
                 snapshots=None, snapshot_interval: int = DEFAULT_SNAPSHOT_INTERVAL,
                 chunk_x: int = 16, chunk_z: int = 16):
        self.dir = dir_path
        os.makedirs(self.dir, exist_ok=True)
        self.cache: dict[str, dict] = {}
        self.snapshots = snapshots            # optional SnapshotStore
        self.snapshot_interval = snapshot_interval
        # Chunk footprint used to bucket edits for fast per-chunk lookup.
        self.chunk_x = chunk_x
        self.chunk_z = chunk_z
        # wid -> { (cx, cz): { (x, y, z): block } }. Derived from w["edits"], built
        # lazily, kept in sync on writes; never serialized. Lets edits_in_chunk
        # touch only the edits in one chunk instead of scanning the whole world.
        self._index: dict[str, dict[tuple, dict]] = {}
        # Write-behind: frequent edits mark a world dirty and a background thread
        # flushes it to disk at most once per FLUSH_INTERVAL, instead of
        # rewriting the whole file on every block change. The cache stays
        # authoritative, so gameplay always reads the latest state; only a hard
        # crash risks the last ~1 s of edits (snapshots + session-end cover the
        # rest).
        self._dirty: set[str] = set()
        self._migrate_legacy(legacy_path)
        self._stop = threading.Event()
        self._flusher = threading.Thread(target=self._flush_loop, daemon=True)
        self._flusher.start()
        atexit.register(self.flush)

    # --- paths / ids ----------------------------------------------------------
    def _path(self, wid: str) -> str:
        return os.path.join(self.dir, f"{wid}.json")

    def _new_id(self) -> str:
        for _ in range(1000):
            wid = "w_" + "".join(random.choice(_ID_ALPHABET) for _ in range(6))
            if not os.path.exists(self._path(wid)):
                return wid
        return "w_" + str(_now())

    def _any_worlds(self) -> bool:
        return any(fn.endswith(".json") for fn in os.listdir(self.dir))

    # --- load / save ----------------------------------------------------------
    def _write_file(self, world: dict):
        """Serialize one world to disk (atomic on POSIX)."""
        tmp = self._path(world["id"]) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(world, f)
        os.replace(tmp, self._path(world["id"]))

    def _write(self, world: dict):
        """Cache + immediate disk write, for lifecycle changes that want to be
        durable at once (create/rename/delete/revert/ownership). Also clears any
        pending write-behind flag. Callers hold _LOCK."""
        self.cache[world["id"]] = world
        self._dirty.discard(world["id"])
        self._write_file(world)

    def _mark_dirty(self, world: dict):
        """Update the world in memory and queue it for a background flush, rather
        than rewriting the file on every edit. Callers hold _LOCK."""
        self.cache[world["id"]] = world
        self._dirty.add(world["id"])

    def flush(self, wid: str | None = None):
        """Write queued worlds to disk now — one world, or all of them. Runs on
        the background timer, at session end, and at process exit (atexit)."""
        with _LOCK:
            targets = [wid] if wid is not None else list(self._dirty)
            for i in targets:
                if i in self._dirty:
                    w = self.cache.get(i)
                    if w is not None:
                        self._write_file(w)
                    self._dirty.discard(i)

    def _flush_loop(self):
        while not self._stop.wait(FLUSH_INTERVAL):
            if self._dirty:
                self.flush()

    def _load(self, wid: str) -> dict | None:
        if wid in self.cache:
            return self.cache[wid]
        path = self._path(wid)
        if not os.path.exists(path):
            return None
        try:
            with open(path) as f:
                world = json.load(f)
        except (json.JSONDecodeError, OSError):
            return None
        world.setdefault("edits", {})
        world.setdefault("player", None)
        # Ownership fields — legacy worlds predate accounts, so they become
        # public + unclaimed (owner=None); any logged-in user can claim one.
        world.setdefault("owner", None)
        world.setdefault("ownerName", "")
        world.setdefault("public", True)
        self.cache[wid] = world
        return world

    def _migrate_legacy(self, legacy_path: str | None):
        if not legacy_path or not os.path.exists(legacy_path) or self._any_worlds():
            return
        try:
            with open(legacy_path) as f:
                data = json.load(f)
            wid = self._new_id()
            world = {
                "id": wid,
                "name": "My First World",
                "seed": int(data.get("seed", 1337)),
                "created": _now(),
                "lastPlayed": _now(),
                "owner": None,
                "ownerName": "",
                "public": True,
                "player": data.get("player"),
                "edits": {k: int(v) for k, v in data.get("edits", {}).items()},
            }
            with _LOCK:
                self._write(world)
            os.rename(legacy_path, legacy_path + ".migrated")
        except (json.JSONDecodeError, OSError, ValueError):
            pass

    # --- world lifecycle ------------------------------------------------------
    @staticmethod
    def summary(w: dict, viewer_uid: str | None = None) -> dict:
        owner = w.get("owner")
        return {
            "id": w["id"], "name": w["name"], "seed": w["seed"],
            "created": w["created"], "lastPlayed": w["lastPlayed"],
            "edits": len(w.get("edits", {})),
            "owner": owner,
            "ownerName": w.get("ownerName", ""),
            "public": w.get("public", True),
            "mine": owner is not None and owner == viewer_uid,
            "unclaimed": owner is None,
        }

    def list_worlds(self, viewer_uid: str | None = None) -> list[dict]:
        """Worlds visible to a viewer: all public worlds plus the viewer's own
        private worlds."""
        out = []
        for fn in os.listdir(self.dir):
            if not fn.endswith(".json"):
                continue
            w = self._load(fn[:-5])
            if not w:
                continue
            if not w.get("public", True) and w.get("owner") != viewer_uid:
                continue                       # private + not yours -> hidden
            out.append(self.summary(w, viewer_uid))
        out.sort(key=lambda s: s["lastPlayed"], reverse=True)
        return out

    def get(self, wid: str) -> dict | None:
        return self._load(wid)

    def create(self, name: str, owner: str | None = None, owner_name: str = "") -> dict:
        name = (name or "New World").strip()[:40] or "New World"
        world = {
            "id": self._new_id(),
            "name": name,
            "seed": random.randrange(1, 2 ** 31),   # fresh terrain per world
            "created": _now(),
            "lastPlayed": _now(),
            "owner": owner,
            "ownerName": owner_name,
            "public": True,                          # public by default; owner can flip
            "player": None,
            "edits": {},
        }
        with _LOCK:
            self._write(world)
        return world

    def rename(self, wid: str, name: str) -> bool:
        w = self._load(wid)
        if not w:
            return False
        with _LOCK:
            w["name"] = (name or w["name"]).strip()[:40] or w["name"]
            self._write(w)
        return True

    def delete(self, wid: str) -> bool:
        with _LOCK:
            self.cache.pop(wid, None)
            self._index.pop(wid, None)
            self._dirty.discard(wid)         # nothing left to flush
            path = self._path(wid)
            existed = os.path.exists(path)
            if existed:
                os.remove(path)
        if self.snapshots:
            self.snapshots.delete_world(wid)
        return existed

    def set_owner(self, wid: str, owner: str, owner_name: str = "") -> bool:
        w = self._load(wid)
        if not w:
            return False
        with _LOCK:
            w["owner"] = owner
            w["ownerName"] = owner_name
            self._write(w)
        return True

    def set_public(self, wid: str, public: bool) -> bool:
        w = self._load(wid)
        if not w:
            return False
        with _LOCK:
            w["public"] = bool(public)
            self._write(w)
        return True

    def apply_state(self, wid: str, edits: dict, player) -> bool:
        """Replace a world's edits + player wholesale (used by revert)."""
        w = self._load(wid)
        if not w:
            return False
        with _LOCK:
            w["edits"] = dict(edits or {})
            w["player"] = player
            w["lastPlayed"] = _now()
            self._index.pop(wid, None)      # edits replaced wholesale; rebuild lazily
            self._write(w)
        return True

    # --- snapshots ------------------------------------------------------------
    def maybe_snapshot(self, wid: str):
        """Capture a snapshot if enough time has passed since the last one. Cheap
        to call on every edit — it only writes when the interval has elapsed."""
        if not self.snapshots:
            return
        w = self._load(wid)
        if not w:
            return
        if _now() - self.snapshots.last_ts(wid) < self.snapshot_interval:
            return
        self.snapshots.capture(wid, w.get("edits", {}), w.get("player"), label="auto")

    def snapshot_now(self, wid: str, label: str = "") -> dict | None:
        """Force a snapshot immediately (e.g. when the last player leaves, or as a
        safety copy right before a revert)."""
        if not self.snapshots:
            return None
        w = self._load(wid)
        if not w:
            return None
        return self.snapshots.capture(wid, w.get("edits", {}), w.get("player"), label=label)

    def touch(self, wid: str):
        w = self._load(wid)
        if w:
            with _LOCK:
                w["lastPlayed"] = _now()
                self._mark_dirty(w)

    # --- edit index (per-chunk) ----------------------------------------------
    def _chunk_of(self, x: int, z: int) -> tuple:
        # Floor division matches the client's floorDiv (correct for negatives).
        return (x // self.chunk_x, z // self.chunk_z)

    def _index_for(self, wid: str) -> dict:
        """Per-chunk edit buckets for a world, built on first use from w["edits"]
        and cached. Callers hold _LOCK."""
        idx = self._index.get(wid)
        if idx is None:
            idx = {}
            w = self._load(wid)
            if w:
                for key, block in w["edits"].items():
                    x, y, z = (int(v) for v in key.split(","))
                    idx.setdefault(self._chunk_of(x, z), {})[(x, y, z)] = block
            self._index[wid] = idx
        return idx

    def _index_put(self, wid: str, x: int, y: int, z: int, block: int):
        """Mirror one edit into the index if it's already built. Callers hold
        _LOCK. If the index isn't built yet, it will pick this edit up from
        w["edits"] when it's first constructed, so there's nothing to do."""
        idx = self._index.get(wid)
        if idx is not None:
            idx.setdefault(self._chunk_of(x, z), {})[(x, y, z)] = block

    # --- edits / player -------------------------------------------------------
    @staticmethod
    def key(x: int, y: int, z: int) -> str:
        return f"{x},{y},{z}"

    def set_block(self, wid: str, x: int, y: int, z: int, block: int):
        w = self._load(wid)
        if not w:
            return
        with _LOCK:
            w["edits"][self.key(x, y, z)] = block
            w["lastPlayed"] = _now()
            self._index_put(wid, x, y, z, block)
            self._mark_dirty(w)
        self.maybe_snapshot(wid)

    def set_blocks(self, wid: str, items):
        w = self._load(wid)
        if not w:
            return
        with _LOCK:
            for x, y, z, block in items:
                w["edits"][self.key(x, y, z)] = block
                self._index_put(wid, x, y, z, block)
            w["lastPlayed"] = _now()
            self._mark_dirty(w)
        self.maybe_snapshot(wid)

    def set_player(self, wid: str, state: dict):
        w = self._load(wid)
        if not w:
            return
        with _LOCK:
            w["player"] = state
            w["lastPlayed"] = _now()
            self._mark_dirty(w)

    def edits_in_chunk(self, wid, cx, cz, chunk_x, chunk_z, world_y):
        with _LOCK:
            bucket = self._index_for(wid).get((cx, cz))
            if not bucket:
                return {}
            x0, z0 = cx * chunk_x, cz * chunk_z
            # Only this chunk's edits are examined now, not the whole world.
            return {(x - x0, y, z - z0): block
                    for (x, y, z), block in bucket.items()
                    if 0 <= y < world_y}
