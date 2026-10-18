#!/usr/bin/env python3
"""Trim and re-pack the generated sprite sheets.

The generator sizes every frame in a sprite to the widest pose in the whole set
(a sword mid-swing), so an idle frame of the knight is 120x158 for a character
that occupies ~50x50. Across the project that is 186 megapixels of sheet for
about 8 megapixels of actual ink — which costs download time, decode time and
overdraw on every frame drawn.

This rewrites each sprite's sheets so every frame is cropped to the union of
the alpha bounds of its body and worn-item layers (one shared box, so the layers
stay pixel-aligned), then shelf-packs the results into new atlases. Nothing is
resampled, so the art is identical — only the padding is gone.

Per-frame output gains `ox`/`oy`: the crop's offset inside the original frame,
which the renderer adds back when it draws.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil

from PIL import Image

MAX_PAGE = 2048
PADDING = 1


def load_pages(folder: pathlib.Path, doc: dict) -> list[Image.Image]:
    return [Image.open(folder / p["file"]).convert("RGBA") for p in doc["pages"]]


def frame_rect(pages: list[Image.Image], frame: dict) -> Image.Image:
    return pages[frame["page"]].crop((frame["x"], frame["y"], frame["x"] + frame["w"], frame["y"] + frame["h"]))


def union_bbox(tiles: list[Image.Image]) -> tuple[int, int, int, int] | None:
    """Smallest box covering every non-zero pixel of every layer.

    The threshold is a single lit pixel, not a "visible" alpha: additive glow
    layers carry very faint fringes, and clipping them changes the art.
    """
    box = None
    for t in tiles:
        bb = t.getchannel("A").getbbox()
        if bb is None:
            continue
        if box is None:
            box = list(bb)
        else:
            box[0] = min(box[0], bb[0])
            box[1] = min(box[1], bb[1])
            box[2] = max(box[2], bb[2])
            box[3] = max(box[3], bb[3])
    return tuple(box) if box else None


class Shelf:
    """Simple shelf packer: rows of equal height, tallest first."""

    def __init__(self, width: int) -> None:
        self.width = width
        self.pages: list[Image.Image] = []
        self.x = 0
        self.y = 0
        self.row = 0
        self._new_page()

    def _new_page(self) -> None:
        self.pages.append(Image.new("RGBA", (self.width, MAX_PAGE), (0, 0, 0, 0)))
        self.x = self.y = self.row = 0

    def place(self, tile: Image.Image) -> tuple[int, int]:
        w, h = tile.size
        if self.x + w + PADDING > self.width:
            self.y += self.row + PADDING
            self.x = 0
            self.row = 0
        if self.y + h + PADDING > MAX_PAGE:
            self._new_page()
        page = len(self.pages) - 1
        self.pages[page].paste(tile, (self.x, self.y))
        spot = (page, self.x, self.y)
        self.x += w + PADDING
        self.row = max(self.row, h)
        return spot


def save_page(img: Image.Image, stem: pathlib.Path, prefer: str) -> tuple[str, int]:
    """Write a page, returning (filename, bytes). Tries every encoding."""
    best = None
    crops = [img]
    if prefer in ("webp", "auto"):
        crops.append(img)  # webp handled below
    for ext, kwargs in (
        ("png", {"optimize": True, "compress_level": 9}),
        ("webp", {"lossless": True, "method": 6, "quality": 100}),
    ):
        if prefer == "png" and ext != "png":
            continue
        if prefer == "webp" and ext != "webp":
            continue
        buf = pathlib.Path("/tmp/_page_test").with_suffix("." + ext)
        img.save(buf, format=ext.upper(), **kwargs)
        size = buf.stat().st_size
        if best is None or size < best[1]:
            best = (ext, size, kwargs)
    ext, size, kwargs = best
    out = stem.with_suffix("." + ext)
    if out.exists():
        out.unlink()
    img.save(out, format=ext.upper(), **kwargs)
    return out.name, size


def page_rects(pname: str, page_no: int, slots: dict, trimmed: dict):
    """(page, x, y, w, h) of every rect placed on one page of one layer."""
    out = []
    for (p, name, i), (pg, x, y) in slots.items():
        if p != pname or pg != page_no:
            continue
        box = trimmed[(name, i)][0]
        if box[2]:
            out.append((pg, x, y, box[2], box[3]))
    return out


def process(folder: pathlib.Path, prefer: str, report: bool) -> tuple[int, int]:
    index = json.loads((folder.parent / "index.json").read_text())[folder.name]
    docs: dict[str, dict] = {}
    images: dict[str, list[Image.Image]] = {}

    def doc_for(key: str, filename: str) -> dict:
        if filename not in docs:
            d = json.loads((folder / filename).read_text())
            docs[filename] = d
            images[filename] = load_pages(folder, d)
        return docs[filename]

    base = doc_for("base", index["base"])
    part_names = [p["json"] for p in index["parts"]]
    for name in part_names:
        doc_for(name, name)

    # Trim every frame: one shared box across the layers of that animation.
    trimmed: dict[tuple[str, int], tuple[tuple[int, int, int, int], list[Image.Image]]] = {}
    max_frames = max(len(a["frames"]) for a in base["animations"])
    for anim in base["animations"]:
        name = anim["name"]
        for i, frame in enumerate(anim["frames"]):
            tiles = [frame_rect(images[index["base"]], frame)]
            for pname in part_names:
                pdoc = docs[pname]
                panim = next((a for a in pdoc["animations"] if a["name"] == name), None)
                if panim and i < len(panim["frames"]):
                    tiles.append(frame_rect(images[pname], panim["frames"][i]))
            box = union_bbox(tiles)
            if box is None:
                trimmed[(name, i)] = ((0, 0, 0, 0), [])
                continue
            cropped = [t.crop(box) if t.size[0] * t.size[1] else t for t in tiles]
            # A part may be smaller than the union box; keep the shared size.
            w = box[2] - box[0]
            h = box[3] - box[1]
            padded = []
            for t in cropped:
                if t.size != (w, h):
                    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
                    canvas.paste(t, (0, 0))
                    padded.append(canvas)
                else:
                    padded.append(t)
            trimmed[(name, i)] = ((box[0], box[1], w, h), padded)

    # Pack, tallest first so rows stay tight. One shelf per layer for the whole
    # sprite — a fresh packer per frame would throw every earlier placement away.
    layer_names = [index["base"]] + part_names
    shelves: dict[str, Shelf] = {n: Shelf(MAX_PAGE) for n in layer_names}
    slots: dict[tuple[str, str, int], tuple[int, int, int]] = {}
    order = sorted(trimmed.keys(), key=lambda k: -trimmed[k][0][3])
    for (name, i) in order:
        tiles = trimmed[(name, i)][1]
        for pname, tile in zip(layer_names, tiles):
            if not tiles:
                continue
            page, x, y = shelves[pname].place(tile)
            slots[(pname, name, i)] = (page, x, y)

    # Write the new pages and rewrite each doc's frame rects.
    total_bytes = 0
    for pname, shelf in shelves.items():
        # Each layer needs its own filenames: the body and the worn items are
        # separate sheets and must not overwrite one another.
        stem_name = folder.name if pname == index["base"] else f"{folder.name}_{pname.split('.')[0].split('_')[-1]}"
        stem = folder / f"{stem_name}_atlas"
        for page_no, page in enumerate(shelf.pages):
            # Trim the transparent band below the art, but never below the last
            # placed rect: a frame that reaches the page edge must still fit
            # inside the size we declare.
            bb = page.getchannel("A").getbbox()
            ink_bottom = bb[3] if bb else 0
            rect_bottom = max((y + h for (pg, _, y, w, h, *_) in page_rects(pname, page_no, slots, trimmed)), default=0)
            page = page.crop((0, 0, page.width, max(ink_bottom, rect_bottom)))
            fname, size = save_page(page, pathlib.Path(f"{stem}_{page_no}"), prefer)
            total_bytes += size
            written = Image.open(folder / fname)
            if written.size != page.size:
                raise RuntimeError(f"{fname}: wrote {written.size} but declared {page.size}")
            while len(docs[pname]["pages"]) <= page_no:
                docs[pname]["pages"].append({"index": len(docs[pname]["pages"]), "file": "", "width": 0, "height": 0})
            docs[pname]["pages"][page_no] = {
                "index": page_no,
                "file": fname,
                "width": page.width,
                "height": page.height,
            }
        docs[pname]["pages"] = docs[pname]["pages"][: len(shelf.pages)]

    # Guard: every frame rect must sit inside the page it points at. This has to
    # run after the frames have been rewritten to their new packed rects.
    for pname, doc in docs.items():
        for anim in doc["animations"]:
            name = anim["name"]
            for i, frame in enumerate(anim["frames"]):
                box = trimmed[(name, i)][0]
                slot = slots.get((pname, name, i))
                if box[2] == 0 or slot is None:
                    frame.update({"page": 0, "x": 0, "y": 0, "w": 0, "h": 0, "ox": 0, "oy": 0})
                    continue
                page, x, y = slot
                frame.update({"page": page, "x": x, "y": y, "w": box[2], "h": box[3], "ox": box[0], "oy": box[1]})
        sizes = [(p["width"], p["height"]) for p in doc["pages"]]
        for anim in doc["animations"]:
            for frame in anim["frames"]:
                if not frame.get("w"):
                    continue
                pw, ph = sizes[frame["page"]]
                if frame["x"] + frame["w"] > pw or frame["y"] + frame["h"] > ph:
                    raise RuntimeError(
                        f"{pname}/{anim['name']}: frame {frame['w']}x{frame['h']} at "
                        f"({frame['x']},{frame['y']}) overflows page {pw}x{ph}"
                    )
        (folder / (index["base"] if pname == index["base"] else pname)).write_text(
            json.dumps(doc, separators=(",", ":"))
        )

    # The old, untrimmed pages are dead weight now.
    for pname in layer_names:
        stem = pathlib.Path(pname).stem
        for stale in list(folder.glob(stem + "_*.png")) + list(folder.glob(stem + "_*.webp")):
            stale.unlink()

    if report:
        pages = sum(len(s.pages) for s in shelves.values())
        print(f"  {folder.name:18} {pages} page(s)  {total_bytes/1024:8.0f} KB")

    return len(trimmed), total_bytes


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="assets/sprites")
    ap.add_argument("--format", default="auto", choices=["auto", "png", "webp"], help="page encoding")
    args = ap.parse_args()

    root = pathlib.Path(args.root)
    before = sum(p.stat().st_size for p in root.rglob("*.png"))
    print(f"before: {before/1048576:.1f} MB of PNG")
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        process(folder, args.format, report=True)
    after = sum(p.stat().st_size for p in root.rglob("*.png")) + sum(p.stat().st_size for p in root.rglob("*.webp"))
    print(f"after:  {after/1048576:.1f} MB   ({before/after:.1f}x smaller)")


if __name__ == "__main__":
    main()
