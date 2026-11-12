// Voice effects: offline pitch correction (YIN + TD-PSOLA) and the realtime
// voice chain (tone, reverb, echo) used for preview and, offline, for export.
import { clampUnit } from './constants.js';
import { createReverb, createEcho, echoSeconds, glide, REVERB_SECONDS, REVERB_PREDELAY, ECHO_FEEDBACK } from './fx.js';

export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = ['minor', 'major'];
export const TONES = ['clean', 'full', 'radio', 'lofi'];
const SCALE_STEPS = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };

const preset = (name, description, settings) => ({
  name,
  description,
  settings: { tune: 0, retune: 0.5, tone: 'full', reverb: 0, echo: 0, ...settings },
});

// presets leave key and scale alone
export const VOICE_PRESETS = {
  clean: preset('Clean', 'Your voice as recorded, only the rumble removed.', { tone: 'clean' }),
  robot: preset('Robot', 'Hard snap to the key: the robotic autotune sound.', {
    tune: 1, retune: 0, reverb: 0.1, echo: 0.15,
  }),
  tuned: preset('Tuned', 'Gentle pitch correction that still sounds natural.', {
    tune: 0.8, retune: 0.6, reverb: 0.12,
  }),
  radio: preset('Radio', 'Thin and crunchy, like an old radio or a phone.', {
    tone: 'radio', reverb: 0.05, echo: 0.1,
  }),
  hall: preset('Hall', 'Big reverb, like rapping in a large hall.', { reverb: 0.6, echo: 0.08 }),
  lofi: preset('Lo-fi', 'Dark and a little gritty.', { tone: 'lofi', reverb: 0.1 }),
};

export const DEFAULT_VOICE = { ...VOICE_PRESETS.clean.settings, key: 'A', scale: 'minor' };

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const round3 = (x) => Math.round(x * 1000) / 1000;

export function normalizeVoice(src, base = DEFAULT_VOICE) {
  const s = isObject(src) ? src : {};
  const unit = (k) => (s[k] === undefined ? base[k] : round3(clampUnit(s[k], base[k])));
  return {
    tune: unit('tune'),
    retune: unit('retune'),
    key: KEYS.includes(s.key) ? s.key : base.key,
    scale: SCALES.includes(s.scale) ? s.scale : base.scale,
    tone: TONES.includes(s.tone) ? s.tone : base.tone,
    reverb: unit('reverb'),
    echo: unit('echo'),
  };
}

/** Settings that change the tuned samples (the rest is realtime). */
export const tuningKey = (v) => (v.tune > 0 ? `${v.tune}|${v.retune}|${v.key}|${v.scale}` : 'off');

export const VOICE_ECHO = '3/16';

export function voiceTail(v, bpm) {
  let tail = 0;
  if (v.reverb > 0) tail = REVERB_SECONDS + REVERB_PREDELAY;
  if (v.echo > 0) {
    const repeats = Math.ceil(Math.log(0.001) / Math.log(ECHO_FEEDBACK));
    tail = Math.max(tail, repeats * echoSeconds(bpm, VOICE_ECHO) + 0.2);
  }
  return tail;
}

// ---- pitch detection (YIN) ----

const MIN_F0 = 70;
const MAX_F0 = 1000;
const FRAME = 0.04;
const HOP = 0.005;
const YIN_THRESHOLD = 0.15;
const GATE = 0.03; // frames more than ~30 dB below the loudest are unvoiced
const MIN_RUN = 3; // frames
const SLICE_MS = 20;

const defaultYield = () => new Promise((r) => setTimeout(r, 0));

function makeYielder(opts) {
  const yieldFn = opts.yield || defaultYield;
  const now = () => globalThis.performance?.now() ?? Date.now();
  let last = now();
  return async () => {
    if (opts.isCancelled?.()) throw new Error('voice-cancelled');
    if (now() - last < SLICE_MS) return;
    await yieldFn();
    if (opts.isCancelled?.()) throw new Error('voice-cancelled');
    last = now();
  };
}

/**
 * Lowpass (two cascaded biquads, 4th order) and keep every D-th sample, in one
 * pass so no full-rate filtered copy is kept. Yields every `chunk` samples.
 */
