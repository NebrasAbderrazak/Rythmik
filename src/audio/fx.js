// Effects shared by the beat bus and the voice chain, realtime and offline.
import { TRACK_IDS, clampUnit, secondsPerStep } from './constants.js';

export const ECHO_TIMES = ['1/8', '3/16', '1/4'];
const ECHO_STEPS = { '1/8': 2, '3/16': 3, '1/4': 4 };
export const FX_NAMES = ['reverb', 'echo', 'echoTime', 'filter', 'drive'];
export const SEND_KINDS = ['reverb', 'echo'];

export const ECHO_FEEDBACK = 0.35;
const ECHO_LOOP_LP = 4200;
const MAX_DELAY = 2;
const RAMP = 0.04; // s, parameter glides
const ECHO_TAU = 0.06; // delay time glide: short tape-style pitch bend on tempo changes

export const REVERB_SECONDS = 2.2;
export const REVERB_PREDELAY = 0.02;

// kick and 808 stay dry so the low end stays tight
export const DEFAULT_SENDS = {
  kick: { reverb: 0, echo: 0 },
  snare: { reverb: 0.3, echo: 0.2 },
  clap: { reverb: 0.35, echo: 0.25 },
  hat: { reverb: 0.1, echo: 0.15 },
  openhat: { reverb: 0.25, echo: 0.2 },
  rim: { reverb: 0.3, echo: 0.3 },
  shaker: { reverb: 0.15, echo: 0.1 },
  bass: { reverb: 0, echo: 0 },
};

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const round3 = (x) => Math.round(x * 1000) / 1000;

export function defaultFx() {
  const sends = {};
  for (const id of TRACK_IDS) sends[id] = { ...DEFAULT_SENDS[id] };
  return { reverb: 0, echo: 0, echoTime: '1/8', filter: 0, drive: 0, sends };
}

/** Clamps one fx value; returns `fallback` for junk. */
export function clampFx(name, value, fallback) {
  if (name === 'echoTime') return ECHO_TIMES.includes(value) ? value : fallback;
  if (name === 'filter') {
    const v = clampUnit(value, fallback, -1, 1);
    return v === fallback ? v : round3(v);
  }
  const v = clampUnit(value, fallback);
  return v === fallback ? v : round3(v);
}

export function normalizeFx(src) {
  const out = defaultFx();
  if (!isObject(src)) return out;
  for (const name of FX_NAMES) out[name] = clampFx(name, src[name], out[name]);
  const sends = isObject(src.sends) ? src.sends : {};
  for (const id of TRACK_IDS) {
    const s = isObject(sends[id]) ? sends[id] : {};
    for (const k of SEND_KINDS) out.sends[id][k] = clampFx(k, s[k], out.sends[id][k]);
  }
  return out;
}

export const echoSeconds = (bpm, echoTime = '1/8') => secondsPerStep(bpm) * (ECHO_STEPS[echoTime] || 2);

// echo repeats lose ~9 dB each; reverb IR is ~60 dB down at its end
export function fxTail(fx, bpm) {
  if (!fx) return 0;
  let tail = 0;
  const anySend = (k) => TRACK_IDS.some((id) => fx.sends?.[id]?.[k] > 0);
  if (fx.reverb > 0 && (fx.sends ? anySend('reverb') : true)) tail = REVERB_SECONDS + REVERB_PREDELAY;
  if (fx.echo > 0 && (fx.sends ? anySend('echo') : true)) {
    const repeats = Math.ceil(Math.log(0.001) / Math.log(ECHO_FEEDBACK));
    tail = Math.max(tail, repeats * echoSeconds(bpm, fx.echoTime) + 0.2);
  }
  return tail;
}

// ---- parameter helpers ----

export function glide(ctx, param, value, smooth, exp = false) {
  if (!smooth) {
    param.cancelScheduledValues(0);
    param.value = value;
    return;
  }
  const t = ctx.currentTime;
  const from = param.value;
  param.cancelScheduledValues(t);
  param.setValueAtTime(from, t);
  if (exp && from > 0 && value > 0) param.exponentialRampToValueAtTime(value, t + RAMP);
  else param.linearRampToValueAtTime(value, t + RAMP);
}

// ---- impulse response ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const irCache = new Map();

/**
 * Decaying stereo noise, 60 dB down after `seconds`, darker as it decays.
 * Seeded so renders are repeatable. Scaled to unit energy per channel.
 */
