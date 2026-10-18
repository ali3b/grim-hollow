// Touch controls for phones and tablets: a floating stick on the left half and
// action buttons on the right. Only mounted once a coarse pointer is seen, so
// the desktop build is untouched.

export function isTouchDevice() {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0)
  );
}

const BUTTONS = [
  { id: 'attack', label: 'ATK', className: 'big', repeat: 0.42 },
  { id: 'heavy', label: 'HEAVY', className: 'mid' },
  { id: 'dash', label: 'DASH', className: 'mid' },
  { id: 'potion', label: 'POTION', className: 'small' },
  { id: 'interact', label: 'USE', className: 'small' },
];

const STICK_RADIUS = 52;
const STICK_DEAD = 6;

export class TouchControls {
  constructor(root, input) {
    this.input = input;
    this.root = root;
    this.pointer = null; // the finger driving the stick
    this.held = new Map();

    root.innerHTML = `
      <div class="touch-zone" id="touch-stick-zone"></div>
      <div class="touch-stick" id="touch-stick" hidden>
        <div class="touch-stick-base"></div>
        <div class="touch-stick-knob"></div>
      </div>
      <div class="touch-buttons">
        ${BUTTONS.map(
          (b) => `<button class="touch-btn ${b.className}" data-action="${b.id}" type="button">${b.label}</button>`,
        ).join('')}
        <div class="touch-corners">
          <button class="touch-btn small corner" data-action="map" type="button">MAP</button>
          <button class="touch-btn small corner pause" data-action="pause" type="button">II</button>
        </div>
      </div>
      <div class="touch-hint" id="touch-hint">drag the left side to move &middot; tap ATK to swing</div>
    `;

    this.stick = root.querySelector('#touch-stick');
    this.knob = root.querySelector('.touch-stick-knob');
    this.zone = root.querySelector('#touch-stick-zone');
    this.hint = root.querySelector('#touch-hint');

    this.#bindStick();
    this.#bindButtons();

    // A tap anywhere on the right that misses a button is an attack.
    root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.touch-btn')) return;
      if (e.clientX < window.innerWidth * 0.45) return;
      input.press('attack');
      e.preventDefault();
    });

    setTimeout(() => this.hint?.classList.add('fade'), 6000);
  }

  #bindStick() {
    const zone = this.zone;

    const place = (e) => {
      this.stick.hidden = false;
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.knob.style.transform = 'translate(-50%, -50%)';
    };

    zone.addEventListener('pointerdown', (e) => {
      if (this.pointer !== null) return;
      this.pointer = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      this.origin = { x: e.clientX, y: e.clientY };
      place(e);
      this.#updateStick(e);
      e.preventDefault();
    });

    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointer) return;
      this.#updateStick(e);
      e.preventDefault();
    });

    const release = (e) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      this.stick.hidden = true;
      this.input.setVirtualAxis(0, 0);
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
  }

  #updateStick(e) {
    let dx = e.clientX - this.origin.x;
    let dy = e.clientY - this.origin.y;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx = (dx / len) * STICK_RADIUS;
      dy = (dy / len) * STICK_RADIUS;
    }
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const mag = Math.hypot(dx, dy);
    if (mag < STICK_DEAD) {
      this.input.setVirtualAxis(0, 0);
      return;
    }
    // Ramp up from the dead zone so a small drag is a slow walk.
    const strength = Math.min(1, (mag - STICK_DEAD) / (STICK_RADIUS - STICK_DEAD));
    this.input.setVirtualAxis((dx / mag) * strength, (dy / mag) * strength);
  }

  #bindButtons() {
    for (const def of BUTTONS) {
      const el = this.root.querySelector(`[data-action="${def.id}"]`);
      const down = (e) => {
        e.preventDefault();
        el.classList.add('down');
        el.setPointerCapture?.(e.pointerId);
        this.input.press(def.id);
        if (def.repeat) {
          this.held.set(def.id, setInterval(() => this.input.press(def.id), def.repeat * 1000));
        }
      };
      const up = (e) => {
        el.classList.remove('down');
        const timer = this.held.get(def.id);
        if (timer) {
          clearInterval(timer);
          this.held.delete(def.id);
        }
        if (e && el.releasePointerCapture && el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    for (const action of ['map', 'pause']) {
      const btn = this.root.querySelector(`[data-action="${action}"]`);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.classList.add('down');
        this.input.press(action);
      });
      const clear = () => btn.classList.remove('down');
      btn.addEventListener('pointerup', clear);
      btn.addEventListener('pointercancel', clear);
      btn.addEventListener('pointerleave', clear);
    }
  }
}
