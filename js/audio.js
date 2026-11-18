// Original, fully synthesized dynamic music + SFX engine.
// No audio files, no licensing concerns: every sound is generated with Web Audio.
//
// Scenes:
//   romantic  — warm pads, soft piano arpeggios, gentle bass
//   suspense  — mysterious drone, sparse piano, heartbeat, tension filter
// Countdown:
//   10s → soft clock ticks, 5s → stronger ticks + higher tension,
//   3/2/1 → synchronized beeps, 0 → dramatic time-up transition
// Reveal:
//   suspense fades briefly → dramatic swell → match success / cute mismatch

const noteFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const LEVEL = { master: 0.9, music: 0.52, sfx: 0.82 };
const FADE = 1.5;
const MUSIC_FADE_OUT = 1.4;

let ctx = null;
let master = null;
let musicBus = null;
let sfxBus = null;
let noiseBuf = null;

let muted = false;
let volume = 0.9;
let pendingScene = null;
let scene = null;
let cdKey = null;
let cdLastSecond = null;
let lastZeroKey = null;
let lastRevealKey = null;

const builders = Object.create(null);

/* ───────── Context / buses ───────── */

function makeNoise(seconds = 2) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < frames; i++) {
    const white = Math.random() * 2 - 1;
    last = last * 0.96 + white * 0.04;
    data[i] = last * 3.2;
  }
  return buf;
}

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
    return null;
  }
  master = ctx.createGain();
  master.gain.value = muted ? 0.0001 : volume;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 24;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.26;

  master.connect(comp);
  comp.connect(ctx.destination);

  musicBus = ctx.createGain();
  musicBus.gain.value = LEVEL.music;
  musicBus.connect(master);

  sfxBus = ctx.createGain();
  sfxBus.gain.value = LEVEL.sfx;
  sfxBus.connect(master);

  noiseBuf = makeNoise(2);
  return ctx;
}

function running() {
  return !!ctx && ctx.state === 'running';
}

/* ───────── Low-level voices ───────── */

function tone({
  freq, when = 0, dur = 0.3, vol = 0.1, attack = 0.008,
  type = 'sine', dest = sfxBus, detune = 0, slideTo = null,
  filterType = null, filterFreq = 2000,
}) {
  if (!ctx) return;
  const t0 = Math.max(ctx.currentTime + 0.001, ctx.currentTime + when);
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(20, freq), t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
  if (detune) o.detune.value = detune;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur);

  let node = o;
  let filter = null;
  if (filterType) {
    filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    node.connect(filter);
    node = filter;
  }
  node.connect(g);
  g.connect(dest);
  o.start(t0);
  o.stop(t0 + attack + dur + 0.05);
  o.onended = () => {
    try { g.disconnect(); } catch { /* noop */ }
    try { filter?.disconnect(); } catch { /* noop */ }
  };
}

function pianoAt(t, midi, vol, dur, dest) {
  if (!ctx) return;
  const start = Math.max(ctx.currentTime + 0.001, t);
  const freq = noteFreq(midi);
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(freq, start);

  const o2 = ctx.createOscillator();
  o2.type = 'sine';
  o2.frequency.setValueAtTime(freq * 2, start);
  o2.detune.value = 5;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3400, start);
  lp.frequency.exponentialRampToValueAtTime(1100, start + dur);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.0001, start);
  g2.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * 0.28), start + 0.01);
  g2.gain.exponentialRampToValueAtTime(0.0001, start + dur * 0.7);

  o.connect(lp);
  o2.connect(g2);
  g2.connect(lp);
  lp.connect(g);
  g.connect(dest);

  o.start(start);
  o2.start(start);
  o.stop(start + dur + 0.05);
  o2.stop(start + dur + 0.05);
  o.onended = () => {
    try { g.disconnect(); } catch { /* noop */ }
    try { g2.disconnect(); } catch { /* noop */ }
    try { lp.disconnect(); } catch { /* noop */ }
  };
}

