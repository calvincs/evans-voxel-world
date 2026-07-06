# Hosting Guide

How to run the server for your household: LAN multiplayer, HTTPS, account
administration, backups, and running it as a service.

## Contents

- [Requirements](#requirements)
- [Starting the server](#starting-the-server)
- [Playing together (LAN multiplayer)](#playing-together-lan-multiplayer)
- [HTTPS & certificates](#https--certificates)
- [Accounts & data](#accounts--data)
- [Resetting a password](#resetting-a-password)
- [Backups](#backups)
- [Running on boot (systemd)](#running-on-boot-systemd)
- [Environment variables](#environment-variables)
- [Running a second instance](#running-a-second-instance)
- [Admin switches](#admin-switches)

## Requirements

- **Python 3.9+** with the `venv` module (Linux or macOS)
- **openssl** on the PATH for the automatic HTTPS certificate (optional — the
  game falls back to HTTP without it)
- A modern browser with WebGL for each player

Dependencies (FastAPI + uvicorn, pinned in `requirements.txt`) are installed
automatically into a local `.venv/` on first run — nothing is installed
globally.

## Starting the server

```bash
./run.sh
```

First launch creates the virtualenv, installs dependencies, and generates a
self-signed HTTPS certificate — takes a few seconds. After that it starts
instantly. The script prints the local and LAN URLs to open.

`./run.sh` passes extra arguments through to uvicorn, and honours `PORT`
(default `8765`).

## Playing together (LAN multiplayer)

Several people on the same Wi-Fi can share a world:

1. **One person hosts** — run `./run.sh`. It serves HTTPS on all interfaces
   (`0.0.0.0`).
2. Find the host's local IP (`hostname -I` on Linux, e.g. `192.168.1.14`) —
   `run.sh` prints it at startup.
3. Everyone else opens **`https://<host-ip>:8765`** in their browser (accept
   the one-time "not secure" warning — it's the host's own cert), signs in,
   and picks the **same world**.

You'll see each other's characters (with name tags) move around, a
who's-online list in the corner, and blocks placed/broken by anyone — with
**spatial sound** (you hear footsteps, breaking, and TNT booms louder when
they're closer). Edits are saved to the host's world file.

Playing over the *internet* (not just LAN) needs port-forwarding or a tunnel
on the host — that's a network setup step outside the game.

## HTTPS & certificates

HTTPS is **on by default** because the browser only allows microphone access
(voice chat) on secure pages. A self-signed certificate is generated
automatically on first run (`tools/make_cert.sh` → `certs/`); each device
accepts a one-time "not secure" warning.

- **Plain HTTP instead:** `EVANS_HTTP=1 ./run.sh` — voice chat will then only
  work on the host machine itself via `localhost`.
- **Your own certificate:** set `EVANS_SSL_CERT` and `EVANS_SSL_KEY` to the
  file paths.

`certs/` is gitignored — the private key never leaves the host machine.

## Accounts & data

Everything lives under `data/` (gitignored — it's your family's save data):

| Path | Contents |
|------|----------|
| `data/users.json` | accounts — passwords salted + hashed with PBKDF2, never plaintext |
| `data/sessions.json` | login session cookies |
| `data/worlds/<id>.json` | one file per world: name, seed, owner, visibility, player positions, and only the blocks players changed |
| `data/snapshots/<id>/` | per-world rewind history |

Terrain is regenerated deterministically from each world's seed, so a whole
world is reproduced exactly from that one small file.

## Resetting a password

On the machine that hosts the game, run:

```bash
tools/reset_password.py <username>
```

It resets the account live (or edits the file directly if the server is
down). The reset endpoint only accepts requests from the host machine itself,
never from the LAN.

## Backups

Snapshots protect against bad edits; backups protect against the disk dying.

`tools/backup.sh` tars `data/` (worlds, accounts, snapshots) into `backups/`
and keeps the newest 14. Add one cron line to make it nightly, and point
`EVANS_BACKUP_DIR` at another drive if you can:

```cron
0 3 * * * /path/to/EvansGame/tools/backup.sh
```

## Running on boot (systemd)

`tools/evansgame.service` is a systemd **user** unit that starts the game on
boot and restarts it after a crash — install instructions are inside the
file.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8765` | server port |
| `EVANS_HTTP` | unset | `1` = plain HTTP (no LAN voice chat) |
| `EVANS_SSL_CERT` / `EVANS_SSL_KEY` | `certs/cert.pem` / `certs/key.pem` | custom TLS certificate |
| `EVANS_DATA_DIR` | `data/` | root for **all** save data — use this to fully isolate an instance |
| `EVANS_WORLDS_DIR` | `<data>/worlds` | world files only (testing; see warning below) |
| `EVANS_USERS_PATH` / `EVANS_SESSIONS_PATH` | inside `<data>` | account / session files |
| `EVANS_SNAPSHOTS_DIR` | `<data>/snapshots` | snapshot history |
| `EVANS_SNAPSHOT_INTERVAL` | server default | seconds between automatic snapshots |
| `EVANS_WILDLIFE` | on | `0` = start with wild creature spawning paused |
| `EVANS_BACKUP_DIR` | `backups/` | where `tools/backup.sh` writes archives |

## Running a second instance

Point it at a completely separate data root:

```bash
EVANS_DATA_DIR=/some/other/dir PORT=8766 ./run.sh
```

so the two don't fight over the same files. **Don't** use `EVANS_WORLDS_DIR`
for this — it moves only the worlds, leaving accounts, sessions and snapshots
shared between the two instances.

## Admin switches

A localhost-only endpoint can pause wild creature spawning entirely — handy
for testing or a calmer world (spawn-egg creatures are unaffected):

```bash
curl -k -X POST https://localhost:8765/api/admin/wildlife \
  -H 'Content-Type: application/json' -d '{"on": false}'
```

Add `"clear": true` to also remove the wild creatures alive right now.

Like the password reset, it only accepts requests from the host machine.
