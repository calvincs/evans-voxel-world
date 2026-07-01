# Optimization notes

A running record of engine performance work — what's been done, and what's
deliberately left for later.

## Shipped

- **Vertex attribute quantization** (`static/js/engine/chunk.js`): chunk mesh
  position/normal/uv packed to ~10 bytes/vertex (was 32). ~69% less chunk
  geometry on both the JS heap and GPU VRAM.
- **Worldgen height-map reuse** (`server/worldgen.py`): each column's height is
  computed once per chunk instead of ~3x across the ground/tree/pumpkin passes.
- **Generated-chunk cache** (`server/worldgen.py`): bounded LRU of the pristine
  base terrain per `(cx, cz)`; terrain is deterministic so a hit is exact.
- **Gzip responses** (`server/main.py`): `GZipMiddleware`; a sample terrain
  chunk drops ~30x on the wire.
- **Binary chunk transfer** (`server/main.py`, `static/js/engine/world.js`): raw
  block bytes instead of base64-in-JSON — no JSON parse, no char-by-char decode.
- **Per-chunk edit index** (`server/storage.py`): `edits_in_chunk` touches only
  one chunk's edits instead of scanning the whole world on every chunk request.
- **Write-behind persistence** (`server/storage.py`): edits mark a world dirty
  and a background thread flushes at most once/second, instead of rewriting the
  whole world file on every block change. Lifecycle ops still write immediately;
  flush also runs at session end and process exit.
- **Mesher interior fast-path** (`static/js/engine/chunk.js`): in-chunk neighbour
  lookups read `this.data` directly; only the six chunk borders call
  `world.getBlock` (which builds a key string + hits a Map).
- **Coords HUD** (`static/js/main.js`): only rewrites the readout when it changes.
- **Adaptive pixel ratio** (`static/js/engine/renderer.js`): coarse-pointer
  (touch) devices cap at 1.5x; desktop stays 2x.

## Deferred: greedy meshing

Merge coplanar, same-tile block faces into larger quads to cut vertex count and
GPU vertex-shading load. **Postponed on purpose (2026-07-01)** — see below.

**Why deferred**
- It's a large custom-shader rewrite with more regression risk than all the
  other optimizations combined.
- The remaining benefit is now modest: attribute quantization already cut chunk
  geometry ~69%, and greedy meshing does *not* reduce draw calls (still ~1 mesh
  per chunk per material). The win is fewer vertices / less vertex shading.

**Feasibility (already checked)**
- The atlas texture uses `NearestFilter` with `generateMipmaps = false`
  (`buildAtlasTexture` in `static/js/blocks.js`), so in-shader `fract()` tile
  tiling will *not* seam (the usual mipmap-derivative artifact doesn't apply).
  A WebGL2 texture array is therefore not required.

**How to pick it up**
- Patch `MeshLambertMaterial` via `onBeforeCompile` so it samples the atlas as
  `tileOrigin + fract(tiledUV) * tileSize`, preserving day/night lighting, fog,
  `alphaTest`, glow emissive, and water `DoubleSide`/transparency.
- Rewrite `Chunk.build` to greedy-merge per axis/slice, only merging faces with
  the same block, tile, and material group.
- Rework the UV quantization: merged quads span multiple blocks, so UVs run
  `0..W` rather than `0..1`, which the current `Uint16` normalized UV encoding
  can't represent as-is.
- Do it on an isolated git worktree/branch and verify with before/after headless
  screenshots (isolated server: `EVANS_WORLDS_DIR` + `?demo`); merge only if the
  result is visually identical.
