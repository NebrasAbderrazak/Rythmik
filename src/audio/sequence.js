// shared by the realtime engine and the offline renderer so both sound the same
import { kick, snare, clap, hat, openhat, rim, shaker, bass } from './instruments.js';
import {
  STEPS, TRACK_IDS, DEFAULT_BASS_NOTE, volumeToGain,
} from './constants.js';

export * from './constants.js';
export { emptyPattern, normalizePattern } from './pattern.js';

export const MASTER_BASE_GAIN = 0.7;
const SMOOTH_TAU = 0.012;

function grooveVelocity(step) {
  if (step % 4 === 0) return 0.85;
  if (step % 2 === 0) return 0.7;
  return 0.5;
}

export function createVoiceState(trackActive = true) {
  return { bass: null, openhat: null, active: trackActive ? [] : null };
}

function track(ctx, voices, v) {
  if (!v || !voices.active) return v;
  const now = ctx.currentTime;
  if (voices.active.length > 64) voices.active = voices.active.filter((x) => x.endTime > now && !x.killed);
  voices.active.push(v);
  return v;
}

export function playVoice(ctx, dest, trackId, time, voices, opts = {}) {
  const step = opts.step ?? 0;
  switch (trackId) {
    case 'kick': return track(ctx, voices, kick(ctx, dest, time));
    case 'snare': return track(ctx, voices, snare(ctx, dest, time));
    case 'clap': return track(ctx, voices, clap(ctx, dest, time));
    case 'rim': return track(ctx, voices, rim(ctx, dest, time));
    case 'shaker':
      return track(ctx, voices, shaker(ctx, dest, time, { velocity: grooveVelocity(step) }));
    case 'hat':
      if (voices.openhat) { voices.openhat.choke(time); voices.openhat = null; }
      return track(ctx, voices, hat(ctx, dest, time, { velocity: grooveVelocity(step) }));
    case 'openhat':
      if (voices.openhat) voices.openhat.choke(time);
      voices.openhat = track(ctx, voices, openhat(ctx, dest, time));
      return voices.openhat;
    case 'bass':
      if (voices.bass) voices.bass.choke(time);
      voices.bass = track(ctx, voices, bass(ctx, dest, time, {
        note: opts.note ?? DEFAULT_BASS_NOTE,
      }));
      return voices.bass;
    default:
      throw new Error(`Unknown track: ${trackId}`);
  }
}

// TRACK_IDS order matters: closed hat before open hat, so an open hat on the
// same step survives. An 808 right after another 808 with a different note
// slides the ringing one instead of retriggering.
export function playStep(ctx, dests, pattern, step, time, voices) {
  const s = pattern.steps;
  for (const id of TRACK_IDS) {
    if (!s[id]?.[step]) continue;
    if (id === 'bass') {
      const note = pattern.bassNotes?.[step] ?? DEFAULT_BASS_NOTE;
      const prev = (step + STEPS - 1) % STEPS;
      const prevBass = voices.bass;
      const slid = s.bass[prev] && prevBass && prevBass.note !== note
        && prevBass.slideTo?.(note, time);
      if (!slid) playVoice(ctx, dests[id], id, time, voices, { step, note });
    } else {
      playVoice(ctx, dests[id], id, time, voices, { step });
    }
  }
}

// pending voices are cancelled, long ringing ones faded, short drums left alone
export function silenceVoices(voices, now) {
  for (const v of voices.active || []) {
    if (v.killed) continue;
    if (v.startTime > now) v.kill();
    else if (v.choke && v.endTime > now) v.choke(now);
  }
  if (voices.active) voices.active = [];
  voices.bass = null;
  voices.openhat = null;
}

const CLIP_KNEE = 0.9;
const CLIP_CEIL = 0.99;
let safetyCurve = null;
// identity below 0.9, tanh knee above. WaveShaper clamps input outside
// [-1, 1] to the curve ends (~0.97), so the output can never hit 0 dBFS.
function getSafetyCurve() {
  if (!safetyCurve) {
    const n = 8193; // odd: exact 0 in the middle
    safetyCurve = new Float32Array(n);
    const span = CLIP_CEIL - CLIP_KNEE;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a <= CLIP_KNEE ? a : CLIP_KNEE + span * Math.tanh((a - CLIP_KNEE) / span);
      safetyCurve[i] = Math.sign(x) * y;
    }
  }
  return safetyCurve;
}

// The compressor "limiter" is not brickwall and overshoots ~0.5 dB on stacked
// transients; the clipper catches that. Normal mixes stay below its knee.
export function createMasterChain(ctx, destination = ctx.destination) {
  const master = ctx.createGain();
  master.gain.value = MASTER_BASE_GAIN;

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -14;
  glue.knee.value = 8;
  glue.ratio.value = 2.5;
  glue.attack.value = 0.02;
  glue.release.value = 0.25;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0;
  limiter.release.value = 0.08;

  const trim = ctx.createGain();
  trim.gain.value = 0.85;

  const clipper = ctx.createWaveShaper();
  clipper.curve = getSafetyCurve();
  clipper.oversample = 'none'; // oversampling adds latency

  const output = ctx.createGain();
  output.gain.value = 1;

  master.connect(glue).connect(limiter).connect(trim).connect(clipper).connect(output).connect(destination);
  return { master, glue, limiter, trim, clipper, output };
}

function setParam(ctx, param, value, smooth) {
  if (smooth) param.setTargetAtTime(value, ctx.currentTime, SMOOTH_TAU);
  else param.value = value;
}

export function isAudible(mixer, trackId) {
  const anySolo = TRACK_IDS.some((id) => mixer[id]?.solo);
  const ch = mixer[trackId] || {};
  return !ch.mute && (!anySolo || !!ch.solo);
}

// gate (mute/solo) -> fader -> destination. Auditions skip the gate so a
// muted pad can still be previewed.
export function createMixer(ctx, destination) {
  const channels = {};
  const inputs = {};
  const auditionInputs = {};
  for (const id of TRACK_IDS) {
    const gate = ctx.createGain();
    const fader = ctx.createGain();
    gate.connect(fader).connect(destination);
    channels[id] = { gate, fader };
    inputs[id] = gate;
    auditionInputs[id] = fader;
  }
  return {
    channels,
    inputs,
    auditionInputs,
    apply(mixer, smooth = true) {
      for (const id of TRACK_IDS) {
        const ch = mixer[id] || {};
        setParam(ctx, channels[id].fader.gain, volumeToGain(ch.volume), smooth);
        setParam(ctx, channels[id].gate.gain, isAudible(mixer, id) ? 1 : 0, smooth);
      }
    },
  };
}

export const masterToGain = (v) => MASTER_BASE_GAIN * volumeToGain(v);

export function applyMaster(ctx, masterNode, volume, smooth = true) {
  setParam(ctx, masterNode.gain, masterToGain(volume), smooth);
}
