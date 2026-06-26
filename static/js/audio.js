// Sound engine: procedural music + sound effects via WebAudio, with optional
// drop-in audio files. No assets are required — music and SFX are synthesized,
// so the game ships with sound out of the box and stays fully offline. But if
// you drop real audio into static/audio/ it is used instead:
//
//   static/audio/music.(mp3|ogg|wav)   looping background music
//   static/audio/break.(...)           block break
//   static/audio/place.(...)           block place
//   static/audio/step.(...)            footstep
//
// Good CC0 sources: kenney.nl, pixabay.com/sound-effects, freesound.org (CC0).
//
// Must be started from a user gesture (browsers block audio otherwise);
// resume() is called when the player engages.

let ctx = null;
let master = null, musicGain = null, sfxGain = null, voiceGain = null;
let started = false;
let musicOn = true;

const OVERRIDE_NAMES = ['music', 'break', 'place', 'step', 'explode'];
const EXTS = ['mp3', 'ogg', 'wav'];
const pendingBuffers = {};   // name -> ArrayBuffer fetched before ctx exists
const samples = {};          // name -> decoded AudioBuffer

// Fetch any override files up front (no AudioContext needed to download).
export async function prefetchOverrides() {
  await Promise.all(OVERRIDE_NAMES.map(async (name) => {
    for (const ext of EXTS) {
      try {
        const res = await fetch(`/static/audio/${name}.${ext}`);
        if (res.ok) { pendingBuffers[name] = await res.arrayBuffer(); return; }
      } catch (_) { /* keep trying */ }
    }
  }));
}

function ensureCtx() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
  musicGain = ctx.createGain(); musicGain.gain.value = 0.0; musicGain.connect(master);
  sfxGain = ctx.createGain(); sfxGain.gain.value = 0.7; sfxGain.connect(master);
  voiceGain = ctx.createGain(); voiceGain.gain.value = 1.0; voiceGain.connect(master);
}

// Make sure the audio context exists and is running (used when joining voice).
export function ensureAudio() {
  ensureCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume();
  return !!ctx;
}

// Route a remote voice MediaStream through a proximity-controlled node chain.
// Returns a handle to update each frame, or null if audio is unavailable.
export function voiceSink(stream) {
  if (!ensureAudio()) return null;
  // Chrome won't pull audio from a MediaStreamSource unless the stream is also
  // consumed by an element; attach a muted <audio> to keep it flowing.
  const el = new Audio();
  el.srcObject = stream;
  el.muted = true;
  el.play().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain(); gain.gain.value = 0;
  const panner = ctx.createStereoPanner();
  src.connect(gain); gain.connect(panner); panner.connect(voiceGain);
  // Tap the raw stream to detect when this peer is speaking (distance-independent).
  const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
  src.connect(analyser);
  return { src, gain, panner, el, analyser, buf: new Uint8Array(analyser.fftSize) };
}

export function audioCtxState() { return ctx ? ctx.state : 'none'; }

// RMS level (0..1) of a voice sink — used to tell if that peer is talking.
export function voiceLevel(handle) {
  if (!handle || !handle.analyser) return 0;
  handle.analyser.getByteTimeDomainData(handle.buf);
  let sum = 0;
  for (let i = 0; i < handle.buf.length; i++) {
    const v = (handle.buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / handle.buf.length);
}

// Update a voice sink's volume/pan from the speaker's world position.
export function setVoiceProximity(handle, pos, maxDist = 24) {
  if (!handle || !listener) return;
  const dx = pos.x - listener.x;
  const dy = (pos.y ?? listener.y) - listener.y;
  const dz = pos.z - listener.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const g = Math.max(0, Math.min(1, (maxDist - dist) / (maxDist - 2)));  // full ≤2m, 0 at maxDist
  handle.gain.gain.value = g;
  const horiz = Math.hypot(dx, dz) || 1;
  handle.panner.pan.value = Math.max(-1, Math.min(1, (dx * listener.rx + dz * listener.rz) / horiz)) * 0.7;
}

export function disposeVoiceSink(handle) {
  if (!handle) return;
  try { handle.src.disconnect(); handle.gain.disconnect(); handle.panner.disconnect(); } catch (_) {}
  try { handle.el.pause(); handle.el.srcObject = null; } catch (_) {}
}

export function resume() {
  ensureCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (started) return;
  started = true;

  // Decode any prefetched override files, then prefer them.
  Promise.all(Object.keys(pendingBuffers).map((name) =>
    ctx.decodeAudioData(pendingBuffers[name].slice(0))
      .then((buf) => { samples[name] = buf; })
      .catch(() => {})
  )).then(() => { if (musicOn) startMusic(); });

  if (musicOn) startMusic();   // start generative music immediately
}

export function isMusicOn() { return musicOn; }

export function toggleMusic() {
  musicOn = !musicOn;
  if (!ctx) return musicOn;
  if (musicOn) startMusic(); else stopMusic();
  return musicOn;
}

// --- White-noise helper for percussive SFX ----------------------------------
let noiseBuf = null;
function noiseSource() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < d.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (s / 0x3fffffff) - 1;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

function env(t0, peak, dur, attack = 0.005) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  return g;
}

