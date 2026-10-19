#!/usr/bin/env python3
"""Pull the blue cast out of the ground atlas so it matches the rest of the art.

The tileset is rendered with a `night` light preset, so every tile is darkened
and pushed blue *in its albedo*. That grade reads well on its own - it gives
the stone its grain - but the game then lays its own darkness and its own cool
ambient over the top, and the floor ends up blue twice over. Measured on the
pure tiles:

    flagstone  #465681   warmth -59     "blue stone"
    moss       #455581   warmth -60     not green
    hero       #262129   warmth  -3     neutral, luminance 35
    brazier    #f9d642   warmth +183    blazing

Three palettes with nothing in common: a blue floor, near-black characters and
blazing yellow props. That is the mismatch.

This is a hue correction only. Exposure and black point are deliberately left
alone, because re-rendering the atlas with a neutral light was tried and looks
worse - the night grade is what gives the stone its texture, and flattening it
turns the floor into blank concrete. What changes is the chroma: the rock
terrains are dragged most of the way to neutral stone, moss keeps enough green
to still read as moss, and the accent terrains (water, lava, rune) are left
completely alone so they stay recognisable.

There is also a faint 32px grid across open floor. Three fixes were tried and
none removed it: re-rendering with a day light, collapsing each terrain's two
variants onto one, and cancelling a per-tile vignette that is measurable in the
atlas (centre luminance ~95, edges ~80). The last two are still here behind
flags because they are harmless and may help on their own, but the grid is
baked into the generated tiles rather than introduced by any of them, and
cancelling it properly means regenerating the ground with seamless source
textures.

Idempotent: the generator's export is kept as <atlas>.orig and every run grades
from that, so running it twice does not compound.

Usage:  grade_tileset.py [--stats-only]
"""

import argparse
import collections
import json
import os
import shutil
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ATLAS = os.path.join(HERE, "..", "assets", "tilesets", "hollow_floor", "hollow_floor.png")
TILESET = os.path.join(HERE, "..", "assets", "tilesets", "hollow_floor", "hollow_floor.tsj")

# How much of each terrain's original chroma survives. 0 is fully neutral.
KEEP_CHROMA = {
    "bedrock": 0.30,
    "flagstone": 0.22,
    "floor": 0.22,
    "rubble": 0.45,
    "moss": 0.62,
    # accents: untouched
    "water": 1.0,
    "lava": 1.0,
    "rune": 1.0,
}
DEFAULT_KEEP = 0.3

# A small red/blue nudge after the chroma pull, so the stone reads as warm-grey
# rather than the neutral grey of a greyscale ramp.
WARMTH = {"bedrock": 3, "flagstone": 5, "floor": 5, "rubble": 4, "moss": 2}


def classify(tsj):
    """tileid -> terrain, using the same rule the game uses to read a cell."""
    wang = tsj["wangsets"][0]
    names = {i: c["name"] for i, c in enumerate(wang["colors"])}
    names.setdefault(0, "none")
    top = max(names)
    out = {}
    for t in wang["wangtiles"]:
        counts = collections.Counter()
        for i in (1, 3, 5, 7):  # the four corners carry the terrain in this set
            code = t["wangid"][i]
            if 0 < code <= top:
                counts[code] += 1
        if not counts:
            continue
        best = max(counts, key=lambda c: counts[c] + (100 if names[c] == "bedrock" else 0))
        out[t["tileid"]] = names[best]
    return out


