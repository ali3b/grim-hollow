# Grim Hollow

A top-down pixel-art **dungeon arena-survivor**. Descend into a flooded,
fire-lit ruin, clear the halls of goblins, skeletons and demons, break the
Warlock's rune — and get back out alive.

Play it in a browser: **desktop keyboard/mouse**, or **iPad and phones** with
on-screen controls. Installable as an app.

---

## Play

**Live:** <https://ali3b.github.io/grim-hollow/>

```bash
git clone https://github.com/ali3b/grim-hollow.git
cd grim-hollow
python3 -m http.server 8080      # or: npx serve .
# open http://localhost:8080
```

It must be served over HTTP (the map and tileset are fetched as JSON) — opening
`index.html` from the filesystem will not work.

### Controls

| | Desktop | Touch |
|---|---|---|
| Move | `WASD` / arrows | drag anywhere on the left half (floating stick) |
| Attack | `J`, `Space`, left click | **ATK** (hold to keep swinging) |
| Heavy attack | `K`, right click | **HEAVY** |
| Dash (i-frames) | `Shift` | **DASH** |
| Drink a potion | `L`, `Q` | **POTION** |
| Open a chest | `E`, `Enter` | **USE** |
| Map | `M` | **MAP** |
| Pause / settings | `Esc`, `P`, **II** | **II** |

In the pause menu: `S`/`N` steps through the settings, `V` toggles sound,
`-`/`+` change the volume, `Esc` or `P` resumes.

`?autostart` skips the title card. `?touch=1` forces the on-screen controls on a
desktop, which is handy for checking the mobile layout.

### Sound

Everything is synthesised at runtime with the Web Audio API — `src/audio.js`,
no audio files. An ambient drone that tightens as enemies close in, plus swings,
impacts, dashes, pickups, level-ups and the Warlock's roar. Browsers only allow
audio after a gesture, so it starts with your first tap or keypress and can be
muted from the pause menu.

### The run

Clear the halls, then find the Warlock deep in the south. Each room wakes its
own garrison when you walk in, and throws two more waves at you once you clear
it — harder each time, and every fourth spawn is an **elite**: bigger, twice the
health, ringed in gold, and worth more souls.

Enemies have jobs, not just stats. A **skeleton knight** carries a shield that
blocks anything but a heavy attack, and turns to face you so you cannot flank
it. A **demon** crouches, then lunges in a straight line and is helpless while
it recovers. A **goblin shaman** keeps its distance and repositions instead of
standing still and shooting. That is what the heavy attack is for.

Souls level you up into a draft: three cards, take one, world paused. Chests and
smashable barrels carry potions and bonus souls. Lava burns, water slows you.
When the Warlock falls the rune shatters and the stairwell back in the entry
hall becomes your way out — a chevron on screen points at whatever you are
heading for and how far it is.

---

## How it was made

Every pixel in this game came out of the
[Synty Sprite Generator](https://github.com/...) as 3D renders — the tileset,
the level, and all sixteen sprites (11,121 animation frames) are generated
assets, committed as-is.

* **Project:** `Grim Hollow` — top-down, 4 directions, pixel art, 32×32 tile lock at 1 m/tile, night lighting.
* **Tileset `hollow_floor`:** 8 terrains (stone, flagstone, moss, rubble, water, lava, bedrock, rune) as a 849-tile corner-wang atlas — every pair and every three/four-way junction resolved, so nothing falls back to a flat tile.
* **Level `hollow_deep`:** 64×64 cells, hand-laid rooms and corridors, then seeded scatters for 137 props (torches, braziers, pillars, barrels, crates, bone piles, rune orbs) with spawn / patrol / objective / extraction zones.
* **Sprites:** a sword-and-shield knight, five enemy types, the Warlock, seven props and two projectile effects — rendered with the matching movesets so every swing, cast, arrow and death animation is real.

The runtime is plain ES modules and a 2D canvas — no engine, no build step.

### Layout

```
index.html              canvas, HUD chrome, touch-control markup, PWA manifest link
manifest.webmanifest    installable-app metadata
icon-*.png              icons composited from the generated art
src/
  main.js               boot, responsive canvas, game loop
  assets.js             tileset / Tiled map / layered sprite-sheet loaders
  audio.js              runtime-synthesised music and sound effects
  game.js               world, camera, entities, AI, combat, rendering, lighting
  input.js              keyboard + mouse, funnelled into one action set
  touch.js              floating stick and action buttons
  ui.js                 HUD, minimap, map screen, pause/settings, title and end cards
assets/
  tilesets/hollow_floor/  atlas PNG + Tiled .tsj (wangset included)
  maps/hollow_deep/       .tmj + the tileset it uses
  sprites/index.json      manifest mapping each sprite to its sheets and layers
  sprites/<name>/         generated sheets + JSON, one folder per sprite
tools/
  sync_assets.py           copy the generator's export in and write index.json
  optimize_sheets.py       crop each frame to its ink box and shelf-pack the atlas
  make_icons.py            build the PWA icons from the game's own art
selftest.html           headless playthrough: spawns, combat, boss, win
stress.html             headless fuzz: randomised input, hunting for runtime errors
perf.html               headless draw-call counter
shot.html               headless screenshot rig for checking a layout
```

### Notes on the generated data

The sprite sheets are **layered**: a character exports as a body sheet plus one
aligned sheet per worn item, and a `.layers.json` that says, per frame, which
item draws in front. `src/assets.js` reads that and composites the sword behind
the body and the shield in front, frame by frame — so the animations are the
generator's, not a re-rig.

Sprites are positioned by the `pivot` the generator writes: the point where the
model's ground origin projects into the frame. Drawing a frame at
`(x - pivot.x, y - pivot.y)` puts a character on the tile it is standing on,
with no per-sprite fudge factors.

`tools/sync_assets.py` trims the export to the fields the loader reads (the
per-frame sockets, hitboxes and authoring metadata are dropped), which roughly
halves the download — worth it on mobile.

### Testing

Three headless harnesses, all driven the same way — serve the folder and open
the page, or run Chrome against it:

```bash
google-chrome --headless=new --disable-gpu --virtual-time-budget=120000 \
  --dump-dom http://localhost:8080/selftest.html | grep -o '<pre id="out">.*</pre>'
```

| Page | What it does | Expected |
|---|---|---|
| `selftest.html` | scripted playthrough of every room plus the boss | `bossDead=true exitOpen=true` / `final state=won` / `runtime errors: none` |
| `stress.html` | 40 runs × 900 frames of randomised input, spawning and killing as it goes | `STRESS PASSED: 40 runs x 900 frames` |
| `perf.html` | counts `drawImage` calls and radial gradients per frame | ~1,250 draws, gradients in single digits |
| `traverse.html` | flood-fills the real collision from the spawn and checks every zone is reachable | `PASS: every zone is reachable` |
| `shot.html` | renders one room and screenshots it (`?zone=`, `?s=`, `?touch=1`, `?hp=`) | — |

`selftest` and `stress` are the ones that matter: they run the real game loop, so
a crash in combat logic shows up as `runtime errors:` rather than only in a
browser console nobody opens.

`traverse.html` covers the failure none of the others can see. The level shipped
with rooms whose corridor graph did not connect — the entry hall, stairwell and
goblin warren were one island, and the other six zones including the boss room
sat behind solid bedrock with no doorway. 507 of 2190 walkable cells were
reachable, so the game could not be finished. `selftest` passed the whole time
because it teleports between rooms. Any change to the map or the collision
should be checked against it.
