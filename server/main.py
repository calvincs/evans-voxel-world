"""
EvansGame — FastAPI server (multi-world, with accounts).

Players sign in (username + password); worlds are owned by their creator and can
be public or private. Everything under /api/worlds requires a session, and the
owner can rewind a world to an earlier snapshot (which boots everyone out until
the state is restored). Auth uses only the standard library — see accounts.py.

Run:  python -m uvicorn server.main:app --reload  (or ./run.sh)
"""

import asyncio
import itertools
import logging
import math
import os
import time

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

log = logging.getLogger("uvicorn.error")

from . import creatures, worldgen
from .accounts import UserStore, SessionStore, DEFAULT_COLORS
from .creatures import WorldSim, daylight_now
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
try:
    SNAP_INTERVAL = int(os.environ.get("EVANS_SNAPSHOT_INTERVAL", DEFAULT_SNAPSHOT_INTERVAL))
except ValueError:
    SNAP_INTERVAL = DEFAULT_SNAPSHOT_INTERVAL

snapshots = SnapshotStore(SNAP_DIR)
store = WorldStore(WORLDS_DIR, legacy_path=LEGACY_PATH,
                   snapshots=snapshots, snapshot_interval=SNAP_INTERVAL,
                   chunk_x=worldgen.CHUNK_X, chunk_z=worldgen.CHUNK_Z)
# Startup housekeeping: clear torn .tmp writes, apply retention to idle worlds,
# and report orphaned snapshot dirs (never auto-deleted).
snapshots.sweep({fn[:-5] for fn in os.listdir(WORLDS_DIR) if fn.endswith(".json")})
users = UserStore(USERS_PATH)
sessions = SessionStore(SESSIONS_PATH)

COOKIE = "evans_session"
SESSION_TTL = 30 * 24 * 3600
GUEST_USERNAME = "guest"

# One generator per (seed, village) pair — deterministic, cheap to keep around.
# Worlds created before villages existed carry no flag and keep their exact
# original terrain; new worlds generate with a village stamped in.
_generators: dict[tuple, worldgen.WorldGenerator] = {}


def gen_for(seed: int, village: bool = False) -> worldgen.WorldGenerator:
    key = (seed, bool(village))
    g = _generators.get(key)
    if g is None:
        g = worldgen.WorldGenerator(seed=seed, village=bool(village))
        _generators[key] = g
    return g


def gen_for_world(w: dict) -> worldgen.WorldGenerator:
    return gen_for(w["seed"], w.get("village", False))


app = FastAPI(title="EvansGame")

# Compress responses for clients that accept it. Voxel chunk data and the
# vendored Three.js bundle are large and highly compressible; the 512-byte floor
# skips tiny JSON where framing overhead would dominate. (Already-compressed
# audio barely shrinks, but it's fetched once and the cost is negligible.)
app.add_middleware(GZipMiddleware, minimum_size=512)


@app.exception_handler(RequestValidationError)
async def _validation_error(request: Request, exc: RequestValidationError):
    """FastAPI's default 422 echoes the invalid input back — which crashes JSON
    rendering when that input is NaN/Infinity. Return a compact body instead."""
    errors = [{"loc": e.get("loc"), "msg": e.get("msg"), "type": e.get("type")}
              for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": errors})


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
        try:
            u = users.create(GUEST_USERNAME, secrets.token_urlsafe(12), color=DEFAULT_COLORS[2])
        except ValueError:
            # Two first-time kiosk tabs raced to create the account; use the winner's.
            u = users.by_username(GUEST_USERNAME)
    return u


# --- Models / validation -------------------------------------------------------
MAX_COORD = 10_000_000        # sanity bound for block coordinates
MAX_EDIT_BATCH = 4096         # matches the client's flood-fill cap


def _int_in(v, lo, hi) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _valid_edit(x, y, z, block) -> bool:
    """One gate for every edit path. WS messages bypass pydantic, and a bad value
    that reaches the persisted edits map can poison the world file (bytearray
    range errors / unparseable index keys) — so nothing is stored unchecked."""
    return (_int_in(x, -MAX_COORD, MAX_COORD) and _int_in(z, -MAX_COORD, MAX_COORD)
            and _int_in(y, 0, worldgen.WORLD_Y - 1) and _int_in(block, 0, 255))


class Edit(BaseModel):
    x: int
    y: int
    z: int
    block: int


class Edits(BaseModel):
    edits: list[Edit]


class PlayerState(BaseModel):
    # NaN/inf must never be persisted: Starlette renders JSON with
    # allow_nan=False, so one bad float makes /config 500 until overwritten.
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)
    yaw: float = Field(default=0.0, allow_inf_nan=False)
    pitch: float = Field(default=0.0, allow_inf_nan=False)
    selected: int = 0
    hotbar: list[int] | None = Field(default=None, max_length=16)


