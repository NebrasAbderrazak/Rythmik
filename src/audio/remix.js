// Remix deck: plays your own song (looped, slowed down or sped up, with space,
// muffle and bass) into the engine's master bus, with the beat in sync if wanted.
//
// Source time is seconds in the original file. The deck plays either the
// original at playbackRate = speed, or a time-stretched copy (keep pitch) at
// rate 1, where buffer time = source time / speed. Everything else (position,
// loop, peaks, beat alignment) is worked out in source time.
import {
  STEPS, MIN_BPM, MAX_BPM, clampUnit, secondsPerStep, swingOffset, volumeToGain,
} from './constants.js';
import {
  createReverb, createBeatFx, glide, fxTail, REVERB_SECONDS, REVERB_PREDELAY,
} from './fx.js';
import {
  createMasterChain, applyMaster, createMixer, playStep, createVoiceState,
} from './sequence.js';
import { normalizePattern } from './pattern.js';
import { DEFAULT_TAIL } from './export.js';
import { snapToAnchors } from './scheduler.js';
import { timeStretch } from './stretch.js';
import { detectBpm } from './tempo.js';

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 1.5;
export const MAX_SONG_SECONDS = 15 * 60;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MIN_LOOP_SECONDS = 0.5;
export const MIN_SOURCE_BPM = 40;
export const MAX_SOURCE_BPM = 220;
export const REMIX_FX = ['reverb', 'muffle', 'bass', 'volume'];

export const SPEED_PRESETS = [
  { id: 'superSlowed', name: 'Super slowed', speed: 0.75 },
  { id: 'slowed', name: 'Slowed', speed: 0.85 },
  { id: 'normal', name: 'Normal', speed: 1 },
  { id: 'spedUp', name: 'Sped up', speed: 1.25 },
];

export const DEFAULT_REMIX = {
  speed: 1, keepPitch: false, reverb: 0, muffle: 0, bass: 0, volume: 0.8, beatSync: false,
};

// presets leave volume and beat sync alone
export const REMIX_PRESETS = {
  original: { name: 'Original', settings: { speed: 1, keepPitch: false, reverb: 0, muffle: 0, bass: 0 } },
  slowedReverb: {
    name: 'Slowed + reverb',
    settings: { speed: 0.85, keepPitch: false, reverb: 0.5, muffle: 0.2, bass: 0.15 },
  },
  nightcore: { name: 'Nightcore', settings: { speed: 1.25, keepPitch: false, reverb: 0.1, muffle: 0, bass: 0 } },
};

const LEAD = 0.1; // s from play() to sound; past the beat scheduler's own start delay
const SWITCH_LEAD = 0.03; // restarts are scheduled this far ahead so old and new line up
const FADE = 0.015; // crossfade on restarts and stops
const FADE_IN = 0.005;
const ANCHOR_LEAD = 0.15; // beat re-alignments must land past the scheduler's look-ahead
const STRETCH_DEBOUNCE_MS = 200;
const STRETCH_CACHE = 2; // stretched copies kept per song (each is as big as the song)
const MIN_CONFIDENCE = 0.1; // below this a detected tempo is not used
const MIN_TAIL = 0.1; // s, covers the master chain look-ahead and the last fade
const DECODE_RATE = 48000; // only when no AudioContext exists yet
const MAX_PEAK_COLUMNS = 8192;

const BASS_HZ = 100;
const BASS_MAX_DB = 9;
const BASS_TRIM_DB = 3; // at full bass the level comes down a little so it hits the limiter less
const MUFFLE_LOW_HZ = 500;
const REVERB_WET = 0.8;
const REVERB_DUCK = 0.35; // dry level drop at full reverb
const DECK_TRIM = 0.7; // about -3 dB: finished songs are mastered loud and the beat needs room

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const disconnect = (n) => { try { n?.disconnect(); } catch { /* already gone */ } };

export const clampSpeed = (x, fallback = 1) => round3(clampUnit(x, fallback, MIN_SPEED, MAX_SPEED));

export function normalizeRemix(src, base = DEFAULT_REMIX) {
  const s = isObject(src) ? src : {};
  const unit = (k) => (s[k] === undefined ? base[k] : round3(clampUnit(s[k], base[k])));
  return {
    speed: s.speed === undefined ? base.speed : clampSpeed(s.speed, base.speed),
    keepPitch: typeof s.keepPitch === 'boolean' ? s.keepPitch : base.keepPitch,
    reverb: unit('reverb'),
    muffle: unit('muffle'),
    bass: unit('bass'),
    volume: unit('volume'),
    beatSync: typeof s.beatSync === 'boolean' ? s.beatSync : base.beatSync,
  };
}

/** Tempo the beat (and takes) use: song tempo * speed, doubled or halved into 60..180. */
export function beatTempo(sourceBpm, speed) {
  if (!(sourceBpm > 0) || !(speed > 0)) return null;
  let b = sourceBpm * speed;
  while (b < MIN_BPM) b *= 2;
  while (b > MAX_BPM) b /= 2;
  return b;
}