export function impulseResponse(sampleRate, { seconds = REVERB_SECONDS, preDelay = REVERB_PREDELAY } = {}) {
  const key = `${sampleRate}|${seconds}|${preDelay}`;
  let ir = irCache.get(key);
  if (ir) return ir;
  const pre = Math.round(preDelay * sampleRate);
  const n = pre + Math.round(seconds * sampleRate);
  const fade = Math.round(0.004 * sampleRate);
  ir = [0, 1].map((ch) => {
    const rnd = mulberry32(0x5eed + ch * 7919);
    const out = new Float32Array(n);
    let lp = 0;
    let energy = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sampleRate;
      const env = Math.exp((-6.91 * t) / seconds) * Math.min(1, (i - pre + 1) / fade);
      const fc = 2500 + 9500 * Math.exp(-t / 0.5);
      const a = Math.exp((-2 * Math.PI * fc) / sampleRate);
      lp = (1 - a) * (rnd() * 2 - 1) + a * lp;
      out[i] = lp * env;
      energy += out[i] * out[i];
    }
    const k = 1 / Math.sqrt(energy || 1);
    for (let i = pre; i < n; i++) out[i] *= k;
    return out;
  });
  irCache.set(key, ir);
  return ir;
}

const irBuffers = new WeakMap();
function irBuffer(ctx) {
  let buf = irBuffers.get(ctx);
  if (!buf) {
    const [l, r] = impulseResponse(ctx.sampleRate);
    buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    irBuffers.set(ctx, buf);
  }
  return buf;
}

// ---- building blocks ----

/** input -> highpass -> convolver -> output (wet only). */
export function createReverb(ctx, highpass = 180) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = highpass;
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = irBuffer(ctx);
  const output = ctx.createGain();
  input.connect(hp).connect(conv).connect(output);
  return { input, output };
}

/** input -> highpass -> delay <-> (lowpass -> feedback); output is wet only. */
export function createEcho(ctx, seconds) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 150;
  const delay = ctx.createDelay(MAX_DELAY);
  delay.delayTime.value = Math.min(MAX_DELAY, seconds);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = ECHO_LOOP_LP;
  lp.Q.value = 0.5;
  const fb = ctx.createGain();
  fb.gain.value = ECHO_FEEDBACK;
  const output = ctx.createGain();
  input.connect(hp).connect(delay).connect(lp);
  lp.connect(fb).connect(delay);
  lp.connect(output);
  return {
    input,
    output,
    setTime(s, smooth) {
      const v = Math.min(MAX_DELAY, s);
      if (smooth) {
        delay.delayTime.cancelScheduledValues(ctx.currentTime);
        delay.delayTime.setTargetAtTime(v, ctx.currentTime, ECHO_TAU);
      } else delay.delayTime.value = v;
    },
  };
}

const DRIVE_SPAN = 8;
const DRIVE_REF = 0.5;
let driveCurve = null;
function getDriveCurve() {
  if (!driveCurve) {
    const n = 8193;
    driveCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) driveCurve[i] = Math.tanh(DRIVE_SPAN * ((i / (n - 1)) * 2 - 1));
  }
  return driveCurve;
}

// out = post * tanh(k * in). At k = 0.05 that is linear to within 0.1% for
// normal levels. post keeps a 0.5 peak at 0.5 so peaks stay put as drive goes
// up; quieter parts come up (that is the saturation), so it sounds denser.
export const driveK = (d) => 0.05 + 3.95 * d;
export const driveMakeup = (k) => DRIVE_REF / Math.tanh(k * DRIVE_REF);

/**
 * Soft saturation. Oversampling delays the signal a few ms, so at drive 0 the
 * signal takes a dry path instead (exact beat timing) and crossfades over on
 * change. The shaper is only built once drive is first used.
 */
export function createDrive(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  input.connect(dry).connect(output);
  let wet = null;
  const set = (d, smooth) => {
    if (!wet && d > 0) {
      const pre = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.curve = getDriveCurve();
      shaper.oversample = '2x';
      const post = ctx.createGain();
      pre.gain.value = driveK(d) / DRIVE_SPAN;
      post.gain.value = driveMakeup(driveK(d));
      const mix = ctx.createGain();
      mix.gain.value = 0;
      input.connect(pre).connect(shaper).connect(post).connect(mix).connect(output);
      wet = { pre, post, mix };
    }
    if (!wet) return;
    const k = driveK(d);
    // both ramps are exponential so k * post never overshoots mid-glide
    glide(ctx, wet.pre.gain, k / DRIVE_SPAN, smooth, true);
    glide(ctx, wet.post.gain, driveMakeup(k), smooth, true);
    glide(ctx, wet.mix.gain, d > 0 ? 1 : 0, smooth);
    glide(ctx, dry.gain, d > 0 ? 0 : 1, smooth);
  };
  return { input, output, set };
}

