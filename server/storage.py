"""
Multi-world persistence.

Each world is one JSON file in data/worlds/<id>.json:

    {
      "id": "w_ab12cd",
      "name": "Evan's Castle",
      "seed": 482913,            # terrain regenerates identically from this
      "created": 1719300000,
      "lastPlayed": 1719300000,
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


class WorldStore:
    def __init__(self, dir_path: str, legacy_path: str | None = None):
        self.dir = dir_path
        os.makedirs(self.dir, exist_ok=True)
        self.cache: dict[str, dict] = {}
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
    def summary(w: dict) -> dict:
        return {
            "id": w["id"], "name": w["name"], "seed": w["seed"],
            "created": w["created"], "lastPlayed": w["lastPlayed"],
            "edits": len(w.get("edits", {})),
        }

    def list_worlds(self) -> list[dict]:
        out = []
        for fn in os.listdir(self.dir):
            if not fn.endswith(".json"):
                continue
            w = self._load(fn[:-5])
            if w:
                out.append(self.summary(w))
        out.sort(key=lambda s: s["lastPlayed"], reverse=True)
        return out

    def get(self, wid: str) -> dict | None:
        return self._load(wid)

    def create(self, name: str) -> dict:
        name = (name or "New World").strip()[:40] or "New World"
        world = {
            "id": self._new_id(),
            "name": name,
            "seed": random.randrange(1, 2 ** 31),   # fresh terrain per world
            "created": _now(),
            "lastPlayed": _now(),
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
            if os.path.exists(path):
                os.remove(path)
                return True
        return False

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

    def set_blocks(self, wid: str, items):
        w = self._load(wid)
        if not w:
            return
        with _LOCK:
            for x, y, z, block in items:
                w["edits"][self.key(x, y, z)] = block
            w["lastPlayed"] = _now()
            self._write(w)

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
