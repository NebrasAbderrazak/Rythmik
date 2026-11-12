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
const MIN_SECONDS = 4;
const MAX_SECONDS = 120; // longer songs: the middle two minutes (skips long intros, plenty for 0.1 BPM)
const MEAN_WINDOW = 0.4; // s, local mean removed from the onset envelope
// favours tempos near 120 when two octaves fit equally well (70 vs 140)
const PRIOR_CENTRE = 120;
const PRIOR_OCTAVES = 1;

const round1 = (x) => Math.round(x * 10) / 10;

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
 *   rounded to 0.1; null (confidence 0) when there is no rhythm to measure
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
  let fine = best;
  let fineScore = score(best);
  for (let bpm = best - 0.15; bpm <= best + 0.15; bpm += 0.005) {
    const s = score(bpm);
    if (s > fineScore) { fineScore = s; fine = bpm; }
  }
  const mean = sum / count;
  const confidence = Math.max(0, Math.min(1, (fineScore - mean) / (1 - mean)));
  if (!(fineScore > mean)) return none;
  return { bpm: round1(fold(fine)), confidence: Math.round(confidence * 100) / 100 };
}

/**
 * tap(timeMs) returns the tempo of the taps so far (null before the second
 * tap). A gap over resetMs starts over. Averages the last `maxTaps` taps.
 */
export function createTapTempo({ resetMs = 2000, maxTaps = 8 } = {}) {
  let taps = [];
  const now = () => globalThis.performance?.now() ?? Date.now();
  return {
    tap(timeMs = now()) {
      const t = Number(timeMs);
      const last = taps[taps.length - 1];
      if (last !== undefined && (t - last > resetMs || t <= last)) taps = [];
      taps.push(t);
      if (taps.length > maxTaps) taps.shift();
      if (taps.length < 2) return null;
      const interval = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      return round1(60000 / interval);
    },
    reset() { taps = []; },
    get count() { return taps.length; },
  };
}
