// shared by the realtime engine and the offline renderer so both sound the same
import {
  kick, snare, clap, hat, openhat, rim, shaker, bass,
  tomlo, tomhi, crash, ride, cowbell, conga, snap, logdrum,
} from './instruments.js';
import { playSample } from './samplevoice.js';
import {
  DEFAULT_BASS_NOTE, DEFAULT_VELOCITY, FLAM_SECONDS, MAX_NUDGE,
  volumeToGain, velocityGain, swingOffset, isSampleId,
} from './constants.js';
import { loopLength, locate, MAX_STEP_SHIFT } from './pattern.js';

export * from './constants.js';
export { emptyPattern, normalizePattern, loopLength, locate } from './pattern.js';

export const MASTER_BASE_GAIN = 0.7;
const SMOOTH_TAU = 0.012;
const RELEASE_MS = 12000; // longer than any sample or tail
const ROLL_DECAY = 0.9; // each roll hit a little softer than the one before
const FLAM_LEVEL = 0.55;

const SYNTHS = {
  kick, snare, clap, rim, shaker, tomlo, tomhi, crash, ride, cowbell, conga, snap,
};

export function createVoiceState(trackActive = true) {
  // seq counts played positions so a slide knows what rang on the step before
  return { bass: null, logdrum: null, openhat: null, seq: 0, active: trackActive ? [] : null };
}

function track(ctx, voices, v) {
  if (!v || !voices.active) return v;
  const now = ctx.currentTime;
  if (voices.active.length > 64) voices.active = voices.active.filter((x) => x.endTime > now && !x.killed);
  voices.active.push(v);
  return v;
}

/**
 * One hit of a voice or sample. opts: v (stored velocity 0..1), p (semitones, or
 * the MIDI note for bass/logdrum), samples ({ [smpId]: def } for sample tracks).
 */
export function playVoice(ctx, dest, trackId, time, voices, opts = {}) {
  const v = opts.v ?? DEFAULT_VELOCITY;
  const velocity = velocityGain(v);
  const pitch = opts.p ?? 0;
  switch (trackId) {
    case 'hat':
      // a closed hat after an open one closes it; one on the same hit leaves it ringing
      if (voices.openhat && voices.openhat.startTime < time) {
        voices.openhat.choke(time);
        voices.openhat = null;
      }
      return track(ctx, voices, hat(ctx, dest, time, { velocity, pitch }));
    case 'openhat':
      if (voices.openhat && voices.openhat.startTime < time) voices.openhat.choke(time);
      voices.openhat = track(ctx, voices, openhat(ctx, dest, time, { velocity, pitch }));
      return voices.openhat;
    case 'bass':
    case 'logdrum': {
      // monophonic: a new note chokes the ringing one
      voices[trackId]?.choke(time);
      const make = trackId === 'bass' ? bass : logdrum;
      voices[trackId] = track(ctx, voices, make(ctx, dest, time, { velocity, note: opts.p ?? DEFAULT_BASS_NOTE }));
      voices[trackId].seq = voices.seq;
      return voices[trackId];
    }
    default:
      if (SYNTHS[trackId]) return track(ctx, voices, SYNTHS[trackId](ctx, dest, time, { velocity, pitch }));
      if (isSampleId(trackId)) {
        const def = opts.samples?.[trackId];
        return def ? track(ctx, voices, playSample(ctx, dest, time, def, { v, p: pitch })) : null;
      }
      throw new Error(`Unknown track: ${trackId}`);
  }
}

