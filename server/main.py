"""
EvansGame — FastAPI server (multi-world, with accounts).

Players sign in (username + password); worlds are owned by their creator and can
be public or private. Everything under /api/worlds requires a session, and the
owner can rewind a world to an earlier snapshot (which boots everyone out until
the state is restored). Auth uses only the standard library — see accounts.py.

Run:  python -m uvicorn server.main:app --reload  (or ./run.sh)
"""

import os

import itertools

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import worldgen
from .accounts import UserStore, SessionStore, DEFAULT_COLORS
from .snapshots import SnapshotStore
from .storage import WorldStore, DEFAULT_SNAPSHOT_INTERVAL

# --- Paths -------------------------------------------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(ROOT, "static")
# Everything persistent lives under one data root, overridable so tests (and a
# second isolated instance) never touch the real worlds. Individual paths can
# still be overridden on their own for backwards compatibility.
DATA_DIR = os.environ.get("EVANS_DATA_DIR") or os.path.join(ROOT, "data")
WORLDS_DIR = os.environ.get("EVANS_WORLDS_DIR") or os.path.join(DATA_DIR, "worlds")
SNAP_DIR = os.environ.get("EVANS_SNAPSHOTS_DIR") or os.path.join(DATA_DIR, "snapshots")
USERS_PATH = os.environ.get("EVANS_USERS_PATH") or os.path.join(DATA_DIR, "users.json")
SESSIONS_PATH = os.environ.get("EVANS_SESSIONS_PATH") or os.path.join(DATA_DIR, "sessions.json")
LEGACY_PATH = os.environ.get("EVANS_LEGACY_PATH") or os.path.join(DATA_DIR, "world.json")
SNAP_INTERVAL = int(os.environ.get("EVANS_SNAPSHOT_INTERVAL", DEFAULT_SNAPSHOT_INTERVAL))

snapshots = SnapshotStore(SNAP_DIR)
store = WorldStore(WORLDS_DIR, legacy_path=LEGACY_PATH,
                   snapshots=snapshots, snapshot_interval=SNAP_INTERVAL,
                   chunk_x=worldgen.CHUNK_X, chunk_z=worldgen.CHUNK_Z)
users = UserStore(USERS_PATH)
sessions = SessionStore(SESSIONS_PATH)

COOKIE = "evans_session"
SESSION_TTL = 30 * 24 * 3600
GUEST_USERNAME = "guest"

# One generator per seed (deterministic, cheap to keep around).
_generators: dict[int, worldgen.WorldGenerator] = {}


def gen_for(seed: int) -> worldgen.WorldGenerator:
    g = _generators.get(seed)
    if g is None:
        g = worldgen.WorldGenerator(seed=seed)
        _generators[seed] = g
    return g


app = FastAPI(title="EvansGame")

# Compress responses for clients that accept it. Voxel chunk data and the
# vendored Three.js bundle are large and highly compressible; the 512-byte floor
# skips tiny JSON where framing overhead would dominate. (Already-compressed
# audio barely shrinks, but it's fetched once and the cost is negligible.)
app.add_middleware(GZipMiddleware, minimum_size=512)


# --- Auth helpers ------------------------------------------------------------
def current_user(request: Request) -> dict | None:
    uid = sessions.resolve(request.cookies.get(COOKIE))
    return users.get(uid) if uid else None


def require_user(request: Request) -> dict:
    u = current_user(request)
    if not u:
        raise HTTPException(401, "login required")
    return u


def _set_session_cookie(response: Response, request: Request, token: str):
    response.set_cookie(
        COOKIE, token, max_age=SESSION_TTL, httponly=True,
        samesite="lax", secure=(request.url.scheme == "https"), path="/")


def _visible(w: dict, uid: str | None) -> bool:
    """Can this user see / play this world?"""
    return w.get("public", True) or w.get("owner") == uid


def _is_owner(w: dict, uid: str | None) -> bool:
    return w.get("owner") is not None and w.get("owner") == uid