/** Low-pass corner for a muffle amount: exponential, so 0.2 is a gentle dulling. */
export function muffleHz(m, sampleRate) {
  const top = Math.min(20000, sampleRate * 0.45);
  return top * (MUFFLE_LOW_HZ / top) ** m;
}

export const remixTail = (s) => (s.reverb > 0 ? REVERB_SECONDS + REVERB_PREDELAY : 0);

/**
 * input -> bass shelf -> muffle (dry at 0, crossfades into the low-pass) -> dry + reverb -> volume -> destination
 * The reverb is built the first time it is turned up.
 */
export function createDeckChain(ctx, destination) {
  const nodes = [];
  const add = (n) => { nodes.push(n); return n; };
  const input = add(ctx.createGain());
  const shelf = add(ctx.createBiquadFilter());
  shelf.type = 'lowshelf';
  shelf.frequency.value = BASS_HZ;
  shelf.gain.value = 0;
  const lp = add(ctx.createBiquadFilter());
  lp.type = 'lowpass';
  lp.Q.value = 0.8;
  lp.frequency.value = muffleHz(0, ctx.sampleRate);
  const muffleDry = add(ctx.createGain());
  const muffleWet = add(ctx.createGain());
  muffleWet.gain.value = 0;
  const post = add(ctx.createGain());
  const dry = add(ctx.createGain());
  const wet = add(ctx.createGain());
  wet.gain.value = 0;
  const volume = add(ctx.createGain());
  volume.gain.value = DECK_TRIM;
  input.connect(shelf);
  shelf.connect(muffleDry).connect(post);
  shelf.connect(lp).connect(muffleWet).connect(post);
  post.connect(dry).connect(volume);
  wet.connect(volume);
  volume.connect(destination);
  let reverb = null;

  return {
    input,
    apply(s, smooth = true) {
      if (!reverb && s.reverb > 0) {
        reverb = createReverb(ctx, 120);
        post.connect(reverb.input);
        reverb.output.connect(wet);
        nodes.push(reverb.input, reverb.output);
      }
      glide(ctx, shelf.gain, s.bass * BASS_MAX_DB, smooth);
      glide(ctx, lp.frequency, muffleHz(s.muffle, ctx.sampleRate), smooth, true);
      glide(ctx, muffleWet.gain, s.muffle > 0 ? 1 : 0, smooth);
      glide(ctx, muffleDry.gain, s.muffle > 0 ? 0 : 1, smooth);
      glide(ctx, dry.gain, 1 - REVERB_DUCK * s.reverb, smooth);
      glide(ctx, wet.gain, s.reverb * REVERB_WET, smooth);
      const trim = DECK_TRIM * 10 ** ((-BASS_TRIM_DB * s.bass) / 20);
      glide(ctx, volume.gain, volumeToGain(s.volume) * trim, smooth);
    },
    dispose() { nodes.forEach(disconnect); },
  };
}

// ---- playback helpers (pure timing, no deck state) ----

function soundOf(buffer, speed, stretched) {
  return stretched
    ? { buffer: stretched, rate: 1, scale: 1 / speed, speed }
    : { buffer, rate: speed, scale: 1, speed };
}

/** Plays `sound` from source time `from` at context time `at`; returns the voice. */
function startVoice(ctx, dest, sound, loop, from, at, fadeIn, duration) {
  const src = ctx.createBufferSource();
  src.buffer = sound.buffer;
  src.playbackRate.value = sound.rate;
  if (loop.enabled) {
    src.loop = true;
    src.loopStart = loop.start * sound.scale;
    src.loopEnd = loop.end * sound.scale;
  }
  const fade = ctx.createGain();
  fade.gain.value = 0;
  fade.gain.setValueAtTime(0, at);
  fade.gain.linearRampToValueAtTime(1, at + fadeIn);
  src.connect(fade).connect(dest);
  src.start(at, Math.min(from * sound.scale, sound.buffer.duration));
  return {
    src,
    fade,
    fadeIn,
    fadeOutAt: null,
    fadeOutFrom: 1,
    t0: at,
    pos0: from,
    speed: sound.speed,
    sound,
    loop: { ...loop },
    duration,
    stopped: false,
  };
}

/** Gain of the voice's fade at context time t, as scheduled. */
function fadeLevel(v, t) {
  const up = clamp((t - v.t0) / v.fadeIn, 0, 1);
  if (v.fadeOutAt === null || t <= v.fadeOutAt) return up;
  return v.fadeOutFrom * clamp(1 - (t - v.fadeOutAt) / FADE, 0, 1);
}

/**
 * Fades the voice out from context time `at` (also fine before it started, or
 * in the middle of its fade-in). Linear ramps only: a target curve here turns
 * into NaN in some implementations.
 */