async function decimate(x, sr, D, fc, tick) {
  const y = new Float32Array(Math.ceil(x.length / D));
  if (D === 1) { y.set(x); return y; }
  const w = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * 0.707);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let p1 = 0, p2 = 0, q1 = 0, q2 = 0; // stage 1 in/out history
  let r1 = 0, r2 = 0, s1 = 0, s2 = 0; // stage 2
  const chunk = 1 << 16;
  for (let i = 0; i < x.length; i++) {
    if (i % chunk === 0) await tick();
    const u = b0 * x[i] + b1 * p1 + b0 * p2 - a1 * q1 - a2 * q2;
    p2 = p1; p1 = x[i]; q2 = q1; q1 = u;
    const v = b0 * u + b1 * r1 + b0 * r2 - a1 * s1 - a2 * s2;
    r2 = r1; r1 = u; s2 = s1; s1 = v;
    if (i % D === 0) y[i / D] = v;
  }
  return y;
}

function parabolicMin(d, i) {
  if (i <= 0 || i >= d.length - 1) return i;
  const a = d[i - 1], b = d[i], c = d[i + 1];
  const den = a - 2 * b + c;
  return den > 0 ? i + (0.5 * (a - c)) / den : i;
}

/**
 * Pitch track: f0[k] in Hz for the frame centred on sample k * hop, 0 = unvoiced.
 * Coarse YIN on a ~11 kHz copy, refined on the full-rate signal.
 * @returns {Promise<{ f0: Float32Array, hop: number }>}
 */