def _ensure_guest() -> dict:
    import secrets
    u = users.by_username(GUEST_USERNAME)
    if not u:
        u = users.create(GUEST_USERNAME, secrets.token_urlsafe(12), color=DEFAULT_COLORS[2])
    return u


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


class Visibility(BaseModel):
    public: bool


class Revert(BaseModel):
    snapshotId: str


class Register(BaseModel):
    username: str
    password: str
    color: int | None = None


class Login(BaseModel):
    username: str
    password: str


class Profile(BaseModel):
    name: str | None = None
    color: int | None = None
    newPassword: str | None = None


def world_or_404(wid: str) -> dict:
    w = store.get(wid)
    if not w:
        raise HTTPException(404, "world not found")
    return w


def access_or_error(request: Request, wid: str) -> tuple[dict, dict]:
    """Common gate for per-world play endpoints: must be logged in and able to see
    the world. Returns (user, world)."""
    u = require_user(request)
    w = world_or_404(wid)
    if not _visible(w, u["uid"]):
        raise HTTPException(403, "this world is private")
    return u, w


# --- Auth --------------------------------------------------------------------
@app.post("/api/auth/register")
def auth_register(body: Register, request: Request, response: Response):
    try:
        user = users.create(body.username, body.password, color=body.color)
    except ValueError as e:
        raise HTTPException(400, str(e))
    _set_session_cookie(response, request, sessions.new(user["uid"]))
    return {"user": UserStore.public(user)}


@app.post("/api/auth/login")
def auth_login(body: Login, request: Request, response: Response):
    user = users.verify(body.username, body.password)
    if not user:
        raise HTTPException(401, "wrong username or password")
    _set_session_cookie(response, request, sessions.new(user["uid"]))
    return {"user": UserStore.public(user)}


@app.post("/api/auth/guest")
def auth_guest(request: Request, response: Response):
    """Issue a session for a shared guest account — used by ?demo / kiosk mode so
    it can skip the login screen."""
    user = _ensure_guest()
    _set_session_cookie(response, request, sessions.new(user["uid"]))
    return {"user": UserStore.public(user)}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    sessions.drop(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/users")
def list_users():
    """Accounts available on the sign-in picker (no guest, no password data)."""
    return {"users": users.list_public(exclude={GUEST_USERNAME})}


@app.get("/api/me")
def whoami(request: Request):
    return {"user": UserStore.public(require_user(request))}


@app.post("/api/profile")
def update_profile(body: Profile, request: Request):
    u = require_user(request)
    try:
        updated = users.update_profile(u["uid"], name=body.name, color=body.color,
                                       new_password=body.newPassword)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"user": UserStore.public(updated)}


# --- World management --------------------------------------------------------
@app.get("/api/worlds")
def list_worlds(request: Request):
    u = require_user(request)
    return {"worlds": store.list_worlds(u["uid"])}


@app.post("/api/worlds")
def create_world(body: NewWorld, request: Request):
    u = require_user(request)
    w = store.create(body.name, owner=u["uid"], owner_name=u["name"])
    return {"world": store.summary(w, u["uid"])}


@app.post("/api/worlds/{wid}/rename")
def rename_world(wid: str, body: RenameWorld, request: Request):
    u = require_user(request)
    w = world_or_404(wid)
    if not _is_owner(w, u["uid"]):
        raise HTTPException(403, "only the owner can rename this world")
    store.rename(wid, body.name)
    return {"ok": True}


@app.post("/api/worlds/{wid}/claim")
def claim_world(wid: str, request: Request):
    u = require_user(request)
    w = world_or_404(wid)
    if w.get("owner") is not None:
        raise HTTPException(409, "world already claimed")
    store.set_owner(wid, u["uid"], u["name"])
    return {"ok": True}


@app.post("/api/worlds/{wid}/visibility")
def set_visibility(wid: str, body: Visibility, request: Request):
    u = require_user(request)
    w = world_or_404(wid)
    if not _is_owner(w, u["uid"]):
        raise HTTPException(403, "only the owner can change visibility")
    store.set_public(wid, body.public)
    return {"ok": True, "public": body.public}


