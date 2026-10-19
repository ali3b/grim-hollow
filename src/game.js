// Grim Hollow — a top-down dungeon arena-survivor.
// The level, the tiles and every sprite come out of the Synty sprite generator;
// this file is the rules, the AI and the renderer that put them together.

import { Animator, clamp, lerp } from './assets.js';

const TAU = Math.PI * 2;

// --- tuning --------------------------------------------------------------

const P = {
  radius: 11,
  speed: 112,
  dashSpeed: 300,
  dashTime: 0.16,
  dashCooldown: 0.55,
  maxHp: 100,
  attackTime: 0.30,
  attackReach: 48,
  attackArc: 2.0,
  attackDamage: 22,
  heavyTime: 0.54,
  heavyReach: 62,
  heavyArc: 2.7,
  heavyDamage: 46,
  invulnAfterHit: 0.55,
  comboWindow: 0.55,
};

// The light attack chains into three beats; each is a little faster and hits a
// little harder, so mashing is a real option but so is committing.
const COMBO = [
  { move: 'attack_1', damage: 1.0, reach: 1.0, arc: 1.0, time: 0.32 },
  { move: 'attack_1', damage: 1.15, reach: 1.05, arc: 1.05, time: 0.28 },
  { move: 'attack_2', damage: 1.7, reach: 1.2, arc: 1.25, time: 0.4 },
];

// A swing captures its parameters when it starts. Reading them back out of the
// combo counter every frame means anything that moves that counter mid-swing can
// desync the animation from the damage, so the beat is stored on the swing.
const HEAVY_BEAT = {
  heavy: true,
  move: 'attack_2',
  damage: 2.1,
  reach: P.heavyReach,
  arc: P.heavyArc,
  time: P.heavyTime,
};

const ENEMY_WINDUP = 0.26;

const ENEMY_TYPES = {
  goblin_brute: { hp: 36, speed: 76, damage: 11, reach: 32, cooldown: 1.1, souls: 9, range: 22, aggro: 190, scale: 1 },
  goblin_shaman: { hp: 30, speed: 62, damage: 9, reach: 16, cooldown: 2.5, souls: 14, range: 250, aggro: 250, ranged: 'orb', scale: 1 },
  skeleton_knight: { hp: 50, speed: 68, damage: 14, reach: 34, cooldown: 1.25, souls: 11, range: 24, aggro: 210, scale: 1 },
  skeleton_ranger: { hp: 32, speed: 66, damage: 12, reach: 16, cooldown: 2.0, souls: 10, range: 300, aggro: 300, ranged: 'arrow', scale: 1 },
  demon: { hp: 105, speed: 88, damage: 22, reach: 42, cooldown: 1.5, souls: 26, range: 30, aggro: 230, scale: 1.2 },
  darklord: { hp: 460, speed: 80, damage: 26, reach: 46, cooldown: 1.1, souls: 250, range: 32, aggro: 4000, scale: 1.28, boss: true },
};

// How each placed prop behaves. `solid` props block movement.
const PROP_TYPES = {
  torch: { radius: 7, solid: false },
  brazier: { radius: 9, solid: false },
  pillar: { radius: 13, solid: true },
  crate: { radius: 12, solid: true },
  chest: { radius: 12, solid: false, chest: true },
  barrel: { radius: 11, solid: false, hp: 26, breakable: true, state: 'intact' },
  bones: { radius: 11, solid: false },
  rune_orb: { radius: 8, solid: false, spin: true },
};

// Each light gets a colour as well as a radius. Cutting the same white hole for
// every source is what made the ruin read as one flat blue wash: a torch, a
// brazier and a rune orb all lit their surroundings identically. The darkness
// pass still carves the hole; the colour pass tints it afterwards.
const LIGHTS = {
  torch: { radius: 155, colour: '255, 178, 96', strength: 0.62 },
  brazier: { radius: 215, colour: '255, 132, 58', strength: 0.72 },
  rune_orb: { radius: 130, colour: '146, 116, 255', strength: 0.66 },
};

// The knight's own pool, so you are never in pitch dark.
const LANTERN = { radius: 172, colour: '146, 178, 255', strength: 0.34 };

// Levelling used to be maxHp += 18, a free full heal and damage += 5 - three
// lines that never gave the player a decision, and the free heal meant potions
// stopped mattering halfway through a run. Now a level is a draft: three of
// these, take one. Levels still grant a small automatic bump on top.
const UPGRADES = [
  { id: 'edge', name: 'Whetstone', desc: '+20% attack damage', max: 5, apply: (p) => { p.damage *= 1.2; } },
  { id: 'vitality', name: 'Heartwood', desc: '+30 max HP, and heal for it', max: 5, apply: (p) => { p.maxHp += 30; p.hp = Math.min(p.maxHp, p.hp + 30); } },
  { id: 'haste', name: 'Quickened', desc: '+45% time to chain the next hit', max: 3, apply: (p) => { p.comboWindow *= 1.45; } },
  { id: 'footwork', name: 'Fleet', desc: '-25% dash cooldown', max: 3, apply: (p) => { p.dashCdMax *= 0.75; p.dashCooldown = Math.min(p.dashCooldown, p.dashCdMax); } },
  { id: 'cruel', name: 'Heavy Hands', desc: '+55% heavy attack damage', max: 3, apply: (p) => { p.heavyPower *= 1.55; } },
  { id: 'whirlwind', name: 'Whirlwind', desc: 'Your third hit sweeps a full circle', max: 1, apply: (p) => { p.whirlwind = true; } },
  { id: 'shockwave', name: 'Shockwave', desc: 'Dashing detonates and hurts what is close', max: 1, apply: (p) => { p.shockwave = true; } },
  { id: 'magnet', name: 'Soul Drain', desc: 'Souls come to you from twice as far', max: 1, apply: (p) => { p.magnet *= 2; } },
  { id: 'quiver', name: 'Quiver', desc: '+1 potion carried', max: 2, apply: (p) => { p.potions += 1; } },
  { id: 'resolve', name: 'Resolve', desc: '18% of hits land a killing blow', max: 4, apply: (p) => { p.crit += 0.18; } },
];

const DRAFT_SIZE = 3;

const SOULS_PER_LEVEL = [0, 45, 100, 175, 270, 390, 540];

// --- helpers -------------------------------------------------------------

export function facingFromVector(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

// --- world ---------------------------------------------------------------

export class World {
  constructor(map, tileset, sprites) {
    this.map = map;
    this.tileset = tileset;
    this.sprites = sprites;
    this.zones = readZones(map);
    this.props = this.#readProps();
  }

  #readProps() {
    return this.map.objects
      .filter((o) => PROP_TYPES[o.exportName])
      .map((o) => {
        const def = PROP_TYPES[o.exportName];
        return {
          kind: o.exportName,
          x: o.x,
          y: o.y,
          radius: def.radius,
          solid: def.solid,
          hp: def.hp || 0,
          maxHp: def.hp || 0,
          breakable: !!def.breakable,
          chest: !!def.chest,
          spin: !!def.spin,
          state: def.state || 'idle',
          opened: false,
          dead: false,
          anim: new Animator(this.sprites[o.exportName]),
          phase: Math.random() * TAU,
          props: o.props,
        };
      });
  }

  zone(id) {
    return this.zones.find((z) => z.id === id);
  }

  cellCentre(cx, cy) {
    return { x: (cx + 0.5) * this.map.tileW, y: (cy + 0.5) * this.map.tileH };
  }

  centreOfRect(rect) {
    const [x0, y0, x1, y1] = rect;
    return this.cellCentre((x0 + x1) / 2, (y0 + y1) / 2);
  }

  randomPointIn(zone, rng, tries = 40) {
    const [x0, y0, x1, y1] = zone.rect;
    for (let i = 0; i < tries; i++) {
      const cx = x0 + Math.floor(rng() * (x1 - x0 + 1));
      const cy = y0 + Math.floor(rng() * (y1 - y0 + 1));
      if (this.map.isSolid(cx, cy)) continue;
      const p = this.cellCentre(cx, cy);
      if (this.props.some((pr) => dist2(pr.x, pr.y, p.x, p.y) < 26 * 26)) continue;
      return p;
    }
    return this.centreOfRect(zone.rect);
  }

  blocked(x, y, r) {
    return this.map.circleBlocked(x, y, r, this.props);
  }

  // Slide a circle without tunnelling through rock or props.
  moveCircle(body, dx, dy) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 8));
    const sx = dx / steps;
    const sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      if (!this.blocked(body.x + sx, body.y, body.radius)) body.x += sx;
      if (!this.blocked(body.x, body.y + sy, body.radius)) body.y += sy;
    }
  }

  lineOfSight(ax, ay, bx, by) {
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 14);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = lerp(ax, bx, t);
      const y = lerp(ay, by, t);
      if (this.map.isSolid(Math.floor(x / this.map.tileW), Math.floor(y / this.map.tileH))) return false;
    }
    return true;
  }
}