export async function detectPitch(x, sampleRate, opts = {}) {
  const tick = makeYielder(opts);
  const D = Math.max(1, Math.round(sampleRate / 11025));
  const srd = sampleRate / D;
  const y = await decimate(x, sampleRate, D, srd * 0.4, tick);

  const tauMin = Math.max(2, Math.floor(srd / MAX_F0));
  const tauMax = Math.ceil(srd / MIN_F0);
  const W = Math.max(Math.round(FRAME * srd) - tauMax, Math.ceil(tauMax * 1.2));
  const span = W + tauMax;
  const hop = Math.round(HOP * sampleRate);
  const frames = Math.floor(x.length / hop) + 1;
  const Wf = W * D;

  // frame energy from per-hop block sums, summed over the blocks a frame spans
  const blocks = new Float64Array(frames);
  for (let i = 0; i < x.length; i++) blocks[(i / hop) | 0] += x[i] * x[i];
  const half = Math.max(1, Math.round(Wf / hop / 2));
  const rms = new Float32Array(frames);
  let loudest = 0;
  for (let k = 0; k < frames; k++) {
    const a = Math.max(0, k - half);
    const b = Math.min(frames, k + half);
    let e = 0;
    for (let i = a; i < b; i++) e += blocks[i];
    rms[k] = Math.sqrt(e / ((b - a) * hop));
    if (rms[k] > loudest) loudest = rms[k];
  }
  const gate = Math.max(1e-4, loudest * GATE);

  const f0 = new Float32Array(frames);
  const d = new Float32Array(tauMax + 1);
  const dn = new Float32Array(tauMax + 1);
  const at = (arr, i) => (i >= 0 && i < arr.length ? arr[i] : 0);

  for (let k = 0; k < frames; k++) {
    if (k % 64 === 0) await tick();
    if (rms[k] < gate) continue;
    const s = Math.round((k * hop) / D) - (span >> 1);
    const inside = s >= 0 && s + span <= y.length;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      if (inside) {
        for (let j = 0; j < W; j++) { const v = y[s + j] - y[s + j + tau]; sum += v * v; }
      } else {
        for (let j = 0; j < W; j++) { const v = at(y, s + j) - at(y, s + j + tau); sum += v * v; }
      }
      d[tau] = sum;
    }
    let run = 0;
    dn[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += d[tau];
      dn[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (dn[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= tauMax && dn[tau + 1] < dn[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) continue;

    // refine at full rate around the coarse lag
    const coarse = parabolicMin(dn, best) * D;
    const lo = Math.max(1, Math.floor(coarse) - D - 1);
    const hi = Math.ceil(coarse) + D + 1;
    const sf = k * hop - (((W + tauMax) * D) >> 1);
    const dl = new Float64Array(hi - lo + 1);
    for (let tau = lo; tau <= hi; tau++) {
      let sum = 0;
      for (let j = 0; j < Wf; j++) { const v = at(x, sf + j) - at(x, sf + j + tau); sum += v * v; }
      dl[tau - lo] = sum;
    }
    let m = 0;
    for (let i = 1; i < dl.length; i++) if (dl[i] < dl[m]) m = i;
    const tau = lo + parabolicMin(dl, m);
    const f = sampleRate / tau;
    if (f >= MIN_F0 * 0.95 && f <= MAX_F0 * 1.05) f0[k] = f;
  }

  // drop blips, then a 3-frame median inside voiced runs against octave jumps
  for (let k = 0; k < frames;) {
    if (!f0[k]) { k++; continue; }
    let e = k;
    while (e < frames && f0[e]) e++;
    if (e - k < MIN_RUN) f0.fill(0, k, e);
    else {
      const run = f0.slice(k, e);
      for (let i = 1; i < run.length - 1; i++) {
        const a = run[i - 1], b = run[i], c = run[i + 1];
        f0[k + i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
      }
    }
    k = e;
  }
  return { f0, hop };
}

// ---- target pitch ----

const midiOf = (f) => 69 + 12 * Math.log2(f / 440);
const HYSTERESIS = 0.2; // semitones; keeps a wobble on a boundary from flipping notes

function nearestNote(m, pcs) {
  let best = null;
  const r = Math.round(m);
  for (let n = r - 2; n <= r + 2; n++) {
    if (!pcs.has(((n % 12) + 12) % 12)) continue;
    if (best === null || Math.abs(m - n) < Math.abs(m - best)) best = n;
  }
  return best;
}

/** Pitch-shift ratio per frame (1 where unvoiced). */
export function correctionRatios(f0, hopSeconds, settings) {
  const v = normalizeVoice(settings);
  const root = KEYS.indexOf(v.key);
  const pcs = new Set(SCALE_STEPS[v.scale].map((s) => (root + s) % 12));
  // retune 0 = instant; 1 = ~0.4 s glide toward the note
  const tau = v.retune <= 0 ? 0 : 0.01 + 0.39 * v.retune * v.retune;
  const alpha = tau ? 1 - Math.exp(-hopSeconds / tau) : 1;
  const out = new Float32Array(f0.length).fill(1);
  let note = null;
  let c = 0;
  for (let k = 0; k < f0.length; k++) {
    if (!(f0[k] > 0)) { note = null; continue; }
    const m = midiOf(f0[k]);
    let n = nearestNote(m, pcs);
    if (note !== null && n !== note && Math.abs(m - note) - Math.abs(m - n) < HYSTERESIS) n = note;
    const want = (n - m) * v.tune;
    c = note === null ? want : c + alpha * (want - c);
    note = n;
    out[k] = 2 ** (c / 12);
  }
  return out;
}

// ---- pitch shifting (TD-PSOLA) ----

const FADE = 0.008; // s, crossfade between shifted and untouched audio

function voicedRuns(f0) {
  const runs = [];
  for (let k = 0; k < f0.length;) {
    if (!(f0[k] > 0)) { k++; continue; }
    let e = k;
    while (e < f0.length && f0[e] > 0) e++;
    runs.push([k, e - 1]);
    k = e;
  }
  return runs;
}

/**
 * Grains two periods long, cut at period-spaced analysis marks and laid down
 * at period/ratio spacing; timing is kept by always using the analysis mark
 * nearest in time. Overlap is normalised by the summed window.
 */
async function psolaRun(x, acc, wsum, from, to, periodAt, ratioAt, tick) {
  const marks = [];
  for (let m = from; m <= to; m += periodAt(m)) marks.push(m);
  if (marks.length < 2) return;
  const last = marks[marks.length - 1];
  let j = 0;
  let grains = 0;
  for (let t = marks[0]; t <= last; t += periodAt(t) / ratioAt(t)) {
    if (++grains % 64 === 0) await tick();
    while (j + 1 < marks.length && Math.abs(marks[j + 1] - t) <= Math.abs(marks[j] - t)) j++;
    const ta = marks[j];
    const P = periodAt(ta);
    const n0 = Math.max(0, Math.ceil(t - P));
    const n1 = Math.min(acc.length - 1, Math.floor(t + P));
    for (let n = n0; n <= n1; n++) {
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (n - t)) / P);
      const pos = ta + (n - t);
      const i = Math.floor(pos);
      if (i < 0 || i + 1 >= x.length) continue;
      const v = x[i] + (x[i + 1] - x[i]) * (pos - i);
      acc[n] += v * w;
      wsum[n] += w;
    }
  }
}

/**
 * Pitch correction of a mono signal. Same length out; unvoiced parts are
 * copied untouched. opts: yield() between slices, isCancelled() (throws
 * Error('voice-cancelled')), pitch (a detectPitch result to reuse).
 */
export async function correctPitch(x, sampleRate, settings, opts = {}) {
  const v = normalizeVoice(settings);
  const out = Float32Array.from(x);
  if (!(v.tune > 0) || x.length < 2) return out;
  const tick = makeYielder(opts);
  const { f0, hop } = opts.pitch || await detectPitch(x, sampleRate, opts);
  const ratio = correctionRatios(f0, hop / sampleRate, v);
  const fade = Math.round(FADE * sampleRate);

  for (const [k0, k1] of voicedRuns(f0)) {
    await tick();
    const a = k0 * hop;
    const b = k1 * hop;
    const interp = (arr, n) => {
      const p = Math.min(k1, Math.max(k0, n / hop));
      const i = Math.min(k1 - 1, Math.floor(p));
      if (i < k0) return arr[k0];
      const fr = p - i;
      return arr[i] + (arr[i + 1] - arr[i]) * fr;
    };
    const periodAt = (n) => sampleRate / interp(f0, n);
    const ratioAt = (n) => interp(ratio, n);
    const pad = fade + 2 * periodAt(a);
    const from = Math.max(0, a - pad);
    const to = Math.min(x.length - 1, b + fade + 2 * periodAt(b));
    const lo = Math.floor(from);
    const len = Math.ceil(to) - lo + 1;
    const acc = new Float32Array(len);
    const wsum = new Float32Array(len);
    // work in a local window so memory stays proportional to the run
    const local = x.subarray(lo, lo + len);
    await psolaRun(local, acc, wsum, from - lo, to - lo, (n) => periodAt(n + lo), (n) => ratioAt(n + lo), tick);
    for (let i = 0; i < len; i++) {
      if (i % 65536 === 65535) await tick();
      const n = lo + i;
      // 1 inside the run, ramps to 0 over `fade` on both sides
      const mask = Math.max(0, Math.min(1, (n - (a - fade)) / fade, ((b + fade) - n) / fade));
      if (mask <= 0) continue;
      const w = wsum[i];
      const g = Math.min(1, w * 2);
      const shifted = w > 1e-6 ? (acc[i] / w) * g + x[n] * (1 - g) : x[n];
      // blend over what is there: the fades of runs a frame or two apart overlap
      out[n] += (shifted - out[n]) * mask;
    }
  }
  return out;
}

// ---- realtime voice chain ----

const VOICE_HIGHPASS_HZ = 80;
const VOICE_REVERB_RETURN = 0.6;
const VOICE_ECHO_RETURN = 0.5;
// per tone: compressor threshold/ratio, and a trim that offsets the compressor's automatic makeup gain
const TONE_DYNAMICS = {
  full: { threshold: -20, ratio: 3, trim: 0.55 },
  radio: { threshold: -24, ratio: 4, trim: 0.5 },
  lofi: { threshold: -18, ratio: 2.5, trim: 0.6 },
};

let radioCurve = null;
let crushCurve = null;
function getRadioCurve() {
  if (!radioCurve) {
    const n = 4097;
    radioCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) radioCurve[i] = Math.tanh(2.5 * ((i / (n - 1)) * 2 - 1)) / Math.tanh(2.5);
  }
  return radioCurve;
}
// mostly clean, part quantised to ~5 bits: grit that follows the voice, no hiss floor
function getCrushCurve() {
  if (!crushCurve) {
    const n = 8193;
    const steps = 16;
    crushCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      crushCurve[i] = 0.65 * x + 0.35 * (Math.round(x * steps) / steps);
    }
  }
  return crushCurve;
}

