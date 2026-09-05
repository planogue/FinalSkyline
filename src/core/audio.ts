/**
 * Every sound is synthesised with the WebAudio API — no asset downloads,
 * so the whole game stays a single self-contained bundle.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let noiseBuffer: AudioBuffer | null = null;

/** What the warhead went off against — each has its own timbre. */
export type ExplosionSurface = 'building' | 'antiair' | 'ground';

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function noise(c: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    const len = Math.floor(c.sampleRate * 1.6);
    noiseBuffer = c.createBuffer(1, len, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

export const audio = {
  init(): void {
    ac();
  },

  get muted(): boolean {
    return muted;
  },

  setMuted(v: boolean): void {
    muted = v;
    if (master && ctx) master.gain.setTargetAtTime(v ? 0 : 0.5, ctx.currentTime, 0.02);
  },

  /**
   * @param pan -1 (far left) .. 1 (far right), used so off-screen action is
   *            still audible in the right ear.
   */
  launch(tier: number, pan = 0): void {
    const c = ac();
    if (!c || muted) return;
    const t = c.currentTime;
    const out = panner(c, pan, 0.55);

    // Rocket motor: filtered noise that opens up as it climbs.
    const src = c.createBufferSource();
    src.buffer = noise(c);
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(180 + tier * 60, t);
    bp.frequency.exponentialRampToValueAtTime(900 + tier * 220, t + 0.5);
    bp.Q.value = 1.1;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    src.connect(bp).connect(g).connect(out);
    src.start(t);
    src.stop(t + 0.9);

    // Low thump on ignition.
    const osc = c.createOscillator();
    const og = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 - tier * 6, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    og.gain.setValueAtTime(0.55, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.42);
  },

  interceptorLaunch(pan = 0): void {
    const c = ac();
    if (!c || muted) return;
    const t = c.currentTime;
    const out = panner(c, pan, 0.4);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(1500, t + 0.22);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.32);
  },

  intercept(pan = 0): void {
    const c = ac();
    if (!c || muted) return;
    const t = c.currentTime;
    const out = panner(c, pan, 0.6);
    const src = c.createBufferSource();
    src.buffer = noise(c);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const g = c.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(hp).connect(g).connect(out);
    src.start(t);
    src.stop(t + 0.32);

    const osc = c.createOscillator();
    const og = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.18);
    og.gain.setValueAtTime(0.25, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.22);
  },

  /**
   * Detonation. `tier` (1..6) scales the whole thing — a Scud is a sharp crack,
   * a Bunker Buster is a long rolling boom — and `surface` colours it: concrete
   * and glass off a building, torn metal and cooking-off rounds off a battery,
   * a muffled earth thud in the street.
   */
  explosion(tier: number, surface: ExplosionSurface = 'ground', pan = 0): void {
    const c = ac();
    if (!c || muted) return;
    const t = c.currentTime;
    const out = panner(c, pan, 0.85);

    // 0 (Scud) .. 1 (Bunker Buster) drives every duration and cutoff below.
    const size = Math.max(0, Math.min(1, (tier - 1) / 5));
    const body = 0.35 + size * 1.25; // seconds of the main blast
    const tail = body * (surface === 'ground' ? 1.6 : 2.3); // rumble/debris tail
    const level = 0.55 + size * 0.45;

    // 1. Ignition crack — the supersonic snap that arrives before the boom.
    const crack = c.createBufferSource();
    crack.buffer = noise(c);
    crack.playbackRate.value = 1.6;
    const crackFilter = c.createBiquadFilter();
    crackFilter.type = 'highpass';
    crackFilter.frequency.value = surface === 'antiair' ? 2600 : 1500;
    const crackGain = c.createGain();
    crackGain.gain.setValueAtTime((surface === 'ground' ? 0.4 : 0.8) * level, t);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + size * 0.05);
    crack.connect(crackFilter).connect(crackGain).connect(out);
    crack.start(t);
    crack.stop(t + 0.14);

    // 2. Blast body — broadband noise whose cutoff collapses downward, which is
    //    what makes a burst read as huge rather than merely loud.
    const openAt = surface === 'building' ? 4200 : surface === 'antiair' ? 5200 : 2600;
    for (const layer of [0, 1]) {
      const src = c.createBufferSource();
      src.buffer = noise(c);
      // A second, detuned copy started a hair late thickens the front edge.
      src.playbackRate.value = layer === 0 ? 1 : 0.62;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(openAt / (layer + 1), t);
      lp.frequency.exponentialRampToValueAtTime(90 + size * 40, t + body);
      const g = c.createGain();
      const start = t + layer * 0.02;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime((layer === 0 ? 0.9 : 0.6) * level, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + body);
      src.connect(lp).connect(g).connect(out);
      src.start(start);
      src.stop(start + body + 0.05);
    }

    // 3. Sub-bass thump. Bigger warheads start lower and take longer to decay.
    const sub = c.createOscillator();
    const sg = c.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime((surface === 'ground' ? 130 : 105) - size * 55, t);
    sub.frequency.exponentialRampToValueAtTime(surface === 'ground' ? 20 : 28, t + body * 0.9);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime((surface === 'ground' ? 1 : 0.8) * level, t + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + body);
    sub.connect(sg).connect(out);
    sub.start(t);
    sub.stop(t + body + 0.05);

    // 4. Surface signature.
    if (surface === 'building') {
      // Concrete shearing and glass raining down.
      const rubble = c.createBufferSource();
      rubble.buffer = noise(c);
      rubble.playbackRate.value = 0.8;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1800, t + 0.05);
      bp.frequency.exponentialRampToValueAtTime(420, t + tail);
      bp.Q.value = 0.7;
      const rg = c.createGain();
      rg.gain.setValueAtTime(0.0001, t + 0.05);
      rg.gain.exponentialRampToValueAtTime(0.34 * level, t + 0.16);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + tail);
      rubble.connect(bp).connect(rg).connect(out);
      rubble.start(t + 0.05);
      rubble.stop(t + tail + 0.05);
      for (let i = 0; i < 4 + Math.round(size * 6); i++) {
        glassShard(c, out, t + 0.12 + Math.random() * tail * 0.7, 0.09 * level);
      }
    } else if (surface === 'antiair') {
      // Struck metal, then the magazine cooking off.
      metalClang(c, out, t + 0.01, 0.4 * level, 240 - size * 60);
      metalClang(c, out, t + 0.06, 0.26 * level, 370 - size * 90);
      const rounds = 3 + Math.round(size * 5);
      for (let i = 0; i < rounds; i++) {
        cookOff(c, out, t + 0.12 + Math.random() * (0.5 + size * 0.7), 0.2 * level);
      }
    } else {
      // Earth and dust: a soft, filtered fall-back with no bright content.
      const dirt = c.createBufferSource();
      dirt.buffer = noise(c);
      dirt.playbackRate.value = 0.5;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(600, t + 0.04);
      lp.frequency.exponentialRampToValueAtTime(120, t + tail);
      const dg = c.createGain();
      dg.gain.setValueAtTime(0.0001, t + 0.04);
      dg.gain.exponentialRampToValueAtTime(0.3 * level, t + 0.14);
      dg.gain.exponentialRampToValueAtTime(0.0001, t + tail);
      dirt.connect(lp).connect(dg).connect(out);
      dirt.start(t + 0.04);
      dirt.stop(t + tail + 0.05);
    }

    // 5. Rolling tail — the distant rumble that only the heavy tiers earn.
    if (size > 0.15) {
      const roll = c.createBufferSource();
      roll.buffer = noise(c);
      roll.playbackRate.value = 0.35;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(260, t + body * 0.4);
      lp.frequency.exponentialRampToValueAtTime(60, t + tail * 1.3);
      const rg = c.createGain();
      rg.gain.setValueAtTime(0.0001, t + body * 0.4);
      rg.gain.exponentialRampToValueAtTime(0.45 * size * level, t + body * 0.75);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + tail * 1.3);
      roll.connect(lp).connect(rg).connect(out);
      roll.start(t + body * 0.4);
      roll.stop(t + tail * 1.35);
    }
  },

  collapse(pan = 0): void {
    const c = ac();
    if (!c || muted) return;
    const t = c.currentTime;
    const out = panner(c, pan, 0.5);
    const src = c.createBufferSource();
    src.buffer = noise(c);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 1.4);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    src.connect(lp).connect(g).connect(out);
    src.start(t);
    src.stop(t + 1.55);
  },

  build(): void {
    if (!ac() || muted) return;
    blip(760, 0.09, 'square', 0.16);
    setTimeout(() => blip(1140, 0.08, 'square', 0.12), 55);
  },

  buy(): void {
    if (!ac() || muted) return;
    blip(520, 0.07, 'triangle', 0.2);
    setTimeout(() => blip(780, 0.09, 'triangle', 0.16), 60);
  },

  click(): void {
    blip(420, 0.045, 'square', 0.1);
  },

  deny(): void {
    blip(160, 0.16, 'sawtooth', 0.14);
  },

  pin(): void {
    blip(980, 0.05, 'sine', 0.14);
  },

  alarm(): void {
    const c = ac();
    if (!c || muted) return;
    const t = c.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'sawtooth';
      const s = t + i * 0.42;
      osc.frequency.setValueAtTime(420, s);
      osc.frequency.linearRampToValueAtTime(700, s + 0.2);
      osc.frequency.linearRampToValueAtTime(420, s + 0.38);
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.18, s + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.4);
      osc.connect(g).connect(master!);
      osc.start(s);
      osc.stop(s + 0.42);
    }
  },

  fanfare(win: boolean): void {
    if (!ac() || muted) return;
    const notes = win ? [523, 659, 784, 1047] : [523, 466, 392, 311];
    notes.forEach((f, i) => setTimeout(() => blip(f, 0.28, 'triangle', 0.22), i * 150));
  },
};