class NewWorld(BaseModel):
    name: str = "New World"


class RenameWorld(BaseModel):
    name: str


class Visibility(BaseModel):
    public: bool


class Peaceful(BaseModel):
    peaceful: bool


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


class AdminReset(BaseModel):
    username: str
    newPassword: str


class Wildlife(BaseModel):
    on: bool
    clear: bool = False


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


@app.post("/api/admin/reset-password")
def admin_reset_password(body: AdminReset, request: Request):
    """Parent rescue for a forgotten password. Only accepted from the machine
    the server runs on — a kid's tablet can never reach it. Use
    tools/reset_password.py, which calls this (or edits the file directly when
    the server is down)."""
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "localhost only")
    try:
        u = users.reset_password(body.username, body.newPassword)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not u:
        raise HTTPException(404, "no such user")
    log.warning("admin: password reset for %r from localhost", body.username)
    return {"ok": True, "user": UserStore.public(u)}


@app.post("/api/admin/wildlife")
def admin_wildlife(body: Wildlife, request: Request):
    """Pause/resume automatic wild-creature spawning (placed creatures always
    keep living). Localhost only — used by the headless tests, and available
    as a parent switch. `clear` also removes the wild creatures alive now."""
    global _wildlife
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "localhost only")
    _wildlife = body.on
    if body.clear:
        for sim in _sims.values():
            sim.clear_wild()
    return {"ok": True, "wildlife": _wildlife}


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


@app.post("/api/worlds/{wid}/peaceful")
async def set_peaceful(wid: str, body: Peaceful, request: Request):
    u = require_user(request)
    w = world_or_404(wid)
    if not _is_owner(w, u["uid"]):
        raise HTTPException(403, "only the owner can change this")
    await asyncio.to_thread(store.set_peaceful, wid, body.peaceful)
    # Everyone in the world shares the same rules, live — most importantly the
    # sim owner, whose client is the one actually running the creatures.
    room = _rooms.get(wid)
    if room:
        await _broadcast(room, None, {"type": "peaceful", "on": body.peaceful})
    return {"ok": True, "peaceful": body.peaceful}


@app.delete("/api/worlds/{wid}")
def delete_world(wid: str, request: Request):
    u = require_user(request)
    w = world_or_404(wid)
    if not _is_owner(w, u["uid"]):
        raise HTTPException(403, "only the owner can delete this world")
    _sims.pop(wid, None)
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
    snap = await asyncio.to_thread(snapshots.get, wid, body.snapshotId)
    if not snap or "edits" not in snap:
        raise HTTPException(404, "snapshot not found")
    _reverting.add(wid)
    # Drop the live sim WITHOUT a checkpoint — its creature state is about to
    # be replaced by the snapshot's; the next join rebuilds from the restored
    # world file.
    _sims.pop(wid, None)
    try:
        # Both store calls hit the disk; keep them off the event loop.
        await asyncio.to_thread(store.snapshot_now, wid, label="before rewind")  # so a rewind is undoable
        await asyncio.to_thread(store.apply_state, wid, snap["edits"], snap.get("player"),
                                snap.get("mines"), snap.get("creatures"))
        await _kick_room(wid)                               # boot everyone out
    finally:
        _reverting.discard(wid)
    return {"ok": True}