@app.delete("/api/worlds/{wid}")
def delete_world(wid: str, request: Request):
    u = require_user(request)
    w = world_or_404(wid)
    if not _is_owner(w, u["uid"]):
        raise HTTPException(403, "only the owner can delete this world")
    store.delete(wid)
    return {"ok": True}


# --- Snapshots / revert ------------------------------------------------------
@app.get("/api/worlds/{wid}/snapshots")
def list_snapshots(wid: str, request: Request):
    u, w = access_or_error(request, wid)
    return {"snapshots": snapshots.list(wid), "canRevert": _is_owner(w, u["uid"])}


@app.post("/api/worlds/{wid}/revert")
async def revert_world(wid: str, body: Revert, request: Request):
    u = require_user(request)
    w = world_or_404(wid)
    if not _is_owner(w, u["uid"]):
        raise HTTPException(403, "only the owner can rewind this world")
    snap = snapshots.get(wid, body.snapshotId)
    if not snap:
        raise HTTPException(404, "snapshot not found")
    _reverting.add(wid)
    try:
        store.snapshot_now(wid, label="before rewind")     # so a rewind is undoable
        store.apply_state(wid, snap["edits"], snap.get("player"))
        await _kick_room(wid)                               # boot everyone out
    finally:
        _reverting.discard(wid)
    return {"ok": True}


# --- Per-world play ----------------------------------------------------------
@app.get("/api/worlds/{wid}/config")
def world_config(wid: str, request: Request):
    u, w = access_or_error(request, wid)
    spawn_h = gen_for(w["seed"]).height_at(0, 0)
    store.touch(wid)
    return {
        "id": w["id"],
        "name": w["name"],
        "seed": w["seed"],
        "owner": w.get("owner"),
        "ownerName": w.get("ownerName", ""),
        "public": w.get("public", True),
        "mine": _is_owner(w, u["uid"]),
        "chunkX": worldgen.CHUNK_X,
        "chunkZ": worldgen.CHUNK_Z,
        "worldY": worldgen.WORLD_Y,
        "waterLevel": worldgen.WATER_LEVEL,
        "spawn": {"x": 0.5, "y": spawn_h + 3, "z": 0.5},
        "player": w.get("player"),
    }


@app.get("/api/worlds/{wid}/chunk/{cx}/{cz}")
def world_chunk(wid: str, cx: int, cz: int, request: Request):
    _, w = access_or_error(request, wid)
    blocks = gen_for(w["seed"]).generate_chunk(cx, cz)
    edits = store.edits_in_chunk(
        wid, cx, cz, worldgen.CHUNK_X, worldgen.CHUNK_Z, worldgen.WORLD_Y)
    for (lx, y, lz), block in edits.items():
        blocks[lx + worldgen.CHUNK_X * (lz + worldgen.CHUNK_Z * y)] = block
    # Raw block bytes (CHUNK_X*CHUNK_Z*WORLD_Y, row-major by the shared index).
    # No base64/JSON: smaller, and the client reads it straight into a Uint8Array
    # instead of decoding char-by-char. GZipMiddleware still compresses it.
    return Response(content=bytes(blocks), media_type="application/octet-stream")


@app.post("/api/worlds/{wid}/edit")
def world_edit(wid: str, edit: Edit, request: Request):
    access_or_error(request, wid)
    if not (0 <= edit.y < worldgen.WORLD_Y):
        raise HTTPException(400, "y out of range")
    if not (0 <= edit.block < 256):
        raise HTTPException(400, "bad block id")
    store.set_block(wid, edit.x, edit.y, edit.z, edit.block)
    return {"ok": True}


@app.post("/api/worlds/{wid}/edits")
def world_edits(wid: str, payload: Edits, request: Request):
    access_or_error(request, wid)
    items = [(e.x, e.y, e.z, e.block) for e in payload.edits
             if 0 <= e.y < worldgen.WORLD_Y and 0 <= e.block < 256]
    store.set_blocks(wid, items)
    return {"ok": True, "count": len(items)}


@app.post("/api/worlds/{wid}/player")
def world_player(wid: str, state: PlayerState, request: Request):
    access_or_error(request, wid)
    store.set_player(wid, state.model_dump())
    return {"ok": True}


