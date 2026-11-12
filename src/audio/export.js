// beat-only export: the pattern looped through the master chain, plus a ring-out tail
import { renderPatternOffline } from './offline.js';

export const EXPORT_BARS = [1, 2, 4, 8, 16];
// worst case (808 on the last step) rings ~1 s past the loop end; 1.5 s leaves headroom
export const DEFAULT_TAIL = 1.5;

/**
 * @param {object} pattern current pattern (bpm, swing, mixer, master are used)
 * @param {object} [opts] bars (1|2|4|8|16), tail (s), sampleRate, OfflineAudioContext
 * @returns {Promise<AudioBuffer>} bars * bar duration + tail seconds long
 */
export function renderBeat(pattern, opts = {}) {
  const { bars = 4, tail = DEFAULT_TAIL, ...rest } = opts;
  if (!EXPORT_BARS.includes(bars)) return Promise.reject(new RangeError(`bars must be one of ${EXPORT_BARS.join(', ')}`));
  if (!(tail >= 0)) return Promise.reject(new RangeError('tail must be >= 0'));
  return renderPatternOffline(pattern, { ...rest, bars, tail, masterChain: true });
}