function readZones(map) {
  const raw = map.properties?.zones;
  if (!raw) return [];
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn('[world] bad zones property', err);
    return [];
  }
}

// --- camera --------------------------------------------------------------

export class Camera {
  constructor(map, viewW, viewH) {
    Object.assign(this, { map, x: 0, y: 0, viewW, viewH, shake: 0, scale: 1 });
  }

  setView(w, h) {
    this.viewW = w;
    this.viewH = h;
    if (this.player) this.clamp();
  }

  snapTo(x, y) {
    // clamp() works on the top-left corner, so offset into centre-on-target first.
    this.x = x - this.viewW / 2;
    this.y = y - this.viewH / 2;
    this.clamp();
  }

  clamp() {
    const w = this.map.w * this.map.tileW;
    const h = this.map.h * this.map.tileH;
    this.x = w <= this.viewW ? (w - this.viewW) / 2 : clamp(this.x, 0, w - this.viewW);
    this.y = h <= this.viewH ? (h - this.viewH) / 2 : clamp(this.y, 0, h - this.viewH);
  }

  follow(x, y, dt) {
    const k = 1 - Math.pow(0.001, dt);
    this.x = lerp(this.x, x - this.viewW / 2, k);
    this.y = lerp(this.y, y - this.viewH / 2, k);
    this.clamp();
  }

  kick(amount) {
    if (!this.scale) return;
    this.shake = Math.min(15, this.shake + amount * this.scale);
  }
}

// --- effects -------------------------------------------------------------

export class Effects {
  constructor() {
    this.particles = [];
    this.floaters = [];
    this.rings = [];
    this.arcs = [];
  }