# --- Multiplayer (WebSocket) -------------------------------------------------
# Each world has a "room" of connected clients. The server relays position
# updates and block edits between everyone in the same world, and persists the
# edits so they survive restarts. Designed for LAN play (a handful of players).
_rooms: dict[str, dict] = {}            # wid -> { websocket: state }
_reverting: set[str] = set()            # worlds mid-rewind (reject joins briefly)
_pid_counter = itertools.count(1)


async def _broadcast(room: dict, sender, msg: dict):
    for ws in list(room.keys()):
        if ws is sender:
            continue
        try:
            await ws.send_json(msg)
        except Exception:
            pass


async def _kick_room(wid: str):
    """Force every client in a world back to the menu (used by revert)."""
    room = _rooms.get(wid) or {}
    for ws in list(room.keys()):
        try:
            await ws.send_json({"type": "reverted"})
        except Exception:
            pass
        try:
            await ws.close(code=4005)
        except Exception:
            pass
    _rooms.pop(wid, None)


@app.websocket("/api/worlds/{wid}/ws")
async def world_ws(ws: WebSocket, wid: str):
    # Authenticate from the session cookie (WebSockets send cookies too).
    uid = sessions.resolve(ws.cookies.get(COOKIE))
    user = users.get(uid) if uid else None
    if not user:
        await ws.close(code=4401)                # not logged in
        return
    w = store.get(wid)
    if not w:
        await ws.close(code=4004)                # no such world
        return
    if not _visible(w, uid):
        await ws.close(code=4403)                # private world, not yours
        return
    if wid in _reverting:
        await ws.close(code=4005)                # world is being restored
        return

    await ws.accept()
    pid = next(_pid_counter)
    room = _rooms.setdefault(wid, {})
    color = user.get("color", DEFAULT_COLORS[0])
    state = {"id": pid, "name": user["name"], "color": color, "pos": None}

    # Tell the newcomer who's already here, then add them to the room.
    existing = [{"id": s["id"], "name": s["name"], "color": s.get("color"), "pos": s["pos"]}
                for s in room.values() if s["pos"] is not None]
    await ws.send_json({"type": "welcome", "id": pid, "color": color, "players": existing})
    room[ws] = state

    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("type")
            if t == "pos":
                state["pos"] = {k: msg.get(k, 0) for k in ("x", "y", "z", "yaw", "pitch")}
                await _broadcast(room, ws, {"type": "pos", "id": pid, **state["pos"]})
            elif t == "hello":
                # Identity is server-authoritative now; just announce the join.
                await _broadcast(room, ws, {"type": "join", "id": pid, "name": state["name"],
                                            "color": state["color"], "pos": state["pos"]})
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
                    for w2, st in list(room.items()):
                        if st["id"] == target:
                            try:
                                await w2.send_json(out)
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
            # Last player left — flush any write-behind edits to disk, then
            # capture the session's final state (unless we got here because of a
            # revert, which already just snapshotted).
            store.flush(wid)
            if wid not in _reverting:
                store.snapshot_now(wid, label="session end")


# --- Health / assets ---------------------------------------------------------
@app.get("/api/health")
def health():
    """Cheap liveness check the client polls to detect disconnection."""
    return {"ok": True}


@app.get("/api/assets")
def assets():
    """Which optional override files actually exist, so the client only requests
    those (instead of probing and logging 404s for the built-in fallbacks)."""
    textures = []
    tex_dir = os.path.join(STATIC_DIR, "textures")
    if os.path.isdir(tex_dir):
        textures = [f[:-4] for f in os.listdir(tex_dir) if f.lower().endswith(".png")]
    audio = {}
    aud_dir = os.path.join(STATIC_DIR, "audio")
    if os.path.isdir(aud_dir):
        for f in os.listdir(aud_dir):
            base, ext = os.path.splitext(f)
            ext = ext.lower().lstrip(".")
            if ext in ("mp3", "ogg", "wav") and base not in audio:
                audio[base] = ext
    return {"textures": textures, "audio": audio}


# --- Static front-end --------------------------------------------------------
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
