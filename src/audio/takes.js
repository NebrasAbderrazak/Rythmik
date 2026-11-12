// Take storage format and offline rendering. A take keeps the raw capture,
// which starts PRE_ROLL seconds before bar 1 and runs POST_ROLL past the last
// bar, so any latency in [-PRE_ROLL, POST_ROLL] can be applied later.
import { STEPS, secondsPerStep } from './constants.js';
import { renderPatternOffline } from './offline.js';
import { createMasterChain } from './sequence.js';

export const PRE_ROLL = 0.25;
export const POST_ROLL = 0.6;
export const MIN_LATENCY_MS = -PRE_ROLL * 1000;
export const MAX_LATENCY_MS = POST_ROLL * 1000;
export const MIX_TAIL = 1;
const VOCAL_TARGET_PEAK = 0.8; // into the master bus, before master gain
const VOCAL_MAX_BOOST = 4; // +12 dB
const VOCAL_HIGHPASS_HZ = 80;

export const barSeconds = (bpm) => secondsPerStep(bpm) * STEPS;

export function peakOf(data) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

const clampLatency = (ms) => Math.min(MAX_LATENCY_MS, Math.max(MIN_LATENCY_MS, ms));

/**
 * raw: Float32Array starting PRE_ROLL before bar 1. autoLatencyMs is frozen
 * with the take: it describes the device the take was recorded on.
 */
export function makeTake(raw, {
  id, name, bpm, bars, sampleRate, autoLatencyMs = 0, offsetMs = 0, createdAt = Date.now(),
}) {
  const duration = bars * barSeconds(bpm);
  const take = {
    meta: { id, name, bars, bpm, duration, peak: 0, autoLatencyMs, createdAt },
    raw,
    sampleRate,
    length: Math.round(duration * sampleRate),
    preRoll: Math.round(PRE_ROLL * sampleRate),
  };
  take.meta.peak = alignedPeak(take, takeLatencyMs(take, offsetMs));
  return take;
}

export const takeLatencyMs = (take, offsetMs) => clampLatency(take.meta.autoLatencyMs + offsetMs);

/** Raw index of bar 1 after shifting the take earlier by latencyMs. */
export function alignedOffset(take, latencyMs) {
  return take.preRoll + Math.round((clampLatency(latencyMs) / 1000) * take.sampleRate);
}

/** Copy of the latency-compensated take, exactly `bars` long. */
export function alignedSamples(take, latencyMs) {
  const out = new Float32Array(take.length);
  const from = alignedOffset(take, latencyMs);
  const avail = Math.max(0, Math.min(take.length, take.raw.length - from));
  if (avail > 0) out.set(take.raw.subarray(from, from + avail));
  return out;
}

/** Peak of the performance only, not the pre/post roll. */
export function alignedPeak(take, latencyMs) {
  const from = alignedOffset(take, latencyMs);
  return peakOf(take.raw.subarray(from, Math.min(take.raw.length, from + take.length)));
}

export function vocalGain(peak) {
  if (!(peak > 1e-4)) return 1;
  return Math.min(VOCAL_MAX_BOOST, VOCAL_TARGET_PEAK / peak);
}

/** highpass -> gain, shared by preview and mix so both sound the same. */
export function createVocalChain(ctx, destination, peak) {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = VOCAL_HIGHPASS_HZ;
  hp.Q.value = 0.707;
  const gain = ctx.createGain();
  gain.gain.value = vocalGain(peak);
  hp.connect(gain).connect(destination);
  return { input: hp, gain };
}

function bufferFrom(ctx, samples, sampleRate) {
  const buf = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
  buf.copyToChannel(samples, 0);
  return buf;
}

/** Beat (pattern looped for the take's bars at the take's bpm) + vocal through the master chain. */
export function renderMix(pattern, take, latencyMs, { OfflineAudioContext } = {}) {
  const samples = alignedSamples(take, latencyMs);
  return renderPatternOffline({ ...pattern, bpm: take.meta.bpm }, {
    bars: take.meta.bars,
    sampleRate: take.sampleRate,
    channels: 2,
    tail: MIX_TAIL,
    OfflineAudioContext,
    setup(ctx, bus) {
      const src = ctx.createBufferSource();
      src.buffer = bufferFrom(ctx, samples, take.sampleRate);
      src.connect(createVocalChain(ctx, bus, peakOf(samples)).input);
      src.start(0);
    },
  });
}

/** Dry, compensated mono take. Scaled down only if it would clip. */
export function renderVocal(take, latencyMs, { OfflineAudioContext } = {}) {
  const Ctor = OfflineAudioContext || globalThis.OfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext not available');
  const samples = alignedSamples(take, latencyMs);
  const peak = peakOf(samples);
  if (peak > 0.99) {
    const k = 0.99 / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= k;
  }
  return bufferFrom(new Ctor(1, 1, take.sampleRate), samples, take.sampleRate);
}

const chainDelays = new Map();

/**
 * Signal delay of the master chain in seconds (compressor look-ahead), measured
 * with a low-level impulse so no gain reduction kicks in.
 */
export function measureChainDelay(sampleRate, Ctor = globalThis.OfflineAudioContext) {
  if (!Ctor) return Promise.resolve(null);
  let p = chainDelays.get(sampleRate);
  if (!p) {
    p = (async () => {
      const len = Math.round(sampleRate * 0.1);
      const ctx = new Ctor(1, len, sampleRate);
      const chain = createMasterChain(ctx);
      const imp = ctx.createBuffer(1, 1, sampleRate);
      imp.getChannelData(0)[0] = 0.05;
      const src = ctx.createBufferSource();
      src.buffer = imp;
      src.connect(chain.master);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      let at = 0;
      for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[at])) at = i;
      return at / sampleRate;
    })().catch(() => null);
    chainDelays.set(sampleRate, p);
  }
  return p;
}