function fadeOutVoice(v, at) {
  if (v.fadeOutAt !== null && v.fadeOutAt <= at) return; // already fading by then
  const g = v.fade.gain;
  const level = fadeLevel(v, at);
  if (typeof g.cancelAndHoldAtTime === 'function') {
    g.cancelAndHoldAtTime(at);
  } else {
    // Firefox: cancel, then ramp to where the cancelled curve would have been
    g.cancelScheduledValues(at);
    g.linearRampToValueAtTime(level, at);
  }
  g.linearRampToValueAtTime(0, at + FADE);
  v.fadeOutAt = at;
  v.fadeOutFrom = level;
  try { v.src.stop(at + FADE + 0.005); } catch { /* already stopped */ }
}

function retireVoice(v, at) {
  if (v.stopped) return;
  v.stopped = true;
  fadeOutVoice(v, at);
  v.src.onended = () => { disconnect(v.src); disconnect(v.fade); };
}

/** Source time the voice plays at context time t. */
export function voicePosition(v, t) {
  let p = v.pos0 + Math.max(0, t - v.t0) * v.speed;
  const { start, end, enabled } = v.loop;
  if (enabled && p >= end) p = start + ((p - start) % (end - start));
  return Math.min(p, v.duration);
}

/** Next loop wrap at or after context time `after`: { at, period } or null. */
function nextWrap(v, after) {
  if (!v.loop.enabled) return null;
  const period = (v.loop.end - v.loop.start) / v.speed;
  let at = v.t0 + (v.loop.end - v.pos0) / v.speed;
  if (at < after) at += Math.ceil((after - at) / period - 1e-9) * period;
  return { at, period };
}

/** Context time of the next bar line (bars counted from the loop start) at or after `after`. */
function nextDownbeat(v, after, bpm) {
  const t = Math.max(after, v.t0);
  const p = voicePosition(v, t);
  const barSrc = secondsPerStep(bpm) * STEPS * v.speed;
  const k = Math.ceil((p - v.loop.start) / barSrc - 1e-6);
  const d = v.loop.start + k * barSrc;
  if (v.loop.enabled && d >= v.loop.end - 1e-6) return nextWrap(v, t).at;
  return t + (d - p) / v.speed;
}

/** Bar anchors for the beat: the next bar line, then every loop wrap. */
function beatAnchors(v, after, bpm) {
  const down = nextDownbeat(v, after, bpm);
  const wrap = nextWrap(v, after);
  if (!wrap) return [{ at: down }];
  if (Math.abs(wrap.at - down) < 1e-6) return [wrap];
  return [{ at: down }, wrap];
}

/** Step times for an offline beat, aligned exactly like the realtime scheduler. */
export function gridSteps(first, spb, anchors, end) {
  const list = anchors.map((a) => ({ at: a.at, period: a.period || 0 })).sort((a, b) => a.at - b.at);
  const grid = { nextTime: first, nextStep: 0 };
  const out = [];
  while (grid.nextTime < end) {
    snapToAnchors(grid, list, spb);
    if (grid.nextTime >= end) break;
    out.push({ step: grid.nextStep, time: grid.nextTime });
    grid.nextTime += spb;
    grid.nextStep = (grid.nextStep + 1) % STEPS;
  }
  return out;
}

/** Channels for the stretch: mono and stereo as they are, more folded down to stereo. */
function stretchInput(buffer) {
  const n = buffer.numberOfChannels;
  if (n <= 2) return Array.from({ length: n }, (_, c) => buffer.getChannelData(c));
  const out = [new Float32Array(buffer.length), new Float32Array(buffer.length)];
  const count = [0, 0];
  for (let c = 0; c < n; c++) {
    const d = buffer.getChannelData(c);
    const o = out[c % 2];
    for (let i = 0; i < d.length; i++) o[i] += d[i];
    count[c % 2]++;
  }
  out.forEach((o, k) => { for (let i = 0; i < o.length; i++) o[i] /= count[k]; });
  return out;
}

const byteSize = (input) => input?.byteLength ?? input?.size ?? 0;

async function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  if (input && typeof input.arrayBuffer === 'function') return input.arrayBuffer();
  throw new Error('decode-failed');
}

/**
 * @param engine from createEngine()
 * @param [opts] OfflineAudioContext (constructor, for decoding before the AudioContext
 *   exists and for renders), detectBpm, timeStretch (injection points for tests)
 */
