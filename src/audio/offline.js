// same voices, mixer, beat fx and master chain as the realtime engine, without timers
import { STEPS, secondsPerStep } from './constants.js';
import {
  playPosition, createMasterChain, createMixer, applyMaster, createVoiceState,
} from './sequence.js';
import { normalizePattern, loopLength } from './pattern.js';
import { createBeatFx } from './fx.js';

/**
 * Wires the pattern's beat bus (fx, mixer) into `bus` and returns
 * play(pos, time, pass) for scheduling loop positions.
 */
export function createBeatPlayer(ctx, bus, p, bpm, { samples = {}, minTime = 0 } = {}) {
  const fx = createBeatFx(ctx, bus);
  fx.setTempo(bpm, false);
  fx.apply(p.fx, false);
  const mixer = createMixer(ctx, fx.input, fx.sends);
  mixer.apply(p.mixer, false);
  mixer.applySends(p.fx.sends, false);
  const voices = createVoiceState(false);
  const spb = secondsPerStep(bpm);
  return (pos, time, pass) => playPosition(ctx, mixer, p, pos, time, voices, { spb, pass, minTime, samples });
}

/**
 * @param {object} [opts] bars (of 16 steps, counted across the chain), sampleRate, channels,
 *   tail (s), tracks (ids to keep), samples ({ [smpId]: def }), masterChain (false = straight
 *   to destination), OfflineAudioContext (constructor), startAt (s, beat starts this late;
 *   the render grows by the same amount), startPos / startPass (where in the loop to begin, see
 *   engine.getLoopPositionAt), setup(ctx, bus) to add extra sources (may be async)
 * @returns {Promise<AudioBuffer>}
 */
export async function renderPatternOffline(pattern, opts = {}) {
  const {
    bars = 2, sampleRate = 44100, channels = 2, tail = 1.2,
    tracks = null, masterChain = true, startAt = 0, samples = {}, startPos = 0, startPass = 0,
  } = opts;
  const Ctor = opts.OfflineAudioContext || globalThis.OfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext not available');

  const p = normalizePattern(pattern);
  if (tracks) {
    for (const sec of Object.values(p.sections)) {
      if (!sec) continue;
      for (const id of p.tracks) if (!tracks.includes(id)) sec.steps[id].fill(null);
    }
  }
  const spb = secondsPerStep(p.bpm);
  const totalSteps = bars * STEPS;
  const duration = startAt + totalSteps * spb + tail;

  const ctx = new Ctor(channels, Math.ceil(duration * sampleRate), sampleRate);
  let bus = ctx.destination;
  if (masterChain) {
    const chain = createMasterChain(ctx);
    applyMaster(ctx, chain.master, p.master, false);
    bus = chain.master;
  }
  const play = createBeatPlayer(ctx, bus, p, p.bpm, { samples, minTime: startAt });
  const len = loopLength(p);
  for (let i = 0; i < totalSteps; i++) {
    const pos = startPos + i;
    play(pos % len, startAt + i * spb, startPass + Math.floor(pos / len));
  }
  if (opts.setup) await opts.setup(ctx, bus);
  return ctx.startRendering();
}

const impulseDelays = new Map();

/**
 * Where a short impulse peaks after passing through a chain, in whole samples.
 * Cached per chain name and sample rate; resolves null if rendering fails.
 * build(ctx) returns the chain's input node, already wired to ctx.destination.
 */
export function measureImpulseDelay(name, sampleRate, Ctor, build, level = 0.05) {
  if (!Ctor) return Promise.resolve(null);
  const key = `${name}@${sampleRate}`;
  let p = impulseDelays.get(key);
  if (!p) {
    p = (async () => {
      const ctx = new Ctor(1, Math.round(sampleRate * 0.1), sampleRate);
      const input = build(ctx);
      const imp = ctx.createBuffer(1, 1, sampleRate);
      imp.getChannelData(0)[0] = level;
      const src = ctx.createBufferSource();
      src.buffer = imp;
      src.connect(input);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      let at = 0;
      for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[at])) at = i;
      return at;
    })().catch(() => null);
    impulseDelays.set(key, p);
  }
  return p;
}
