// Take storage format and offline rendering. A take keeps the raw capture,
// which starts PRE_ROLL seconds before bar 1 and runs POST_ROLL past the last
// bar, so any latency in [-PRE_ROLL, POST_ROLL] can be applied later.
import { STEPS, secondsPerStep } from './constants.js';
import { renderPatternOffline } from './offline.js';
import { createMasterChain } from './sequence.js';
import { normalizePattern } from './pattern.js';
import { fxTail } from './fx.js';
import { createVoiceChain, voiceTail, vocalGain, DEFAULT_VOICE } from './voice.js';

export { vocalGain };

export const PRE_ROLL = 0.25;
export const POST_ROLL = 0.6;
export const MIN_LATENCY_MS = -PRE_ROLL * 1000;
export const MAX_LATENCY_MS = POST_ROLL * 1000;
export const MIX_TAIL = 1;
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

function bufferFrom(ctx, samples, sampleRate) {
  const buf = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
  buf.copyToChannel(samples, 0);
  return buf;
}

// drops the first `frames` (the voice chain's look-ahead delay)
function trimStart(buf, frames, Ctor) {
  if (!frames) return buf;
  const len = Math.max(1, buf.length - frames);
  const out = new Ctor(buf.numberOfChannels, 1, buf.sampleRate).createBuffer(buf.numberOfChannels, len, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(frames), c);
  return out;
}

const offlineCtor = (C) => {
  const Ctor = C || globalThis.OfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext not available');
  return Ctor;
};

/**
 * Beat (pattern looped for the take's bars at the take's bpm, with its fx) +
 * vocal through the voice chain, all through the master chain.
 * opts: samples (processed aligned vocal; default dry), voice settings,
 * voiceDelay (frames, from measureVoiceDelay), OfflineAudioContext,
 * renderBacking({ duration, sampleRate, startAt, tail, setup, OfflineAudioContext })
 * to render something else than the pattern under the vocal (the remix deck).
 */
export async function renderMix(pattern, take, latencyMs, opts = {}) {
  const { voice = DEFAULT_VOICE, voiceDelay = 0 } = opts;
  const Ctor = offlineCtor(opts.OfflineAudioContext);
  const samples = opts.samples || alignedSamples(take, latencyMs);
  const peak = peakOf(samples); // level follows what is played: the tuned samples when tuning is on
  const startAt = voiceDelay / take.sampleRate;
  if (opts.renderBacking) {
    const { bpm } = take.meta;
    const buf = await opts.renderBacking({
      duration: take.meta.duration,
      sampleRate: take.sampleRate,
      startAt,
      tail: Math.max(MIX_TAIL, voiceTail(voice, bpm)),
      OfflineAudioContext: Ctor,
      setup(ctx, bus) {
        const src = ctx.createBufferSource();
        src.buffer = bufferFrom(ctx, samples, take.sampleRate);
        src.connect(createVoiceChain(ctx, bus, {
          peak, bpm, settings: voice, delay: voiceDelay,
        }).input);
        src.start(0);
      },
    });
    return trimStart(buf, voiceDelay, Ctor);
  }
  const p = normalizePattern({ ...pattern, bpm: take.meta.bpm });
  const tail = Math.max(MIX_TAIL, fxTail(p.fx, p.bpm), voiceTail(voice, p.bpm));
  const buf = await renderPatternOffline(p, {
    bars: take.meta.bars,
    sampleRate: take.sampleRate,
    channels: 2,
    tail,
    startAt,
    OfflineAudioContext: Ctor,
    setup(ctx, bus) {
      const src = ctx.createBufferSource();
      src.buffer = bufferFrom(ctx, samples, take.sampleRate);
      src.connect(createVoiceChain(ctx, bus, {
        peak, bpm: p.bpm, settings: voice, delay: voiceDelay,
      }).input);
      src.start(0);
    },
  });
  return trimStart(buf, voiceDelay, Ctor);
}

/** Dry, compensated mono take. Scaled down only if it would clip. */
export function renderVocal(take, latencyMs, { OfflineAudioContext } = {}) {
  const Ctor = offlineCtor(OfflineAudioContext);
  const samples = alignedSamples(take, latencyMs);
  const peak = peakOf(samples);
  if (peak > 0.99) {
    const k = 0.99 / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= k;
  }
  return bufferFrom(new Ctor(1, 1, take.sampleRate), samples, take.sampleRate);
}

/**
 * Processed vocal: tuned samples through the voice chain (tone, reverb, echo),
 * stereo, plus the effect tail. Scaled down only if it would clip.
 */
export async function renderProcessedVocal(take, latencyMs, opts = {}) {
  const { voice = DEFAULT_VOICE, voiceDelay = 0 } = opts;
  const Ctor = offlineCtor(opts.OfflineAudioContext);
  const samples = opts.samples || alignedSamples(take, latencyMs);
  const sr = take.sampleRate;
  const tail = Math.max(0.3, voiceTail(voice, take.meta.bpm));
  const ctx = new Ctor(2, voiceDelay + samples.length + Math.ceil(tail * sr), sr);
  const src = ctx.createBufferSource();
  src.buffer = bufferFrom(ctx, samples, sr);
  src.connect(createVoiceChain(ctx, ctx.destination, {
    peak: peakOf(samples), bpm: take.meta.bpm, settings: voice, delay: voiceDelay,
  }).input);
  src.start(0);
  const buf = trimStart(await ctx.startRendering(), voiceDelay, Ctor);
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) pk = Math.max(pk, peakOf(buf.getChannelData(c)));
  if (pk > 0.99) {
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= 0.99 / pk;
    }
  }
  return buf;
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
