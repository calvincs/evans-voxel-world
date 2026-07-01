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


class WorldStore:
    def __init__(self, dir_path: str, legacy_path: str | None = None,
                 snapshots=None, snapshot_interval: int = DEFAULT_SNAPSHOT_INTERVAL):
        self.dir = dir_path
        os.makedirs(self.dir, exist_ok=True)
        self.cache: dict[str, dict] = {}
        self.snapshots = snapshots            # optional SnapshotStore
        self.snapshot_interval = snapshot_interval
        self._migrate_legacy(legacy_path)

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
    def _write(self, world: dict):
        self.cache[world["id"]] = world
        tmp = self._path(world["id"]) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(world, f)
        os.replace(tmp, self._path(world["id"]))   # atomic on POSIX

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
                self._write(w)

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
            self._write(w)
        self.maybe_snapshot(wid)

    def set_blocks(self, wid: str, items):
        w = self._load(wid)
        if not w:
            return
        with _LOCK:
            for x, y, z, block in items:
                w["edits"][self.key(x, y, z)] = block
            w["lastPlayed"] = _now()
            self._write(w)
        self.maybe_snapshot(wid)

    def set_player(self, wid: str, state: dict):
        w = self._load(wid)
        if not w:
            return
        with _LOCK:
            w["player"] = state
            w["lastPlayed"] = _now()
            self._write(w)

    def edits_in_chunk(self, wid, cx, cz, chunk_x, chunk_z, world_y):
        w = self._load(wid)
        if not w:
            return {}
        out = {}
        x0, z0 = cx * chunk_x, cz * chunk_z
        for key, block in w["edits"].items():
            x, y, z = (int(v) for v in key.split(","))
            if x0 <= x < x0 + chunk_x and z0 <= z < z0 + chunk_z and 0 <= y < world_y:
                out[(x - x0, y, z - z0)] = block
        return out
