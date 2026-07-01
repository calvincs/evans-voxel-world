# Third-party components

Evan's Voxel World is licensed under the MIT License (see `LICENSE`). It
bundles or depends on the following third-party components, each under its own
license. All are permissively licensed and free to redistribute.

## Bundled in this repository

| Component | Location | License | Notes |
|-----------|----------|---------|-------|
| **Three.js** (r160) | `static/js/vendor/three.module.js` | MIT — Copyright © 2010–2023 Three.js Authors | WebGL rendering library. License header retained in the file. https://github.com/mrdoob/three.js |
| **Game audio** | `static/audio/*.ogg` | **CC0 1.0 (public domain)** | Break / place / step / music sound effects from OpenGameArt.org. No attribution required; sources credited in `static/audio/CREDITS.md`. |
| **Textures** (`banner.png`, block tiles) | `static/textures/`, generated | Author's own | Procedurally drawn and/or AI-generated for this project. |

## Python dependencies (installed via `requirements.txt`, not bundled)

| Package | License |
|---------|---------|
| **FastAPI** | MIT |
| **uvicorn** | BSD-3-Clause |

---

This game is an independent, from-scratch voxel sandbox. It is not affiliated
with, endorsed by, or derived from Minecraft, Mojang, or Microsoft, and
contains none of their code or assets.