function thumpAt(t, freq, vol, dur, dest) {
  if (!ctx) return;
  const start = Math.max(ctx.currentTime + 0.001, t);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq * 1.45, start);
  o.frequency.exponentialRampToValueAtTime(freq, start + 0.09);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g);
  g.connect(dest);
  o.start(start);
  o.stop(start + dur + 0.04);
  o.onended = () => { try { g.disconnect(); } catch { /* noop */ } };
}

function noiseBurst({
  when = 0, dur = 0.2, vol = 0.05, band = 1200, q = 1,
  dest = sfxBus, slideTo = null,
}) {
  if (!ctx || !noiseBuf) return;
  const t0 = Math.max(ctx.currentTime + 0.001, ctx.currentTime + when);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(band, t0);
  f.Q.value = q;
  if (slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t0);
  src.stop(t0 + dur + 0.03);
  src.onended = () => {
    try { g.disconnect(); } catch { /* noop */ }
    try { f.disconnect(); } catch { /* noop */ }
  };
}

/* ───────── One-shot sounds ───────── */

function sfxClick() {
  tone({ freq: 720, type: 'triangle', dur: 0.07, vol: 0.055, attack: 0.003 });
}

function sfxLock() {
  tone({ freq: 560, type: 'triangle', dur: 0.1, vol: 0.06 });
  tone({ freq: 840, type: 'triangle', dur: 0.12, vol: 0.05, when: 0.07 });
}

function sfxTick(strong) {
  noiseBurst({ dur: strong ? 0.05 : 0.038, vol: strong ? 0.045 : 0.026, band: strong ? 2800 : 2000, q: 2.6 });
  tone({ freq: strong ? 2200 : 1650, type: 'sine', dur: 0.03, vol: strong ? 0.03 : 0.017, attack: 0.002 });
}

function sfxCountdown(sec) {
  const freq = sec === 3 ? 784 : sec === 2 ? 988 : 1175;
  tone({ freq, type: 'triangle', dur: 0.17, vol: 0.08, attack: 0.004 });
  tone({ freq: freq * 2, type: 'sine', dur: 0.1, vol: 0.026, attack: 0.003 });
}

function sfxTimeUp() {
  tone({ freq: 96, type: 'sine', dur: 1.15, vol: 0.15, attack: 0.01, slideTo: 46 });
  tone({ freq: 192, type: 'triangle', dur: 0.7, vol: 0.05, attack: 0.01, slideTo: 96 });
  noiseBurst({ dur: 0.85, vol: 0.06, band: 360, q: 0.8, slideTo: 2400 });
}

function sfxRevealSwell() {
  tone({ freq: 300, type: 'sawtooth', dur: 0.55, vol: 0.035, attack: 0.04, slideTo: 940, filterType: 'lowpass', filterFreq: 1500 });
  noiseBurst({ dur: 0.65, vol: 0.055, band: 520, q: 0.85, slideTo: 4200 });
  tone({ freq: 132, type: 'sine', dur: 0.95, vol: 0.11, attack: 0.012, slideTo: 64 });
}

function sfxMatch() {
  const notes = [72, 76, 79, 84, 79, 84];
  notes.forEach((midi, i) => pianoAt(ctx.currentTime + i * 0.105, midi, 0.085, 0.9, sfxBus));
  tone({ freq: noteFreq(96), type: 'sine', dur: 0.5, vol: 0.026, attack: 0.01, when: 0.32 });
  tone({ freq: noteFreq(100), type: 'sine', dur: 0.45, vol: 0.02, attack: 0.01, when: 0.45 });
}

