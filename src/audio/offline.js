// same voices, mixer and master chain as the realtime engine, without timers
import { STEPS, TRACK_IDS, secondsPerStep, swingOffset } from './constants.js';
import {
  playStep, createMasterChain, createMixer, applyMaster, createVoiceState,
} from './sequence.js';
import { normalizePattern } from './pattern.js';

/**
 * @param {object} [opts] bars, sampleRate, channels, tail (s), tracks (ids to keep),
 *   masterChain (false = straight to destination), OfflineAudioContext (constructor)
 * @returns {Promise<AudioBuffer>}
 */
export async function renderPatternOffline(pattern, opts = {}) {
  const {
    bars = 2, sampleRate = 44100, channels = 2, tail = 1.2,
    tracks = TRACK_IDS, masterChain = true,
  } = opts;
  const Ctor = opts.OfflineAudioContext || globalThis.OfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext not available');

  const p = normalizePattern(pattern);
  for (const id of TRACK_IDS) if (!tracks.includes(id)) p.steps[id].fill(false);
  const spb = secondsPerStep(p.bpm);
  const totalSteps = bars * STEPS;
  const duration = totalSteps * spb + tail;

  const ctx = new Ctor(channels, Math.ceil(duration * sampleRate), sampleRate);
  let bus = ctx.destination;
  if (masterChain) {
    const chain = createMasterChain(ctx);
    applyMaster(ctx, chain.master, p.master, false);
    bus = chain.master;
  }
  const mixer = createMixer(ctx, bus);
  mixer.apply(p.mixer, false);

  const voices = createVoiceState(false);
  for (let i = 0; i < totalSteps; i++) {
    const step = i % STEPS;
    playStep(ctx, mixer.inputs, p, step, i * spb + swingOffset(step, p.swing, spb), voices);
  }
  return ctx.startRendering();
}