// --- Spatial routing --------------------------------------------------------
// Sounds optionally carry a world position. We attenuate by distance and pan
// left/right by angle relative to the listener (the local player). A sound with
// no position (your own actions) plays full and centred.
let listener = null;   // { x, y, z, rx, rz } — rx,rz = listener's "right" axis

export function setListener(x, y, z, yaw) {
  listener = { x, y, z, rx: Math.cos(yaw), rz: -Math.sin(yaw) };
}

// Returns { node, gain } to route a sound through, or null if it's inaudible
// (too far). `node` is a stereo panner (spatial) or sfxGain (centred).
function dest(pos, maxDist) {
  if (!pos || !listener) return { node: sfxGain, gain: 1 };
  const dx = pos.x - listener.x;
  const dy = (pos.y ?? listener.y) - listener.y;
  const dz = pos.z - listener.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist >= maxDist) return null;
  const gain = Math.pow(1 - dist / maxDist, 1.6);
  const horiz = Math.hypot(dx, dz) || 1;
  const pan = Math.max(-1, Math.min(1, (dx * listener.rx + dz * listener.rz) / horiz));
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan * 0.85;
  panner.connect(sfxGain);
  return { node: panner, gain };
}

function playSample(name, d) {
  const src = ctx.createBufferSource();
  src.buffer = samples[name];
  const g = ctx.createGain();
  g.gain.value = d.gain;
  src.connect(g); g.connect(d.node);
  src.start();
}

// --- Sound effects ----------------------------------------------------------
// Every effect takes an optional world position `pos`; pass it for other
// players' actions so they're heard in space, omit it for your own.
export function playBreak(pos) {
  if (!ctx) return;
  const d = dest(pos, 30); if (!d) return;
  if (samples.break) return playSample('break', d);
  const t0 = ctx.currentTime;
  const src = noiseSource();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(2200, t0);
  lp.frequency.exponentialRampToValueAtTime(350, t0 + 0.18);
  const ng = env(t0, 0.5 * d.gain, 0.2);
  src.connect(lp); lp.connect(ng); ng.connect(d.node);
  src.start(t0); src.stop(t0 + 0.22);
  const osc = ctx.createOscillator();        // low thunk for weight
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(150, t0);
  osc.frequency.exponentialRampToValueAtTime(70, t0 + 0.12);
  const og = env(t0, 0.4 * d.gain, 0.15);
  osc.connect(og); og.connect(d.node);
  osc.start(t0); osc.stop(t0 + 0.17);
}

export function playPlace(pos) {
  if (!ctx) return;
  const d = dest(pos, 30); if (!d) return;
  if (samples.place) return playSample('place', d);
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(240, t0);
  osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.09);
  const g = env(t0, 0.45 * d.gain, 0.12);
  osc.connect(g); g.connect(d.node);
  osc.start(t0); osc.stop(t0 + 0.14);
}

// Spark / fuse-light tick when igniting TNT.
export function playIgnite(pos) {
  if (!ctx) return;
  const d = dest(pos, 24); if (!d) return;
  const t0 = ctx.currentTime;
  const src = noiseSource();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 2200;
  const g = env(t0, 0.25 * d.gain, 0.18);
  src.connect(hp); hp.connect(g); g.connect(d.node);
  src.start(t0); src.stop(t0 + 0.2);
}

