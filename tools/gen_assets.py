#!/usr/bin/env python3
"""
Generate game art with an AI image model via OpenRouter.

OpenRouter exposes image generation through the normal chat-completions
endpoint: send modalities=["image","text"] to an image-capable model (Google's
Gemini image model by default) and the PNG comes back as a base64 data URL.

The engine auto-uses anything you drop in static/textures/:
  * static/textures/banner.png        -> shown on the start screen
  * static/textures/<tile>.png (16px) -> overrides a block face, e.g.
    grass_top.png, grass_side.png, dirt.png, stone.png, sand.png,
    wood_top.png, wood_side.png, leaves.png, water.png, planks.png,
    glass.png, brick.png, cobble.png

Usage:
  python tools/gen_assets.py banner                 # title banner (recommended)
  python tools/gen_assets.py textures               # all block tiles
  python tools/gen_assets.py textures stone grass_top
  python tools/gen_assets.py prompt "a treasure chest" out.png

The API key is read from $OPENROUTER_API_KEY, else parsed out of
tech-notes.txt. It is never printed or written into committed files.
"""

import base64
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX_DIR = os.path.join(ROOT, "static", "textures")
MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemini-2.5-flash-image")
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

# Prompt per block tile. Kept consistent so the set looks cohesive.
TILE_PROMPTS = {
    "grass_top":  "top-down view of lush green grass",
    "grass_side": "side view of a soil block with a green grass strip across the very top",
    "dirt":       "plain brown soil / dirt",
    "stone":      "grey stone rock",
    "sand":       "pale yellow sand",
    "wood_top":   "top cross-section of a tree log showing rings",
    "wood_side":  "side bark of a brown tree log with vertical grain",
    "leaves":     "dense green tree leaves / foliage",
    "water":      "blue rippling water surface",
    "planks":     "wooden planks",
    "glass":      "clear light-blue glass pane",
    "brick":      "red brick wall with grey mortar",
    "cobble":     "grey cobblestone",
}

TILE_STYLE = (
    "16x16 pixel-art game texture, seamless and tileable, flat top-down, "
    "Minecraft block texture style, crisp pixels, no text, no border, "
    "fills the whole square. Subject: {}"
)

BANNER_PROMPT = (
    "A cheerful title banner for a kids' Minecraft-style voxel game. "
    "The words \"EVAN'S WORLD\" written in chunky 3D blocky cube letters made of "
    "grass and stone blocks. A couple of simple cube trees and a bright blue sky "
    "with a fluffy cloud. Colorful, friendly, cartoon voxel art, wide banner, "
    "plain simple background, no extra text."
)


def get_api_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key.strip()
    notes = os.path.join(ROOT, "tech-notes.txt")
    if os.path.exists(notes):
        with open(notes) as f:
            m = re.search(r"sk-or-[A-Za-z0-9\-_]+", f.read())
            if m:
                return m.group(0)
    sys.exit("No API key found. Set $OPENROUTER_API_KEY or put it in tech-notes.txt")


def generate(prompt: str, out_path: str, key: str):
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "modalities": ["image", "text"],
    }).encode()

    req = urllib.request.Request(
        ENDPOINT, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost",
            "X-Title": "EvansGame asset generator",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.load(resp)

    try:
        images = result["choices"][0]["message"]["images"]
        data_url = images[0]["image_url"]["url"]
    except (KeyError, IndexError, TypeError):
        text = result.get("choices", [{}])[0].get("message", {}).get("content")
        sys.exit(f"No image in response. Model said: {text!r}\nRaw: {json.dumps(result)[:500]}")

    b64 = data_url.split(",", 1)[1]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(b64))
    print(f"  wrote {os.path.relpath(out_path, ROOT)}  ({os.path.getsize(out_path)//1024} KB)")


def main(argv):
    if not argv:
        print(__doc__)
        return
    key = get_api_key()
    cmd = argv[0]

    if cmd == "banner":
        print("Generating title banner...")
        generate(BANNER_PROMPT, os.path.join(TEX_DIR, "banner.png"), key)

    elif cmd == "textures":
        names = argv[1:] or list(TILE_PROMPTS)
        for name in names:
            if name not in TILE_PROMPTS:
                print(f"  skip unknown tile '{name}'")
                continue
            print(f"Generating tile '{name}'...")
            generate(TILE_STYLE.format(TILE_PROMPTS[name]),
                     os.path.join(TEX_DIR, f"{name}.png"), key)

    elif cmd == "prompt":
        if len(argv) < 3:
            sys.exit("usage: prompt \"<text>\" <out.png>")
        out = argv[2] if os.path.isabs(argv[2]) else os.path.join(ROOT, argv[2])
        print(f"Generating from prompt...")
        generate(argv[1], out, key)

    else:
        sys.exit(f"unknown command '{cmd}'. Try: banner | textures | prompt")


if __name__ == "__main__":
    main(sys.argv[1:])