const LP_MIN = 180;
const HP_MAX = 3000;
const OPEN = 20000;

/** -1..1 -> { type, frequency, Q }. Exponential so equal knob moves sound equal. */
export function filterSettings(v, sampleRate) {
  const top = Math.min(OPEN, sampleRate * 0.45);
  if (v > 0) return { type: 'highpass', frequency: 20 * (HP_MAX / 20) ** v, Q: 0.707 + 0.4 * v };
  const a = -v;
  return { type: 'lowpass', frequency: top * (LP_MIN / top) ** a, Q: 0.707 + 0.4 * a };
}

/**
 * At 0 the signal skips the biquad (a 20 kHz lowpass still dulls the top end);
 * moving off 0 crossfades into it. Neither path delays the signal, so the
 * crossfade cannot comb.
 */
export function createSweepFilter(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0;
  const f = ctx.createBiquadFilter();
  input.connect(dry).connect(output);
  input.connect(f).connect(wet).connect(output);
  let current = null;
  const set = (v, smooth) => {
    const s = filterSettings(v, ctx.sampleRate);
    const live = smooth && current !== null;
    if (live && s.type !== f.type) {
      // restart from the new type's open end so the switch itself is inaudible
      f.type = s.type;
      f.frequency.cancelScheduledValues(0);
      f.frequency.value = s.type === 'highpass' ? 20 : filterSettings(0, ctx.sampleRate).frequency;
    } else {
      f.type = s.type;
    }
    glide(ctx, f.frequency, s.frequency, live, true);
    glide(ctx, f.Q, s.Q, live);
    glide(ctx, wet.gain, v === 0 ? 0 : 1, live);
    glide(ctx, dry.gain, v === 0 ? 1 : 0, live);
    current = v;
  };
  set(0, false);
  return { input, output, set };
}

// ---- beat bus ----

const REVERB_RETURN = 1.4;
const ECHO_RETURN = 1;

/**
 * tracks -> input -> drive -> sum -> filter -> destination
 * per-track sends -> sends.reverb / sends.echo -> returns -> sum
 * Reverb and echo are built the first time they are used: an idle convolver
 * still costs CPU, and offline renders without them stay fast.
 */
export function createBeatFx(ctx, destination) {
  const input = ctx.createGain();
  const sum = ctx.createGain();
  const filter = createSweepFilter(ctx);
  const drive = createDrive(ctx);
  const sends = { reverb: ctx.createGain(), echo: ctx.createGain() };
  const reverbReturn = ctx.createGain();
  const echoReturn = ctx.createGain();
  reverbReturn.gain.value = 0;
  echoReturn.gain.value = 0;
  reverbReturn.connect(sum);
  echoReturn.connect(sum);
  input.connect(drive.input);
  drive.output.connect(sum);
  sum.connect(filter.input);
  filter.output.connect(destination);

  let reverb = null;
  let echo = null;
  let echoTime = '1/8';
  let bpm = 120;
  const anySend = (fx, k) => TRACK_IDS.some((id) => fx.sends?.[id]?.[k] > 0);
  return {
    input,
    sends,
    apply(fx, smooth = true) {
      if (!reverb && fx.reverb > 0 && anySend(fx, 'reverb')) {
        reverb = createReverb(ctx);
        sends.reverb.connect(reverb.input);
        reverb.output.connect(reverbReturn);
      }
      if (!echo && fx.echo > 0 && anySend(fx, 'echo')) {
        echo = createEcho(ctx, echoSeconds(bpm, fx.echoTime));
        sends.echo.connect(echo.input);
        echo.output.connect(echoReturn);
      } else if (echo && fx.echoTime !== echoTime) {
        echo.setTime(echoSeconds(bpm, fx.echoTime), smooth);
      }
      echoTime = fx.echoTime;
      glide(ctx, reverbReturn.gain, fx.reverb * REVERB_RETURN, smooth);
      glide(ctx, echoReturn.gain, fx.echo * ECHO_RETURN, smooth);
      drive.set(fx.drive, smooth);
      filter.set(fx.filter, smooth);
    },
    setTempo(next, smooth = true) {
      if (next === bpm) return;
      bpm = next;
      echo?.setTime(echoSeconds(bpm, echoTime), smooth);
    },
  };
}