function sfxFunny() {
  // Cute rubbery boing + wooden clack.
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(540, t);
  o.frequency.exponentialRampToValueAtTime(180, t + 0.36);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 17;
  const lg = ctx.createGain();
  lg.gain.value = 26;
  lfo.connect(lg);
  lg.connect(o.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  o.connect(g);
  g.connect(sfxBus);
  o.start(t);
  lfo.start(t);
  o.stop(t + 0.46);
  lfo.stop(t + 0.46);
  o.onended = () => { try { g.disconnect(); lg.disconnect(); } catch { /* noop */ } };
  tone({ freq: 900, type: 'square', dur: 0.055, vol: 0.028, attack: 0.002, when: 0.02 });
  tone({ freq: 680, type: 'square', dur: 0.07, vol: 0.022, attack: 0.002, when: 0.11 });
}

function sfxTada() {
  const notes = [72, 76, 79, 84, 88];
  notes.forEach((midi, i) => pianoAt(ctx.currentTime + i * 0.09, midi, 0.075, 0.8, sfxBus));
  sfxMatch();
}

function play(name) {
  if (!ensureCtx()) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  switch (name) {
    case 'click': sfxClick(); break;
    case 'lock': sfxLock(); break;
    case 'tick': sfxTick(true); break;
    case 'match': sfxMatch(); break;
    case 'mismatch': sfxFunny(); break;
    case 'reveal': sfxRevealSwell(); break;
    case 'timeup': sfxTimeUp(); break;
    case 'tada': sfxTada(); break;
    default: break;
  }
}

/* ───────── Music scenes ───────── */

function buildRomantic(gain) {
  const chords = [
    [53, 57, 60, 64], // Fmaj7
    [48, 55, 59, 64], // Cmaj7
    [50, 57, 60, 65], // Dm7
    [46, 53, 57, 62], // Bb maj7
  ];
  const padGain = ctx.createGain();
  padGain.gain.value = 0.0001;
  padGain.connect(gain);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  lp.Q.value = 0.4;
  lp.connect(padGain);

  const padOscs = chords[0].map((midi, i) => {
    const o = ctx.createOscillator();
    o.type = i % 2 ? 'triangle' : 'sine';
    o.frequency.value = noteFreq(midi + 12);
    o.detune.value = (i - 1.5) * 4;
    const g = ctx.createGain();
    g.gain.value = 0.026;
    o.connect(g);
    g.connect(lp);
    o.start();
    return o;
  });
  padGain.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.8);

  const stepDur = 60 / 72 / 2;
  let nextTime = ctx.currentTime + 0.12;
  let step = 0;
  let chordIdx = -1;
  const pattern = [0, 2, 3, 1, 2, 3, 1, 2];

  function schedule() {
    if (!ctx) return;
    if (nextTime < ctx.currentTime - 0.3) nextTime = ctx.currentTime + 0.05;
    while (nextTime < ctx.currentTime + 0.3) {
      const ci = Math.floor(step / 16) % chords.length;
      if (ci !== chordIdx) {
        chordIdx = ci;
        padOscs.forEach((o, i) => {
          o.frequency.setTargetAtTime(noteFreq(chords[ci][i] + 12), nextTime, 0.35);
        });
        thumpAt(nextTime, noteFreq(chords[ci][0] - 24), 0.018, 1.4, gain);
      }
      if (step % 2 === 0) {
        const idx = pattern[(step / 2) % pattern.length];
        const midi = chords[ci][idx] + 12;
        pianoAt(nextTime, midi, step % 16 === 0 ? 0.055 : 0.042, 1.15, gain);
      }
      if (step % 32 === 18) pianoAt(nextTime, chords[ci][2] + 24, 0.022, 1.9, gain);
      step++;
      nextTime += stepDur;
    }
  }
  schedule();
  const timer = setInterval(schedule, 90);

  return {
    setTension() {},
    stop() {
      clearInterval(timer);
      if (!ctx) return;
      const t = ctx.currentTime;
      padGain.gain.cancelScheduledValues(t);
      padGain.gain.setTargetAtTime(0.0001, t, 0.08);
      padOscs.forEach((o) => { try { o.stop(t + 0.35); } catch { /* noop */ } });
      setTimeout(() => {
        try { padGain.disconnect(); } catch { /* noop */ }
        try { lp.disconnect(); } catch { /* noop */ }
      }, 700);
    },
  };
}