# --- Per-world play ----------------------------------------------------------
_spawns: dict[tuple, dict] = {}    # (seed, village) -> spawn point (deterministic)


def _spawn_for(w: dict) -> dict:
    """Spawn on dry land near the origin. An unlucky seed puts (0,0) under the
    ocean, which strands a brand-new player on the seabed. Uses the effective
    surface (village levelling and rooftops included) so nobody spawns inside
    a building."""
    key = (w["seed"], bool(w.get("village", False)))
    spawn = _spawns.get(key)
    if spawn is None:
        gen = gen_for_world(w)
        x = z = 0
        h = gen.surface_at(0, 0)
        if h <= worldgen.WATER_LEVEL:
            for r in range(4, 129, 4):           # spiral outward in 8 directions
                cands = [(r, 0), (-r, 0), (0, r), (0, -r), (r, r), (-r, r), (r, -r), (-r, -r)]
                dry = next(((cx, cz, gen.surface_at(cx, cz)) for cx, cz in cands
                            if gen.surface_at(cx, cz) > worldgen.WATER_LEVEL), None)
                if dry:
                    x, z, h = dry
                    break
        spawn = _spawns[key] = {"x": x + 0.5, "y": h + 3, "z": z + 0.5}
    return spawn


@app.get("/api/worlds/{wid}/config")
def world_config(wid: str, request: Request):
    u, w = access_or_error(request, wid)
    store.touch(wid)
    return {
        "id": w["id"],
        "name": w["name"],
        "seed": w["seed"],
        "owner": w.get("owner"),
        "ownerName": w.get("ownerName", ""),
        "public": w.get("public", True),
        "peaceful": w.get("peaceful", False),
        "mine": _is_owner(w, u["uid"]),
        "chunkX": worldgen.CHUNK_X,
        "chunkZ": worldgen.CHUNK_Z,
        "worldY": worldgen.WORLD_Y,
        "waterLevel": worldgen.WATER_LEVEL,
        "spawn": _spawn_for(w),
        # Where the village is (or null) — the client spawns villagers there.
        "village": gen_for_world(w).village_info(),
        # Armed-mine ownership {"x,y,z": playerName}: sensors never fire on a
        # mine's owner, and this survives reloads and adoption by other clients.
        "mines": w.get("mines", {}),
        # Placed (egg-hatched) creatures {cid: {t, x, y, z, hp}} — the room's
        # sim owner brings them to life; everyone sees the same ones.
        "creatures": w.get("creatures", {}),
        "player": w.get("player"),
        # Server wall clock: clients derive the day/night phase from this so
        # everyone in a world shares the same night (and the same spiders).
        "serverNow": time.time(),
    }


@app.get("/api/worlds/{wid}/chunk/{cx}/{cz}")
def world_chunk(wid: str, cx: int, cz: int, request: Request):
    _, w = access_or_error(request, wid)
    blocks = gen_for_world(w).generate_chunk(cx, cz)
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
    if wid in _reverting:                # same gate the WS edit path has
        raise HTTPException(409, "world is being rewound")
    if not _valid_edit(edit.x, edit.y, edit.z, edit.block):
        raise HTTPException(400, "bad edit")
    store.set_block(wid, edit.x, edit.y, edit.z, edit.block)
    sim = _sims.get(wid)
    if sim:
        sim.view.invalidate(edit.x, edit.z)
    return {"ok": True}


@app.post("/api/worlds/{wid}/edits")
def world_edits(wid: str, payload: Edits, request: Request):
    u, _ = access_or_error(request, wid)
    if wid in _reverting:
        raise HTTPException(409, "world is being rewound")
    items = [(e.x, e.y, e.z, e.block) for e in payload.edits[:MAX_EDIT_BATCH]
             if _valid_edit(e.x, e.y, e.z, e.block)]
    store.set_blocks(wid, items, u["name"])
    sim = _sims.get(wid)
    if sim:
        for (x, _, z, _b) in items:
            sim.view.invalidate(x, z)
    return {"ok": True, "count": len(items)}


