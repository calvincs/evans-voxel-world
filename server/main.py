"""
EvansGame — FastAPI server (multi-world).

Worlds are listed/created/deleted via /api/worlds, and everything else is
scoped to a world id: /api/worlds/{id}/config, /chunk, /edit, /edits, /player.
Each world regenerates its terrain from its own seed and layers the player's
saved edits on top.

Run:  python -m uvicorn server.main:app --reload  (or ./run.sh)
"""

import base64
import os

import itertools

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import worldgen
from .storage import WorldStore

# --- Paths -------------------------------------------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(ROOT, "static")
# Data location can be overridden (e.g. to run a second, isolated instance).
WORLDS_DIR = os.environ.get("EVANS_WORLDS_DIR") or os.path.join(ROOT, "data", "worlds")
LEGACY_PATH = os.environ.get("EVANS_LEGACY_PATH") or os.path.join(ROOT, "data", "world.json")

store = WorldStore(WORLDS_DIR, legacy_path=LEGACY_PATH)

# One generator per seed (deterministic, cheap to keep around).
_generators: dict[int, worldgen.WorldGenerator] = {}


def gen_for(seed: int) -> worldgen.WorldGenerator:
    g = _generators.get(seed)
    if g is None:
        g = worldgen.WorldGenerator(seed=seed)
        _generators[seed] = g
    return g


app = FastAPI(title="EvansGame")


# --- Models ------------------------------------------------------------------
class Edit(BaseModel):
    x: int
    y: int
    z: int
    block: int


class Edits(BaseModel):
    edits: list[Edit]


class PlayerState(BaseModel):
    x: float
    y: float
    z: float
    yaw: float = 0.0
    pitch: float = 0.0
    selected: int = 0


class NewWorld(BaseModel):
    name: str = "New World"


class RenameWorld(BaseModel):
    name: str


def world_or_404(wid: str) -> dict:
    w = store.get(wid)
    if not w:
        raise HTTPException(404, "world not found")
    return w


# --- World management --------------------------------------------------------
@app.get("/api/worlds")
def list_worlds():
    return {"worlds": store.list_worlds()}


@app.post("/api/worlds")
def create_world(body: NewWorld):
    return {"world": store.summary(store.create(body.name))}


@app.post("/api/worlds/{wid}/rename")
def rename_world(wid: str, body: RenameWorld):
    if not store.rename(wid, body.name):
        raise HTTPException(404, "world not found")
    return {"ok": True}


@app.delete("/api/worlds/{wid}")
def delete_world(wid: str):
    store.delete(wid)
    return {"ok": True}


# --- Per-world play ----------------------------------------------------------
@app.get("/api/worlds/{wid}/config")
def world_config(wid: str):
    w = world_or_404(wid)
    spawn_h = gen_for(w["seed"]).height_at(0, 0)
    store.touch(wid)
    return {
        "id": w["id"],
        "name": w["name"],
        "seed": w["seed"],
        "chunkX": worldgen.CHUNK_X,
        "chunkZ": worldgen.CHUNK_Z,
        "worldY": worldgen.WORLD_Y,
        "waterLevel": worldgen.WATER_LEVEL,
        "spawn": {"x": 0.5, "y": spawn_h + 3, "z": 0.5},
        "player": w.get("player"),
    }


@app.get("/api/worlds/{wid}/chunk/{cx}/{cz}")
def world_chunk(wid: str, cx: int, cz: int):
    w = world_or_404(wid)
    blocks = gen_for(w["seed"]).generate_chunk(cx, cz)
    edits = store.edits_in_chunk(
        wid, cx, cz, worldgen.CHUNK_X, worldgen.CHUNK_Z, worldgen.WORLD_Y)
    for (lx, y, lz), block in edits.items():
        blocks[lx + worldgen.CHUNK_X * (lz + worldgen.CHUNK_Z * y)] = block
    return {"cx": cx, "cz": cz,
            "data": base64.b64encode(bytes(blocks)).decode("ascii")}