function buildSuspense(gain) {
  const root = 38; // D2
  const droneGain = ctx.createGain();
  droneGain.gain.value = 0.0001;
  droneGain.connect(gain);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 420;
  lp.Q.value = 2;
  lp.connect(droneGain);

  const drones = [0, 1, 7].map((semi, i) => {
    const o = ctx.createOscillator();
    o.type = i === 2 ? 'triangle' : 'sine';
    o.frequency.value = noteFreq(root + semi);
    o.detune.value = (i - 1) * 3;
    const g = ctx.createGain();
    g.gain.value = i === 0 ? 0.6 : 0.22;
    o.connect(g);
    g.connect(lp);
    o.start();
    return o;
  });
  droneGain.gain.linearRampToValueAtTime(0.085, ctx.currentTime + 1.5);

  const air = ctx.createBufferSource();
  air.buffer = noiseBuf;
  air.loop = true;
  const airF = ctx.createBiquadFilter();
  airF.type = 'bandpass';
  airF.frequency.value = 680;
  airF.Q.value = 0.8;
  const airG = ctx.createGain();
  airG.gain.value = 0.0001;
  air.connect(airF);
  airF.connect(airG);
  airG.connect(gain);
  air.start();
  airG.gain.linearRampToValueAtTime(0.016, ctx.currentTime + 1.5);

  const shim = ctx.createOscillator();
  shim.type = 'sine';
  shim.frequency.value = noteFreq(86);
  const shimG = ctx.createGain();
  shimG.gain.value = 0.0001;
  shim.connect(shimG);
  shimG.connect(gain);
  shim.start();
  shimG.gain.linearRampToValueAtTime(0.004, ctx.currentTime + 1.6);

  let tension = 0.15;
  function setTension(v) {
    if (!ctx) return;
    tension = clamp(v, 0, 1);
    const t = ctx.currentTime;
    lp.frequency.setTargetAtTime(360 + 1150 * tension, t, 0.3);
    droneGain.gain.setTargetAtTime(0.072 + 0.032 * tension, t, 0.4);
    airG.gain.setTargetAtTime(0.013 + 0.026 * tension, t, 0.4);
    shimG.gain.setTargetAtTime(0.003 + 0.02 * tension, t, 0.4);
  }
  setTension(0.15);

  let nextBeat = ctx.currentTime + 0.4;
  const heartTimer = setInterval(() => {
    if (!ctx) return;
    if (nextBeat < ctx.currentTime - 0.4) nextBeat = ctx.currentTime + 0.1;
    while (nextBeat < ctx.currentTime + 0.22) {
      const vol = 0.04 + tension * 0.05;
      thumpAt(nextBeat, 58, vol, 0.18, gain);
      thumpAt(nextBeat + 0.17, 48, vol * 0.72, 0.24, gain);
      nextBeat += 60 / (58 + 50 * tension);
    }
  }, 100);

  const scale = [62, 63, 65, 67, 69, 70, 74];
  let nextNote = ctx.currentTime + 1.1;
  const noteTimer = setInterval(() => {
    if (!ctx) return;
    if (nextNote < ctx.currentTime - 0.5) nextNote = ctx.currentTime + 0.1;
    while (nextNote < ctx.currentTime + 0.32) {
      const midi = scale[Math.floor(Math.random() * scale.length)] + (Math.random() < 0.35 ? 12 : 0);
      pianoAt(nextNote, midi, 0.022 + 0.016 * tension, 2.5, gain);
      nextNote += 1.7 + Math.random() * 2.3 - tension * 0.7;
    }
  }, 140);

  return {
    setTension,
    getTension: () => tension,
    stop() {
      clearInterval(heartTimer);
      clearInterval(noteTimer);
      if (!ctx) return;
      const t = ctx.currentTime;
      droneGain.gain.cancelScheduledValues(t);
      droneGain.gain.setTargetAtTime(0.0001, t, 0.07);
      airG.gain.cancelScheduledValues(t);
      airG.gain.setTargetAtTime(0.0001, t, 0.07);
      shimG.gain.cancelScheduledValues(t);
      shimG.gain.setTargetAtTime(0.0001, t, 0.07);
      try { air.stop(t + 0.4); } catch { /* noop */ }
      try { shim.stop(t + 0.4); } catch { /* noop */ }
      drones.forEach((o) => { try { o.stop(t + 0.4); } catch { /* noop */ } });
      setTimeout(() => {
        try { droneGain.disconnect(); } catch { /* noop */ }
        try { airG.disconnect(); } catch { /* noop */ }
        try { shimG.disconnect(); } catch { /* noop */ }
      }, 800);
    },
  };
}

