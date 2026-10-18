// HUD, minimap and the title / death / victory overlays. Drawn on the same
// canvas as the game so there is a single render target.

import { clamp } from './assets.js';

const MONO = '"Courier New", ui-monospace, monospace';

export class UI {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.showMap = false;
  }

  // Narrow viewports (phones) drop the minimap and move the HUD clear of the
  // on-screen controls. Read live so a window resize switches layouts.
  get compact() {
    return this.canvas.width < 780;
  }

  toggleMap() {
    this.showMap = !this.showMap;
  }

  draw(dt) {
    const ctx = this.ctx;
    const g = this.game;
    const W = this.canvas.width;
    const H = this.canvas.height;

    if (g.state === 'title') return this.#title(ctx, W, H);

    if (this.showMap) this.#bigMap(ctx, W, H);
    else if (!this.compact) this.#minimap(ctx, W, H);

    this.#vitals(ctx, W, H);
    this.#messages(ctx, W, H);
    this.#bossBar(ctx, W, H);
    this.#objective(ctx, W, H);

    if (g.state === 'won') this.#endCard(ctx, W, H, true);
    if (g.state === 'lost') this.#endCard(ctx, W, H, false);
  }

  // --- pieces ------------------------------------------------------------

  #panel(ctx, x, y, w, h, alpha = 0.72) {
    ctx.fillStyle = `rgba(9,7,14,${alpha})`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(150,130,190,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  #text(ctx, text, x, y, { size = 11, colour = '#d8cfe4', align = 'left', weight = '' } = {}) {
    ctx.font = `${weight} ${size}px ${MONO}`.trim();
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  }

  #bar(ctx, x, y, w, h, frac, colour, back = 'rgba(0,0,0,0.6)') {
    ctx.fillStyle = back;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, Math.max(0, w * clamp(frac, 0, 1)), h);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  #vitals(ctx, W, H) {
    const p = this.game.player;
    if (!p) return;
    const barW = Math.min(200, W - 40);
    const x = this.compact ? 14 : 14;
    const y = this.compact ? 96 : H - 62;

    this.#panel(ctx, x - 6, y - 20, barW + 26, 66);
    this.#text(ctx, 'GRIM HOLLOW', x, y - 6, { size: 10, colour: '#8b7fa8' });

    this.#bar(ctx, x, y, barW, 12, p.hp / p.maxHp, '#b8362c');
    this.#text(ctx, `${Math.ceil(p.hp)} / ${p.maxHp}`, x + barW / 2, y + 9, { size: 10, colour: '#ffe3d8', align: 'center' });

    const dashReady = p.dashCooldown <= 0;
    this.#bar(ctx, x, y + 18, barW, 5, dashReady ? 1 : 1 - p.dashCooldown / 0.55, dashReady ? '#5e7fd6' : '#2f3d63');

    const lvlFrac = p.soulCeiling() > p.soulFloor() ? (p.souls - p.soulFloor()) / (p.soulCeiling() - p.soulFloor()) : 1;
    this.#bar(ctx, x, y + 29, barW, 5, lvlFrac, '#7f9ad6');
    this.#text(ctx, `Lv ${p.level}`, x + barW + 6, y + 34, { size: 10, colour: '#a9bde8' });
    this.#text(ctx, `${p.souls} souls`, x, y + 47, { size: 10, colour: '#8fb6d8' });
    this.#text(ctx, `Potions ${p.potions} [L]`, x + barW * 0.6, y + 47, { size: 10, colour: '#e59ab0' });

    if (this.game.prompt) {
      this.#text(ctx, this.game.prompt.text, W / 2, H - (this.compact ? 190 : 96), {
        size: 12,
        colour: '#ffd479',
        align: 'center',
        weight: 'bold',
      });
    }
  }

  #messages(ctx, W, H) {
    let y = this.compact ? 58 : 44;
    for (const m of this.game.messages) {
      ctx.globalAlpha = clamp(m.life / 1.2, 0, 1);
      this.#text(ctx, m.text, W / 2, y, { size: this.compact ? 11 : 12, colour: m.colour, align: 'center', weight: 'bold' });
      ctx.globalAlpha = 1;
      y += this.compact ? 14 : 16;
    }
  }

  #bossBar(ctx, W, H) {
    const boss = this.game.entities.find((e) => e.kind === 'darklord' && !e.dead);
    if (!boss) return;
    const w = Math.min(420, W - 60);
    const x = (W - w) / 2;
    const y = this.compact ? 190 : H - 128;
    this.#panel(ctx, x - 8, y - 18, w + 16, 34);
    this.#text(ctx, 'THE WARLOCK', W / 2, y - 5, { size: 11, colour: '#d8b4ff', align: 'center', weight: 'bold' });
    this.#bar(ctx, x, y, w, 12, boss.hp / boss.maxHp, '#8a3fd6');
  }

  #objective(ctx, W, H) {
    const g = this.game;
    let text;
    let colour = '#d8cfe4';
    if (g.bossDead) {
      text = this.compact ? 'Rune broken — run back to the stairwell' : 'Return to the stairwell  [M] for the map';
      colour = '#9ce8b0';
    } else if (g.bossSpawned) {
      text = 'Destroy the Warlock';
      colour = '#d8b4ff';
    } else {
      text = this.compact ? 'Find the Warlock, deep south' : 'Find the Warlock, deep in the south';
    }

    if (this.compact) {
      // Tuck it under the vitals so the touch buttons keep the lower right.
      this.#text(ctx, text, 14, H - 26, { size: 11, colour, weight: 'bold' });
    } else {
      this.#text(ctx, text, W / 2, 20, { size: 11, colour, align: 'center' });
    }
  }

  #minimap(ctx, W, H) {
    const g = this.game;
    const map = g.map;
    const cell = 2;
    const w = map.w * cell;
    const h = map.h * cell;
    const x = W - w - 14;
    const y = 14;

    ctx.fillStyle = 'rgba(6,5,10,0.78)';
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.strokeStyle = 'rgba(150,130,190,0.3)';
    ctx.strokeRect(x - 3.5, y - 3.5, w + 7, h + 7);

    const colours = {
      bedrock: '#15121d',
      floor: '#4a4657',
      flagstone: '#57536a',
      moss: '#3d5440',
      rubble: '#59545a',
      water: '#1f4a63',
      lava: '#c2410f',
      rune: '#6c3fd0',
    };

    for (let cy = 0; cy < map.h; cy++) {
      for (let cx = 0; cx < map.w; cx++) {
        const t = map.terrain[map.idx(cx, cy)];
        if (!t || t === 'bedrock') continue;
        ctx.fillStyle = colours[t] || '#444';
        ctx.fillRect(x + cx * cell, y + cy * cell, cell, cell);
      }
    }

    for (const e of g.entities) {
      if (!(e instanceof Object) || !e.kind || e.dead) continue;
      ctx.fillStyle = '#e05a4a';
      ctx.fillRect(x + (e.x / map.tileW - 0.5) * cell, y + (e.y / map.tileH - 0.5) * cell, 2, 2);
    }

    const p = g.player;
    if (p) {
      ctx.fillStyle = '#ffe08a';
      ctx.fillRect(x + (p.x / map.tileW - 0.8) * cell, y + (p.y / map.tileH - 0.8) * cell, 3, 3);
    }
  }

  #bigMap(ctx, W, H) {
    const g = this.game;
    const map = g.map;
    const cell = Math.max(3, Math.min(Math.floor(W / map.w) - 2, Math.floor(H / map.h) - 2));
    const w = map.w * cell;
    const h = map.h * cell;
    const x = (W - w) / 2;
    const y = (H - h) / 2;

    ctx.fillStyle = 'rgba(4,3,8,0.86)';
    ctx.fillRect(0, 0, W, H);

    const colours = {
      bedrock: '#15121d',
      floor: '#4a4657',
      flagstone: '#57536a',
      moss: '#3d5440',
      rubble: '#59545a',
      water: '#1f4a63',
      lava: '#c2410f',
      rune: '#6c3fd0',
    };
    for (let cy = 0; cy < map.h; cy++) {
      for (let cx = 0; cx < map.w; cx++) {
        const t = map.terrain[map.idx(cx, cy)];
        ctx.fillStyle = t ? colours[t] || '#444' : '#15121d';
        ctx.fillRect(x + cx * cell, y + cy * cell, cell, cell);
      }
    }

    const zones = g.world.zones;
    for (const z of zones) {
      const [x0, y0, x1, y1] = z.rect;
      const colour =
        z.kind === 'objective' || z.kind === 'boss' ? '#b47bff' : z.kind === 'extraction' ? '#6fe0a0' : z.kind === 'spawn' ? '#6fc0e0' : '#c0a060';
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + x0 * cell, y + y0 * cell, (x1 - x0 + 1) * cell, (y1 - y0 + 1) * cell);
      this.#text(ctx, z.name, x + x0 * cell + 3, y + y0 * cell - 3, { size: 9, colour });
    }

    for (const e of g.entities) {
      if (!e.kind || e.dead) continue;
      ctx.fillStyle = '#e05a4a';
      ctx.fillRect(x + (e.x / map.tileW - 1) * cell, y + (e.y / map.tileH - 1) * cell, 3, 3);
    }

    const p = g.player;
    if (p) {
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath();
      ctx.arc(x + (p.x / map.tileW) * cell, y + (p.y / map.tileH) * cell, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    this.#text(ctx, 'GRIM HOLLOW —  [M] to close', W / 2, y - 14, { size: 13, colour: '#cbb994', align: 'center', weight: 'bold' });
  }

  #title(ctx, W, H) {
    ctx.fillStyle = 'rgba(4,3,8,0.82)';
    ctx.fillRect(0, 0, W, H);
    this.#text(ctx, 'GRIM HOLLOW', W / 2, H / 2 - 40, { size: 40, colour: '#cbb994', align: 'center', weight: 'bold' });
    this.#text(ctx, 'a dungeon arena-survivor', W / 2, H / 2 - 14, { size: 13, colour: '#8b7fa8', align: 'center' });
    const lines = [
      'WASD / arrows   move          J / click   attack',
      'K / right click heavy         Shift       dash',
      'L  drink potion               M          map',
      '',
      'Clear the halls, kill the Warlock, run back to the stairwell.',
    ];
    lines.forEach((l, i) => {
      this.#text(ctx, l, W / 2, H / 2 + 18 + i * 16, { size: 11, colour: i === lines.length - 1 ? '#9ce8b0' : '#b0a6c4', align: 'center' });
    });
    if (Math.floor(performance.now() / 500) % 2 === 0) {
      this.#text(ctx, 'press ENTER', W / 2, H / 2 + 96, { size: 12, colour: '#ffe08a', align: 'center', weight: 'bold' });
    }
  }

  #endCard(ctx, W, H, won) {
    ctx.fillStyle = won ? 'rgba(10,20,14,0.72)' : 'rgba(24,6,6,0.72)';
    ctx.fillRect(0, 0, W, H);
    this.#text(ctx, won ? 'THE HOLLOW IS QUIET' : 'YOU DIED IN THE DARK', W / 2, H / 2 - 20, {
      size: 26,
      colour: won ? '#9ce8b0' : '#e06a5a',
      align: 'center',
      weight: 'bold',
    });
    const g = this.game;
    const p = g.player;
    const mins = Math.floor((g.time || 0) / 60);
    const secs = Math.floor((g.time || 0) % 60);
    const rows = [
      `Level ${p?.level ?? 1}`,
      `Souls ${p?.souls ?? 0}`,
      `Kills ${g.stats.kills}`,
      `Damage taken ${Math.round(g.stats.damageTaken)}`,
      `Time ${mins}:${String(secs).padStart(2, '0')}`,
    ];
    rows.forEach((r, i) => this.#text(ctx, r, W / 2, H / 2 + 12 + i * 16, { size: 12, colour: '#cbb994', align: 'center' }));
    if (Math.floor(performance.now() / 500) % 2 === 0) {
      this.#text(ctx, 'press R to try again', W / 2, H / 2 + 110, { size: 12, colour: '#ffe08a', align: 'center' });
    }
  }
}