@app.post("/api/worlds/{wid}/edit")
def world_edit(wid: str, edit: Edit):
    world_or_404(wid)
    if not (0 <= edit.y < worldgen.WORLD_Y):
        raise HTTPException(400, "y out of range")
    if not (0 <= edit.block < 256):
        raise HTTPException(400, "bad block id")
    store.set_block(wid, edit.x, edit.y, edit.z, edit.block)
    return {"ok": True}


@app.post("/api/worlds/{wid}/edits")
def world_edits(wid: str, payload: Edits):
    world_or_404(wid)
    items = [(e.x, e.y, e.z, e.block) for e in payload.edits
             if 0 <= e.y < worldgen.WORLD_Y and 0 <= e.block < 256]
    store.set_blocks(wid, items)
    return {"ok": True, "count": len(items)}


@app.post("/api/worlds/{wid}/player")
def world_player(wid: str, state: PlayerState):
    world_or_404(wid)
    store.set_player(wid, state.model_dump())
    return {"ok": True}


# --- Multiplayer (WebSocket) -------------------------------------------------
# Each world has a "room" of connected clients. The server relays position
# updates and block edits between everyone in the same world, and persists the
# edits so they survive restarts. Designed for LAN play (a handful of players).
_rooms: dict[str, dict] = {}            # wid -> { websocket: state }
_pid_counter = itertools.count(1)


async def _broadcast(room: dict, sender, msg: dict):
    for ws in list(room.keys()):
        if ws is sender:
            continue
        try:
            await ws.send_json(msg)
        except Exception:
            pass


@app.websocket("/api/worlds/{wid}/ws")
async def world_ws(ws: WebSocket, wid: str):
    if not store.get(wid):
        await ws.close(code=4004)
        return
    await ws.accept()
    pid = next(_pid_counter)
    room = _rooms.setdefault(wid, {})
    state = {"id": pid, "name": f"Player{pid}", "pos": None}

    # Tell the newcomer who's already here, then add them to the room.
    existing = [{"id": s["id"], "name": s["name"], "pos": s["pos"]}
                for s in room.values() if s["pos"] is not None]
    await ws.send_json({"type": "welcome", "id": pid, "players": existing})
    room[ws] = state

    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("type")
            if t == "pos":
                state["pos"] = {k: msg.get(k, 0) for k in ("x", "y", "z", "yaw", "pitch")}
                await _broadcast(room, ws, {"type": "pos", "id": pid, **state["pos"]})
            elif t == "hello":
                state["name"] = str(msg.get("name") or state["name"])[:24]
                await _broadcast(room, ws, {"type": "join", "id": pid,
                                            "name": state["name"], "pos": state["pos"]})
            elif t == "edit":
                store.set_block(wid, msg["x"], msg["y"], msg["z"], msg["block"])
                await _broadcast(room, ws, {"type": "edit", "x": msg["x"], "y": msg["y"],
                                            "z": msg["z"], "block": msg["block"]})
            elif t == "edits":
                items = [(e["x"], e["y"], e["z"], e["block"]) for e in msg.get("edits", [])]
                store.set_blocks(wid, items)
                await _broadcast(room, ws, {"type": "edits", "edits": msg.get("edits", [])})
            elif t == "fx":
                # Ephemeral effect (explosion etc.) — relay only, no persistence.
                await _broadcast(room, ws, msg)
            elif t == "voice":
                # WebRTC signaling. Tag the sender; deliver to one peer if a
                # target id is given, otherwise to the whole room.
                out = {**msg, "from": pid}
                target = msg.get("to")
                if target is None:
                    await _broadcast(room, ws, out)
                else:
                    for w, st in list(room.items()):
                        if st["id"] == target:
                            try:
                                await w.send_json(out)
                            except Exception:
                                pass
                            break
    except (WebSocketDisconnect, KeyError, TypeError, ValueError):
        pass
    finally:
        room.pop(ws, None)
        await _broadcast(room, None, {"type": "leave", "id": pid})
        if not room:
            _rooms.pop(wid, None)


# --- Static front-end --------------------------------------------------------
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
