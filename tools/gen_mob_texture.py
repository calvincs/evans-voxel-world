#!/usr/bin/env python3
"""
Generate a mob skin texture with an OpenRouter image model (Google "nano
banana" / Gemini image) and save it to static/textures/mob_<type>.png, where the
game picks it up automatically (see static/js/mobs.js: any mob_<type>.png present
is used as that animal's skin, otherwise it falls back to a flat colour).

Setup:
    pip install Pillow
    export OPENROUTER_KEY=sk-or-...          # your OpenRouter API key

Usage:
    # built-in prompt for a known animal:
    tools/gen_mob_texture.py cow

    # your own prompt for a new one:
    tools/gen_mob_texture.py dragon "red dragon scales, overlapping plates"

Options:
    --size N        output square size in px (default 64)
    --model ID      OpenRouter model id (default: google/gemini-2.5-flash-image;
                    try google/gemini-3-pro-image for "Nano Banana Pro")
    --out PATH      output path (default static/textures/mob_<type>.png)
    --keep-raw PATH also save the full-resolution source image

The texture is tiled onto the animal's body/head/legs, so prompt for a SEAMLESS,
FLAT, TOP-DOWN surface pattern (hide / fur / feathers / scales) — not a picture
of the whole animal. Built-in prompts already follow that style.
"""
import argparse
import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-2.5-flash-image"

# Shared style so every skin matches the game's chunky pixel-art look.
STYLE = ("seamless tileable, flat top-down, even lighting, no shadows, "
         "no background, retro 16-bit video game texture, Minecraft block "
         "texture style, fill the entire square edge to edge")

# Built-in surface-pattern prompts (the "core" of each; STYLE is appended).
PROMPTS = {
    "pig":     "smooth pink pig hide with subtle darker pink mottling",
    "sheep":   "thick fluffy creamy off-white sheep wool with soft woolly curls and bumps",
    "cow":     "cream and dark-brown irregular cow patches, dairy cow pattern, short fur",
    "chicken": "soft white chicken feathers, layered plumage, subtle pale-grey shading",
    "wolf":    "thick coarse grey wolf fur, short hair, subtle darker grey streaks",
    "spider":  "black spider exoskeleton, dark chitin with faint dull-red markings, slightly bristly",
    "squid":   "deep reddish-purple squid skin, smooth wet mottled cephalopod hide",
    # Villagers: the skin is tiled onto body + limbs as CLOTHING (their heads
    # keep a flat face colour in mobs.js), so prompt for fabric, not skin.
    "farmer":  "rough earthy brown linen farmer tunic fabric, coarse homespun weave, "
               "a couple of lighter stitched-on patches",
    "smith":   "dark charcoal-grey leather blacksmith apron, worn and scuffed, "
               "faint soot marks, stitched seams and a few dull metal rivets",
    "elder":   "soft cream woven wool robe fabric, fine gentle weave, "
               "subtle pale grey age lines, dignified and plain",
    "kid":     "bright cornflower-blue woven cotton cloth, "
               "simple chunky knit-style rows, playful",
}


def build_prompt(mob_type: str, custom: str | None) -> str:
    core = custom or PROMPTS.get(mob_type)
    if not core:
        sys.exit(f"No built-in prompt for '{mob_type}'. Pass one explicitly:\n"
                 f"  tools/gen_mob_texture.py {mob_type} \"<surface description>\"")
    return f"A texture of {core}. {STYLE}."


def generate(prompt: str, model: str, key: str) -> bytes:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "modalities": ["image", "text"],
    }).encode()
    req = urllib.request.Request(API, data=body, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost/evansgame",
        "X-Title": "EvansGame mob texture",
    })
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"OpenRouter HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:500]}")

    msg = data["choices"][0]["message"]
    imgs = msg.get("images") or []
    if not imgs:
        sys.exit(f"No image in response (content: {(msg.get('content') or '')[:300]!r})")
    url = imgs[0]["image_url"]["url"]
    return base64.b64decode(url.split(",", 1)[1] if url.startswith("data:") else url)


def main():
    ap = argparse.ArgumentParser(description="Generate a mob skin via OpenRouter.")
    ap.add_argument("type", help="animal name, e.g. cow (used for the built-in "
                                  "prompt and the mob_<type>.png filename)")
    ap.add_argument("prompt", nargs="?", help="custom surface-pattern prompt")
    ap.add_argument("--size", type=int, default=64)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--out")
    ap.add_argument("--keep-raw")
    args = ap.parse_args()

    key = os.environ.get("OPENROUTER_KEY")
    if not key:
        sys.exit("Set OPENROUTER_KEY in the environment (your OpenRouter API key).")
    try:
        from PIL import Image
    except ImportError:
        sys.exit("Pillow is required: pip install Pillow")

    prompt = build_prompt(args.type, args.prompt)
    print(f"[{args.model}] {prompt}")
    raw = generate(prompt, args.model, key)
    print(f"  received {len(raw)} bytes")
    if args.keep_raw:
        with open(args.keep_raw, "wb") as f:
            f.write(raw)

    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    w, h = im.size
    s = min(w, h)                                   # centre-crop to square
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    out = args.out or os.path.join(ROOT, "static", "textures", f"mob_{args.type}.png")
    im.resize((args.size, args.size), Image.LANCZOS).save(out)
    print(f"  wrote {out} ({args.size}x{args.size})")


if __name__ == "__main__":
    main()
