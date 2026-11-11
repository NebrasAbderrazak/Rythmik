import { Scheduler } from './scheduler.js';
import {
  STEPS, TRACKS, TRACK_IDS, BASS_NOTES, MIN_BPM, MAX_BPM, MAX_SWING, DEFAULT_BASS_NOTE,
  clampBpm, clampSwing, clampUnit, isBassNote, secondsPerStep, swingOffset,
} from './constants.js';
import {
  playStep, playVoice, createMasterChain, createMixer, applyMaster,
  createVoiceState, silenceVoices,
} from './sequence.js';
import { emptyPattern, normalizePattern } from './pattern.js';

export { STEPS, TRACKS, BASS_NOTES, MIN_BPM, MAX_BPM, MAX_SWING };

/** Pass { context } to use an existing (e.g. offline) AudioContext. */
export function createEngine(options = {}) {
  let context = null;
  let chain = null;
  let mixer = null;
  let pattern = emptyPattern();
  let playing = false;
  // separate voice state for auditions so they never choke sequenced voices
  let voices = createVoiceState();
  const auditionVoices = createVoiceState();
  const stateListeners = new Set();
  const patternListeners = new Set();

  function setupContext(ctx) {
    context = ctx;
    chain = createMasterChain(ctx);
    mixer = createMixer(ctx, chain.master);
    mixer.apply(pattern.mixer, false);
    applyMaster(ctx, chain.master, pattern.master, false);
  }
  if (options.context) setupContext(options.context);

  const call = (set, arg) => {
    for (const cb of [...set]) {
      try { cb(arg); } catch (e) { console.error(e); }
    }
  };
  const emitState = () => call(stateListeners, { isPlaying: playing, bpm: pattern.bpm });
  const emitPattern = () => {
    if (patternListeners.size) call(patternListeners, normalizePattern(pattern));
  };

  const applyMixer = () => { if (mixer) mixer.apply(pattern.mixer, true); };
  const applyMasterVolume = () => { if (chain) applyMaster(context, chain.master, pattern.master, true); };

  const scheduler = new Scheduler({
    getContext: () => context,
    getSecondsPerStep: () => secondsPerStep(pattern.bpm),
    getStepOffset: (step, spb) => swingOffset(step, pattern.swing, spb),
    steps: STEPS,
    onStep: (step, time) => playStep(context, mixer.inputs, pattern, step, time, voices),
  });

  async function resume() {
    if (!context) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio API not supported');
      setupContext(new Ctor({ latencyHint: 'interactive' }));
    }
    // iOS can report 'interrupted', not just 'suspended'
    if (context.state !== 'running' && typeof context.resume === 'function') {
      await context.resume();
    }
    return context;
  }

  async function start() {
    if (playing) return;
    playing = true; // set early so double clicks don't double-start
    try {
      await resume();
    } catch (e) {
      playing = false;
      throw e;
    }
    if (!playing) return; // stop() called while resuming
    scheduler.start();
    emitState();
  }

  function stop() {
    if (!playing) return;
    playing = false;
    scheduler.stop();
    if (context) silenceVoices(voices, context.currentTime);
    voices = createVoiceState();
    emitState();
  }

  function assertTrack(trackId) {
    if (!TRACK_IDS.includes(trackId)) throw new Error(`Unknown track: ${trackId}`);
  }
  function assertStep(step) {
    const i = Number(step);
    if (!Number.isInteger(i) || i < 0 || i >= STEPS) throw new Error(`Bad step: ${step}`);
    return i;
  }
  function assertBassNote(midi) {
    if (!isBassNote(midi)) throw new Error(`Not an 808 note: ${midi}`);
  }

  function setBpm(n) {
    const next = clampBpm(n, pattern.bpm);
    if (next === pattern.bpm) return next;
    pattern.bpm = next;
    emitState();
    emitPattern();
    return next;
  }

  function setSwing(x) {
    const next = Math.round(clampSwing(x, pattern.swing) * 1000) / 1000;
    if (next !== pattern.swing) { pattern.swing = next; emitPattern(); }
    return next;
  }

  function setTrackVolume(trackId, v) {
    assertTrack(trackId);
    const ch = pattern.mixer[trackId];
    const next = clampUnit(v, ch.volume);
    if (next !== ch.volume) { ch.volume = next; applyMixer(); emitPattern(); }
    return next;
  }

  function setMute(trackId, on) {
    assertTrack(trackId);
    const ch = pattern.mixer[trackId];
    const next = !!on;
    if (next !== ch.mute) { ch.mute = next; applyMixer(); emitPattern(); }
    return next;
  }

  function setSolo(trackId, on) {
    assertTrack(trackId);
    const ch = pattern.mixer[trackId];
    const next = !!on;
    if (next !== ch.solo) { ch.solo = next; applyMixer(); emitPattern(); }
    return next;
  }

  function setMasterVolume(v) {
    const next = clampUnit(v, pattern.master);
    if (next !== pattern.master) { pattern.master = next; applyMasterVolume(); emitPattern(); }
    return next;
  }

  const clock = {
    get bpm() { return pattern.bpm; },
    setBpm,
    get secondsPerStep() { return secondsPerStep(pattern.bpm); },
    get swing() { return pattern.swing; },
    get isPlaying() { return playing; },
  };

  function playNow(trackId, midi) {
    const t = context.currentTime + 0.005;
    let note;
    if (trackId === 'bass') {
      note = midi ?? pattern.bassNotes.find((_, i) => pattern.steps.bass[i]) ?? DEFAULT_BASS_NOTE;
    }
    playVoice(context, mixer.auditionInputs[trackId], trackId, t, auditionVoices, { note });
  }

  return {
    get context() { return context; },
    get master() { return chain ? chain.master : null; },
    get output() { return chain ? chain.output : null; },
    clock,
    resume,
    start,
    stop,
    get isPlaying() { return playing; },

    getPattern() { return normalizePattern(pattern); },
    setPattern(p) {
      const prevBpm = pattern.bpm;
      pattern = normalizePattern(p);
      applyMixer();
      applyMasterVolume();
      if (pattern.bpm !== prevBpm) emitState();
      emitPattern();
    },
    toggleStep(trackId, stepIndex) {
      assertTrack(trackId);
      const i = assertStep(stepIndex);
      pattern.steps[trackId][i] = !pattern.steps[trackId][i];
      emitPattern();
      return pattern.steps[trackId][i];
    },
    setBassNote(stepIndex, midi) {
      const i = assertStep(stepIndex);
      assertBassNote(midi);
      if (pattern.bassNotes[i] !== midi) { pattern.bassNotes[i] = midi; emitPattern(); }
      return midi;
    },
    /** Play a sound now, ignoring mute/solo. Call from a user gesture. */
    trigger(trackId, opts = {}) {
      assertTrack(trackId);
      const midi = opts?.midi;
      if (midi != null) assertBassNote(midi);
      if (context && context.state === 'running') { playNow(trackId, midi); return; }
      resume().then(() => playNow(trackId, midi)).catch((e) => console.error(e));
    },

    setBpm,
    setSwing,
    setTrackVolume,
    setMute,
    setSolo,
    setMasterVolume,

    getCurrentStep() { return playing ? scheduler.getCurrentStep() : -1; },
    onStateChange(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onPatternChange(cb) {
      patternListeners.add(cb);
      return () => patternListeners.delete(cb);
    },
  };
}