/** A single pane of glass hitting the pavement. */
function glassShard(c: AudioContext, out: AudioNode, at: number, vol: number): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(2400 + Math.random() * 2600, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07 + Math.random() * 0.06);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + 0.16);
}

/** Struck launcher plate — an inharmonic ring, not a musical note. */
function metalClang(c: AudioContext, out: AudioNode, at: number, vol: number, base: number): void {
  for (const ratio of [1, 2.37, 3.61, 5.13]) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(base * ratio, at);
    osc.frequency.exponentialRampToValueAtTime(base * ratio * 0.82, at + 0.3);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol / (ratio * 1.4), at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 0.36);
  }
}

/** One interceptor round in the magazine going up after the battery is hit. */
function cookOff(c: AudioContext, out: AudioNode, at: number, vol: number): void {
  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.playbackRate.value = 1.3;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 700 + Math.random() * 1400;
  bp.Q.value = 1.6;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
  src.connect(bp).connect(g).connect(out);
  src.start(at);
  src.stop(at + 0.12);
}

function blip(freq: number, dur: number, type: OscillatorType, vol: number): void {
  const c = ac();
  if (!c || muted || !master) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function panner(c: AudioContext, pan: number, vol: number): AudioNode {
  const g = c.createGain();
  g.gain.value = vol;
  if (typeof c.createStereoPanner === 'function') {
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(master!);
  } else {
    g.connect(master!);
  }
  return g;
}