// a stable 0..1 per (pass, position, track), so chance is repeatable
export function chanceRoll(pass, pos, id) {
  let h = Math.imul(pass + 1, 0x85ebca6b) ^ Math.imul(pos + 1, 0xc2b2ae35);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Seconds a step can sound before its grid time (negative nudge, flams). */
export const maxLead = (spb) => (MAX_NUDGE + MAX_STEP_SHIFT) * spb + FLAM_SECONDS + 0.005;

/** How early this pattern actually plays anything, so plain patterns are not scheduled sooner than needed. */
export function patternLead(pattern, spb) {
  let early = 0;
  for (const id of pattern.tracks) {
    const nudge = pattern.mixer[id]?.nudge || 0;
    for (const sec of [pattern.sections.A, pattern.sections.B]) {
      for (const s of sec?.steps[id] || []) {
        if (!s) continue;
        const shift = Math.max(0, -(nudge + (s.t || 0))) * spb + (s.f ? FLAM_SECONDS : 0);
        if (shift > early) early = shift;
      }
    }
  }
  return early > 0 ? Math.min(early, maxLead(spb)) + 0.005 : 0;
}

/**
 * Plays loop position `pos` (counted across the chain) whose grid time is
 * `time`. Swing, nudge, rolls, flams and chance are applied here.
 * opts: spb, pass (for chance), minTime (no hit earlier than this), samples.
 * Returns { chainIndex, section, step }.
 * An 808 or log drum note right after one that played on the step before, with
 * a different note, slides the ringing one instead of retriggering.
 */
export function playPosition(ctx, mixer, pattern, pos, time, voices, opts = {}) {
  const { spb, pass = 0, minTime = -Infinity, samples } = opts;
  const len = loopLength(pattern);
  const at = ((pos % len) + len) % len;
  const loc = locate(pattern, at);
  const steps = pattern.sections[loc.section].steps;
  voices.seq++;
  for (const id of pattern.tracks) {
    const s = steps[id]?.[loc.step];
    if (!s) continue;
    if (s.c < 1 && chanceRoll(pass, at, id) >= s.c) continue;
    const ch = pattern.mixer[id] || {};
    const swing = ch.swing ?? pattern.swing;
    const t0 = time + swingOffset(loc.step, swing, spb) + ((ch.nudge || 0) + (s.t || 0)) * spb;
    const dest = mixer.input(id);
    const play = (t, v) => playVoice(ctx, dest, id, Math.max(t, minTime), voices, { v, p: s.p, samples });

    if (s.f) play(t0 - FLAM_SECONDS, s.v * FLAM_LEVEL);
    for (let k = 0; k < s.r; k++) {
      const t = t0 + (k * spb) / s.r;
      const v = s.v * ROLL_DECAY ** k;
      if (k === 0 && !s.f && (id === 'bass' || id === 'logdrum')) {
        const ringing = voices[id];
        if (ringing && ringing.seq === voices.seq - 1 && ringing.note !== s.p
          && ringing.slideTo?.(s.p, Math.max(t, minTime))) {
          ringing.seq = voices.seq;
          continue;
        }
      }
      play(t, v);
    }
  }
  return loc;
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
  voices.logdrum = null;
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
  const ch = mixer[trackId];
  if (!ch) return false;
  const anySolo = Object.values(mixer).some((c) => c?.solo);
  return !ch.mute && (!anySolo || !!ch.solo);
}

/**
 * gate (mute/solo) -> fader -> destination, fader -> send gains -> fx buses.
 * Channels are made on first use, so any track id works. Auditions skip the
 * gate so a muted pad can still be previewed.
 */
export function createMixer(ctx, destination, sendDests = null) {
  const channels = {};
  let lastMixer = {};
  let lastSends = {};

  function applyChannel(id, smooth) {
    const c = channels[id];
    setParam(ctx, c.fader.gain, volumeToGain(lastMixer[id]?.volume), smooth);
    setParam(ctx, c.gate.gain, isAudible(lastMixer, id) ? 1 : 0, smooth);
    for (const [kind, node] of Object.entries(c.sends)) {
      setParam(ctx, node.gain, lastSends[id]?.[kind] ?? 0, smooth);
    }
  }

  function channel(id) {
    if (channels[id]) return channels[id];
    const gate = ctx.createGain();
    const fader = ctx.createGain();
    gate.connect(fader).connect(destination);
    const sends = {};
    if (sendDests) {
      for (const [kind, dest] of Object.entries(sendDests)) {
        sends[kind] = ctx.createGain();
        sends[kind].gain.value = 0;
        fader.connect(sends[kind]).connect(dest);
      }
    }
    channels[id] = { gate, fader, sends };
    applyChannel(id, false);
    return channels[id];
  }

  // a track left the pattern: close its gate now, free the nodes once anything
  // still ringing through the fader (an audition, a long sample) is done
  function release(id) {
    const c = channels[id];
    delete channels[id];
    setParam(ctx, c.gate.gain, 0, true);
    const free = () => {
      for (const n of [c.gate, c.fader, ...Object.values(c.sends)]) {
        try { n.disconnect(); } catch { /* already disconnected */ }
      }
    };
    setTimeout(free, RELEASE_MS);
  }

  return {
    channels,
    input: (id) => channel(id).gate,
    auditionInput: (id) => channel(id).fader,
    apply(mixer, smooth = true) {
      lastMixer = mixer || {};
      for (const id of Object.keys(channels)) if (!lastMixer[id]) release(id);
      for (const id of Object.keys(lastMixer)) {
        if (!channels[id]) channel(id);
        else applyChannel(id, smooth);
      }
    },
    /** sends: { [trackId]: { reverb, echo } } */
    applySends(sends, smooth = true) {
      lastSends = sends || {};
      for (const id of Object.keys(channels)) applyChannel(id, smooth);
    },
  };
}

export const masterToGain = (v) => MASTER_BASE_GAIN * volumeToGain(v);

export function applyMaster(ctx, masterNode, volume, smooth = true) {
  setParam(ctx, masterNode.gain, masterToGain(volume), smooth);
}