@app.post("/api/worlds/{wid}/player")
def world_player(wid: str, state: PlayerState, request: Request):
    access_or_error(request, wid)
    if wid in _reverting:
        raise HTTPException(409, "world is being rewound")
    store.set_player(wid, state.model_dump())
    return {"ok": True}


# --- Multiplayer (WebSocket) -------------------------------------------------
# Each world has a "room" of connected clients. The server relays position
# updates and block edits between everyone in the same world, and persists the
# edits so they survive restarts. Designed for LAN play (a handful of players).
_rooms: dict[str, dict] = {}            # wid -> { websocket: state }
_reverting: set[str] = set()            # worlds mid-rewind (reject joins briefly)
_pid_counter = itertools.count(1)

# --- Creature simulation ---------------------------------------------------------
# The SERVER runs every creature's brain (server/creatures.py) and streams
# ~10 Hz snapshots to each world's room — all players see the same animals in
# the same places, nothing depends on any client's tab being visible, and
# egg-hatched creatures persist in the world file. Clients only render, and
# send back "I hit creature X" / "hatch an egg here".
MOB_TYPES = set(creatures.TYPES)
MAX_CREATURES = 64          # persisted per world
SIM_TICK = 0.1              # seconds per simulation step (10 Hz)
SIM_CHECKPOINT = 5.0        # seconds between persistent-position checkpoints
_sims: dict[str, WorldSim] = {}
# Automatic wild spawning on/off (placed creatures always live). Toggled by
# the localhost-only admin endpoint — used by the headless tests, and handy
# as a parent switch.
_wildlife = os.environ.get("EVANS_WILDLIFE", "1") != "0"


def _sim_for(w: dict) -> WorldSim:
    sim = _sims.get(w["id"])
    if sim is None:
        gen = gen_for_world(w)
        sim = WorldSim(store, gen, w["id"], village=gen.village_info())
        sim.load_persistent(w.get("creatures"))
        _sims[w["id"]] = sim
    return sim


async def _sim_loop():
    """One shared 10 Hz loop advancing every world that has (or just had)
    players. Sims retire — after a final checkpoint — when their room empties.
    All the store calls here only mutate in-memory state and mark the world
    dirty; the write-behind flusher owns the disk."""
    last_cp = time.monotonic()
    while True:
        t0 = time.monotonic()
        try:
            daylight = daylight_now()
            do_cp = t0 - last_cp >= SIM_CHECKPOINT
            if do_cp:
                last_cp = t0
            for wid in list(_sims.keys()):
                room = _rooms.get(wid)
                if not room:
                    sim = _sims.pop(wid)
                    sim.checkpoint()                 # park it exactly as-is
                    continue
                if wid in _reverting:
                    continue
                w = store.get(wid)
                if w is None:                        # world deleted mid-play
                    _sims.pop(wid, None)
                    continue
                sim = _sims[wid]
                players = [{"pid": st["id"], "x": st["pos"]["x"],
                            "y": st["pos"]["y"], "z": st["pos"]["z"]}
                           for st in room.values() if st["pos"]]
                ev = sim.tick(SIM_TICK, players, bool(w.get("peaceful")), daylight,
                              wildlife=_wildlife)
                await _broadcast(room, None, {"type": "mobs", "m": ev["snapshot"]})
                for (x, y, z, kind) in ev["deaths"]:
                    await _broadcast(room, None,
                                     {"type": "mobdie", "x": x, "y": y, "z": z, "t": kind})
                for (pid, amount, x, z, kind) in ev["bites"]:
                    for ws2, st in list(room.items()):
                        if st["id"] == pid:
                            await _send_safe(ws2, {"type": "mobbite", "amount": amount,
                                                   "x": x, "z": z, "source": kind})
                            break
                if do_cp:
                    sim.checkpoint()
        except Exception:
            log.exception("creature sim loop error (continuing)")
        await asyncio.sleep(max(0.02, SIM_TICK - (time.monotonic() - t0)))