// Big boom for TNT (carries further than other effects).
export function playExplosion(pos) {
  if (!ctx) return;
  const d = dest(pos, 50); if (!d) return;
  if (samples.explode) return playSample('explode', d);
  const t0 = ctx.currentTime;
  const src = noiseSource();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, t0);
  lp.frequency.exponentialRampToValueAtTime(110, t0 + 0.5);
  const ng = env(t0, 0.95 * d.gain, 0.6);
  src.connect(lp); lp.connect(ng); ng.connect(d.node);
  src.start(t0); src.stop(t0 + 0.65);
  const o = ctx.createOscillator();          // low rumble
  o.type = 'sine';
  o.frequency.setValueAtTime(90, t0);
  o.frequency.exponentialRampToValueAtTime(38, t0 + 0.5);
  const og = env(t0, 0.7 * d.gain, 0.55);
  o.connect(og); og.connect(d.node);
  o.start(t0); o.stop(t0 + 0.6);
}

let stepSalt = 7;
export function playStep(pos) {
  if (!ctx) return;
  const d = dest(pos, 18); if (!d) return;
  if (samples.step) return playSample('step', d);
  stepSalt = (stepSalt * 1103515245 + 12345) & 0x7fffffff;
  const jitter = stepSalt / 0x7fffffff;
  const t0 = ctx.currentTime;
  const src = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 320 + jitter * 240;
  bp.Q.value = 0.8;
  const g = env(t0, 0.12 * d.gain, 0.08);
  src.connect(bp); bp.connect(g); g.connect(d.node);
  src.start(t0); src.stop(t0 + 0.1);
}

// --- Background music -------------------------------------------------------
// Either loop a provided music file, or generate a calm pentatonic piece with
// a soft pad, a wandering melody and a gentle bass. Pentatonic + triads means
// it always sounds consonant, however the notes fall.
let musicTimer = null;
let fileSource = null;
let nextNoteTime = 0;
let step = 0;
let melodyIdx = 4;

const BPM = 76;
const EIGHTH = (60 / BPM) / 2;

// C-major pentatonic melody notes across two octaves (Hz).
const PENTA = [261.63, 293.66, 329.63, 392.00, 440.00,
               523.25, 587.33, 659.25, 783.99, 880.00];
// Chord triads (Hz), one per two bars: C, G, Am, F.
const CHORDS = [
  [130.81, 164.81, 196.00],
  [98.00, 123.47, 146.83],
  [110.00, 130.81, 164.81],
  [87.31, 110.00, 130.81],
];

export function startMusic() {
  if (!ctx) return;
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.setTargetAtTime(0.22, ctx.currentTime, 0.6);

  // Prefer a real music file if one was provided.
  if (samples.music) {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } // stop generative
    if (fileSource) return;
    fileSource = ctx.createBufferSource();
    fileSource.buffer = samples.music;
    fileSource.loop = true;
    fileSource.connect(musicGain);
    fileSource.start();
    return;
  }
  if (musicTimer || fileSource) return;
  nextNoteTime = ctx.currentTime + 0.1;
  step = 0;
  musicTimer = setInterval(scheduleMusic, 90);
}

export function stopMusic() {
  if (!ctx) return;
  musicGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.3);
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  if (fileSource) { try { fileSource.stop(); } catch (_) {} fileSource = null; }
}

function scheduleMusic() {
  while (nextNoteTime < ctx.currentTime + 0.2) {
    emitStep(step, nextNoteTime);
    nextNoteTime += EIGHTH;
    step++;
  }
}

function tone(type, freq, t, dur, peak, attack, filterHz) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = env(t, peak, dur, attack);
  if (filterHz) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = filterHz;
    o.connect(f); f.connect(g);
  } else {
    o.connect(g);
  }
  g.connect(musicGain);
  o.start(t); o.stop(t + dur + 0.05);
}

function emitStep(s, t) {
  const pos = s % 16;                       // 16 eighths = 2 bars
  const chord = CHORDS[Math.floor(s / 16) % CHORDS.length];

  if (pos === 0) {
    // Soft sustained pad on the chord (warm, slow attack).
    for (const f of chord) tone('triangle', f * 2, t, 6.0, 0.10, 0.5, 900);
    tone('sine', chord[0] / 2, t, 2.2, 0.18, 0.02);   // bass on the down-beat
  }
  if (pos === 8) tone('sine', chord[0] / 2, t, 2.0, 0.15, 0.02);

  // Wandering melody, a little sparse so it breathes.
  if (Math.random() < 0.55) {
    melodyIdx += [-1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 6)];
    melodyIdx = Math.max(0, Math.min(PENTA.length - 1, melodyIdx));
    tone('triangle', PENTA[melodyIdx], t, 0.5, 0.16, 0.01, 2500);
  }
}
