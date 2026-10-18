// Boot: load everything the sprite generator exported, wire up input for the
// device we are on, then run the loop.

import { loadTileset, loadMap, loadSprite, loadJSON, placeholderSprite } from './assets.js';
import { Game, World } from './game.js';
import { Input } from './input.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { UI } from './ui.js';
import { Audio } from './audio.js';

const TILESET_DIR = 'assets/tilesets/hollow_floor';
const MAP_DIR = 'assets/maps/hollow_deep';
const SPRITE_DIR = 'assets/sprites';

const MAX_BACKING_W = 1600;
const MAX_BACKING_H = 1100;

const canvas = document.getElementById('game');
const wrap = document.getElementById('wrap');
const status = document.getElementById('status');
const setStatus = (t) => {
  if (status) status.textContent = t;
};

async function boot() {
  setStatus('loading tileset…');
  const tileset = await loadTileset(TILESET_DIR, 'hollow_floor');

  setStatus('loading map…');
  const map = await loadMap(MAP_DIR, tileset);

  setStatus('loading sprite manifest…');
  const manifest = await loadJSON(`${SPRITE_DIR}/index.json`);

  const sprites = {};
  const names = Object.keys(manifest);
  const failed = [];
  let done = 0;

  // One retry: a dropped request on a phone should not leave a permanent
  // placeholder in the level.
  const loadWithRetry = async (name) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await loadSprite(`${SPRITE_DIR}/${name}`, name, manifest[name]);
      } catch (err) {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
        else {
          console.warn(`[boot] ${name} failed to load (${err.message})`);
          failed.push(name);
          return placeholderSprite(name);
        }
      }
    }
    return placeholderSprite(name);
  };

  await Promise.all(
    names.map(async (name) => {
      sprites[name] = await loadWithRetry(name);
      done++;
      setStatus(`loading sprites… ${done}/${names.length}`);
    }),
  );

  const world = new World(map, tileset, sprites);
  const input = new Input(canvas);
  const game = new Game(canvas, world, input);
  const ui = new UI(canvas, game);
  const audio = new Audio();
  game.audio = audio;

  // Browsers only allow audio after a gesture; wire it to the first one of any kind.
  const wake = () => {
    audio.resume();
    if (game.state === 'play') audio.setMusic(true);
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
    window.removeEventListener('touchstart', wake);
  };
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);
  window.addEventListener('touchstart', wake);

  // Debug flags: ?autostart skips the title card, ?touch forces the on-screen
  // controls on a desktop so the mobile layout can be checked anywhere.
  const flags = new URLSearchParams(location.search);
  if (isTouchDevice() || flags.has('touch')) {
    document.body.classList.add('touch');
    new TouchControls(document.getElementById('touch'), input);
  }

  status?.remove();
  document.body.classList.add('ready');

  const resize = () => {
    const rect = wrap.getBoundingClientRect();
    const cssW = Math.max(320, Math.floor(rect.width));
    const cssH = Math.max(240, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.max(0.5, Math.min(dpr, MAX_BACKING_W / cssW, MAX_BACKING_H / cssH));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * scale);
    canvas.height = Math.round(cssH * scale);
    game.resize(canvas.width, canvas.height);
  };
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  resize();

  if (flags.has('autostart')) game.reset();

  if (failed.length) {
    const note = `${failed.length} sprite(s) failed to load: ${failed.join(', ')}`;
    console.warn('[boot] ' + note);
    game.say(note + ' — reload the page to retry.', '#e08a6a');
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (input.consume('pause')) {
      if (game.state === 'play') {
        ui.togglePause();
        game.audio?.ui();
      }
    }
    if (ui.paused) {
      ui.key(input.lastPauseKey);
      input.lastPauseKey = null;
      game.camera.scale = ui.shake ? 1 : 0;
      game.draw();
      ui.draw(dt);
      input.endFrame();
      requestAnimationFrame(frame);
      return;
    }

    // Title and end cards advance on any "confirm" input, keyboard or touch.
    const confirm = () => input.consume('interact') || input.consume('attack');
    if (game.state === 'title' && confirm()) {
      game.reset();
      game.audio?.resume();
      game.audio?.setMusic(true);
    }
    if ((game.state === 'won' || game.state === 'lost') && (game.bossDead || (game.player && game.player.deathTimer > 1.6)) && confirm()) {
      game.reset();
    }
    if (input.consume('map')) ui.toggleMap();

    game.update(dt);
    game.draw();
    ui.draw(dt);
    input.endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Handy for poking at the level from the console.
  window.game = game;
}

boot().catch((err) => {
  console.error(err);
  if (status) {
    status.innerHTML =
      `<strong>Failed to start.</strong><br>${err.message}<br><br>` +
      'Serve the folder over HTTP (the map and tileset are fetched as JSON):<br>' +
      '<code>python3 -m http.server 8080</code>';
  }
});