export function createRemix(engine, opts = {}) {
  const Offline = () => opts.OfflineAudioContext || globalThis.OfflineAudioContext;
  const detect = opts.detectBpm || detectBpm;
  const stretch = opts.timeStretch || timeStretch;

  let song = null; // { buffer, name, id, peaks }
  let songCount = 0;
  let loading = false;
  let loop = { start: 0, end: 0, enabled: true };
  let settings = { ...DEFAULT_REMIX };
  let sourceBpm = null;
  let bpmConfidence = 0;
  let bpmManual = false;
  let bpmBusy = false;
  let chain = null;
  let voice = null;
  let playGen = 0;
  let pending = null; // { gen, pos } while play() waits for the stretched copy
  let locked = false;
  let disposed = false;
  let decodeCtx = null;
  const players = new Set(); // playSnapshot handles still sounding
  const stretches = new WeakMap(); // song buffer -> Map(speed -> AudioBuffer)
  const jobs = []; // { buffer, speed, pinned, cancelled, promise }
  let stretchTimer = null;
  let beatOwner = null; // token of whoever started the beat (the deck or a take preview)
  let beatGen = 0; // a takeBeat that resumes after a newer one (or a release) must not touch the engine
  let switching = false; // our own engine stop/start, not the user's
  const DECK = { name: 'deck' };
  const listeners = new Set();

  const emit = () => {
    for (const cb of [...listeners]) {
      try { cb(); } catch (e) { console.error(e); }
    }
  };

  // ---- beat ----

  function stopEngine() {
    if (!engine.isPlaying) return;
    switching = true;
    try { engine.stop(); } finally { switching = false; }
  }

  // anchors() runs once the beat is running: start() clears them, and the
  // voice may have been restarted while it was starting
  async function takeBeat(owner, { bpm, at, anchors, endTime }) {
    const gen = ++beatGen;
    beatOwner = owner;
    engine.setTempoOverride(bpm);
    stopEngine();
    await engine.start({ at });
    if (gen !== beatGen || beatOwner !== owner) return;
    engine.setBarAnchors(anchors());
    if (Number.isFinite(endTime)) engine.setEndTime(endTime);
  }

  function releaseBeat(owner) {
    if (!owner || beatOwner !== owner) return;
    beatOwner = null;
    beatGen++;
    engine.setTempoOverride(null);
    stopEngine();
  }

  // the user stopped the beat: it is theirs again
  const offEngine = engine.onStateChange(({ isPlaying }) => {
    if (isPlaying || switching || !beatOwner) return;
    beatOwner = null;
    engine.setTempoOverride(null);
  });

  const wantsBeat = () => settings.beatSync && sourceBpm != null;

  function syncDeckBeat() {
    if (!voice) return;
    if (!wantsBeat()) { releaseBeat(DECK); return; }
    const ctx = engine.context;
    const bpm = beatTempo(sourceBpm, voice.speed);
    const anchors = () => {
      if (!voice) return null;
      const b = beatTempo(sourceBpm, voice.speed);
      engine.setTempoOverride(b);
      return beatAnchors(voice, ctx.currentTime + ANCHOR_LEAD, b);
    };
    if (beatOwner === DECK && engine.isPlaying) {
      engine.setBarAnchors(anchors());
      return;
    }
    const at = nextDownbeat(voice, ctx.currentTime + ANCHOR_LEAD / 2, bpm);
    takeBeat(DECK, { bpm, at, anchors }).catch((e) => console.error(e));
  }

  // ---- stretch ----

  const cachedStretch = (buffer, speed) => stretches.get(buffer)?.get(speed) || null;
  const wantedStretch = () => (song && settings.keepPitch && settings.speed !== 1 ? settings.speed : null);
  const liveJob = (buffer, speed) => jobs.find((j) => !j.cancelled && j.buffer === buffer && j.speed === speed);

  function bufferContext() {
    if (engine.context) return engine.context;
    if (!decodeCtx) {
      const Ctor = Offline();
      if (!Ctor) throw new Error('Web Audio API not supported');
      decodeCtx = new Ctor(2, 1, DECODE_RATE);
    }
    return decodeCtx;
  }

  function stretchJob(buffer, speed, pinned) {
    const running = liveJob(buffer, speed);
    if (running) {
      running.pinned ||= pinned;
      return running.promise;
    }
    const job = { buffer, speed, pinned, cancelled: false, promise: null };
    job.promise = (async () => {
      const chans = stretchInput(buffer);
      const ab = bufferContext().createBuffer(
        chans.length, Math.max(1, Math.round(buffer.length / speed)), buffer.sampleRate,
      );
      const output = chans.map((_, c) => ab.getChannelData(c));
      await stretch(chans, buffer.sampleRate, speed, { isCancelled: () => job.cancelled, output });
      let m = stretches.get(buffer);
      if (!m) stretches.set(buffer, (m = new Map()));
      m.set(speed, ab);
      while (m.size > STRETCH_CACHE) m.delete(m.keys().next().value);
      return ab;
    })().finally(() => {
      jobs.splice(jobs.indexOf(job), 1);
      if (!job.cancelled) followSound();
      emit();
    });
    job.promise.catch(() => {});
    jobs.push(job);
    emit();
    return job.promise;
  }

  // drops live stretch work that no longer matches the settings, starts the wanted one after a pause
  function scheduleStretch() {
    const want = wantedStretch();
    for (const j of jobs) {
      if (!j.pinned && (j.buffer !== song?.buffer || j.speed !== want)) j.cancelled = true;
    }
    clearTimeout(stretchTimer);
    stretchTimer = null;
    if (want == null || cachedStretch(song.buffer, want) || liveJob(song.buffer, want)) return;
    stretchTimer = setTimeout(() => {
      stretchTimer = null;
      if (song && wantedStretch() === want && !cachedStretch(song.buffer, want)) {
        stretchJob(song.buffer, want, false).catch(() => {});
      } else emit();
    }, STRETCH_DEBOUNCE_MS);
  }

  /** Sound for a snapshot; waits for the stretch when keep pitch is on. */
  async function soundFor(snap) {
    if (!snap.keepPitch || snap.speed === 1) return soundOf(snap.buffer, snap.speed, null);
    const ready = cachedStretch(snap.buffer, snap.speed) || await stretchJob(snap.buffer, snap.speed, true);
    return soundOf(snap.buffer, snap.speed, ready);
  }

  /** What the deck should play now; null while a wanted stretch is not ready (keep the old sound). */
  function targetSound() {
    if (!song) return null;
    const want = wantedStretch();
    if (want == null) return soundOf(song.buffer, settings.speed, null);
    const ready = cachedStretch(song.buffer, want);
    return ready ? soundOf(song.buffer, want, ready) : null;
  }

  // ---- transport ----

  function liveChain(ctx) {
    if (!chain) {
      chain = createDeckChain(ctx, engine.master);
      chain.apply(settings, false);
    }
    return chain;
  }

  function watchEnd(v) {
    v.src.onended = () => {
      disconnect(v.src);
      disconnect(v.fade);
      if (voice !== v) return;
      voice = null;
      releaseBeat(DECK);
      emit();
    };
  }

  function startPosition(from) {
    const d = song.buffer.duration;
    if (!Number.isFinite(from)) return loop.enabled ? loop.start : 0;
    const p = clamp(from, 0, d);
    if (loop.enabled && p >= loop.end) return loop.start;
    return p;
  }

  // keep pitch: wait for the stretched copy rather than play the plain one
  async function stretchReady(gen, pos) {
    for (;;) {
      const want = wantedStretch();
      if (want === null || cachedStretch(song.buffer, want)) break;
      const first = !pending;
      pending = { gen, pos };
      if (first) emit();
      try {
        await stretchJob(song.buffer, want, false);
      } catch (e) {
        // cancelled because the speed moved on: wait for the new one
        if (e?.message !== 'stretch-cancelled') {
          if (pending?.gen === gen) { pending = null; emit(); }
          throw e;
        }
      }
      if (gen !== playGen || !song) return false;
    }
    if (pending?.gen === gen) pending = null;
    return true;
  }

  /**
   * opts.from: source time (default loop start, or 0 with the loop off);
   * opts.at: context time to start (default right away). With keep pitch on and
   * the stretch not ready yet, it waits for it (isPlaying and pending are true).
   */
  async function play({ from, at } = {}) {
    if (!song) throw new Error('no-song');
    const gen = ++playGen;
    const ctx = await engine.resume();
    if (gen !== playGen || !song) return;
    if (voice) {
      retireVoice(voice, ctx.currentTime);
      voice = null;
      releaseBeat(DECK); // restarted below on the new bar 1
    }
    const pos = startPosition(from);
    if (!(await stretchReady(gen, pos))) return;
    const t = Math.max(ctx.currentTime + LEAD, Number.isFinite(at) ? at : 0);
    voice = startVoice(ctx, liveChain(ctx).input, targetSound(), loop, pos, t, FADE_IN, song.buffer.duration);
    watchEnd(voice);
    emit();
    syncDeckBeat();
  }

  function stop() {
    playGen++;
    const v = voice;
    const was = !!v || !!pending;
    voice = null;
    pending = null;
    if (v) retireVoice(v, engine.context.currentTime);
    releaseBeat(DECK);
    if (was) emit();
  }

  // the deck is playing the original at a changed rate although keep pitch is on
  const playsPlain = (v) => v.sound.buffer === song?.buffer && v.sound.rate !== 1 && wantedStretch() !== null;

  // stops the plain sound and plays again from the same spot once the stretch is ready
  function waitForStretch() {
    const pos = voicePosition(voice, engine.context.currentTime);
    play({ from: pos }).catch((e) => console.error(e));
  }

  /**
   * Same position, new sound or loop: crossfades into a fresh source. When the
   * playhead has to jump (it is outside the new loop) the beat restarts with it.
   */
  function restart() {
    if (!voice || !song) return;
    if (!targetSound() && playsPlain(voice)) { waitForStretch(); return; }
    const ctx = engine.context;
    let t = Math.max(ctx.currentTime + SWITCH_LEAD, voice.t0);
    let pos = voicePosition(voice, t);
    const jump = loop.enabled && (pos < loop.start || pos >= loop.end);
    if (jump) {
      t = Math.max(ctx.currentTime + LEAD, voice.t0);
      pos = loop.start;
      releaseBeat(DECK);
    }
    const sound = targetSound() || voice.sound;
    const old = voice;
    voice = startVoice(ctx, liveChain(ctx).input, sound, loop, pos, t, t > old.t0 ? FADE : FADE_IN, song.buffer.duration);
    watchEnd(voice);
    retireVoice(old, t);
    syncDeckBeat();
  }

  // a stretched copy at the old speed may keep playing until the new one is ready; the plain sound may not
  function followSound() {
    if (!voice) return;
    const target = targetSound();
    if (target) {
      if (target.buffer !== voice.sound.buffer || target.rate !== voice.sound.rate) restart();
    } else if (playsPlain(voice)) waitForStretch();
  }

  // ---- settings ----

  function update(partial) {
    if (locked) return;
    const next = normalizeRemix(partial, settings);
    if (next.beatSync && !settings.beatSync && sourceBpm == null) next.beatSync = false;
    const soundChanged = next.speed !== settings.speed || next.keepPitch !== settings.keepPitch;
    const fxChanged = REMIX_FX.some((k) => next[k] !== settings[k]);
    const syncChanged = next.beatSync !== settings.beatSync;
    if (!soundChanged && !fxChanged && !syncChanged) return;
    settings = next;
    if (fxChanged) chain?.apply(settings, true);
    if (soundChanged) {
      scheduleStretch();
      followSound();
    }
    if (syncChanged) syncDeckBeat();
    emit();
  }

  function applySourceBpm(bpm) {
    if (bpm === sourceBpm) return;
    sourceBpm = bpm;
    syncDeckBeat();
  }

  function setSourceBpm(n) {
    if (locked) return sourceBpm;
    let next;
    if (n === null) next = null;
    else {
      const v = Number(n);
      if (n === '' || typeof n === 'boolean' || !Number.isFinite(v)) return sourceBpm;
      next = clamp(v, MIN_SOURCE_BPM, MAX_SOURCE_BPM);
    }
    bpmManual = true;
    if (next !== sourceBpm) {
      applySourceBpm(next);
      emit();
    }
    return next;
  }

  function setLoop(start, end) {
    if (!song || locked) return { ...loop };
    const d = song.buffer.duration;
    const num = (x, fallback) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : fallback);
    let s = clamp(num(start, loop.start), 0, d);
    let e = clamp(num(end, loop.end), 0, d);
    if (e < s) [s, e] = [e, s];
    const min = Math.min(MIN_LOOP_SECONDS, d);
    if (e - s < min) {
      if (s + min <= d) e = s + min;
      else { e = d; s = d - min; }
    }
    if (s !== loop.start || e !== loop.end) {
      loop = { ...loop, start: s, end: e };
      restart();
      emit();
    }
    return { ...loop };
  }

  function setLoopEnabled(on) {
    if (locked) return loop.enabled;
    const next = !!on;
    if (next !== loop.enabled) {
      loop = { ...loop, enabled: next };
      restart();
      emit();
    }
    return next;
  }

  // ---- file ----

  function startDetection(s) {
    bpmBusy = true;
    setTimeout(() => {
      if (song !== s) return;
      detect(s.buffer, { isCancelled: () => song !== s })
        .then(({ bpm, confidence }) => {
          if (song !== s) return;
          bpmConfidence = confidence;
          if (!bpmManual && bpm != null && confidence >= MIN_CONFIDENCE) applySourceBpm(bpm);
        })
        .catch((e) => { if (song === s) console.error(e); })
        .finally(() => {
          if (song !== s) return;
          bpmBusy = false;
          emit();
        });
    }, 0);
  }

  function clearSong() {
    stop();
    song = null;
    loop = { start: 0, end: 0, enabled: true };
    sourceBpm = null;
    bpmConfidence = 0;
    bpmManual = false;
    bpmBusy = false;
    scheduleStretch();
  }

  /**
   * Decodes and replaces the current song. Rejects Error('decode-failed' |
   * 'too-long' | 'too-large' | 'busy' (loading, or locked by a take) | 'cancelled' (disposed)).
   */
  async function load(input, { name } = {}) {
    if (loading || locked) throw new Error('busy');
    if (disposed) throw new Error('cancelled');
    if (byteSize(input) > MAX_FILE_BYTES) throw new Error('too-large');
    loading = true;
    try {
      let decoded = null;
      try {
        const data = await toArrayBuffer(input);
        decoded = await bufferContext().decodeAudioData(data);
      } catch (e) {
        if (e?.message === 'Web Audio API not supported') throw e;
      }
      if (disposed) throw new Error('cancelled');
      if (!decoded || !(decoded.length > 0)) throw new Error('decode-failed');
      if (decoded.duration > MAX_SONG_SECONDS) throw new Error('too-long');
      if (locked) throw new Error('busy');
      clearSong();
      song = {
        buffer: decoded,
        name: String(name ?? input?.name ?? 'Untitled'),
        id: ++songCount,
        peaks: new Map(),
      };
      loop = { start: 0, end: decoded.duration, enabled: true };
      startDetection(song);
      scheduleStretch();
      emit();
      return info();
    } finally {
      loading = false;
    }
  }

  function unload() {
    if (locked) throw new Error('busy');
    if (!song) return;
    clearSong();
    emit();
  }

  const info = () => (song ? {
    name: song.name,
    duration: song.buffer.duration,
    sampleRate: song.buffer.sampleRate,
    channels: song.buffer.numberOfChannels,
  } : null);

  /** min/max per column (1..8192) over all channels, columns spread evenly over the song. */
  function getPeaks(columns) {
    const n = Math.floor(Number(columns));
    const cols = Number.isFinite(n) ? clamp(n, 1, MAX_PEAK_COLUMNS) : 1;
    if (!song) return { min: new Float32Array(0), max: new Float32Array(0) };
    let hit = song.peaks.get(cols);
    if (!hit) {
      const buf = song.buffer;
      const len = buf.length;
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      const min = new Float32Array(cols);
      const max = new Float32Array(cols);
      for (let i = 0; i < cols; i++) {
        const a = Math.floor((i * len) / cols);
        const b = Math.max(a + 1, Math.floor(((i + 1) * len) / cols));
        let lo = Infinity, hi = -Infinity;
        for (const d of chans) {
          for (let j = a; j < b && j < len; j++) {
            const x = d[j];
            if (x < lo) lo = x;
            if (x > hi) hi = x;
          }
        }
        min[i] = lo === Infinity ? 0 : lo;
        max[i] = hi === -Infinity ? 0 : hi;
      }
      hit = { min, max };
      if (song.peaks.size >= 4) song.peaks.delete(song.peaks.keys().next().value);
      song.peaks.set(cols, hit);
    }
    return { min: hit.min.slice(), max: hit.max.slice() };
  }

  // ---- snapshots (takes recorded over the deck) and offline renders ----

  function rawSnapshot() {
    return {
      type: 'remix',
      name: song.name,
      ...settings,
      sourceBpm,
      bpm: beatTempo(sourceBpm, settings.speed),
      loop: { ...loop },
      buffer: song.buffer,
    };
  }

  /** Current song + settings, frozen for a take. Throws Error('no-remix' | 'no-bpm'). */
  function snapshot() {
    if (!song) throw new Error('no-remix');
    if (sourceBpm == null) throw new Error('no-bpm');
    return rawSnapshot();
  }

  /**
   * One pass of the song from `from` for `length` context seconds (looping when
   * loop is true) through the deck chain and the master chain, optionally with
   * the beat (bars from the loop start, re-aligned on every wrap).
   */
  async function renderOffline(snap, o) {
    const Ctor = o.OfflineAudioContext || Offline();
    if (!Ctor) throw new Error('OfflineAudioContext not available');
    const sound = await soundFor(snap);
    const sr = o.sampleRate || snap.buffer.sampleRate;
    const startAt = o.startAt || 0;
    const pattern = normalizePattern(o.pattern || engine.getPattern());
    const bpm = o.withBeat ? snap.bpm : null;
    const tail = Math.max(
      MIN_TAIL, o.tail || 0, remixTail(snap), bpm ? Math.max(DEFAULT_TAIL, fxTail(pattern.fx, bpm)) : 0,
    );
    const ctx = new Ctor(2, Math.ceil((startAt + o.length + tail) * sr), sr);
    const master = createMasterChain(ctx);
    applyMaster(ctx, master.master, pattern.master, false);
    const bus = master.master;
    const deck = createDeckChain(ctx, bus);
    deck.apply(snap, false);
    const loopUsed = o.loop ? snap.loop : { ...snap.loop, end: snap.buffer.duration, enabled: false };
    const v = startVoice(ctx, deck.input, sound, loopUsed, o.from, startAt, FADE_IN, snap.buffer.duration);
    fadeOutVoice(v, startAt + o.length);

    if (bpm) {
      const fx = createBeatFx(ctx, bus);
      fx.setTempo(bpm, false);
      fx.apply(pattern.fx, false);
      const mixer = createMixer(ctx, fx.input, fx.sends);
      mixer.apply(pattern.mixer, false);
      mixer.applySends(pattern.fx.sends, false);
      const voices = createVoiceState(false);
      const spb = secondsPerStep(bpm);
      const first = nextDownbeat(v, startAt, bpm);
      const anchors = beatAnchors(v, first + 1e-3, bpm).filter((a) => a.period);
      for (const { step, time } of gridSteps(first, spb, anchors, startAt + o.length)) {
        playStep(ctx, mixer.inputs, pattern, step, time + swingOffset(step, pattern.swing, spb), voices);
      }
    }
    if (o.setup) await o.setup(ctx, bus);
    return ctx.startRendering();
  }

  /**
   * Export: the loop (or the whole song) as you hear it, plus the reverb tail.
   * withBeat needs a BPM and is ignored without one.
   */
  async function render({ loopOnly = true, withBeat = settings.beatSync, ...rest } = {}) {
    if (!song) throw new Error('no-song');
    const snap = rawSnapshot();
    const from = loopOnly ? loop.start : 0;
    const to = loopOnly ? loop.end : song.buffer.duration;
    return renderOffline(snap, {
      ...rest, from, length: (to - from) / snap.speed, loop: false, withBeat: !!withBeat && snap.bpm != null,
    });
  }

  /**
   * Backing for a take: the snapshot's loop from its start, `duration` seconds.
   * o: duration, sampleRate, startAt, tail, setup(ctx, bus), OfflineAudioContext.
   */
  function renderSnapshot(snap, o) {
    return renderOffline(snap, {
      ...o, from: snap.loop.start, length: o.duration, loop: snap.loop.enabled, withBeat: snap.beatSync,
    });
  }

  /**
   * Plays a snapshot (its own settings, not the deck's) from its loop start at
   * context time `at`, with the beat if it was synced. Stops the deck.
   * Resolves with { startTime, stop(ringOut) }; startTime is later than `at`
   * when getting ready took too long.
   */
  async function playSnapshot(snap, { at, duration = Infinity } = {}) {
    const ctx = await engine.resume();
    const sound = await soundFor(snap);
    if (disposed) return { startTime: ctx.currentTime, stop() {} };
    stop();
    const deck = createDeckChain(ctx, engine.master);
    deck.apply(snap, false);
    const t = Math.max(ctx.currentTime + SWITCH_LEAD, Number.isFinite(at) ? at : 0);
    const v = startVoice(ctx, deck.input, sound, snap.loop, snap.loop.start, t, FADE_IN, snap.buffer.duration);
    const end = t + duration;
    if (Number.isFinite(end)) fadeOutVoice(v, end);
    const token = { name: 'snapshot' };
    if (snap.beatSync && snap.bpm) {
      takeBeat(token, {
        bpm: snap.bpm, at: t, anchors: () => beatAnchors(v, ctx.currentTime + ANCHOR_LEAD, snap.bpm), endTime: end,
      }).catch((e) => console.error(e));
    }
    let done = false;
    const handle = {
      startTime: t,
      stop(ringOut = 0) {
        if (done) return;
        done = true;
        players.delete(handle);
        retireVoice(v, ctx.currentTime);
        releaseBeat(token);
        setTimeout(() => deck.dispose(), (FADE * 3 + Math.max(0, ringOut)) * 1000);
      },
    };
    players.add(handle);
    return handle;
  }

  /** While locked (a take is being recorded over the deck) song and settings stay put. */
  function setLocked(on) {
    const next = !!on;
    if (next !== locked) {
      locked = next;
      emit();
    }
    return locked;
  }

  return {
    load,
    unload,
    get loaded() { return !!song; },
    get info() { return info(); },
    getPeaks,

    play,
    stop,
    get isPlaying() { return !!voice || !!pending; },
    /** true while play() waits for the keep-pitch stretch */
    get pending() { return !!pending; },
    getPosition() {
      if (pending) return pending.pos;
      return voice && engine.context ? voicePosition(voice, engine.context.currentTime) : null;
    },
    setLoop,
    setLoopEnabled,
    get loop() { return { ...loop }; },

    setSpeed(x) { update({ speed: x }); return settings.speed; },
    setKeepPitch(on) { update({ keepPitch: !!on }); return settings.keepPitch; },
    /** true while any stretch is waiting or running (also when a take needs one again) */
    get stretchBusy() { return stretchTimer !== null || jobs.some((j) => !j.cancelled); },
    setFx(name, value) {
      if (!REMIX_FX.includes(name)) throw new Error(`Unknown effect: ${name}`);
      update({ [name]: value });
      return settings[name];
    },
    applyPreset(id) {
      if (typeof id !== 'string' || !Object.hasOwn(REMIX_PRESETS, id)) throw new Error(`Unknown remix preset: ${id}`);
      update(REMIX_PRESETS[id].settings);
      return { ...settings };
    },
    get settings() { return { ...settings }; },
    setSettings(partial) { update(partial); return { ...settings }; },

    get sourceBpm() { return sourceBpm; },
    get bpmConfidence() { return bpmConfidence; },
    get bpmBusy() { return bpmBusy; },
    setSourceBpm,
    get effectiveBpm() { return sourceBpm == null ? null : round1(sourceBpm * settings.speed); },
    setBeatSync(on) { update({ beatSync: !!on }); return settings.beatSync; },

    render,

    get locked() { return locked; },
    setLocked,
    snapshot,
    prepareSnapshot: (snap) => soundFor(snap).then(() => {}),
    playSnapshot,
    renderSnapshot,

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      disposed = true;
      locked = false;
      clearSong();
      for (const h of [...players]) h.stop();
      for (const j of jobs) j.cancelled = true;
      offEngine();
      chain?.dispose();
      chain = null;
      listeners.clear();
    },
  };
}
