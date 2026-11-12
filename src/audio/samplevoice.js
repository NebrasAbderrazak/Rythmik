// Plays a region of a user sample as a step voice, realtime or offline.
import { velocityGain, DEFAULT_VELOCITY } from './constants.js';

const reversedCache = new WeakMap();

// the engine registers its sample map here so renderBeat() finds it by default
let registered = {};
export const registerSampleVoices = (map) => { registered = map || {}; };
export const registeredSampleVoices = () => registered;

/** A reversed copy of the buffer, made once per buffer. */
export function reversedBuffer(ctx, buffer) {
  let rev = reversedCache.get(buffer);
  if (!rev) {
    rev = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c);
      const dst = rev.getChannelData(c);
      for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    reversedCache.set(buffer, rev);
  }
  return rev;
}

const MIN_FADE = 0.003; // s, avoids clicks at hard cuts
const CHOKE_FADE = 0.01;

const num = (x, fallback) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

/**
 * def: { buffer, start, end (s in the buffer), gain 0..1, pitch -12..12, reverse, fadeIn, fadeOut }
 * opts: { v: velocity 0..1 (0.8 = normal), p: extra semitones }
 * Returns a voice handle like the synth voices, or null if there is nothing to play.
 */
export function playSample(ctx, destination, time, def, { v = DEFAULT_VELOCITY, p = 0 } = {}) {
  const buffer = def?.buffer;
  if (!buffer) return null;
  const dur = buffer.duration;
  const start = Math.max(0, Math.min(dur, num(def.start, 0)));
  const end = Math.max(start, Math.min(dur, num(def.end, dur)));
  const length = end - start;
  if (length <= 0) return null;

  const rate = Math.pow(2, (num(def.pitch, 0) + num(p, 0)) / 12);
  const playLen = length / rate;
  const level = Math.max(0, Math.min(1, num(def.gain, 1))) * velocityGain(v);
  const fadeIn = Math.min(Math.max(num(def.fadeIn, 0) / rate, MIN_FADE / 3), playLen / 2);
  const fadeOut = Math.min(Math.max(num(def.fadeOut, 0) / rate, MIN_FADE), playLen / 2);
  const stopAt = time + playLen;

  const src = ctx.createBufferSource();
  src.buffer = def.reverse ? reversedBuffer(ctx, buffer) : buffer;
  src.playbackRate.value = rate;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(level, time + fadeIn);
  amp.gain.setValueAtTime(level, stopAt - fadeOut);
  amp.gain.linearRampToValueAtTime(0, stopAt);
  const chokeGain = ctx.createGain();
  chokeGain.gain.value = 1;
  src.connect(amp).connect(chokeGain).connect(destination);
  src.start(time, def.reverse ? dur - end : start, length);
  src.stop(stopAt + 0.005);
  src.onended = () => {
    for (const n of [src, amp, chokeGain]) {
      try { n.disconnect(); } catch { /* already disconnected */ }
    }
  };

  let killed = false;
  let choked = false;
  let endTime = stopAt + 0.005;
  return {
    startTime: time,
    get endTime() { return endTime; },
    get killed() { return killed; },
    kill() {
      if (killed) return;
      killed = true;
      try { src.stop(ctx.currentTime); } catch { /* already stopped */ }
      try { chokeGain.disconnect(); } catch { /* already disconnected */ }
    },
    choke(t) {
      if (choked || killed || t >= endTime) return;
      choked = true;
      const at = Math.max(t, time);
      chokeGain.gain.setValueAtTime(1, at);
      chokeGain.gain.linearRampToValueAtTime(0, at + CHOKE_FADE);
      endTime = at + CHOKE_FADE + 0.004;
      try { src.stop(endTime); } catch { /* already stopped */ }
    },
  };
}
