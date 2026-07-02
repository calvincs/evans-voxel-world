"""
User accounts + sessions (standard-library only — no extra dependencies).

Two small JSON stores, mirroring WorldStore's atomic-write style:

    users.json     { uid: {uid, username, name, color, pw_hash, pw_salt, created} }
    sessions.json  { token: {uid, created, expires} }

Passwords are hashed with PBKDF2-HMAC-SHA256 (a fresh random salt per user);
sessions are opaque random tokens with a long TTL and are persisted so a long
play session — or a server restart — doesn't log anyone out. Nothing here ever
edits a user other than the one identified by the caller's session, which is the
"a password prevents others from editing your profile" guarantee.
"""

import hashlib
import hmac
import json
import os
import random
import secrets
import threading
import time

_PBKDF2_ROUNDS = 200_000
_SESSION_TTL = 30 * 24 * 3600          # 30 days
_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

# Default character shirt colours offered on sign-up (hex ints, matching the
# palette style in remoteplayers.js).
DEFAULT_COLORS = [
    0x3aa657, 0xff6b6b, 0x4db6ff, 0xffd24d,
    0xb084ff, 0x55d98a, 0xff9f40, 0xff7ad9,
]


def _now() -> int:
    return int(time.time())


def _hash_pw(password: str, salt: bytes) -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return dk.hex()


def _clamp_color(color) -> int:
    try:
        c = int(color)
    except (TypeError, ValueError):
        return DEFAULT_COLORS[0]
    return c & 0xFFFFFF


class UserStore:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self.users: dict[str, dict] = {}
        self._load()

    # --- persistence ----------------------------------------------------------
    def _load(self):
        if not os.path.exists(self.path):
            return
        try:
            os.chmod(self.path, 0o600)   # tighten files created before this rule
        except OSError:
            pass
        try:
            with open(self.path) as f:
                self.users = json.load(f)
        except (json.JSONDecodeError, OSError):
            self.users = {}

    def _write(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.users, f)
            f.flush()
            os.fsync(f.fileno())     # survive power loss, not just a crash
        os.chmod(tmp, 0o600)         # password hashes: owner-only, never 664
        os.replace(tmp, self.path)   # atomic on POSIX

    def _new_uid(self) -> str:
        for _ in range(1000):
            uid = "u_" + "".join(random.choice(_ID_ALPHABET) for _ in range(6))
            if uid not in self.users:
                return uid
        return "u_" + str(_now())

    # --- lookups --------------------------------------------------------------
    @staticmethod
    def public(u: dict) -> dict:
        """The safe, client-visible subset of a user record (no hashes)."""
        return {"uid": u["uid"], "username": u["username"],
                "name": u.get("name") or u["username"], "color": u.get("color", DEFAULT_COLORS[0])}

    def get(self, uid: str) -> dict | None:
        return self.users.get(uid)

    def list_public(self, exclude: set[str] | None = None) -> list[dict]:
        """Public info for every account (no hashes), for the sign-in picker.
        `exclude` is a set of usernames to omit (e.g. the shared guest account)."""
        skip = {u.lower() for u in (exclude or set())}
        out = [self.public(u) for u in self.users.values()
               if u["username"].lower() not in skip]
        out.sort(key=lambda u: u["name"].lower())
        return out

    def by_username(self, username: str) -> dict | None:
        key = (username or "").strip().lower()
        for u in self.users.values():
            if u["username"].lower() == key:
                return u
        return None

    # --- lifecycle ------------------------------------------------------------
    def create(self, username: str, password: str, color=None) -> dict:
        """Create a user. Raises ValueError on bad input or a taken username."""
        username = (username or "").strip()
        if not (2 <= len(username) <= 20):
            raise ValueError("Username must be 2–20 characters.")
        if not password or len(password) < 3:
            raise ValueError("Password must be at least 3 characters.")
        with self._lock:
            if self.by_username(username):
                raise ValueError("That username is already taken.")
            salt = secrets.token_bytes(16)
            user = {
                "uid": self._new_uid(),
                "username": username,
                "name": username,
                "color": _clamp_color(color if color is not None else DEFAULT_COLORS[0]),
                "pw_salt": salt.hex(),
                "pw_hash": _hash_pw(password, salt),
                "created": _now(),
            }
            self.users[user["uid"]] = user
            self._write()
        return user

    def verify(self, username: str, password: str) -> dict | None:
        u = self.by_username(username)
        if not u:
            return None
        salt = bytes.fromhex(u["pw_salt"])
        candidate = _hash_pw(password or "", salt)
        if hmac.compare_digest(candidate, u["pw_hash"]):
            return u
        return None

    def reset_password(self, username: str, new_password: str) -> dict | None:
        """Set a new password for an account by name, bypassing the old one —
        the parent-rescue path for "I forgot my password". Only reachable from
        the server machine itself (the localhost admin endpoint / CLI), never
        from the game UI."""
        if not new_password or len(new_password) < 3:
            raise ValueError("Password must be at least 3 characters.")
        with self._lock:
            u = self.by_username(username)
            if not u:
                return None
            salt = secrets.token_bytes(16)
            u["pw_salt"] = salt.hex()
            u["pw_hash"] = _hash_pw(new_password, salt)
            self._write()
        return u

    def update_profile(self, uid: str, name=None, color=None, new_password=None) -> dict | None:
        """Update the caller's own profile. Callers pass only the session uid, so
        one user can never edit another."""
        with self._lock:
            u = self.users.get(uid)
            if not u:
                return None
            if name is not None:
                nm = str(name).strip()[:20]
                if nm:
                    u["name"] = nm
            if color is not None:
                u["color"] = _clamp_color(color)
            if new_password:
                if len(new_password) < 3:
                    raise ValueError("Password must be at least 3 characters.")
                salt = secrets.token_bytes(16)
                u["pw_salt"] = salt.hex()
                u["pw_hash"] = _hash_pw(new_password, salt)
            self._write()
        return u


class SessionStore:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self.sessions: dict[str, dict] = {}
        self._load()

    def _load(self):
        if not os.path.exists(self.path):
            return
        try:
            os.chmod(self.path, 0o600)   # tighten files created before this rule
        except OSError:
            pass
        try:
            with open(self.path) as f:
                self.sessions = json.load(f)
        except (json.JSONDecodeError, OSError):
            self.sessions = {}
        self._purge_expired()

    def _write(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.sessions, f)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)         # session tokens: owner-only, never 664
        os.replace(tmp, self.path)

    def _purge_expired(self):
        now = _now()
        dead = [t for t, s in self.sessions.items() if s.get("expires", 0) <= now]
        for t in dead:
            self.sessions.pop(t, None)

    def new(self, uid: str) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self.sessions[token] = {"uid": uid, "created": _now(),
                                    "expires": _now() + _SESSION_TTL}
            self._write()
        return token

    def resolve(self, token: str | None) -> str | None:
        if not token:
            return None
        s = self.sessions.get(token)
        if not s:
            return None
        if s.get("expires", 0) <= _now():
            with self._lock:
                self.sessions.pop(token, None)
                self._write()
            return None
        return s["uid"]

    def drop(self, token: str | None):
        if not token:
            return
        with self._lock:
            if self.sessions.pop(token, None) is not None:
                self._write()
