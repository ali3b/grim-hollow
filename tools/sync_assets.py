#!/usr/bin/env python3
"""Copy the sprite generator's export into the game and write assets/sprites/index.json.

The generator names each file after the source model (Character_Male_Baird.json,
Character_Male_Baird_weapon.json, ...), so a static server cannot guess which JSON
is the body and which are worn-item layers. This writes the mapping once.
"""
import json
import pathlib
import shutil
import sys

SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else
                   "/home/andrew/projects/synty-sprite-generator/data/outputs/mcp/grim-hollow/all")
DST = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else
                   "/home/andrew/projects/game-test/assets/sprites")

LAYER_SUFFIXES = ("_weapon", "_offhand", "_back", "_head", "_body", "_accessory")

# The generator ships per-frame sockets, hitboxes and authoring metadata that
# the game never reads. Keeping them roughly doubles the download, which hurts on
# mobile, so the synced copies are trimmed to what the loader actually uses.
KEEP_ANIM = ("name", "clip", "direction", "loop", "fps")
KEEP_FRAME = ("page", "x", "y", "w", "h")
KEEP_DOC = ("asset", "frameWidth", "frameHeight", "fps", "pivot", "pixelsPerMetre", "scale", "pages")


def slim(doc: dict) -> dict:
    out = {k: doc[k] for k in KEEP_DOC if k in doc}
    out["animations"] = [
        {**{k: a[k] for k in KEEP_ANIM if k in a}, "frames": [{k: f[k] for k in KEEP_FRAME if k in f} for f in a["frames"]]}
        for a in doc["animations"]
    ]
    return out


def slim_layers(doc: dict) -> dict:
    """Only the front/back decision per frame is used to order the worn items."""
    return {
        "base": doc.get("base"),
        "frameWidth": doc.get("frameWidth"),
        "frameHeight": doc.get("frameHeight"),
        "fps": doc.get("fps"),
        "pivot": doc.get("pivot"),
        "animations": [
            {
                "name": a.get("name"),
                "clip": a.get("clip"),
                "direction": a.get("direction"),
                "frames": [{"front": f.get("front", {})} for f in a.get("frames", [])],
            }
            for a in doc.get("animations", [])
        ],
    }


def build_one(folder: pathlib.Path) -> dict | None:
    docs = sorted(p for p in folder.glob("*.json") if not p.name.endswith(".layers.json"))
    if not docs:
        return None

    def layer_of(stem: str) -> str | None:
        for s in LAYER_SUFFIXES:
            if stem.endswith(s):
                return s[1:]
        return None

    base = None
    parts = []
    for d in docs:
        layer = layer_of(d.stem)
        if layer:
            parts.append({"layer": layer, "json": d.name})
        elif base is None:
            base = d
    if base is None:
        base = docs[0]

    doc = json.loads(base.read_text())
    for d in docs:  # trim every sheet the loader touches
        trimmed = slim(json.loads(d.read_text()))
        d.write_text(json.dumps(trimmed, separators=(",", ":")))

    layers_file = base.with_suffix("").with_suffix(".layers.json")
    if layers_file.exists():
        layers_file.write_text(json.dumps(slim_layers(json.loads(layers_file.read_text())), separators=(",", ":")))

    index = {
        "base": base.name,
        "layers": base.with_suffix("").name + ".layers.json"
        if base.with_suffix("").with_suffix(".layers.json").exists() else None,
        "parts": parts,
        "frameWidth": doc.get("frameWidth"),
        "frameHeight": doc.get("frameHeight"),
        "pivot": doc.get("pivot"),
        "clips": sorted({a["clip"] for a in doc.get("animations", []) if a.get("clip")}),
        "anims": sorted({a["name"] for a in doc.get("animations", [])}),
        "directions": [d["name"] for d in doc.get("directions", [])],
    }
    return index


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    manifest = {}
    for folder in sorted(p for p in SRC.iterdir() if p.is_dir()):
        target = DST / folder.name
        shutil.copytree(folder, target, ignore=shutil.ignore_patterns("previews"))
        entry = build_one(target)
        if entry:
            manifest[folder.name] = entry

    (DST / "index.json").write_text(json.dumps(manifest, indent=1))
    for name, e in sorted(manifest.items()):
        print(f"{name:18} {e['frameWidth']}x{e['frameHeight']}  parts={[p['layer'] for p in e['parts']]}  anims={len(e['anims'])}")


if __name__ == "__main__":
    main()