  burst(x, y, count, opts = {}) {
    const { colour = '#d8c9a8', speed = 90, life = 0.5, size = 2.5, gravity = 0, spread = TAU, angle = 0, lift = 0 } = opts;
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const s = speed * (0.45 + Math.random() * 0.8);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - lift,
        life: life * (0.6 + Math.random() * 0.7),
        maxLife: life,
        colour,
        size: size * (0.6 + Math.random() * 0.8),
        gravity,
      });
    }
  }

  ring(x, y, opts = {}) {
    const { radius = 10, grow = 90, life = 0.35, colour = '#fff', width = 3 } = opts;
    this.rings.push({ x, y, radius, grow, life, maxLife: life, colour, width });
  }

  // The visible sweep of a sword swing: an arc that opens outward.
  swing(x, y, angle, arc, reach, colour = '#cfe0ff', life = 0.2, width = 4) {
    this.arcs.push({
      x,
      y,
      a0: angle - arc / 2,
      sweep: arc,
      r0: reach * 0.35,
      r1: reach,
      life,
      maxLife: life,
      colour,
      width,
    });
  }

  text(x, y, text, colour = '#ffd479') {
    this.floaters.push({ x, y, text, colour, life: 0.9, maxLife: 0.9 });
  }

  update(dt) {
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const r of this.rings) {
      r.life -= dt;
      r.radius += r.grow * dt;
    }
    this.rings = this.rings.filter((r) => r.life > 0);

    for (const a of this.arcs) a.life -= dt;
    this.arcs = this.arcs.filter((a) => a.life > 0);

    for (const f of this.floaters) {
      f.life -= dt;
      f.y -= 28 * dt;
    }
    this.floaters = this.floaters.filter((f) => f.life > 0);
  }

  draw(ctx) {
    for (const r of this.rings) {
      const a = clamp(r.life / r.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = a * 0.85;
      ctx.strokeStyle = r.colour;
      ctx.lineWidth = Math.max(0.5, r.width * a);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    for (const a of this.arcs) {
      const t = 1 - a.life / a.maxLife; // 0 -> 1 as the blade sweeps through
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = a.colour;
      ctx.lineWidth = Math.max(0.5, a.width * (1 - t * 0.7));
      ctx.beginPath();
      ctx.arc(a.x, a.y, lerp(a.r0, a.r1, t), a.a0, a.a0 + a.sweep * Math.min(1, t * 1.6));
      ctx.stroke();
      ctx.restore();
    }

    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.fillStyle = p.colour;
      const s = p.size * (0.4 + clamp(p.life / p.maxLife, 0, 1) * 0.6);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 11px "Courier New", monospace';
    for (const f of this.floaters) {
      ctx.globalAlpha = clamp(f.life / f.maxLife, 0, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = f.colour;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();
  }
}

// --- entities ------------------------------------------------------------

let nextId = 1;

class Body {
  constructor(x, y, radius) {
    Object.assign(this, { id: nextId++, x, y, vx: 0, vy: 0, radius, facing: 'S', flash: 0, dead: false });
  }
}

export class Player extends Body {
  constructor(x, y) {
    super(x, y, P.radius);
    this.maxHp = P.maxHp;
    this.hp = P.maxHp;
    this.souls = 0;
    this.level = 1;
    this.damage = P.attackDamage;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.attackTimer = 0;
    this.attackHits = new Set();
    this.attackProps = new Set();
    this.invuln = 0;
    this.hurtFlash = 0;
    this.potions = 2;
    this.deathTimer = 0;
    this.inWater = false;
    this.anim = null;
    this.comboStep = -1;
    this.comboTimer = 0;
    this.swing = null;
    this.swingId = 0;
    this.ghosts = [];
    this.footTimer = 0;
    // Everything the draft can change. Kept on the player so a run's build is
    // legible in one place.
    this.comboWindow = P.comboWindow;
    this.dashCdMax = P.dashCooldown;
    this.heavyPower = 2.1;
    this.magnet = 96;
    this.crit = 0;
    this.whirlwind = false;
    this.shockwave = false;
    this.taken = [];
  }

  countOf(id) {
    return this.taken.filter((u) => u === id).length;
  }

  // Returns how many levels were gained; the Game turns that into a draft.
  addSouls(n) {
    this.souls += n;
    let gained = 0;
    while (this.level < SOULS_PER_LEVEL.length - 1 && this.souls >= SOULS_PER_LEVEL[this.level]) {
      this.level++;
      this.maxHp += 8;
      this.hp = Math.min(this.maxHp, this.hp + 8);
      this.damage += 3;
      gained++;
    }
    return gained;
  }

  soulFloor() {
    return SOULS_PER_LEVEL[this.level - 1] ?? 0;
  }

  soulCeiling() {
    return SOULS_PER_LEVEL[this.level] ?? SOULS_PER_LEVEL[SOULS_PER_LEVEL.length - 1];
  }

  hurt(amount, effects) {
    if (this.invuln > 0 || this.dead) return false;
    this.hp -= amount;
    this.invuln = P.invulnAfterHit;
    this.hurtFlash = 0.32;
    effects.burst(this.x, this.y - 14, 8, { colour: '#c4342b', speed: 120, life: 0.4 });
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
    }
    return true;
  }
}

export class Enemy extends Body {
  constructor(kind, x, y, zone) {
    const def = ENEMY_TYPES[kind];
    super(x, y, 12 * (def.scale || 1));
    Object.assign(this, {
      kind,
      def,
      maxHp: def.hp,
      hp: def.hp,
      scale: def.scale || 1,
      state: 'idle',
      stateTimer: Math.random() * 1.4,
      attackCd: Math.random() * def.cooldown,
      windup: 0,
      attackAnim: 0,
      castAnim: 0,
      // Knockback is an impulse that decays, not a teleport, so a hit reads as
      // a shove you can watch rather than a teleporting corpse.
      kx: 0,
      ky: 0,
      stagger: 0,
      moving: false,
      castMax: 0,
      summon: 0,
      tellFlash: 0,
      homeX: x,
      homeY: y,
      zone,
      aggro: false,
      deathTimer: 0,
      wander: null,
      wanderTime: 0,
      anim: null,
    });
  }

  get isBoss() {
    return !!this.def.boss;
  }
}

export class Projectile extends Body {
  constructor(x, y, vx, vy, opts = {}) {
    super(x, y, opts.radius || 5);
    Object.assign(this, {
      vx,
      vy,
      damage: opts.damage || 10,
      life: opts.life || 3,
      kind: opts.kind || 'orb',
      spin: Math.random() * TAU,
      trail: [],
    });
  }
}
export class Pickup extends Body {
  constructor(x, y, kind, value) {
    super(x, y, 9);
    Object.assign(this, { kind, value, bob: Math.random() * TAU, life: 40 });
  }
}

// --- game ----------------------------------------------------------------

export class Game {
  constructor(canvas, world, input) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.input = input;
    this.map = world.map;
    this.tileset = world.tileset;
    this.sprites = world.sprites;

    this.camera = new Camera(this.map, canvas.width, canvas.height);
    this.effects = new Effects();
    this.state = 'title';
    this.time = 0;
    this.messages = [];
    this.prompt = null;
    this.bossSpawned = false;
    this.bossDead = false;
    this.exitOpen = false;
    this.entities = [];
    this.projectiles = [];
    this.pickups = [];
    this.player = null;
    this.freeze = 0;
    this.lookAhead = { x: 0, y: 0 };
    this.lavaTimer = 0;
    this.roomsSeen = new Set();
    this.audio = null;
    // A draft is a modal pick; while one is open the sim is paused and nothing
    // ticks, so it is safe to open mid-fight.
    this.draft = null;
    this.pendingLevels = 0;

    this.spawn = world.zone('entry') || { rect: [8, 34, 10, 36], name: 'Entry' };
    this.extraction = world.zone('stairs_out');
    this.triggers = world.zones.filter((z) => z.kind === 'patrol' || z.kind === 'boss');
  }

  reset() {
    this.rng = mulberry32(0x9e3779b9);
    this.entities = [];
    this.projectiles = [];
    this.pickups = [];
    this.effects = new Effects();
    this.time = 0;
    this.messages = [];
    this.bossSpawned = false;
    this.bossDead = false;
    this.exitOpen = false;
    this.stats = { kills: 0, damageTaken: 0 };
    this.freeze = 0;
    this.lookAhead = { x: 0, y: 0 };
    this.lavaTimer = 0;
    this.roomsSeen = new Set([this.spawn.id]);
    this.draft = null;
    this.pendingLevels = 0;

    for (const p of this.world.props) {
      p.dead = false;
      p.opened = false;
      p.hp = p.maxHp;
      p.state = PROP_TYPES[p.kind].state || 'idle';
    }
    for (const t of this.triggers) {
      t.entered = false;
    }

    const start = this.world.centreOfRect(this.spawn.rect);
    this.player = new Player(start.x, start.y);
    this.player.anim = new Animator(this.sprites.hero);
    this.entities.push(this.player);
    this.camera.snapTo(this.player.x, this.player.y);
    this.cameraFollows = true;

    this.state = 'play';
    this.say('Grim Hollow — break the Warlock, then run.', '#b9a7ff');
  }

  say(text, colour = '#cbb994') {
    this.messages.push({ text, colour, life: 4.5 });
  }

  // --- loop --------------------------------------------------------------

  update(dt) {
    // A draft is a modal: the world stops until a card is chosen.
    if (this.draft) return;

    this.time += dt;
    for (const m of this.messages) m.life -= dt;
    this.messages = this.messages.filter((m) => m.life > 0);

    if (this.state !== 'play') {
      if (this.state === 'won' || this.state === 'lost') this.effects.update(dt);
      return;
    }

    // Hitstop: a few frozen frames on impact. The world holds still, the
    // shake and the particles still read, so a hit lands with weight.
    if (this.freeze > 0) {
      this.freeze -= dt;
      this.camera.shake = Math.max(0, this.camera.shake - dt * 30);
      return;
    }

    this.#updateTriggers();
    this.#updatePlayer(dt);
    this.#updateEnemies(dt);
    this.#updateProjectiles(dt);
    this.#updatePickups(dt);
    this.#updateProps(dt);
    this.effects.update(dt);

    this.camera.follow(this.player.x + this.lookAhead.x, this.player.y + this.lookAhead.y, dt);
    this.camera.shake = Math.max(0, this.camera.shake - dt * 42);

    const here = this.map.terrainAtPx(this.player.x, this.player.y);
    const wasWater = this.player.inWater;
    this.player.inWater = here === 'water';
    if (here === 'lava') {
      if (this.player.hurt(22 * dt, this.effects)) this.camera.kick(2);
      this.lavaTimer = (this.lavaTimer || 0) + dt;
      if (this.lavaTimer > 0.45) {
        this.lavaTimer = 0;
        this.effects.burst(this.player.x, this.player.y - 6, 5, { colour: '#ff7a2a', speed: 70, life: 0.5, lift: 60, gravity: -40 });
        this.audio?.lava();
      }
    }
    if (this.player.inWater !== wasWater && this.player.inWater) {
      this.effects.ring(this.player.x, this.player.y, { colour: '#6fd0ff', grow: 120, radius: 6, life: 0.3 });
    }

    // Tension drives the ambience: more live enemies, more menacing.
    if (this.audio) {
      const threat = Math.min(1, this.entities.filter((e) => e instanceof Enemy && !e.dead).length / 8 + (this.bossSpawned ? 0.4 : 0));
      this.audio.setTension(threat);
    }

    this.#checkExtraction();

    if (this.player.dead) {
      this.player.deathTimer += dt;
      if (this.player.deathTimer > 1.5) {
        this.state = 'lost';
        this.draft = null;
        this.pendingLevels = 0;
        this.audio?.lose();
        this.audio?.setTension(0);
      }
    }

    this.#maybeDraft();
  }

  #pointInRect(x, y, rect) {
    const cx = x / this.map.tileW;
    const cy = y / this.map.tileH;
    return cx >= rect[0] && cx <= rect[2] && cy >= rect[1] && cy <= rect[3];
  }

  #updateTriggers() {
    for (const z of this.triggers) {
      if (z.entered || !this.#pointInRect(this.player.x, this.player.y, z.rect)) continue;
      z.entered = true;
      this.roomsSeen.add(z.id);
      if (z.kind === 'patrol') {
        for (const kind of z.enemies || []) {
          const p = this.world.randomPointIn(z, this.rng);
          const enemy = new Enemy(kind, p.x, p.y, z);
          enemy.anim = new Animator(this.sprites[kind]);
          this.entities.push(enemy);
        }
        this.say(`— ${z.name} —`, '#e0b46a');
      } else if (z.kind === 'boss') {
        this.#spawnBoss(z);
      }
    }
  }

  #spawnBoss(zone) {
    if (this.bossSpawned) return;
    this.bossSpawned = true;
    const p = this.world.centreOfRect(zone.rect);
    const boss = new Enemy('darklord', p.x, p.y, zone);
    boss.anim = new Animator(this.sprites.darklord);
    boss.summon = 1.4;
    this.entities.push(boss);
    this.say('The Warlock rises. Break his rune!', '#c08cff');
    this.camera.kick(11);
    this.audio?.bossRoar();
  }

  // --- levelling draft ---------------------------------------------------

  // Open the next pick if a level is owed and the game is in a state where a
  // modal is welcome. Dying drops the queue rather than making you draft on
  // the death card.
  #maybeDraft() {
    if (this.draft || this.pendingLevels <= 0) return;
    if (this.state !== 'play' || this.player.dead) {
      if (this.state !== 'play') this.pendingLevels = 0;
      return;
    }
    const p = this.player;
    const pool = UPGRADES.filter((u) => p.countOf(u.id) < u.max);
    const cards = [];
    const bag = pool.slice();
    while (cards.length < DRAFT_SIZE && bag.length) {
      cards.push(bag.splice(Math.floor(this.rng() * bag.length), 1)[0]);
    }
    if (!cards.length) return;
    this.draft = cards;
    this.pendingLevels -= 1;
    this.audio?.levelUp();
  }

  choose(i) {
    const card = this.draft?.[i];
    if (!card) return false;
    this.draft = null;
    card.apply(this.player, this);
    this.player.taken.push(card.id);
    this.say(card.name, '#ffd479');
    this.effects.ring(this.player.x, this.player.y - 14, { colour: '#ffd479', grow: 280, radius: 8, life: 0.6, width: 5 });
    this.audio?.ui();
    return true;
  }

  #checkExtraction() {
    if (!this.exitOpen || !this.extraction || this.player.dead) return;
    if (this.#pointInRect(this.player.x, this.player.y, this.extraction.rect)) {
      this.state = 'won';
      this.audio?.win();
      this.audio?.setTension(0);
    }
  }

  // --- player ------------------------------------------------------------

  #updatePlayer(dt) {
    const p = this.player;
    const inp = this.input;

    p.invuln = Math.max(0, p.invuln - dt);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.attackTimer = Math.max(0, p.attackTimer - dt);
    p.comboTimer = Math.max(0, p.comboTimer - dt);
    if (p.comboTimer <= 0) p.comboStep = -1;
    p.attackHits.clear();
    p.attackProps.clear();

    let dx = inp.axis.x;
    let dy = inp.axis.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      dx /= len;
      dy /= len;
      p.facing = facingFromVector(dx, dy);
    }
    p.vx = dx * P.speed;
    p.vy = dy * P.speed;

    // Camera drifts a little ahead of where you are heading.
    const wantAhead = 46;
    this.lookAhead.x = lerp(this.lookAhead.x, dx * wantAhead, 1 - Math.pow(0.02, dt));
    this.lookAhead.y = lerp(this.lookAhead.y, dy * wantAhead, 1 - Math.pow(0.02, dt));

    if (inp.consume('dash') && p.dashCooldown <= 0 && len > 0) {
      p.dashTimer = P.dashTime;
      p.dashCooldown = p.dashCdMax;
      p.invuln = Math.max(p.invuln, P.dashTime + 0.08);
      for (let i = 0; i < 4; i++) {
        p.ghosts.push({ x: p.x - dx * i * 5, y: p.y - dy * i * 5, life: 0.3, maxLife: 0.3 });
      }
      this.effects.burst(p.x, p.y - 12, 10, { colour: '#8fa6d8', speed: 130, life: 0.35, lift: 12 });
      this.audio?.dash();

      // Shockwave upgrade: the dash itself is the hit.
      if (p.shockwave) {
        const R = 74;
        this.effects.ring(p.x, p.y - 10, { colour: '#9fc4ff', grow: R * 2.6, radius: 10, life: 0.34, width: 4 });
        this.audio?.hit(true);
        this.camera.kick(4);
        for (const e of this.entities) {
          if (!(e instanceof Enemy) || e.dead) continue;
          if (Math.hypot(e.x - p.x, e.y - p.y) > R + e.radius) continue;
          const a = Math.atan2(e.y - p.y, e.x - p.x);
          this.#damageEnemy(e, p.damage * 0.8, a, false);
        }
      }
    }
    for (const g of p.ghosts) g.life -= dt;
    p.ghosts = p.ghosts.filter((g) => g.life > 0);

    let speed = p.inWater ? P.speed * 0.62 : P.speed;
    if (p.dashTimer > 0) {
      speed = P.dashSpeed;
      p.dashTimer -= dt;
    }

    const heavy = inp.consume('heavy');
    const light = inp.consume('attack');
    if ((heavy || light) && p.attackTimer <= 0) {
      if (heavy) {
        p.comboStep = -1;
        p.swing = HEAVY_BEAT;
      } else {
        p.comboStep = p.comboTimer > 0 ? (p.comboStep + 1) % COMBO.length : 0;
        p.comboTimer = P.comboWindow;
        p.swing = COMBO[p.comboStep];
      }
      p.attackTimer = p.swing.time;
      p.swingId += 1;
      p.attackHits.clear();
      this.audio?.swing(!!p.swing.heavy);
    }
    if (p.attackTimer > 0 && p.swing) {
      const total = p.swing.time;
      if (total - p.attackTimer > total * 0.3) this.#resolveSwing();
      speed *= p.swing.heavy ? 0.35 : 0.72;
    }

    this.world.moveCircle(p, dx * speed * dt, dy * speed * dt);

    // Footsteps, spaced by distance rather than time.
    if (len > 0 && p.dashTimer <= 0 && p.attackTimer <= 0) {
      p.footTimer -= dt * speed;
      if (p.footTimer <= 0) {
        p.footTimer = 34;
        this.audio?.step(!p.inWater);
        if (this.rng() < 0.5) {
          this.effects.burst(p.x, p.y, 2, { colour: p.inWater ? '#7fc8ff' : '#6b6459', speed: 26, life: 0.3, size: 1.6, spread: 1.2, angle: Math.PI / 2 });
        }
      }
    }

    // Animation
    const a = p.anim;
    if (p.attackTimer > 0 && p.swing) {
      // restart only when the swing begins, or the clip would be pinned to frame 0
      if (p.swingId !== a.swingId) {
        a.play(this.sprites.hero.find(p.swing.move, p.facing) || this.sprites.hero.find('idle', p.facing), { restart: true });
        a.swingId = p.swingId;
      }
    } else if (len > 0) {
      a.play(this.sprites.hero.find('walk', p.facing) || this.sprites.hero.find('idle', p.facing));
    } else {
      a.play(this.sprites.hero.find('idle', p.facing));
    }
    a.update(dt);

    // Potions
    if (inp.consume('potion') && p.potions > 0 && p.hp < p.maxHp) {
      p.potions--;
      const healed = Math.min(45, p.maxHp - p.hp);
      p.hp += healed;
      this.effects.ring(p.x, p.y - 12, { colour: '#ff8fa8', grow: 150, radius: 8 });
      this.effects.burst(p.x, p.y - 12, 14, { colour: '#ff9fb4', speed: 100, life: 0.6, lift: 20 });
      this.effects.text(p.x, p.y - 26, `+${Math.round(healed)} HP`, '#ff9fb4');
      this.audio?.potion();
    }

    // Interaction prompt
    this.prompt = null;
    for (const prop of this.world.props) {
      if (prop.dead || !prop.chest || prop.opened) continue;
      if (dist2(prop.x, prop.y, p.x, p.y) < 30 * 30) {
        this.prompt = { text: '[E] open the chest', prop };
        break;
      }
    }
    if (inp.consume('interact') && this.prompt) this.#openChest(this.prompt.prop);
  }

  #openChest(prop) {
    prop.opened = true;
    const loot = (prop.props?.loot || 'souls').split(',');
    const taken = [];
    for (const item of loot) {
      const kind = item.trim();
      if (!kind) continue;
      if (kind === 'potion') {
        this.player.potions++;
        taken.push('potion');
      } else {
        const value = 30 + Math.floor(this.rng() * 40);
        this.pickups.push(new Pickup(prop.x, prop.y - 10, 'souls', value));
        taken.push(`${value} souls`);
      }
    }
    this.effects.ring(prop.x, prop.y - 8, { colour: '#ffd479', grow: 170, radius: 6 });
    this.effects.burst(prop.x, prop.y - 8, 18, { colour: '#ffd479', speed: 130, life: 0.7, lift: 40 });
    this.audio?.chest();
    this.say(`Chest: ${taken.join(', ')}`, '#ffd479');
  }

  #resolveSwing() {
    const p = this.player;
    const beat = p.swing || COMBO[0];
    const heavy = !!beat.heavy;
    const reach = heavy ? beat.reach : P.attackReach * beat.reach;
    const finisher = beat === COMBO[COMBO.length - 1];
    const arc = p.whirlwind && finisher && !heavy ? TAU : heavy ? beat.arc : P.attackArc * beat.arc;
    let damage = p.damage * (heavy ? p.heavyPower : beat.damage);
    const crit = this.rng() < p.crit;
    if (crit) damage *= 2;
    const base = { S: Math.PI / 2, W: Math.PI, E: 0, N: -Math.PI / 2 }[p.facing];

    let hit = false;
    for (const e of this.entities) {
      if (!(e instanceof Enemy) || e.dead || e.summon > 0 || p.attackHits.has(e.id)) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d > reach + e.radius) continue;
      const a = Math.atan2(e.y - p.y, e.x - p.x);
      const diff = Math.abs(((a - base + Math.PI * 3) % TAU) - Math.PI);
      if (diff > arc / 2) continue;
      p.attackHits.add(e.id);
      this.#damageEnemy(e, damage, a, heavy, crit);
      hit = true;
    }

    // Barrels smash, which opens a shortcut to their contents.
    for (const prop of this.world.props) {
      if (prop.dead || !prop.breakable || p.attackProps.has(prop)) continue;
      const d = Math.hypot(prop.x - p.x, prop.y - p.y);
      if (d > reach + prop.radius) continue;
      const a = Math.atan2(prop.y - p.y, prop.x - p.x);
      const diff = Math.abs(((a - base + Math.PI * 3) % TAU) - Math.PI);
      if (diff > arc / 2) continue;
      p.attackProps.add(prop);
      prop.hp -= heavy ? damage * 2 : damage;
      prop.flash = 0.12;
      hit = true;
      if (prop.hp <= 0) {
        prop.dead = true;
        this.audio?.smash();
        this.effects.burst(prop.x, prop.y - 12, 24, { colour: '#8a5a30', speed: 170, life: 0.7, lift: 40 });
        this.effects.ring(prop.x, prop.y - 12, { colour: '#c99a5a', grow: 150, radius: 8 });
        if (this.rng() < 0.55) this.pickups.push(new Pickup(prop.x, prop.y, 'souls', 15 + Math.floor(this.rng() * 25)));
        if (this.rng() < 0.25) this.pickups.push(new Pickup(prop.x, prop.y, 'heart', 1));
      } else if (prop.state !== 'damaged') {
        prop.state = 'damaged';
        this.say('The barrel cracks.', '#c9a06a');
      }
    }

    if (hit) {
      this.freeze = heavy ? 0.075 : 0.04;
      this.camera.kick(heavy ? 6 : 3);
      this.audio?.hit(heavy);
    } else {
      this.effects.swing(p.x, p.y - 14, base, arc, reach, heavy ? '#ffd479' : '#cfe0ff', 0.2, heavy ? 6 : 4);
    }
  }

  #damageEnemy(enemy, amount, angle, heavy = false, crit = false) {
    enemy.hp -= amount;
    enemy.flash = 0.15;
    enemy.aggro = true;
    enemy.state = 'chase';
    // A boss is too heavy to be shoved around or interrupted, so heavy attacks
    // land as damage rather than as a stun.
    if (!enemy.isBoss) {
      const push = heavy ? 300 : 150;
      enemy.kx += Math.cos(angle) * push;
      enemy.ky += Math.sin(angle) * push;
      enemy.stagger = heavy ? 0.26 : 0.13;
      enemy.windup = 0;
      enemy.attackAnim = 0;
      enemy.castAnim = 0;
    }
    this.effects.burst(enemy.x, enemy.y - enemy.radius, heavy ? 14 : 8, {
      colour: enemy.isBoss ? '#c08cff' : '#b8342a',
      speed: heavy ? 170 : 120,
      life: 0.4,
      lift: 18,
    });
    this.effects.text(
      enemy.x,
      enemy.y - enemy.radius * 2.2,
      crit ? `${Math.round(amount)}!` : String(Math.round(amount)),
      crit ? '#ff9a4d' : '#ffe08a',
    );

    if (enemy.hp <= 0) {
      enemy.dead = true;
      this.stats.kills++;
      const levelled = this.player.addSouls(enemy.def.souls);
      if (levelled) this.pendingLevels += levelled;
      this.effects.burst(enemy.x, enemy.y - enemy.radius, enemy.isBoss ? 60 : 22, {
        colour: enemy.isBoss ? '#b47bff' : '#8a3a2a',
        speed: 180,
        life: 0.7,
        lift: 40,
      });
      this.effects.ring(enemy.x, enemy.y - enemy.radius, { colour: enemy.isBoss ? '#c08cff' : '#d9b98a', grow: 190, radius: 8 });
      this.audio?.die(enemy.isBoss);
      if (this.rng() < 0.3) this.pickups.push(new Pickup(enemy.x, enemy.y - 12, 'souls', Math.round(enemy.def.souls / 2)));
      if (levelled) {
        this.audio?.levelUp();
        this.say(`Level ${this.player.level}!`, '#a9d8ff');
        this.effects.ring(this.player.x, this.player.y - 14, { colour: '#a9d8ff', grow: 260, radius: 10, life: 0.6, width: 5 });
      }
      if (enemy.isBoss) {
        this.bossDead = true;
        this.exitOpen = true;
        this.say('The rune shatters — get to the stairwell!', '#9ce8b0');
        this.camera.kick(15);
      }
    }
  }

  // --- enemies -----------------------------------------------------------

  #updateEnemies(dt) {
    const p = this.player;
    for (const e of this.entities) {
      if (!(e instanceof Enemy)) continue;

      if (e.dead) {
        e.deathTimer += dt;
        this.#animateEnemy(e, dt);
        continue;
      }
      e.flash = Math.max(0, e.flash - dt);
      e.attackCd -= dt;
      e.attackAnim = Math.max(0, e.attackAnim - dt);
      e.castAnim = Math.max(0, e.castAnim - dt);
      e.tellFlash = Math.max(0, (e.tellFlash || 0) - dt);

      if (e.summon > 0) {
        e.summon -= dt;
        e.flash = 0.18;
        if (this.time % 0.1 < dt) this.effects.burst(e.x, e.y - 18, 4, { colour: '#a45cff', speed: 70, life: 0.5, lift: 30 });
        continue;
      }

      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;

      if (!e.aggro && dist < e.def.aggro && this.world.lineOfSight(e.x, e.y, p.x, p.y)) {
        e.aggro = true;
        e.state = 'chase';
      }
      if (e.aggro && dist > 700) e.aggro = false;

      let move = { x: 0, y: 0 };
      if (e.stagger > 0) {
        // Windup is the enemy's warning; being hit for it should cost them the
        // swing, which is what makes reading a tell worth the effort.
        e.stagger -= dt;
        e.state = 'hurt';
      } else if (e.aggro) {
        move = e.def.ranged ? this.#rangedBrain(e, p, dx, dy, dist, dt) : this.#meleeBrain(e, p, dx, dy, dist, dt);
        e.facing = facingFromVector(dx, dy);
      } else {
        e.stateTimer -= dt;
        if (e.stateTimer <= 0) {
          e.stateTimer = 1 + this.rng() * 2.5;
          const a = this.rng() * TAU;
          e.wander = { x: Math.cos(a), y: Math.sin(a) };
          e.wanderTime = 0.8 + this.rng();
        }
        if (e.wander) {
          e.wanderTime -= dt;
          if (e.wanderTime <= 0) e.wander = null;
          else move = e.wander;
        }
      }

      let vx = move.x * e.def.speed * (e.aggro ? 1 : 0.32);
      let vy = move.y * e.def.speed * (e.aggro ? 1 : 0.32);

      // Soft separation so a pack does not collapse into one pixel.
      for (const other of this.entities) {
        if (other === e || !(other instanceof Enemy) || other.dead) continue;
        const ox = e.x - other.x;
        const oy = e.y - other.y;
        const d2 = ox * ox + oy * oy;
        const min = (e.radius + other.radius) * 1.05;
        if (d2 > 0.01 && d2 < min * min) {
          const d = Math.sqrt(d2);
          vx += (ox / d) * 70;
          vy += (oy / d) * 70;
        }
      }

      const wasX = e.x;
      const wasY = e.y;
      this.world.moveCircle(e, vx * dt, vy * dt);
      e.moving = Math.hypot(e.x - wasX, e.y - wasY) > 0.4;

      if (e.kx || e.ky) {
        this.world.moveCircle(e, e.kx * dt, e.ky * dt);
        const damp = Math.exp(-9 * dt);
        e.kx *= damp;
        e.ky *= damp;
        if (Math.abs(e.kx) < 2 && Math.abs(e.ky) < 2) {
          e.kx = 0;
          e.ky = 0;
        }
      }
      this.#animateEnemy(e, dt);
    }

    this.entities = this.entities.filter((e) => !(e instanceof Enemy && e.dead && e.deathTimer > 1.1));
  }

  #animateEnemy(e, dt) {
    const sprite = this.sprites[e.kind];
    if (!sprite || !e.anim) return;
    const f = e.facing;
    // Assets register a bare alias per clip (sword_death_S is also death_S), so
    // the game can ask for "death" without knowing which weapon it is holding.
    const find = (m) => sprite.find(m, f) || sprite.find(m, 'S');

    if (e.dead) {
      // Sixteen generated death animations that used to play exactly zero times.
      e.anim.play(find('death') || find('idle'), { restart: e.deathTimer < dt * 2 });
      e.anim.update(dt);
      return;
    }
    if (e.castAnim > 0) {
      // A bow draws and then looses. A staff has no cast clip at all, so it
      // winds up with the swing it actually has rather than playing a walk.
      const half = (e.castMax || 0) * 0.5;
      e.anim.play(e.castAnim > half ? (find('draw') || find('attack_1')) : (find('shoot') || find('attack_1') || find('idle')), {
        restart: e.castAnim > (e.castMax || 0),
      });
    } else if (e.attackAnim > 0) {
      e.anim.play((e.attackAnim > 0.22 ? find('attack_2') : find('attack_1')) || find('attack_1'), { restart: e.attackAnim > 0.34 });
    } else if (e.aggro && e.moving) {
      e.anim.play(find('run') || find('walk') || find('idle'));
    } else if (e.moving) {
      e.anim.play(find('walk') || find('idle'));
    } else {
      e.anim.play(find('idle') || find('walk'));
    }
    e.anim.update(dt);
  }

  #meleeBrain(e, p, dx, dy, dist, dt) {
    const want = e.def.reach + p.radius + e.radius - 6;
    if (dist > want) {
      e.state = 'chase';
      return { x: dx / dist, y: dy / dist };
    }
    e.state = 'attack';

    // Windup first, strike at the end of it: the tell is the fair warning.
    if (e.windup > 0) {
      e.windup -= dt;
      if (e.windup <= 0) {
        const angle = Math.atan2(dy, dx);
        if (dist < e.radius + p.radius + 12 && p.hurt(e.def.damage, this.effects)) {
          this.stats.damageTaken += e.def.damage;
          this.camera.kick(7);
          this.freeze = 0.05;
          this.audio?.hurt();
          this.effects.text(p.x, p.y - 26, `-${e.def.damage}`, '#ff7a7a');
        }
        this.audio?.flesh();
        this.effects.burst(e.x + Math.cos(angle) * e.radius, e.y + Math.sin(angle) * e.radius - 8, 6, {
          colour: '#d05a4a',
          speed: 110,
          life: 0.3,
          spread: 1.4,
          angle,
        });
      }
      return { x: 0, y: 0 };
    }

    if (e.attackCd <= 0) {
      e.attackCd = e.def.cooldown;
      e.windup = ENEMY_WINDUP;
      e.attackAnim = ENEMY_WINDUP + 0.2;
      e.tellFlash = ENEMY_WINDUP;
    }
    // A little circling so melee enemies are not static.
    const side = Math.sin(this.time * 1.7 + e.id) * 0.35;
    return { x: (-dy / dist) * side, y: (dx / dist) * side };
  }

  #rangedBrain(e, p, dx, dy, dist, dt) {
    const want = e.def.range;
    if (e.windup > 0) {
      e.windup -= dt;
      if (e.windup <= 0) {
        const cast = e.kind === 'goblin_shaman';
        const speed = e.def.ranged === 'arrow' ? 255 : 165;
        const lead = e.def.ranged === 'arrow' ? 0.22 : 0.1;
        const a = Math.atan2(p.y + p.vy * lead - e.y, p.x + p.vx * lead - e.x);
        this.projectiles.push(
          new Projectile(e.x + Math.cos(a) * (e.radius + 6), e.y + Math.sin(a) * (e.radius + 6) - 8, Math.cos(a) * speed, Math.sin(a) * speed, {
            damage: e.def.damage,
            kind: e.def.ranged,
            life: 3,
          }),
        );
        this.effects.burst(e.x + Math.cos(a) * e.radius, e.y + Math.sin(a) * e.radius - 8, 8, {
          colour: cast ? '#b47bff' : '#e8d8a8',
          speed: 120,
          life: 0.3,
          spread: 0.9,
          angle: a,
        });
      }
      return { x: 0, y: 0 };
    }

    if (e.attackCd <= 0 && dist < want && this.world.lineOfSight(e.x, e.y, p.x, p.y)) {
      e.attackCd = e.def.cooldown;
      e.windup = ENEMY_WINDUP + 0.12;
      e.castAnim = ENEMY_WINDUP + 0.22;
      e.castMax = e.castAnim;
      e.tellFlash = ENEMY_WINDUP;
    }

    if (dist > want * 0.78) return { x: dx / dist, y: dy / dist };
    if (dist < want * 0.42) return { x: -dx / dist, y: -dy / dist };
    const side = Math.sin(this.time * 0.9 + e.id) > 0 ? 1 : -1;
    return { x: (-dy / dist) * side, y: (dx / dist) * side };
  }

  // --- other -------------------------------------------------------------

  #updateProjectiles(dt) {
    const p = this.player;
    for (const pr of this.projectiles) {
      pr.life -= dt;
      pr.spin += dt * 9;
      pr.trail.push({ x: pr.x, y: pr.y });
      if (pr.trail.length > 7) pr.trail.shift();
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;

      if (this.map.circleBlocked(pr.x, pr.y, pr.radius)) {
        pr.life = 0;
        this.effects.burst(pr.x, pr.y, 6, { colour: pr.kind === 'arrow' ? '#c8b48a' : '#b47bff', speed: 80, life: 0.3 });
        continue;
      }
      if (!p.dead && dist2(pr.x, pr.y, p.x, p.y - 14) < (pr.radius + p.radius) ** 2) {
        if (p.hurt(pr.damage, this.effects)) {
          this.stats.damageTaken += pr.damage;
          this.camera.kick(5);
          this.effects.text(p.x, p.y - 26, `-${pr.damage}`, '#ff7a7a');
          this.audio?.hurt();
        }
        pr.life = 0;
      }
    }
    this.projectiles = this.projectiles.filter((x) => x.life > 0);
  }

  #updatePickups(dt) {
    const p = this.player;
    for (const it of this.pickups) {
      it.life -= dt;
      it.bob += dt * 4;
      if (p.dead) continue;
      const d = Math.hypot(p.x - it.x, p.y - 14 - (it.y - 14)) || 1;
      if (d < p.magnet) {
        const pull = (1 - d / p.magnet) * 430;
        it.x += ((p.x - it.x) / d) * pull * dt;
        it.y += ((p.y - 14 - it.y) / d) * pull * dt;
      }
      if (d < 24) {
        it.taken = true;
        if (it.kind === 'souls') {
          this.pendingLevels += p.addSouls(it.value);
          this.audio?.souls();
          this.effects.text(it.x, it.y - 12, `+${it.value} souls`, '#a9d8ff');
        } else {
          p.hp = Math.min(p.maxHp, p.hp + 25);
          this.audio?.pickup();
          this.effects.text(it.x, it.y - 12, '+25 HP', '#ff9fb4');
          this.effects.burst(it.x, it.y - 12, 10, { colour: '#ff9fb4', speed: 90, life: 0.5, lift: 20 });
        }
      }
    }
    this.pickups = this.pickups.filter((it) => !it.taken && it.life > 0);
  }

  #updateProps(dt) {
    for (const prop of this.world.props) {
      const sprite = this.sprites[prop.kind];
      prop.phase += dt;
      prop.flash = Math.max(0, (prop.flash || 0) - dt);
      if (!sprite || !prop.anim) continue;
      const clip = prop.spin ? sprite.find('spin', 'S') : sprite.find(prop.state, 'S') || sprite.find('idle', 'S');
      prop.anim.play(clip, { restart: prop.spin });
      prop.anim.update(dt);
    }
  }

  // --- rendering ---------------------------------------------------------

  resize(w, h) {
    this.camera.setView(w, h);
    if (this.player) this.camera.snapTo(this.player.x, this.player.y);
    this._lightCanvas = null;
  }

  // Set to true to count canvas calls; used by perf.html.
  stats = null;

  draw() {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#07050b';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const sx = cam.shake ? (Math.random() - 0.5) * cam.shake : 0;
    const sy = cam.shake ? (Math.random() - 0.5) * cam.shake : 0;

    ctx.save();
    ctx.translate(Math.round(-cam.x + sx), Math.round(-cam.y + sy));
    this.#drawGround(ctx);
    this.#drawPickups(ctx);
    this.#drawProjectiles(ctx);
    this.#drawSorted(ctx);
    this.effects.draw(ctx);
    ctx.restore();

    this.#drawLighting(ctx);
    this.#drawDanger(ctx);
  }

  #visibleBounds() {
    const cam = this.camera;
    return {
      x0: Math.max(0, Math.floor(cam.x / this.map.tileW) - 1),
      y0: Math.max(0, Math.floor(cam.y / this.map.tileH) - 1),
      x1: Math.min(this.map.w, Math.ceil((cam.x + cam.viewW) / this.map.tileW) + 1),
      y1: Math.min(this.map.h, Math.ceil((cam.y + cam.viewH) / this.map.tileH) + 1),
    };
  }

  #drawGround(ctx) {
    const { x0, y0, x1, y1 } = this.#visibleBounds();
    const tw = this.map.tileW;
    const th = this.map.tileH;
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const id = this.map.localIds[this.map.idx(cx, cy)];
        if (id >= 0) this.tileset.draw(ctx, id, cx * tw, cy * th);
      }
    }
  }

  // Props and actors together, sorted by their ground line.
  #drawSorted(ctx) {
    const items = [];
    for (const prop of this.world.props) {
      if (!prop.dead) items.push({ y: prop.y, draw: () => this.#drawProp(ctx, prop) });
    }
    for (const e of this.entities) {
      if (!(e instanceof Enemy) || e.summon > 0) continue;
      if (e.dead && e.deathTimer > 1.1) continue;
      items.push({ y: e.y, draw: () => this.#drawEnemy(ctx, e) });
    }
    if (this.player) items.push({ y: this.player.y, draw: () => this.#drawPlayer(ctx) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
  }

  #drawProp(ctx, prop) {
    const sprite = this.sprites[prop.kind];
    if (!sprite || !prop.anim?.clip) return;
    sprite.draw(ctx, prop.anim.clip, prop.x, prop.y, 1);
    if (prop.opened) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#1a1410';
      ctx.fillRect(prop.x - 6, prop.y - 4, 12, 4);
      ctx.restore();
    }
  }

  #drawEnemy(ctx, e) {
    const sprite = this.sprites[e.kind];
    if (!sprite || !e.anim?.clip) return;

    if (e.dead) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, e.deathTimer - 0.65) / 0.45);
      sprite.draw(ctx, e.anim.clip, e.x, e.y, e.scale);
      ctx.restore();
      return;
    }

    if (e.summon > 0) {
      ctx.save();
      ctx.globalAlpha = 0.35 + Math.sin(this.time * 14) * 0.2;
      sprite.draw(ctx, e.anim.clip, e.x, e.y, e.scale);
      ctx.restore();
      return;
    }

    this.#drawShadow(ctx, e, sprite, e.scale);
    // The windup tell: the enemy flares just before its blow lands.
    if (e.tellFlash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.8, e.tellFlash * 3.4);
      ctx.globalCompositeOperation = 'lighter';
      sprite.draw(ctx, e.anim.clip, e.x, e.y, e.scale);
      ctx.restore();
    }
    if (e.flash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, e.flash * 5);
      ctx.globalCompositeOperation = 'lighter';
      sprite.draw(ctx, e.anim.clip, e.x, e.y, e.scale);
      ctx.restore();
    }
    sprite.draw(ctx, e.anim.clip, e.x, e.y, e.scale);

    if (e.hp < e.maxHp) {
      const w = e.isBoss ? 60 : 26;
      const y = e.y - sprite.pivot.y * e.scale - 8;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(e.x - w / 2 - 1, y - 1, w + 2, 5);
      ctx.fillStyle = e.isBoss ? '#a25cff' : '#d1463b';
      ctx.fillRect(e.x - w / 2, y, w * Math.max(0, e.hp / e.maxHp), 3);
    }
  }

  #drawPlayer(ctx) {
    const p = this.player;
    const sprite = this.sprites.hero;
    if (!sprite || !p.anim?.clip) return;

    if (p.dead) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, p.deathTimer - 1.0) / 0.5);
      sprite.draw(ctx, p.anim.clip, p.x, p.y, 1);
      ctx.restore();
      return;
    }

    // Dash afterimages.
    for (const g of p.ghosts) {
      const a = (g.life / g.maxLife) * 0.4;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.globalCompositeOperation = 'lighter';
      sprite.draw(ctx, p.anim.clip, g.x, g.y, 1);
      ctx.restore();
    }

    this.#drawShadow(ctx, p, sprite, 1);
    if (p.invuln > 0 && Math.floor(this.time * 24) % 2 === 0) ctx.globalAlpha = 0.5;
    sprite.draw(ctx, p.anim.clip, p.x, p.y, 1);
    ctx.globalAlpha = 1;

    if (p.hurtFlash > 0) {
      ctx.save();
      ctx.globalAlpha = p.hurtFlash * 1.4;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath();
      ctx.arc(p.x, p.y - 20, 17, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  // A pulsing red edge when you are nearly dead.
  #drawDanger(ctx) {
    const p = this.player;
    if (!p || p.dead || p.hp / p.maxHp > 0.34) return;
    const t = clamp((0.34 - p.hp / p.maxHp) / 0.34, 0, 1);
    const pulse = 0.5 + Math.sin(this.time * (4 + t * 5)) * 0.5;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.62);
    g.addColorStop(0, 'rgba(190,20,25,0)');
    g.addColorStop(1, `rgba(190,20,25,${0.14 + t * 0.3 * pulse})`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // The generator already bakes a shadow into each frame; this adds the small
  // contact shadow that keeps actors planted on the tile grid.
  #drawShadow(ctx, e, sprite, scale) {
    const r = 11 * scale;
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(e.x, e.y, r, r * 0.42, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  #drawPickups(ctx) {
    for (const it of this.pickups) {
      const bob = Math.sin(it.bob) * 2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (it.kind === 'souls') {
        const g = ctx.createRadialGradient(it.x, it.y - 8 + bob, 0, it.x, it.y - 8 + bob, 9);
        g.addColorStop(0, 'rgba(190,225,255,0.95)');
        g.addColorStop(1, 'rgba(90,160,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(it.x, it.y - 8 + bob, 9, 0, TAU);
        ctx.fill();
      } else {
        const g = ctx.createRadialGradient(it.x, it.y - 8 + bob, 0, it.x, it.y - 8 + bob, 10);
        g.addColorStop(0, 'rgba(255,180,200,0.95)');
        g.addColorStop(1, 'rgba(255,80,130,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(it.x, it.y - 8 + bob, 10, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  #drawProjectiles(ctx) {
    for (const pr of this.projectiles) {
      ctx.save();
      ctx.strokeStyle = pr.kind === 'arrow' ? 'rgba(232,216,168,0.3)' : 'rgba(180,123,255,0.3)';
      ctx.lineWidth = pr.kind === 'arrow' ? 1.5 : 4;
      ctx.beginPath();
      ctx.moveTo(pr.trail[0]?.x ?? pr.x, pr.trail[0]?.y ?? pr.y);
      for (const t of pr.trail) ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.restore();

      // The generated arrow / rune sprites, oriented along the flight path.
      const sprite = this.sprites[pr.kind];
      const clip = pr.kind === 'arrow' ? sprite?.find('projectile', 'E') : sprite?.find('spin', 'S');
      if (sprite && clip) {
        ctx.save();
        if (pr.kind === 'arrow') {
          ctx.translate(pr.x, pr.y);
          ctx.rotate(Math.atan2(pr.vy, pr.vx));
          sprite.draw(ctx, clip, 0, 0, 1);
        } else {
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, 16);
          g.addColorStop(0, 'rgba(215,185,255,0.55)');
          g.addColorStop(1, 'rgba(140,70,255,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(pr.x, pr.y, 16, 0, TAU);
          ctx.fill();
          sprite.draw(ctx, clip, pr.x, pr.y, 0.85);
        }
        ctx.restore();
        return;
      }

      // Fallback if a render is missing.
      if (pr.kind === 'arrow') {
        ctx.save();
        ctx.translate(pr.x, pr.y);
        ctx.rotate(Math.atan2(pr.vy, pr.vx));
        ctx.fillStyle = '#e8d8a8';
        ctx.fillRect(-7, -1, 12, 2);
        ctx.fillStyle = '#c0b090';
        ctx.fillRect(-7, -3, 3, 6);
        ctx.restore();
      } else {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const r = 8 + Math.sin(pr.spin) * 1.5;
        const g = ctx.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, r * 2.2);
        g.addColorStop(0, 'rgba(225,200,255,0.95)');
        g.addColorStop(1, 'rgba(140,70,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, r * 2.2, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  #drawLighting(ctx) {
    if (!this._lightCanvas) {
      this._lightCanvas = document.createElement('canvas');
      this._lightCanvas.width = this.canvas.width;
      this._lightCanvas.height = this.canvas.height;
    }
    // One pre-rendered radial glow per colour, blitted per light. Building a
    // fresh gradient for every torch on every frame is the single most expensive
    // thing this renderer could do, and it is entirely avoidable.
    const build = (key, stops) => {
      this._glows = this._glows || new Map();
      let g = this._glows.get(key);
      if (g) return g;
      g = document.createElement('canvas');
      g.width = g.height = 128;
      const c = g.getContext('2d');
      const grad = c.createRadialGradient(64, 64, 0, 64, 64, 64);
      for (const [at, a] of stops) grad.addColorStop(at, `rgba(${key},${a})`);
      c.fillStyle = grad;
      c.fillRect(0, 0, 128, 128);
      this._glows.set(key, g);
      return g;
    };
    // How far the darkness is carved back; the colour profile falls off faster,
    // so a lit floor keeps contrast instead of going flat and milky.
    const carve = () => build('255,255,255', [[0, 1], [0.55, 0.72], [1, 0]]);
    const glow = (colour) => build(colour, [[0, 0.85], [0.32, 0.34], [0.68, 0.08], [1, 0]]);

    const lc = this._lightCanvas;
    const lctx = lc.getContext('2d');
    const W = lc.width;
    const H = lc.height;

    // Collect the lights once so the darkness pass and the colour pass agree.
    const lights = [];
    const add = (x, y, r, colour, strength) => {
      const sx = x - this.camera.x;
      const sy = y - this.camera.y;
      if (sx < -r || sy < -r || sx > W + r || sy > H + r) return;
      lights.push({ sx, sy, r, colour, strength });
    };

    if (this.player && !this.player.dead) {
      add(this.player.x, this.player.y - 16, LANTERN.radius, LANTERN.colour, LANTERN.strength);
    }

    for (const prop of this.world.props) {
      const light = LIGHTS[prop.kind];
      if (!light || prop.dead) continue;
      const flick = 0.92 + Math.sin(this.time * 7 + prop.phase) * 0.05 + Math.sin(this.time * 13.3 + prop.phase * 2) * 0.03;
      add(prop.x, prop.y - 14, light.radius * flick, light.colour, light.strength * flick);
    }

    // Pass 1: carve the darkness.
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
    lctx.fillStyle = 'rgba(4,3,9,0.90)';
    lctx.fillRect(0, 0, W, H);
    lctx.globalCompositeOperation = 'destination-out';
    for (const l of lights) {
      lctx.globalAlpha = 0.92;
      lctx.drawImage(carve(), l.sx - l.r, l.sy - l.r, l.r * 2, l.r * 2);
    }

    // Pass 2: pour the colour back into the holes. Doing this on the light canvas
    // rather than the scene matters - added on top of the scene it lifts the
    // blacks into grey haze instead of tinting what the light actually reaches.
    lctx.globalCompositeOperation = 'lighter';
    for (const l of lights) {
      lctx.globalAlpha = l.strength;
      lctx.drawImage(glow(l.colour), l.sx - l.r, l.sy - l.r, l.r * 2, l.r * 2);
    }
    lctx.globalAlpha = 1;
    lctx.globalCompositeOperation = 'source-over';

    ctx.drawImage(lc, 0, 0);
  }
}

export { P, PROP_TYPES, LIGHTS };