@app.on_event("startup")
async def _start_sim():
    asyncio.create_task(_sim_loop())


def _valid_creature(rec) -> dict | None:
    """Sanitize one client-supplied creature record; None if hopeless."""
    if not isinstance(rec, dict) or rec.get("t") not in MOB_TYPES:
        return None
    coords = [rec.get(k) for k in ("x", "y", "z")]
    if not all(_finite(v) for v in coords):
        return None
    x, y, z = (float(v) for v in coords)
    if not (-MAX_COORD <= x <= MAX_COORD and -MAX_COORD <= z <= MAX_COORD
            and 0 <= y <= worldgen.WORLD_Y):
        return None
    hp = rec.get("hp")
    hp = int(hp) if isinstance(hp, (int, float)) and math.isfinite(hp) else 1
    return {"t": rec["t"], "x": round(x, 2), "y": round(y, 2), "z": round(z, 2),
            "hp": max(1, min(99, hp))}


async def _send_safe(ws, msg: dict, timeout: float = 2.0):
    """Send with a timeout so one stalled client (a tablet that went to sleep
    with the socket open) can't hold up the room. On failure the socket is
    closed; its handler then cleans up through the normal disconnect path."""
    try:
        await asyncio.wait_for(ws.send_json(msg), timeout)
    except Exception:
        try:
            await asyncio.wait_for(ws.close(), 1.0)
        except Exception:
            pass