function biquad(ctx, type, frequency, Q = 0.707, gain = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  f.gain.value = gain;
  return f;
}

/**
 * input -> highpass -> level -> tone branch (full | radio | lofi) -> compressor -> trim -> out,
 * clean: level -> delay -> out, the delay matching the compressor look-ahead so
 * every tone has the same latency. out -> destination, reverb and echo sends.
 * Reverb and echo are built when first turned up.
 * opts: peak (of the samples played, sets the level), bpm (echo sync), settings,
 * delay (frames, from measureVoiceDelay).
 */
export function createVoiceChain(ctx, destination, {
  peak = 0.8, bpm = 120, settings = DEFAULT_VOICE, delay = 0,
} = {}) {
  const nodes = [];
  const add = (n) => { nodes.push(n); return n; };
  const input = add(biquad(ctx, 'highpass', VOICE_HIGHPASS_HZ));
  const level = add(ctx.createGain());
  level.gain.value = vocalGain(peak);
  input.connect(level);

  const sum = add(ctx.createGain());
  const branches = {};
  const branch = (id, chain) => {
    const g = add(ctx.createGain());
    g.gain.value = 0;
    let node = level;
    for (const n of chain) { node.connect(add(n)); node = n; }
    node.connect(g).connect(sum);
    branches[id] = g;
  };
  branch('full', [
    biquad(ctx, 'lowshelf', 200, 0.707, -2),
    biquad(ctx, 'peaking', 3500, 0.8, 3),
    biquad(ctx, 'highshelf', 10000, 0.707, 1.5),
  ]);
  const radioDrive = ctx.createWaveShaper();
  radioDrive.curve = getRadioCurve();
  const radioGain = ctx.createGain();
  radioGain.gain.value = 0.9;
  branch('radio', [
    biquad(ctx, 'highpass', 300, 0.9),
    biquad(ctx, 'lowpass', 3000, 1.1),
    biquad(ctx, 'peaking', 1500, 1, 4),
    radioDrive,
    radioGain,
  ]);
  const crush = ctx.createWaveShaper();
  crush.curve = getCrushCurve();
  branch('lofi', [
    biquad(ctx, 'lowpass', 5000, 0.9),
    biquad(ctx, 'lowshelf', 250, 0.707, 2),
    crush,
    biquad(ctx, 'lowpass', 6000, 0.707),
  ]);

  const comp = add(ctx.createDynamicsCompressor());
  comp.knee.value = 8;
  comp.attack.value = 0.005;
  comp.release.value = 0.15;
  const trim = add(ctx.createGain());
  const out = add(ctx.createGain());
  sum.connect(comp).connect(trim).connect(out);
  out.connect(destination);

  const lookahead = add(ctx.createDelay(0.1));
  lookahead.delayTime.value = Math.min(0.1, delay / ctx.sampleRate);
  const clean = add(ctx.createGain());
  clean.gain.value = 0;
  level.connect(lookahead).connect(clean).connect(out);
  branches.clean = clean;

  const reverbReturn = add(ctx.createGain());
  const echoReturn = add(ctx.createGain());
  reverbReturn.gain.value = 0;
  echoReturn.gain.value = 0;
  reverbReturn.connect(destination);
  echoReturn.connect(destination);
  let reverb = null;
  let echo = null;

  let current = null;
  function apply(next, smooth = true) {
    const v = normalizeVoice(next);
    if (!reverb && v.reverb > 0) {
      reverb = createReverb(ctx, 200);
      out.connect(reverb.input);
      reverb.output.connect(reverbReturn);
      nodes.push(reverb.input, reverb.output);
    }
    if (!echo && v.echo > 0) {
      echo = createEcho(ctx, echoSeconds(bpm, VOICE_ECHO));
      out.connect(echo.input);
      echo.output.connect(echoReturn);
      nodes.push(echo.input, echo.output);
    }
    for (const id of TONES) glide(ctx, branches[id].gain, v.tone === id ? 1 : 0, smooth);
    const dyn = TONE_DYNAMICS[v.tone] || TONE_DYNAMICS.full;
    glide(ctx, comp.threshold, dyn.threshold, smooth);
    glide(ctx, comp.ratio, dyn.ratio, smooth);
    glide(ctx, trim.gain, dyn.trim, smooth);
    glide(ctx, reverbReturn.gain, v.reverb * VOICE_REVERB_RETURN, smooth);
    glide(ctx, echoReturn.gain, v.echo * VOICE_ECHO_RETURN, smooth);
    current = v;
  }
  apply(settings, false);

  return {
    input,
    apply,
    get settings() { return current; },
    dispose() {
      for (const n of nodes) { try { n.disconnect(); } catch { /* already gone */ } }
    },
  };
}

