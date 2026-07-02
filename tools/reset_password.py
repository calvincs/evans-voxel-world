#!/usr/bin/env python3
"""
Reset a player's password — the "kid forgot it" rescue. Run on the machine
that hosts the game:

    tools/reset_password.py evan            # prompts for the new password
    tools/reset_password.py evan newpass    # or pass it directly

Tries the running server first (so the change takes effect immediately, no
restart needed). If the server isn't running, edits data/users.json directly.
"""

import getpass
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def try_server(username: str, password: str, port: str) -> tuple[bool, dict | None]:
    """(server_answered, response). Self-signed HTTPS first, then plain HTTP."""
    body = json.dumps({"username": username, "newPassword": password}).encode()
    insecure = ssl.create_default_context()
    insecure.check_hostname = False
    insecure.verify_mode = ssl.CERT_NONE          # it's our own self-signed cert
    for scheme, ctx in (("https", insecure), ("http", None)):
        url = f"{scheme}://127.0.0.1:{port}/api/admin/reset-password"
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=3, context=ctx) as r:
                return True, json.load(r)
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read().decode()).get("detail", str(e))
            except Exception:
                detail = str(e)
            return True, {"error": detail}
        except (urllib.error.URLError, OSError, TimeoutError):
            continue                              # wrong scheme or server down
    return False, None


def direct(username: str, password: str) -> bool:
    from server.accounts import UserStore
    data_dir = os.environ.get("EVANS_DATA_DIR") or os.path.join(ROOT, "data")
    users_path = os.environ.get("EVANS_USERS_PATH") or os.path.join(data_dir, "users.json")
    if not os.path.exists(users_path):
        print(f"no accounts file at {users_path}", file=sys.stderr)
        return False
    store = UserStore(users_path)
    try:
        u = store.reset_password(username, password)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return False
    if not u:
        known = ", ".join(sorted(x["username"] for x in store.users.values())) or "(none)"
        print(f"no account named {username!r} — accounts: {known}", file=sys.stderr)
        return False
    print(f"password reset for {u['username']} (edited {users_path} directly).")
    print("NOTE: if the server is actually running somewhere, restart it — "
          "it keeps accounts in memory and could overwrite this change.")
    return True


def main():
    if len(sys.argv) not in (2, 3):
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)
    username = sys.argv[1]
    password = sys.argv[2] if len(sys.argv) == 3 else getpass.getpass("New password: ")
    port = os.environ.get("PORT", "8765")

    answered, resp = try_server(username, password, port)
    if answered:
        if resp and resp.get("ok"):
            print(f"password reset for {username} — live immediately, no restart needed.")
            sys.exit(0)
        print(f"server refused: {(resp or {}).get('error', 'unknown error')}", file=sys.stderr)
        sys.exit(1)
    print("server not reachable on this machine — editing the accounts file directly.")
    sys.exit(0 if direct(username, password) else 1)


if __name__ == "__main__":
    main()