def edge_lift(im, tileid, cols, tw, th, margin, spacing):
    """Cancel the per-tile vignette baked into a pure terrain tile.

    Every generated tile is brightest in the middle and darker at its own
    edges. Tile them 32px apart and those private edges line up into a grid
    across the whole floor - which is the patchwork, not the variants. Only
    pure tiles (all four corners the same terrain) are lifted, because those
    are the ones that tile across open ground; a transition tile's edges are
    load-bearing, they are how one terrain blends into the next.
    """
    x = margin + (tileid % cols) * (tw + spacing)
    y = margin + (tileid // cols) * (th + spacing)
    patch = im.crop((x, y, x + tw, y + th))
    px = patch.load()
    band = max(2, tw // 8)

    def lum(a, b):
        r, g, b_ = px[a, b]
        return (r * 299 + g * 587 + b_ * 114) / 1000.0

    edge_n = inner_n = 0
    edge_sum = inner_sum = 0.0
    for b in range(th):
        for a in range(tw):
            d = min(a, b, tw - 1 - a, th - 1 - b)
            v = lum(a, b)
            if d < band:
                edge_sum += v
                edge_n += 1
            elif d > band * 2:
                inner_sum += v
                inner_n += 1
    if not edge_n or not inner_n:
        return None
    lift = (inner_sum / inner_n) - (edge_sum / edge_n)
    if abs(lift) < 1.0:
        return None

    for b in range(th):
        for a in range(tw):
            d = min(a, b, tw - 1 - a, th - 1 - b)
            if d >= band * 2:
                continue
            w = 1.0 - (d / (band * 2.0))
            w = w * w * (3 - 2 * w)  # smoothstep, so the fix adds no new seam
            r, g, b_ = px[a, b]
            px[a, b] = tuple(
                max(0, min(255, int(round(v + lift * w)))) for v in (r, g, b_)
            )
    return patch, (x, y), lift


def adjust(c, keep, warm):
    r, g, b = c
    lum = (r * 299 + g * 587 + b * 114) / 1000.0
    pull = 1.0 - keep
    r += (lum - r) * pull
    g += (lum - g) * pull
    b += (lum - b) * pull
    return tuple(max(0, min(255, int(round(v)))) for v in (r + warm, g, b - warm))


def report(store, label):
    print(f"\n{label}")
    print(f'  {"terrain":10} {"avg":9} {"lum":>4} {"warm":>5}')
    for name in sorted(store):
        r, g, b, n = store[name]
        if not n:
            continue
        r, g, b = r // n, g // n, b // n
        lum = (r * 299 + g * 587 + b * 114) // 1000
        print(f"  {name:10} #{r:02x}{g:02x}{b:02x}  {lum:4}  {r-b:+5}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats-only", action="store_true")
    ap.add_argument(
        "--flatten-variants",
        action="store_true",
        help="make each terrain's second variant identical to its first",
    )
    ap.add_argument(
        "--lift-edges",
        action="store_true",
        help="cancel the per-tile vignette on pure tiles (did not remove the grid)",
    )
    args = ap.parse_args()

    tsj = json.load(open(TILESET))
    tile_of = classify(tsj)
    cols = tsj["columns"]
    tw, th = tsj["tilewidth"], tsj["tileheight"]
    margin, spacing = tsj.get("margin", 0), tsj.get("spacing", 0)

    pristine = os.path.abspath(ATLAS + ".orig")
    if not args.stats_only and not os.path.exists(pristine):
        shutil.copyfile(ATLAS, pristine)
        print(f"kept the generator's export at {pristine}")
    src = pristine if os.path.exists(pristine) else ATLAS
    img = Image.open(src).convert("RGB")
    px = img.load()

    before = collections.defaultdict(lambda: [0, 0, 0, 0])
    after = collections.defaultdict(lambda: [0, 0, 0, 0])

    for tid, terrain in tile_of.items():
        keep = KEEP_CHROMA.get(terrain, DEFAULT_KEEP)
        warm = WARMTH.get(terrain, 0)
        x = margin + (tid % cols) * (tw + spacing)
        y = margin + (tid // cols) * (th + spacing)
        for py in range(y + 6, y + th - 6, 4):
            for pxx in range(x + 6, x + tw - 6, 4):
                if not (0 <= pxx < img.width and 0 <= py < img.height):
                    continue
                c = px[pxx, py]
                for store, v in ((before, c), (after, adjust(c, keep, warm))):
                    acc = store[terrain]
                    acc[0] += v[0]
                    acc[1] += v[1]
                    acc[2] += v[2]
                    acc[3] += 1

    # --- flatten the variants -------------------------------------------
    # Every terrain is generated with two variants and the map picks between
    # them per cell, so neighbouring tiles of the same stone do not match. On a
    # flat floor that shows up as a checkerboard: the seam between two identical
    # terrains should only exist where the terrain actually changes. Tiles that
    # share a corner layout are therefore made byte-identical.
    groups = collections.defaultdict(list)
    pure_ids = set()
    for t in tsj["wangsets"][0]["wangtiles"]:
        groups[tuple(t["wangid"])].append(t["tileid"])
        cs = {c for c in (t["wangid"][1], t["wangid"][3], t["wangid"][5], t["wangid"][7]) if 0 < c <= 7}
        if len(cs) == 1:
            pure_ids.add(t["tileid"])

    by_id = {t["tileid"]: tuple(t["wangid"]) for t in tsj["wangsets"][0]["wangtiles"]}
    lifted = 0
    for tid in sorted(pure_ids if args.lift_edges else ()):
        got = edge_lift(img, tid, cols, tw, th, margin, spacing)
        if not got:
            continue
        patch, (ox, oy), _ = got
        img.paste(patch, (ox, oy))
        # a pure tile's twin is pure too, so write the same pixels to both
        for twin in groups[by_id[tid]]:
            if twin == tid:
                continue
            tx = margin + (twin % cols) * (tw + spacing)
            ty = margin + (twin // cols) * (th + spacing)
            img.paste(patch, (tx, ty))
        lifted += 1
    if not args.stats_only and lifted:
        print(f"lifted the per-tile vignette off {lifted} pure tiles")
    flattened = 0
    for ids in (groups.values() if args.flatten_variants else ()):
        if len(ids) < 2:
            continue
        keep = ids[0]
        kx = margin + (keep % cols) * (tw + spacing)
        ky = margin + (keep // cols) * (th + spacing)
        patch = [img.crop((kx, ky, kx + tw, ky + th)).copy()]
        for other in ids[1:]:
            ox = margin + (other % cols) * (tw + spacing)
            oy = margin + (other // cols) * (th + spacing)
            img.paste(patch[0], (ox, oy))
            flattened += 1
    if not args.stats_only:
        print(f"flattened {flattened} variant tiles onto their twin")

    report(before, "before")
    if args.stats_only:
        return 0

    for tid, terrain in tile_of.items():
        keep = KEEP_CHROMA.get(terrain, DEFAULT_KEEP)
        warm = WARMTH.get(terrain, 0)
        x = margin + (tid % cols) * (tw + spacing)
        y = margin + (tid // cols) * (th + spacing)
        for py in range(y + 6, y + th - 6):
            for pxx in range(x + 6, x + tw - 6):
                if 0 <= pxx < img.width and 0 <= py < img.height:
                    px[pxx, py] = adjust(px[pxx, py], keep, warm)

    img.save(ATLAS)
    report(after, "after")
    print(f"\nwrote {ATLAS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