const VOCAL_TARGET_PEAK = 0.8; // into the tone stage; clean passes it straight to the master bus
const VOCAL_MAX_BOOST = 4; // +12 dB

export function vocalGain(peak) {
  if (!(peak > 1e-4)) return 1;
  return Math.min(VOCAL_MAX_BOOST, VOCAL_TARGET_PEAK / peak);
}

const chainDelays = new Map();

/**
 * Signal delay of the voice chain in whole samples (compressor look-ahead).
 * Preview starts the voice this much early; offline renders trim it.
 */
export function measureVoiceDelay(sampleRate, Ctor = globalThis.OfflineAudioContext) {
  if (!Ctor) return Promise.resolve(0);
  let p = chainDelays.get(sampleRate);
  if (!p) {
    p = (async () => {
      const len = Math.round(sampleRate * 0.1);
      const ctx = new Ctor(1, len, sampleRate);
      const comp = ctx.createDynamicsCompressor();
      comp.connect(ctx.destination);
      const imp = ctx.createBuffer(1, 1, sampleRate);
      imp.getChannelData(0)[0] = 0.01;
      const src = ctx.createBufferSource();
      src.buffer = imp;
      src.connect(comp);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      let at = 0;
      for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[at])) at = i;
      return at;
    })().catch(() => 0);
    chainDelays.set(sampleRate, p);
  }
  return p;
}