builders.romantic = buildRomantic;
builders.suspense = buildSuspense;
builders.results = buildRomantic;

/* ───────── Scene management ───────── */

function applyScene(name) {
  if (!ctx) return;
  if (scene && scene.name === name) return;

  const old = scene;
  const t = ctx.currentTime;
  scene = null;

  if (old) {
    const g = old.gain;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0.0001, t + MUSIC_FADE_OUT);
    setTimeout(() => {
      try { old.stop(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    }, MUSIC_FADE_OUT * 1000 + 150);
  }

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.connect(musicBus);

  const handle = builders[name](gain);
  gain.gain.exponentialRampToValueAtTime(1, t + FADE);

  scene = {
    name,
    gain,
    stop: handle.stop,
    setTension: handle.setTension || (() => {}),
    getTension: handle.getTension || (() => null),
  };
}

function applyPending() {
  if (!ctx || !running() || !pendingScene) return;
  const name = pendingScene;
  pendingScene = null;
  if (!scene || scene.name !== name) applyScene(name);
}

function setScene(name) {
  if (!name) return;
  if (!ensureCtx()) return;
  if (!running()) {
    pendingScene = name;
    ctx.resume().then(applyPending).catch(() => {});
    return;
  }
  applyScene(name);
}

function unlock() {
  const c = ensureCtx();
  if (!c) return;
  if (ctx.state === 'suspended') ctx.resume().then(applyPending).catch(() => {});
  else applyPending();
}

function setMuted(value) {
  muted = !!value;
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(muted ? 0.0001 : volume, t + 0.22);
}

function setVolume(value) {
  const next = clamp(Number(value), 0, 1);
  if (!Number.isFinite(next)) return;
  volume = next;
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(muted ? 0.0001 : volume, t + 0.12);
}

/* ───────── Countdown + reveal ───────── */

function countdown(remainingMs, key, active = true) {
  if (!active) {
    cdKey = null;
    cdLastSecond = null;
    return;
  }
  if (!running()) return;
  if (cdKey !== key) {
    cdKey = key;
    cdLastSecond = null;
  }
  const sec = Math.max(0, Math.ceil(remainingMs / 1000));
  if (sec > 10) {
    scene?.setTension(0.15);
    return;
  }
  if (cdLastSecond === sec) return;
  cdLastSecond = sec;

  const tension = sec <= 0 ? 1
    : sec <= 3 ? 0.9 + (3 - sec) * 0.05
      : sec <= 5 ? 0.75 + (5 - sec) * 0.075
        : 0.35 + (10 - sec) * 0.08;
  scene?.setTension(clamp(tension, 0, 1));

  if (sec >= 1 && sec <= 10) sfxTick(sec <= 5);
  if (sec === 3 || sec === 2 || sec === 1) sfxCountdown(sec);
  if (sec === 0 && lastZeroKey !== key) {
    lastZeroKey = key;
    sfxTimeUp();
  }
}

function reveal(isMatch, key) {
  if (!running()) return;
  if (key && lastRevealKey === key) return;
  if (key) lastRevealKey = key;

  if (scene) {
    const old = scene;
    scene = null;
    const t = ctx.currentTime;
    old.gain.gain.cancelScheduledValues(t);
    old.gain.gain.setValueAtTime(old.gain.gain.value, t);
    old.gain.gain.linearRampToValueAtTime(0.0001, t + 0.35);
    setTimeout(() => {
      try { old.stop(); } catch { /* noop */ }
      try { old.gain.disconnect(); } catch { /* noop */ }
    }, 520);
  }

  sfxRevealSwell();
  setTimeout(() => {
    if (!ctx) return;
    if (isMatch) sfxMatch();
    else sfxFunny();
  }, 470);
}

/* ───────── Public API ───────── */

export function createAudioEngine() {
  return {
    unlock,
    setMuted,
    setVolume,
    play,
    setScene,
    countdown,
    reveal,
    currentScene: () => scene?.name || pendingScene || null,
    isMuted: () => muted,
    getVolume: () => volume,
    currentTension: () => (scene && scene.name === 'suspense' ? scene.getTension() : null),
  };
}
