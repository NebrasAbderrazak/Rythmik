// Tempo: detection from audio (onset envelope + autocorrelation) and tap tempo.
import { createFft } from './fft.js';
import { makeYielder } from './work.js';

export const DETECT_MIN_BPM = 70;
export const DETECT_MAX_BPM = 180;

const WORK_RATE = 11025; // Hz, the song is averaged down to about this first
const FRAME = 512; // ~46 ms at the work rate
const HOP = 64; // ~5.8 ms
const SEARCH_MIN = 50;
const SEARCH_MAX = 220;
const COMB = 4; // beat multiples summed per candidate tempo
const FINE_COMB = 32; // more multiples for the last digits: the error at k beats is k times smaller
const MIN_SECONDS = 4;
const MAX_SECONDS = 120; // longer songs: the middle two minutes (skips long intros, plenty for 0.1 BPM)
const MEAN_WINDOW = 0.4; // s, local mean removed from the onset envelope
// favours tempos near 120 when two octaves fit equally well (70 vs 140)
const PRIOR_CENTRE = 120;
const PRIOR_OCTAVES = 1;

const TAP_MIN_BPM = 40;
const TAP_MAX_BPM = 220;

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Mono at about 11 kHz: plain averaging of D samples is a crude lowpass, but the
 * onset envelope only needs the energy changes, not a clean spectrum.
 */
async function downmix(buffer, tick) {
  const D = Math.max(1, Math.round(buffer.sampleRate / WORK_RATE));
  const span = Math.min(buffer.length, Math.round(MAX_SECONDS * buffer.sampleRate));
  const from = Math.floor((buffer.length - span) / 2);
  const n = Math.floor(span / D);
  const out = new Float32Array(n);
  const chans = buffer.numberOfChannels;
  const k = 1 / (D * chans);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      if ((i & 0xffff) === 0) await tick();
      let s = 0;
      const o = from + i * D;
      for (let j = 0; j < D; j++) s += data[o + j];
      out[i] += s * k;
    }
  }
  return { x: out, rate: buffer.sampleRate / D };
}

/** Spectral flux on log magnitudes, local mean removed, half-wave rectified. */
async function onsetEnvelope(x, tick) {
  const frames = Math.floor((x.length - FRAME) / HOP) + 1;
  const env = new Float32Array(Math.max(0, frames));
  const fft = createFft(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const bins = FRAME / 2;
  const prev = new Float64Array(bins + 1);
  for (let f = 0; f < frames; f++) {
    if ((f & 255) === 0) await tick();
    const o = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);
    let flux = 0;
    for (let k = 1; k <= bins; k++) {
      const m = Math.log1p(100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      if (f > 0 && m > prev[k]) flux += m - prev[k];
      prev[k] = m;
    }
    env[f] = flux;
  }
  return env;
}

function removeLocalMean(env, fps) {
  const w = Math.max(1, Math.round((MEAN_WINDOW * fps) / 2));
  const out = new Float32Array(env.length);
  const csum = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) csum[i + 1] = csum[i] + env[i];
  let mean = 0;
  for (let i = 0; i < env.length; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(env.length, i + w + 1);
    out[i] = Math.max(0, env[i] - (csum[b] - csum[a]) / (b - a));
    mean += out[i];
  }
  mean /= env.length || 1;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

/** Unbiased autocorrelation, normalised so lag 0 is 1. */
async function autocorrelate(e, maxLag, tick) {
  const n = e.length;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < n; lag++) {
    if ((lag & 31) === 0) await tick();
    let s = 0;
    for (let i = 0, m = n - lag; i < m; i++) s += e[i] * e[i + lag];
    ac[lag] = s / (n - lag);
  }
  const zero = ac[0];
  if (!(zero > 0)) return null;
  for (let i = 0; i <= maxLag; i++) ac[i] /= zero;
  return ac;
}

function interp(ac, x) {
  const i = Math.floor(x);
  if (i + 1 >= ac.length) return 0;
  const f = x - i;
  return ac[i] * (1 - f) + ac[i + 1] * f;
}

/** Normalised autocorrelation at single lags, computed on demand (long lags, few of them). */
function lagCorrelator(e) {
  const n = e.length;
  let zero = 0;
  for (let i = 0; i < n; i++) zero += e[i] * e[i];
  zero /= n;
  const memo = new Map();
  const at = (lag) => {
    if (lag < 0 || lag >= n) return 0;
    let v = memo.get(lag);
    if (v === undefined) {
      let s = 0;
      for (let i = 0, m = n - lag; i < m; i++) s += e[i] * e[i + lag];
      v = s / (n - lag) / zero;
      memo.set(lag, v);
    }
    return v;
  };
  // Catmull-Rom between whole lags: smooth, so the peak is not pulled to a whole lag
  return (x) => {
    const i = Math.floor(x);
    const t = x - i;
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  };
}

