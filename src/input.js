// Keyboard, mouse and touch, funnelled into one action set. Attack / heavy /
// dash are edge-triggered and consumed once per press so holding the key does
// not machine-gun the swing; the touch layer re-presses on a timer instead.

const ACTIONS = {
  KeyJ: 'attack',
  Space: 'attack',
  KeyK: 'heavy',
  ShiftLeft: 'dash',
  ShiftRight: 'dash',
  KeyL: 'potion',
  KeyQ: 'potion',
  KeyE: 'interact',
  Enter: 'interact',
  KeyM: 'map',
};

export class Input {
  constructor(target) {
    this.down = new Set();
    this.pressed = new Set();
    this.axis = { x: 0, y: 0 };
    this.virtualAxis = null;
    this.mouse = { x: 0, y: 0, down: false };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const action = ACTIONS[e.code];
      if (action) {
        e.preventDefault();
        this.press(action);
        this.down.add(action);
      }
      this.down.add(e.code);
      this.#axis();
    });

    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      const action = ACTIONS[e.code];
      if (action) this.down.delete(action);
      this.#axis();
    });

    window.addEventListener('blur', () => {
      this.down.clear();
      this.virtualAxis = null;
    });

    // Desktop mouse: left button attacks, right button is the heavy swing.
    target.addEventListener('mousedown', (e) => {
      if (e.pointerType === 'touch') return; // handled by the touch layer
      e.preventDefault();
      this.press(e.button === 2 ? 'heavy' : 'attack');
      this.mouse.down = true;
    });
    window.addEventListener('mouseup', () => (this.mouse.down = false));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
  }

  #axis() {
    if (this.virtualAxis) {
      this.axis.x = this.virtualAxis.x;
      this.axis.y = this.virtualAxis.y;
      return;
    }
    let x = 0;
    let y = 0;
    if (this.down.has('KeyA') || this.down.has('ArrowLeft')) x -= 1;
    if (this.down.has('KeyD') || this.down.has('ArrowRight')) x += 1;
    if (this.down.has('KeyW') || this.down.has('ArrowUp')) y -= 1;
    if (this.down.has('KeyS') || this.down.has('ArrowDown')) y += 1;
    this.axis.x = x;
    this.axis.y = y;
  }

  setVirtualAxis(x, y) {
    this.virtualAxis = x || y ? { x, y } : null;
    this.#axis();
  }

  press(action) {
    this.pressed.add(action);
  }

  consume(action) {
    if (!this.pressed.has(action)) return false;
    this.pressed.delete(action);
    return true;
  }

  endFrame() {
    this.pressed.clear();
  }
}
