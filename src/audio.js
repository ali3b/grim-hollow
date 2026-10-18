// All sound is synthesised at runtime with the Web Audio API: no audio files to
// ship, and every effect is a few oscillators and a noise burst. Built lazily
// on the first gesture so autoplay policies are respected.

const NOTES = { C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.0, A4: 440.0, C5: 523.25, E5: 659.25, G5: 783.99 };

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.enabled = true;
    this.volume = 0.7;
    this.musicOn = true;
    this._noise = null;
    this._ambient = null;
    this._lastStep = 0;
  }

  // Must be called from a user gesture the first time.
  resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(this.ctx.destination);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.9;
      this.sfxGain.connect(this.master);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.0;
      this.musicGain.connect(this.master);

      this._noise = this.#noiseBuffer();
      this.#startAmbient();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.enabled) this.master.gain.value = this.volume;
  }

  setMusic(on) {
    this.musicOn = on;
    if (this.musicGain) {
      const t = this.ctx.currentTime;
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.linearRampToValueAtTime(on ? 0.5 : 0, t + 1.2);
    }
  }

  // Intensity 0..1 drives the dungeon's ambience: 0 = calm, 1 = boss.
  setTension(v) {
    if (!this.musicGain || !this.musicOn) return;
    const t = this.ctx.currentTime;
    this.musicGain.gain.linearRampToValueAtTime(0.32 + v * 0.4, t + 1.5);
    if (this._droneFilter) {
      this._droneFilter.frequency.linearRampToValueAtTime(180 + v * 520, t + 1.5);
    }
  }

  #noiseBuffer() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  #now() {
    return this.ctx.currentTime;
  }

  #env(node, { attack = 0.005, decay = 0.12, peak = 1, at = null }) {
    const t = at ?? this.#now();
    const g = node.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return t + attack + decay;
  }

  #tone(freq, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const { type = 'sine', gain = 0.3, attack = 0.004, decay = 0.15, detune = 0, slideTo = null, dest = null } = opts;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    if (detune) osc.detune.value = detune;
    const t = this.#now();
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + attack + decay);
    osc.connect(amp);
    amp.connect(dest || this.sfxGain);
    this.#env(amp, { attack, decay, peak: gain, at: t });
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  #noise(opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const { gain = 0.25, attack = 0.003, decay = 0.12, filter = 'bandpass', freq = 1200, q = 1, sweepTo = null } = opts;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const bq = this.ctx.createBiquadFilter();
    bq.type = filter;
    bq.frequency.value = freq;
    bq.Q.value = q;
    const amp = this.ctx.createGain();
    src.connect(bq);
    bq.connect(amp);
    amp.connect(this.sfxGain);
    const t = this.#now();
    if (sweepTo) bq.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + attack + decay);
    this.#env(amp, { attack, decay, peak: gain, at: t });
    src.start(t);
    src.stop(t + attack + decay + 0.05);
  }

  // --- ambience ---------------------------------------------------------

  #startAmbient() {
    const t = this.#now();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    filter.Q.value = 0.8;
    filter.connect(this.musicGain);
    this._droneFilter = filter;

    // Two detuned saws through a slow filter sweep: a room tone, not a chord.
    for (const [freq, detune, type] of [
      [55, -6, 'sawtooth'],
      [55, 7, 'sawtooth'],
      [82.4, 3, 'triangle'],
    ]) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = this.ctx.createGain();
      g.gain.value = type === 'triangle' ? 0.12 : 0.18;
      osc.connect(g);
      g.connect(filter);
      osc.start(t);
    }

    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 70;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start(t);
  }

  // --- effects ----------------------------------------------------------

  swing(heavy = false) {
    this.#noise({ gain: heavy ? 0.3 : 0.2, decay: heavy ? 0.26 : 0.16, filter: 'bandpass', freq: heavy ? 700 : 1400, sweepTo: heavy ? 220 : 420, q: 0.9 });
  }

  hit(heavy = false) {
    this.#noise({ gain: heavy ? 0.4 : 0.28, decay: heavy ? 0.2 : 0.12, filter: 'lowpass', freq: heavy ? 1600 : 2600, sweepTo: 200, q: 1.2 });
    this.#tone(heavy ? 90 : 150, { type: 'triangle', gain: heavy ? 0.42 : 0.26, decay: heavy ? 0.22 : 0.11, slideTo: heavy ? 42 : 70 });
  }

  flesh() {
    this.#noise({ gain: 0.22, decay: 0.1, filter: 'bandpass', freq: 420, q: 2 });
  }

  hurt() {
    this.#tone(320, { type: 'sawtooth', gain: 0.3, decay: 0.32, slideTo: 70 });
    this.#noise({ gain: 0.16, decay: 0.2, filter: 'lowpass', freq: 900, sweepTo: 180 });
  }

  die(boss = false) {
    this.#tone(boss ? 160 : 240, { type: 'sawtooth', gain: boss ? 0.42 : 0.24, decay: boss ? 1.1 : 0.42, slideTo: boss ? 34 : 60 });
    this.#noise({ gain: boss ? 0.36 : 0.2, decay: boss ? 0.9 : 0.34, filter: 'lowpass', freq: 1800, sweepTo: 120 });
  }

  bossRoar() {
    if (!this.ctx || !this.enabled) return;
    for (const [f, d] of [[70, 0], [104, 9], [139, -8]]) {
      this.#tone(f, { type: 'sawtooth', gain: 0.3, attack: 0.08, decay: 1.5, detune: d, slideTo: f * 0.55 });
    }
    this.#noise({ gain: 0.3, attack: 0.1, decay: 1.3, filter: 'lowpass', freq: 500, sweepTo: 90 });
  }

  dash() {
    this.#noise({ gain: 0.22, decay: 0.2, filter: 'bandpass', freq: 2200, sweepTo: 500, q: 0.7 });
  }

  step(hallway = true) {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    if (now - this._lastStep < 0.14) return;
    this._lastStep = now;
    this.#noise({ gain: hallway ? 0.07 : 0.05, attack: 0.002, decay: 0.06, filter: 'lowpass', freq: 420 + Math.random() * 180 });
  }

  pickup() {
    this.#tone(NOTES.E5, { type: 'triangle', gain: 0.16, decay: 0.1 });
    setTimeout(() => this.#tone(NOTES.G5, { type: 'triangle', gain: 0.14, decay: 0.14 }), 55);
  }

  souls() {
    this.#tone(NOTES.A4, { type: 'sine', gain: 0.1, decay: 0.1 });
    setTimeout(() => this.#tone(NOTES.E5, { type: 'sine', gain: 0.08, decay: 0.16 }), 45);
  }

  potion() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.#tone(180 + i * 60, { type: 'sine', gain: 0.14, decay: 0.09, slideTo: 300 + i * 60 }), i * 70);
    }
  }

  levelUp() {
    [NOTES.C4, NOTES.E4, NOTES.G4, NOTES.C5].forEach((n, i) => {
      setTimeout(() => this.#tone(n, { type: 'triangle', gain: 0.2, decay: 0.26 }), i * 85);
    });
  }

  chest() {
    this.#noise({ gain: 0.18, attack: 0.02, decay: 0.3, filter: 'bandpass', freq: 320, q: 3 });
    setTimeout(() => {
      [NOTES.G4, NOTES.C5, NOTES.E5].forEach((n, i) => setTimeout(() => this.#tone(n, { type: 'triangle', gain: 0.14, decay: 0.18 }), i * 70));
    }, 160);
  }

  smash() {
    this.#noise({ gain: 0.34, decay: 0.3, filter: 'bandpass', freq: 900, sweepTo: 200, q: 0.8 });
    this.#tone(120, { type: 'square', gain: 0.16, decay: 0.2, slideTo: 45 });
  }

  lava() {
    this.#noise({ gain: 0.12, attack: 0.05, decay: 0.4, filter: 'lowpass', freq: 700, sweepTo: 200 });
  }

  ui() {
    this.#tone(NOTES.C5, { type: 'triangle', gain: 0.1, decay: 0.06 });
  }

  win() {
    [NOTES.C4, NOTES.E4, NOTES.G4, NOTES.C5, NOTES.G4, NOTES.C5].forEach((n, i) => {
      setTimeout(() => this.#tone(n, { type: 'triangle', gain: 0.22, decay: 0.35 }), i * 130);
    });
  }

  lose() {
    [NOTES.G4, NOTES.E4, NOTES.C4].forEach((n, i) => {
      setTimeout(() => this.#tone(n, { type: 'sawtooth', gain: 0.22, decay: 0.5, slideTo: n * 0.5 }), i * 220);
    });
  }
}