const fold = (bpm) => {
  let b = bpm;
  while (b < DETECT_MIN_BPM) b *= 2;
  while (b > DETECT_MAX_BPM) b /= 2;
  return b;
};

/**
 * Estimates the tempo of a song.
 * @param buffer AudioBuffer (or { sampleRate, length, numberOfChannels, getChannelData })
 * @param [opts] yield(), isCancelled()
 * @returns {Promise<{ bpm: number | null, confidence: number }>} bpm folded into 70..180,
 *   rounded to 0.01; null (confidence 0) when there is no rhythm to measure
 */
export async function detectBpm(buffer, opts = {}) {
  const none = { bpm: null, confidence: 0 };
  if (!buffer || !(buffer.length > 0) || !(buffer.sampleRate > 0)) return none;
  const tick = makeYielder(opts, 'bpm-cancelled');
  const { x, rate } = await downmix(buffer, tick);
  if (x.length < MIN_SECONDS * rate) return none;
  const fps = rate / HOP;
  const env = removeLocalMean(await onsetEnvelope(x, tick), fps);
  const lagOf = (bpm) => (60 * fps) / bpm;
  const maxLag = Math.ceil(lagOf(SEARCH_MIN) * COMB) + 2;
  if (env.length < maxLag * 2) return none;
  const ac = await autocorrelate(env, maxLag, tick);
  if (!ac) return none;

  const score = (bpm) => {
    const L = lagOf(bpm);
    let s = 0;
    for (let k = 1; k <= COMB; k++) s += interp(ac, k * L);
    return s / COMB;
  };
  const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTRE) / PRIOR_OCTAVES) ** 2);

  let best = SEARCH_MIN;
  let bestWeighted = -Infinity;
  let sum = 0;
  let count = 0;
  for (let bpm = SEARCH_MIN; bpm <= SEARCH_MAX; bpm += 0.1) {
    const s = score(bpm);
    sum += s;
    count++;
    const w = s * prior(bpm);
    if (w > bestWeighted) { bestWeighted = w; best = bpm; }
  }
  // refine on the plain score so the prior cannot pull the peak sideways
  let coarse = best;
  let coarseScore = score(best);
  for (let bpm = best - 0.15; bpm <= best + 0.15; bpm += 0.005) {
    const s = score(bpm);
    if (s > coarseScore) { coarseScore = s; coarse = bpm; }
  }
  const mean = sum / count;
  if (!(coarseScore > mean)) return none;
  const confidence = Math.max(0, Math.min(1, (coarseScore - mean) / (1 - mean)));

  const corr = lagCorrelator(env);
  const K = Math.max(COMB, Math.min(FINE_COMB, Math.floor(env.length / 2 / lagOf(coarse))));
  const fineScore = (bpm) => {
    const L = lagOf(bpm);
    let s = 0;
    for (let k = 1; k <= K; k++) s += corr(k * L);
    return s;
  };
  let fine = coarse;
  let fineBest = fineScore(coarse);
  for (let bpm = coarse - 0.25; bpm <= coarse + 0.25; bpm += 0.002) {
    if ((Math.round(bpm * 500) & 7) === 0) await tick();
    const s = fineScore(bpm);
    if (s > fineBest) { fineBest = s; fine = bpm; }
  }
  return { bpm: round2(fold(fine)), confidence: Math.round(confidence * 100) / 100 };
}

/**
 * tap(timeMs) returns the tempo of the taps so far (null before the second
 * tap), clamped to 40..220. A gap over resetMs starts over; a time that is not
 * a number is ignored. Averages the last `maxTaps` taps.
 */
export function createTapTempo({ resetMs = 2000, maxTaps = 8 } = {}) {
  let taps = [];
  const now = () => globalThis.performance?.now() ?? Date.now();
  const current = () => {
    const interval = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    return round1(Math.min(TAP_MAX_BPM, Math.max(TAP_MIN_BPM, 60000 / interval)));
  };
  return {
    tap(timeMs = now()) {
      const t = Number(timeMs);
      if (!Number.isFinite(t)) return taps.length < 2 ? null : current();
      const last = taps[taps.length - 1];
      if (last !== undefined && (t - last > resetMs || t <= last)) taps = [];
      taps.push(t);
      if (taps.length > maxTaps) taps.shift();
      if (taps.length < 2) return null;
      return current();
    },
    reset() { taps = []; },
    get count() { return taps.length; },
  };
}
