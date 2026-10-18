// Loaders for what the Synty sprite generator exports:
//
//   <sprite>/<Model>.json           body sheet  (pages + animations + pivot)
//   <sprite>/<Model>_weapon.json    worn-item layer, pixel-aligned with the body
//   <sprite>/<Model>_offhand.json
//   <sprite>/<Model>.layers.json    which parts draw in front, per frame
//   <sprite>/<Model>_<n>.png        the sheet pages
//
// Plus a Tiled tileset (.tsj + atlas png) and a Tiled map (.tmj).
//
// Assets are read exactly as exported: the pivot is where the model's ground
// origin projects to, so drawing a frame at (x - pivot.x, y - pivot.y) puts the
// character on the tile it stands on.

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed: ' + src));
    img.src = src;
  });
}

export async function loadJSON(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${res.status} ${src}`);
  return res.json();
}

// --- one sheet ----------------------------------------------------------

// A multi-page image set; every page shares the frame grid.
class Pages {
  constructor(images) {
    this.images = images;
  }

  draw(ctx, frame, dx, dy, dw, dh) {
    const img = this.images[frame.page] || this.images[0];
    if (!img) return;
    ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, dx, dy, dw, dh);
  }
}

// --- one exported sprite ------------------------------------------------

const MOVESETS = ['martial_arts', 'unarmed', 'sword', 'knife', 'bow', 'staff', 'rifle', 'pistol'];

export class Sprite {
  constructor(name) {
    this.name = name;
    this.pivot = { x: 0, y: 0 };
    this.frameWidth = 0;
    this.frameHeight = 0;
    this.fps = 12;
    this.pages = new Pages([]);
    this.clips = new Map(); // lookup key -> Clip
    this.movesets = [];
  }

  has(key) {
    return this.clips.has(key);
  }

  clip(key) {
    return this.clips.get(key);
  }

  // Every clip whose move is `move`, for any moveset. Lets the game say
  // "play the cast animation" without knowing the weapon class prefix.
  find(move, dir) {
    return this.clips.get(move + '_' + dir) || this.clips.get(move + '_S') || null;
  }

  // Frames are trimmed to their own ink (see tools/optimize_sheets.py), so each
  // one carries its own size plus the offset of that crop inside the full frame.
  // `x, y` is where the character's ground pivot sits, and the crop is placed
  // back relative to it — which is why no per-sprite offsets are needed.
  draw(ctx, clip, x, y, scale = 1) {
    if (!clip) return;
    const baseX = x - this.pivot.x * scale;
    const baseY = y - this.pivot.y * scale;
    const index = clip.sample().index;
    for (const layer of clip.layersInOrder(index)) {
      const f = layer.frames[index];
      if (!f || !f.w) continue;
      layer.pages.draw(ctx, f, baseX + (f.ox || 0) * scale, baseY + (f.oy || 0) * scale, f.w * scale, f.h * scale);
    }
  }
}

// A single animation: base frames, the worn-item layers, and the per-frame
// front/back decision that keeps a sword behind the body and a shield in front.
class Clip {
  constructor(name, base, parts, order, fps, loop) {
    this.name = name;
    this.base = base;
    this.parts = parts; // [{layer, frames, pages}]
    this.order = order; // [{layer, front}]
    this.fps = fps || 12;
    this.loop = loop !== false;
    this.time = 0;
    this.index = 0;
  }

  get length() {
    return this.base.frames.length;
  }

  get duration() {
    return this.length / this.fps;
  }

  sample() {
    return { index: Math.min(this.index, this.length - 1) };
  }

  reset() {
    this.time = 0;
    this.index = 0;
  }

  // Parts flagged in front draw last; everything else sits behind the body.
  layersInOrder(index) {
    const back = [];
    const front = [];
    const perFrame = this.order[index];
    for (const part of this.parts) {
      const flag = perFrame?.[part.layer];
      (flag ? front : back).push(part);
    }
    return [this.base, ...back, ...front];
  }

  advance(dt) {
    if (this.length <= 1) return;
    this.time += dt * this.fps;
    let guard = 0;
    while (this.time >= 1 && guard++ < 240) {
      this.time -= 1;
      if (this.index < this.length - 1) this.index++;
      else if (this.loop) this.index = 0;
      else {
        this.index = this.length - 1;
        this.time = 0;
        break;
      }
    }
  }
}

// Playback controller: one Clip playing at a time.
export class Animator {
  constructor(sprite) {
    this.sprite = sprite;
    this.clip = null;
  }

  play(clip, { restart = false } = {}) {
    if (!clip) return false;
    if (restart || this.clip !== clip) clip.reset();
    this.clip = clip;
    return true;
  }

  update(dt) {
    if (this.clip) this.clip.advance(dt);
  }
}

async function buildLayer(dir, file) {
  const doc = await loadJSON(`${dir}/${file}`);
  const images = await Promise.all(doc.pages.map((p) => loadImage(`${dir}/${p.file}`)));
  const animations = new Map();
  for (const a of doc.animations) {
    animations.set(a.name, {
      frames: a.frames,
      loop: a.loop !== false,
      fps: a.fps || doc.fps || 12,
    });
  }
  return { doc, pages: new Pages(images), animations };
}

export async function loadSprite(dir, name, entry) {
  const sprite = new Sprite(name);
  const body = await buildLayer(dir, entry.base);

  sprite.frameWidth = body.doc.frameWidth;
  sprite.frameHeight = body.doc.frameHeight;
  sprite.fps = body.doc.fps || 12;
  sprite.pivot = body.doc.pivot || { x: sprite.frameWidth / 2, y: sprite.frameHeight };
  sprite.pages = body.pages;

  // The layers file says, per frame, which parts are in front.
  let orderByAnim = new Map();
  if (entry.layers) {
    try {
      const layers = await loadJSON(`${dir}/${entry.layers}`);
      for (const a of layers.animations || []) {
        orderByAnim.set(a.name, a.frames.map((f) => f.front || {}));
      }
    } catch (err) {
      console.warn(`[assets] ${name}: layers file missing (${err.message})`);
    }
  }

  const parts = [];
  for (const p of entry.parts || []) {
    const layer = await buildLayer(dir, p.json);
    parts.push({ layer: p.layer, ...layer });
  }

  const register = (key, clip) => {
    if (!sprite.clips.has(key)) sprite.clips.set(key, clip);
  };

  for (const [animName, anim] of body.animations) {
    const clipParts = parts
      .filter((p) => p.animations.has(animName))
      .map((p) => ({ layer: p.layer, pages: p.pages, frames: p.animations.get(animName).frames }));
    const clip = new Clip(animName, { pages: body.pages, frames: anim.frames }, clipParts, orderByAnim.get(animName) || [], anim.fps, anim.loop);

    // Animation names are "<clip>_<DIR>", e.g. "sword_attack_1_S". Drop the
    // separator and the facing, then optionally the moveset prefix.
    const dir = animName.slice(-1);
    const move = animName.slice(0, -2);
    const moveset = MOVESETS.find((m) => move.startsWith(m + '_'));
    const bare = moveset ? move.slice(moveset.length + 1) : move;
    if (moveset && !sprite.movesets.includes(moveset)) sprite.movesets.push(moveset);

    register(animName, clip);
    register(move + '_' + dir, clip);
    register(bare + '_' + dir, clip);
  }

  return sprite;
}

// A stand-in so a missing render never punches a hole in the level.
export function placeholderSprite(name, w = 32, h = 32, colour = '#7b6cff') {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  c.fillStyle = colour;
  c.globalAlpha = 0.45;
  c.fillRect(4, 4, w - 8, h - 8);
  const sprite = new Sprite(name);
  sprite.frameWidth = w;
  sprite.frameHeight = h;
  sprite.pivot = { x: w / 2, y: h - 4 };
  sprite.pages = new Pages([canvas]);
  const clip = new Clip('idle', { pages: sprite.pages, frames: [{ page: 0, x: 0, y: 0, w, h }] }, [], [], 1, true);
  sprite.clips.set('idle_S', clip);
  return sprite;
}

// --- Tiled tileset ------------------------------------------------------

export class Tileset {
  constructor(atlas, doc) {
    this.image = atlas;
    this.doc = doc;
    this.tileW = doc.tilewidth;
    this.tileH = doc.tileheight;
    this.spacing = doc.spacing || 0;
    this.margin = doc.margin || 0;
    this.columns = doc.columns || Math.floor((atlas.width - this.margin * 2) / (this.tileW + this.spacing));
    this.tilecount = doc.tilecount;
    const colours = doc.wangsets?.[0]?.colors || [];
    this.names = ['none', ...colours.map((c) => c.name)];
    this.tileTerrain = this.#classify();
  }

  // Every tile's dominant terrain, so gameplay can ask "is this cell lava?".
  #classify() {
    const out = new Int8Array(this.tilecount);
    const wang = this.doc.wangsets?.[0];
    if (!wang) return out;
    for (const { tileid, wangid } of wang.wangtiles || []) {
      const counts = new Map();
      for (let i = 1; i < wangid.length; i++) {
        const code = wangid[i];
        if (code) counts.set(code, (counts.get(code) || 0) + 1);
      }
      let best = 0;
      let bestScore = -1;
      for (const [code, n] of counts) {
        // Prefer bedrock so a cell that touches rock is solid, not walkable.
        const score = n + (this.names[code] === 'bedrock' ? 100 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = code;
        }
      }
      if (best) out[tileid] = best;
    }
    return out;
  }

  terrainName(localId) {
    if (localId < 0 || localId >= this.tileTerrain.length) return null;
    return this.names[this.tileTerrain[localId]] || null;
  }

  draw(ctx, localId, dx, dy) {
    const id = localId | 0;
    if (id < 0 || id >= this.tilecount) return;
    const sx = this.margin + (id % this.columns) * (this.tileW + this.spacing);
    const sy = this.margin + Math.floor(id / this.columns) * (this.tileH + this.spacing);
    ctx.drawImage(this.image, sx, sy, this.tileW, this.tileH, dx, dy, this.tileW, this.tileH);
  }
}

export async function loadTileset(dir, name) {
  const doc = await loadJSON(`${dir}/${name}.tsj`);
  const atlas = await loadImage(`${dir}/${doc.image || name + '.png'}`);
  return new Tileset(atlas, doc);
}

// --- Tiled map ----------------------------------------------------------

export class TileMap {
  constructor(doc, tileset) {
    this.doc = doc;
    this.tileset = tileset;
    this.w = doc.width;
    this.h = doc.height;
    this.tileW = doc.tilewidth;
    this.tileH = doc.tileheight;
    this.properties = {};

    this.localIds = new Int32Array(this.w * this.h).fill(-1);
    this.solid = new Uint8Array(this.w * this.h);
    this.terrain = new Array(this.w * this.h).fill(null);
    this.objects = [];
    this.collisionShapes = [];

    for (const p of doc.properties || []) this.properties[p.name] = p.value;

    const firstGid = doc.tilesets?.[0]?.firstgid ?? 1;
    for (const layer of doc.layers || []) {
      if (layer.type === 'tilelayer' && layer.name === 'ground') this.#readGround(layer, firstGid);
      else if (layer.type === 'objectgroup' && layer.name === 'objects') this.#readObjects(layer);
      else if (layer.type === 'objectgroup' && layer.name === 'collision_shapes') this.#readCollision(layer);
    }
  }

  #readGround(layer, firstGid) {
    const ids = layer.data || [];
    for (let i = 0; i < ids.length && i < this.localIds.length; i++) {
      const local = ids[i] - firstGid;
      if (local < 0) continue;
      this.localIds[i] = local;
      const name = this.tileset.terrainName(local);
      this.terrain[i] = name;
      if (name === 'bedrock') this.solid[i] = 1;
    }
  }

  #readObjects(layer) {
    for (const o of layer.objects || []) {
      const props = {};
      for (const p of o.properties || []) props[p.name] = p.value;
      this.objects.push({
        id: o.id,
        name: o.name,
        exportName: props.exportName || o.name,
        x: o.x || 0,
        y: o.y || 0,
        props,
        solid: false,
        hp: 0,
      });
    }
  }

  #readCollision(layer) {
    // Polygons are in Tiled pixels around the object's anchor.
    for (const o of layer.objects || []) {
      this.collisionShapes.push({ x: o.x, y: o.y, polygon: o.polygon || [] });
    }
    // Attach each shape to the object it names, by index order of `mapId`.
    const byId = new Map(this.objects.map((o) => [o.props.mapId, o]));
    for (const o of layer.objects || []) {
      const props = {};
      for (const p of o.properties || []) props[p.name] = p.value;
      const owner = byId.get(props.mapId);
      if (owner && o.polygon?.length) {
        owner.polygon = o.polygon;
        owner.solid = true;
      }
    }
  }

  idx(cx, cy) {
    return cy * this.w + cx;
  }

  inBounds(cx, cy) {
    return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h;
  }

  isSolid(cx, cy) {
    return !this.inBounds(cx, cy) || this.solid[this.idx(cx, cy)] === 1;
  }

  terrainAt(cx, cy) {
    return this.inBounds(cx, cy) ? this.terrain[this.idx(cx, cy)] : null;
  }

  terrainAtPx(x, y) {
    return this.terrainAt(Math.floor(x / this.tileW), Math.floor(y / this.tileH));
  }

  // Solid test for a circle: map rock plus any prop that blocks.
  circleBlocked(x, y, r, props = null) {
    const x0 = Math.floor((x - r) / this.tileW);
    const x1 = Math.floor((x + r) / this.tileW);
    const y0 = Math.floor((y - r) / this.tileH);
    const y1 = Math.floor((y + r) / this.tileH);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!this.isSolid(cx, cy)) continue;
        const left = cx * this.tileW;
        const top = cy * this.tileH;
        const nx = Math.max(left, Math.min(x, left + this.tileW));
        const ny = Math.max(top, Math.min(y, top + this.tileH));
        const dx = x - nx;
        const dy = y - ny;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    if (props) {
      for (const p of props) {
        if (!p.solid || p.dead) continue;
        const dx = x - p.x;
        const dy = y - p.y;
        const rr = r + (p.radius || 12);
        if (dx * dx + dy * dy < rr * rr) return true;
      }
    }
    return false;
  }

  reachable(from, to, maxNodes = 30000) {
    const key = (x, y) => y * this.w + x;
    const start = key(from.x, from.y);
    const goal = key(to.x, to.y);
    const seen = new Uint8Array(this.w * this.h);
    const queue = [start];
    seen[start] = 1;
    let visited = 0;
    while (queue.length && visited < maxNodes) {
      const cur = queue.shift();
      visited++;
      if (cur === goal) return true;
      const x = cur % this.w;
      const y = (cur / this.w) | 0;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (!this.inBounds(nx, ny) || this.isSolid(nx, ny)) continue;
        const k = key(nx, ny);
        if (seen[k]) continue;
        seen[k] = 1;
        queue.push(k);
      }
    }
    return false;
  }
}

export async function loadMap(dir, tileset) {
  const name = dir.split('/').pop();
  const doc = await loadJSON(`${dir}/${name}.tmj`);
  return new TileMap(doc, tileset);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
