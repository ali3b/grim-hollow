#!/usr/bin/env python3
"""Build the PWA icons and manifest from the game's own art.

Takes the hero's first idle frame straight out of the exported atlas so the icon
is the real character, on a background sampled from the tileset.
"""
import json
import pathlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPRITE = ROOT / "assets/sprites/hero"
TILESET = ROOT / "assets/tilesets/hollow_floor/hollow_floor.tsj"

BG = (18, 14, 26, 255)
ACCENT = (108, 63, 208, 255)


def hero_frame() -> Image.Image:
    index = json.loads((SPRITE.parent / "index.json").read_text())["hero"]
    doc = json.loads((SPRITE / index["base"]).read_text())
    anim = next(a for a in doc["animations"] if a["name"] == "sword_idle_S")
    frame = anim["frames"][0]
    page = doc["pages"][frame["page"]]
    sheet = Image.open(SPRITE / page["file"]).convert("RGBA")
    crop = sheet.crop((frame["x"], frame["y"], frame["x"] + frame["w"], frame["y"] + frame["h"]))
    return crop.crop(crop.getbbox() or (0, 0, crop.width, crop.height))


def runes(size: int) -> Image.Image:
    """The rune terrain's pure tile, drawn under the hero as a glowing sigil."""
    doc = json.loads(TILESET.read_text())
    wang = doc["wangsets"][0]
    codes = [i + 1 for i, c in enumerate(wang["colors"]) if c["name"] == "rune"]
    code = codes[0] if codes else 1
    tileid = next(
        t["tileid"]
        for t in wang["wangtiles"]
        if [v for v in t["wangid"][1:] if v] == [code] * 4
    )
    cols = doc["columns"]
    atlas = Image.open(TILESET.with_suffix(".png")).convert("RGBA")
    x = tileid % cols * doc["tilewidth"]
    y = tileid // cols * doc["tileheight"]
    return atlas.crop((x, y, x + doc["tilewidth"], y + doc["tileheight"])).resize((size, size), Image.NEAREST)


def compose(size: int, hero_h_frac: float, feet_frac: float) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, size - 1, size - 1), outline=ACCENT, width=max(2, size // 128))

    feet_y = int(size * feet_frac)
    hero_h = int(size * hero_h_frac)
    hero = hero_frame()
    hero = hero.resize((max(1, round(hero.width * (hero_h / hero.height))), hero_h), Image.LANCZOS)
    hero_x = (size - hero.width) // 2

    # Rune sigil pooled around the hero's feet. The tile is fully opaque, so the
    # feather has to happen on the alpha channel, not the colour.
    px = int(size * 0.44)
    sigil = runes(px)
    mask = sigil.getchannel("A").filter(ImageFilter.GaussianBlur(px / 12))
    radial = Image.new("L", (px, px), 0)
    inset = int(px * 0.12)
    ImageDraw.Draw(radial).ellipse((inset, inset, px - 1 - inset, px - 1 - inset), fill=255)
    radial = radial.filter(ImageFilter.GaussianBlur(px / 6))
    mask = ImageChops.multiply(mask, radial)
    sigil.putalpha(mask.point(lambda v: int(v * 0.95)))
    img.alpha_composite(sigil, ((size - px) // 2, feet_y - px // 2))

    img.alpha_composite(hero, (hero_x, feet_y - hero_h))
    return img


def main() -> None:
    for name, size, hero_h, feet in (
        ("icon-192.png", 192, 0.46, 0.76),
        ("icon-512.png", 512, 0.46, 0.76),
        ("icon-maskable-512.png", 512, 0.34, 0.66),
    ):
        compose(size, hero_h, feet).save(ROOT / name)
        print("wrote", name)

    manifest = {
        "name": "Grim Hollow",
        "short_name": "Grim Hollow",
        "description": "A top-down pixel-art dungeon arena-survivor.",
        "start_url": "./",
        "scope": "./",
        "display": "fullscreen",
        "orientation": "any",
        "background_color": "#06040a",
        "theme_color": "#06040a",
        "icons": [
            {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    (ROOT / "manifest.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote manifest.webmanifest")


if __name__ == "__main__":
    main()
