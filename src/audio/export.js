// beat-only export: the pattern looped through the master chain, plus a ring-out tail
import { renderPatternOffline } from './offline.js';
import { normalizePattern } from './pattern.js';
import { fxTail } from './fx.js';
import { secondsPerStep, isSampleId, MAX_NUDGE } from './constants.js';
import { registeredSampleVoices } from './samplevoice.js';

export const EXPORT_BARS = [1, 2, 4, 8, 16];
// worst case (808 on the last step) rings ~1 s past the loop end; 1.5 s leaves headroom
export const DEFAULT_TAIL = 1.5;

/**
 * @param {object} pattern current pattern (bpm, swing, mixer, master are used)
 * @param {object} [opts] bars (1|2|4|8|16, of 16 steps across the chain), tail (s; default covers
 *   the 808 and any echo/reverb ring-out), samples (default: the engine's sample voices),
 *   sampleRate, OfflineAudioContext
 * @returns {Promise<AudioBuffer>} bars * bar duration + tail seconds long
 */
export function renderBeat(pattern, opts = {}) {
  const { bars = 4, samples = registeredSampleVoices(), ...rest } = opts;
  const tail = opts.tail ?? beatTail(pattern, samples);
  if (!EXPORT_BARS.includes(bars)) return Promise.reject(new RangeError(`bars must be one of ${EXPORT_BARS.join(', ')}`));
  if (!(tail >= 0)) return Promise.reject(new RangeError('tail must be >= 0'));
  return renderPatternOffline(pattern, { ...rest, bars, tail, samples, masterChain: true });
}

// how long a hit keeps sounding, s; anything not listed is gone within 0.6 s
const VOICE_RING = { crash: 1.62, ride: 1.02, bass: 1.02, logdrum: 0.44, openhat: 0.37 };
const SHORT_RING = 0.6;

/**
 * Seconds the pattern's sounds can ring past the end of the loop: the longest
 * voice or sample it uses, played as late as swing and nudge allow.
 */
export function soundTail(pattern, samples = registeredSampleVoices()) {
  const p = normalizePattern(pattern);
  let longest = 0;
  for (const id of p.tracks) {
    const hits = [p.sections.A, p.sections.B].flatMap((sec) => (sec ? sec.steps[id].filter(Boolean) : []));
    if (!hits.length) continue;
    let ring = VOICE_RING[id] ?? SHORT_RING;
    const def = isSampleId(id) ? samples?.[id] : null;
    if (def?.buffer) {
      const len = Math.max(0, Math.min(def.end ?? def.buffer.duration, def.buffer.duration) - (def.start || 0));
      const lowest = Math.min(...hits.map((s) => s.p));
      ring = len / Math.pow(2, ((def.pitch || 0) + lowest) / 12);
    }
    longest = Math.max(longest, ring);
  }
  // a late step: full swing, nudge and micro timing, plus the last roll hit
  return longest + (0.5 + MAX_NUDGE + 0.25 + 0.75) * secondsPerStep(p.bpm);
}

export function beatTail(pattern, samples = registeredSampleVoices()) {
  const p = normalizePattern(pattern);
  return Math.max(DEFAULT_TAIL, fxTail(p.fx, p.bpm), soundTail(p, samples) + 0.2);
}