async def _broadcast(room: dict, sender, msg: dict):
    targets = [ws for ws in list(room.keys()) if ws is not sender]
    if targets:
        await asyncio.gather(*(_send_safe(ws, msg) for ws in targets))


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

    # Tell the newcomer who's already here, then add them to the room. Joining
    # also wakes the world's creature simulation (it idles when nobody's in).
    existing = [{"id": s["id"], "name": s["name"], "color": s.get("color"), "pos": s["pos"]}
                for s in room.values() if s["pos"] is not None]
    await ws.send_json({"type": "welcome", "id": pid, "color": color, "players": existing})
    room[ws] = state
    _sim_for(w)

    POS_KEYS = ("x", "y", "z", "yaw", "pitch")
    FX_KINDS = ("explode", "ignite")
    FX_WINDOW, FX_MAX = 10.0, 40       # per-client effect rate limit
    fx_t0, fx_n = 0.0, 0

    try:
        while True:
            try:
                msg = await ws.receive_json()
            except (ValueError, KeyError):
                continue                            # malformed frame — ignore it
            if not isinstance(msg, dict):
                continue
            t = msg.get("type")
            if t == "pos":
                vals = [msg.get(k, 0) for k in POS_KEYS]
                if all(_finite(v) for v in vals):   # never relay NaN positions
                    state["pos"] = dict(zip(POS_KEYS, (float(v) for v in vals)))
                    await _broadcast(room, ws, {"type": "pos", "id": pid, **state["pos"]})
            elif t == "hello":
                # Identity is server-authoritative now; just announce the join.
                await _broadcast(room, ws, {"type": "join", "id": pid, "name": state["name"],
                                            "color": state["color"], "pos": state["pos"]})
            elif t == "edit":
                x, y, z, block = (msg.get(k) for k in ("x", "y", "z", "block"))
                if _valid_edit(x, y, z, block) and wid not in _reverting:
                    await asyncio.to_thread(store.set_block, wid, x, y, z, block,
                                            user["name"])
                    sim = _sims.get(wid)
                    if sim:
                        sim.view.invalidate(x, z)     # creatures see the new block
                    out = {"type": "edit", "x": x, "y": y, "z": z, "block": block}
                    # Arming a mine stamps the owner so every client's sensor
                    # knows who it must never fire on.
                    if block in store.PROX_ARMED:
                        out["owner"] = user["name"]
                    await _broadcast(room, ws, out)
            elif t == "edits":
                raw = msg.get("edits")
                items = []
                for e in (raw if isinstance(raw, list) else [])[:MAX_EDIT_BATCH]:
                    if isinstance(e, dict) and _valid_edit(e.get("x"), e.get("y"),
                                                           e.get("z"), e.get("block")):
                        items.append((e["x"], e["y"], e["z"], e["block"]))
                if items and wid not in _reverting:
                    await asyncio.to_thread(store.set_blocks, wid, items, user["name"])
                    sim = _sims.get(wid)
                    if sim:
                        for (x2, _, z2, _b) in items:
                            sim.view.invalidate(x2, z2)
                    await _broadcast(room, ws, {"type": "edits", "edits": [
                        {"x": x, "y": y, "z": z, "block": b} for (x, y, z, b) in items]})
            elif t == "fx":
                # Ephemeral effect — relay only, no persistence. Rebuilt rather
                # than forwarded verbatim, and rate-limited: receiving clients
                # apply real blast damage from "explode".
                now = time.monotonic()
                if now - fx_t0 > FX_WINDOW:
                    fx_t0, fx_n = now, 0
                fx_n += 1
                coords = [msg.get(k) for k in ("x", "y", "z")]
                if (fx_n <= FX_MAX and msg.get("kind") in FX_KINDS
                        and all(_finite(v) for v in coords)):
                    await _broadcast(room, ws, {
                        "type": "fx", "kind": msg["kind"],
                        "x": float(coords[0]), "y": float(coords[1]), "z": float(coords[2])})
                    # Explosions kill creatures server-side — the sim is the
                    # single truth, whoever's client lit the fuse.
                    if msg["kind"] == "explode":
                        sim = _sims.get(wid)
                        if sim:
                            sim.blast_kill(float(coords[0]), float(coords[1]),
                                           float(coords[2]))
            elif t == "mobhatch":
                # A spawn egg was used: the server's sim brings the creature to
                # life (next snapshot shows it to everyone) and persists it.
                rec = _valid_creature(msg)
                w2 = store.get(wid)
                if rec and w2 is not None and len(w2.get("creatures", {})) < MAX_CREATURES:
                    import secrets as _s
                    cid = "c" + _s.token_hex(4)
                    if _sim_for(w2).hatch(cid, rec["t"], rec["x"], rec["y"], rec["z"]):
                        store.add_creature(wid, cid, rec)
            elif t == "mobhit":
                # A player swung at a creature — the sim applies the damage.
                i, dmg = msg.get("i"), msg.get("dmg")
                if (isinstance(i, str) and 0 < len(i) <= 24 and _finite(dmg)
                        and _finite(msg.get("dx", 0)) and _finite(msg.get("dz", 0))):
                    sim = _sims.get(wid)
                    if sim:
                        sim.hurt(i, max(1, min(4, int(dmg))),
                                 max(-1.0, min(1.0, float(msg.get("dx", 0)))),
                                 max(-1.0, min(1.0, float(msg.get("dz", 0)))))
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
                            await _send_safe(w2, out)
                            break
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("world_ws: unexpected error (player %s, world %s)", pid, wid)
    finally:
        room.pop(ws, None)
        await _broadcast(room, None, {"type": "leave", "id": pid})
        # Only tear the room down if it's still *this* room: after a revert
        # kick, a fresh room may already live under the same wid, and popping
        # that one would strand its players in an orphaned room.
        if not room and _rooms.get(wid) is room:
            _rooms.pop(wid, None)
            # Last player left — flush any write-behind edits to disk, then
            # capture the session's final state (unless we got here because of
            # a revert, which already just snapshotted). Both touch the disk,
            # so keep them off the event loop.
            await asyncio.to_thread(store.flush, wid)
            if wid not in _reverting:
                await asyncio.to_thread(store.snapshot_now, wid, label="session end")


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
