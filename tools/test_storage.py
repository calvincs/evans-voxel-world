#!/usr/bin/env python3
"""
Unit tests for the persistence layer (storage / snapshots): the code that
guards the actual world data. Run directly:

    .venv/bin/python tools/test_storage.py

Covers the corruption-recovery path end to end: snapshots carry enough
metadata to rebuild a world file, a corrupt file is quarantined (never
deleted) and rebuilt, and mine ownership survives snapshots and rewinds.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.snapshots import SnapshotStore
from server.storage import WorldStore

PASS = 0


def check(name, cond):
    global PASS
    assert cond, f"FAIL: {name}"
    PASS += 1
    print(f"  ok: {name}")


def fresh_stores(root):
    """A (snapshots, worlds) pair over the same data dirs — building a new pair
    simulates a server restart (empty caches, state read back from disk)."""
    snaps = SnapshotStore(os.path.join(root, "snapshots"))
    store = WorldStore(os.path.join(root, "worlds"), snapshots=snaps)
    return snaps, store


def main():
    root = tempfile.mkdtemp(prefix="evans-storage-test-")
    print(f"data root: {root}")

    # --- build a world with edits, an armed mine, and a snapshot --------------
    snaps, store = fresh_stores(root)
    w = store.create("Test World", owner="u_test01", owner_name="Evan")
    wid = w["id"]
    store.set_block(wid, 1, 30, 1, 4)
    store.set_block(wid, 2, 30, 2, 26, owner="Evan")     # armed mine (PROX_ARMED)
    store.set_player(wid, {"x": 1.0, "y": 32.0, "z": 1.0})
    snap = store.snapshot_now(wid, label="test")
    check("snapshot captured", snap is not None)
    check("snapshot carries mine ownership", snap["mines"] == {"2,30,2": "Evan"})
    check("snapshot carries world metadata (seed)",
          snap["world"]["seed"] == w["seed"] and snap["world"]["name"] == "Test World")
    store.flush()

    # --- corrupt the world file, restart, expect quarantine + rebuild ---------
    path = os.path.join(root, "worlds", f"{wid}.json")
    with open(path, "w") as f:
        f.write('{"id": "half a wor')                    # torn write
    snaps2, store2 = fresh_stores(root)
    w2 = store2.get(wid)
    check("corrupt world rebuilt from snapshot", w2 is not None)
    check("rebuild kept seed", w2["seed"] == w["seed"])
    check("rebuild kept name/owner", w2["name"] == "Test World" and w2["owner"] == "u_test01")
    check("rebuild kept edits", w2["edits"] == {"1,30,1": 4, "2,30,2": 26})
    check("rebuild kept mines", w2["mines"] == {"2,30,2": "Evan"})
    check("rebuild kept player", (w2["player"] or {}).get("x") == 1.0)
    corrupt = [f for f in os.listdir(os.path.join(root, "worlds"))
               if f.startswith(f"{wid}.json.corrupt-")]
    check("corrupt file quarantined, not deleted", len(corrupt) == 1)
    with open(path) as f:
        check("rebuilt file parses and is complete", json.load(f)["seed"] == w["seed"])
    check("rebuilt world is listed in the menu",
          any(s["id"] == wid for s in store2.list_worlds("u_test01")))

    # --- zero-length file (the power-loss artifact) ----------------------------
    with open(path, "w"):
        pass                                             # truncate to 0 bytes
    _, store3 = fresh_stores(root)
    w3 = store3.get(wid)
    check("zero-length world file rebuilt", w3 is not None and w3["seed"] == w["seed"])

    # --- valid JSON that isn't a world -----------------------------------------
    with open(path, "w") as f:
        json.dump({"hello": "not a world"}, f)
    _, store4 = fresh_stores(root)
    check("non-world JSON rebuilt too", store4.get(wid) is not None)

    # --- rewind restores mines; pre-metadata snapshots prune stale owners ------
    _, store5 = fresh_stores(root)
    store5.set_block(wid, 2, 30, 2, 0, owner="Evan")     # defuse: mine entry drops
    check("clearing the block clears its mine entry",
          store5.get(wid)["mines"] == {})
    store5.apply_state(wid, snap["edits"], snap.get("player"), snap.get("mines"))
    check("rewind restores mine ownership",
          store5.get(wid)["mines"] == {"2,30,2": "Evan"})
    # A legacy snapshot (no mines recorded): stale entries must not survive
    # where the reverted edits no longer hold an armed mine.
    store5.apply_state(wid, {"1,30,1": 4}, None, None)
    check("legacy rewind prunes stale mine owners", store5.get(wid)["mines"] == {})

    # --- corruption with no usable snapshot ------------------------------------
    w6 = store5.create("No Snapshot World")
    store5.flush()
    path6 = os.path.join(root, "worlds", f'{w6["id"]}.json')
    with open(path6, "w") as f:
        f.write("garbage")
    _, store6 = fresh_stores(root)
    check("unrecoverable world returns None (file kept aside)",
          store6.get(w6["id"]) is None)
    check("unrecoverable file quarantined",
          any(f.startswith(f'{w6["id"]}.json.corrupt-')
              for f in os.listdir(os.path.join(root, "worlds"))))

    # --- prune always keeps the newest snapshot, however old --------------------
    import time as _time
    snaps7, store7 = fresh_stores(root)
    w7 = store7.create("Old World")
    store7.set_block(w7["id"], 0, 30, 0, 4)   # triggers the auto snapshot
    old = snaps7.list(w7["id"])[0]
    # Age the snapshot two weeks by rewriting its ts (retention would drop it).
    p7 = os.path.join(root, "snapshots", w7["id"], f'{old["id"]}.json')
    with open(p7) as f:
        d = json.load(f)
    d["ts"] -= 14 * 24 * 3600
    with open(p7, "w") as f:
        json.dump(d, f)
    snaps7._last_ts.pop(w7["id"], None)
    snaps7.prune(w7["id"])
    check("prune keeps the newest snapshot no matter its age",
          len(snaps7.list(w7["id"])) == 1)

    # --- startup sweep: prunes known worlds, keeps orphans, drops .tmp ----------
    orphan_dir = os.path.join(root, "snapshots", "w_orphan")
    os.makedirs(orphan_dir, exist_ok=True)
    with open(os.path.join(orphan_dir, "123_beef.json"), "w") as f:
        json.dump({"id": "123_beef", "ts": 123, "edits": {}}, f)
    with open(os.path.join(orphan_dir, "torn.json.tmp"), "w") as f:
        f.write("{half")
    snaps7.sweep({w7["id"]})
    check("sweep removes torn .tmp files",
          not os.path.exists(os.path.join(orphan_dir, "torn.json.tmp")))
    check("sweep never deletes orphaned snapshots",
          os.path.exists(os.path.join(orphan_dir, "123_beef.json")))

    print(f"\nall {PASS} checks passed")


if __name__ == "__main__":
    main()
