import { Scheduler } from './scheduler.js';
import {
  STEPS, TRACKS, VOICES, VOICE_IDS, BASS_NOTES, MIN_BPM, MAX_BPM, MAX_SWING, MAX_TRACKS, MAX_CHAIN,
  MAX_NUDGE, SECTION_LENGTHS, DEFAULT_BASS_NOTE,
  clampBpm, clampSwing, clampUnit, isBassNote, isPitched, isTrackId, secondsPerStep, swingOffset,
} from './constants.js';
import {
  playPosition, playVoice, createMasterChain, createMixer, applyMaster,
  createVoiceState, silenceVoices, patternLead,
} from './sequence.js';
import {
  emptyPattern, normalizePattern, normalizeStep, defaultStep, defaultChannel, emptyRow, loopLength,
} from './pattern.js';
import { createBeatFx, clampFx, defaultSends, FX_NAMES, SEND_KINDS, ECHO_TIMES } from './fx.js';
import { registerSampleVoices } from './samplevoice.js';

export {
  STEPS, TRACKS, VOICES, VOICE_IDS, BASS_NOTES, MIN_BPM, MAX_BPM, MAX_SWING, MAX_TRACKS, MAX_CHAIN,
  SECTION_LENGTHS, FX_NAMES, ECHO_TIMES,
};

const round3 = (x) => Math.round(x * 1000) / 1000;
const copyStep = (s) => (s ? { ...s } : null);

/** Pass { context } to use an existing (e.g. offline) AudioContext. */
export function createEngine(options = {}) {
  let context = null;
  let chain = null;
  let mixer = null;
  let fx = null;
  let pattern = emptyPattern();
  let editSection = 'A';
  let sampleVoices = {};
  let playing = false;
  let starting = null;
  let tempoOverride = null;
  // separate voice state for auditions so they never choke sequenced voices
  let voices = createVoiceState();
  const auditionVoices = createVoiceState();
  const stateListeners = new Set();
  const patternListeners = new Set();

  function setupContext(ctx) {
    context = ctx;
    chain = createMasterChain(ctx);
    fx = createBeatFx(ctx, chain.master);
    fx.setTempo(tempoOverride ?? pattern.bpm, false);
    fx.apply(pattern.fx, false);
    mixer = createMixer(ctx, fx.input, fx.sends);
    mixer.apply(pattern.mixer, false);
    mixer.applySends(pattern.fx.sends, false);
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

  const applyMixer = () => {
    if (!mixer) return;
    mixer.apply(pattern.mixer, true);
    mixer.applySends(pattern.fx.sends, true);
  };
  const applyMasterVolume = () => { if (chain) applyMaster(context, chain.master, pattern.master, true); };
  const applyFx = () => {
    if (!fx) return;
    fx.setTempo(tempoOverride ?? pattern.bpm, true);
    fx.apply(pattern.fx, true);
    mixer.applySends(pattern.fx.sends, true);
  };

  const spbNow = () => secondsPerStep(tempoOverride ?? pattern.bpm);
  const scheduler = new Scheduler({
    getContext: () => context,
    getSecondsPerStep: spbNow,
    getSteps: () => loopLength(pattern),
    getLead: () => patternLead(pattern, spbNow()),
    // only moves the playhead; each track's own swing is applied when it plays
    getStepOffset: (pos, spb) => swingOffset(pos, pattern.swing, spb),
    onStep: (pos, time, pass, gridTime) => playPosition(context, mixer, pattern, pos, gridTime, voices, {
      spb: spbNow(),
      pass,
      minTime: Math.max(scheduler.startTime, context.currentTime),
      samples: sampleVoices,
    }),
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

  /**
   * opts.at: context time for step 0 (e.g. a bar after a count-in).
   * While a start is in progress, further calls return the same promise.
   */
  function start(opts = {}) {
    if (playing) return starting || Promise.resolve();
    playing = true; // set early so double clicks don't double-start
    starting = (async () => {
      try {
        await resume();
      } catch (e) {
        playing = false;
        throw e;
      }
      if (!playing) return; // stop() called while resuming
      scheduler.start(0.06, opts?.at ?? null);
      emitState();
    })().finally(() => { starting = null; });
    return starting;
  }

  function stop() {
    if (!playing) return;
    playing = false;
    scheduler.stop();
    if (context) silenceVoices(voices, context.currentTime);
    voices = createVoiceState();
    emitState();
  }

  // ---- checks ----

  function assertTrack(id) {
    if (!pattern.tracks.includes(id)) throw new Error(`Unknown track: ${id}`);
  }
  function assertStep(step) {
    const i = Number(step);
    const len = pattern.sections[editSection].length;
    if (!Number.isInteger(i) || i < 0 || i >= len) throw new Error(`Bad step: ${step}`);
    return i;
  }
  function assertBassNote(midi) {
    if (!isBassNote(midi)) throw new Error(`Not an 808 note: ${midi}`);
  }
  function assertSection(name) {
    if (name !== 'A' && name !== 'B') throw new Error(`Unknown section: ${name}`);
    if (!pattern.sections[name]) throw new Error(`No section ${name}`);
  }
  const editRows = () => pattern.sections[editSection].steps;

  // ---- global controls ----

  function setBpm(n) {
    const next = clampBpm(n, pattern.bpm);
    if (next === pattern.bpm) return next;
    pattern.bpm = next;
    applyFx();
    emitState();
    emitPattern();
    return next;
  }

  function setSwing(x) {
    const next = round3(clampSwing(x, pattern.swing));
    if (next !== pattern.swing) { pattern.swing = next; emitPattern(); }
    return next;
  }

  function setChannel(id, key, next) {
    assertTrack(id);
    const ch = pattern.mixer[id];
    if (next !== ch[key]) { ch[key] = next; applyMixer(); emitPattern(); }
    return next;
  }

  const setTrackVolume = (id, v) => {
    assertTrack(id);
    return setChannel(id, 'volume', clampUnit(v, pattern.mixer[id].volume));
  };
  const setMute = (id, on) => setChannel(id, 'mute', !!on);
  const setSolo = (id, on) => setChannel(id, 'solo', !!on);

  function setTrackSwing(id, x) {
    assertTrack(id);
    const ch = pattern.mixer[id];
    const next = x === null || x === undefined ? null : round3(clampSwing(x, ch.swing ?? pattern.swing));
    return setChannel(id, 'swing', next);
  }

  function setTrackNudge(id, steps) {
    assertTrack(id);
    const ch = pattern.mixer[id];
    return setChannel(id, 'nudge', round3(clampUnit(steps, ch.nudge, -MAX_NUDGE, MAX_NUDGE)));
  }

  function setMasterVolume(v) {
    const next = clampUnit(v, pattern.master);
    if (next !== pattern.master) { pattern.master = next; applyMasterVolume(); emitPattern(); }
    return next;
  }

  function setFx(name, value) {
    if (!FX_NAMES.includes(name)) throw new Error(`Unknown effect: ${name}`);
    const next = clampFx(name, value, pattern.fx[name]);
    if (next !== pattern.fx[name]) { pattern.fx[name] = next; applyFx(); emitPattern(); }
    return next;
  }

  function setTrackSend(id, kind, value) {
    assertTrack(id);
    if (!SEND_KINDS.includes(kind)) throw new Error(`Unknown send: ${kind}`);
    const s = pattern.fx.sends[id];
    const next = clampFx(kind, value, s[kind]);
    if (next !== s[kind]) { s[kind] = next; applyFx(); emitPattern(); }
    return next;
  }

  // ---- tracks ----

  function addTrack(id) {
    if (!isTrackId(id)) throw new Error(`Unknown track: ${id}`);
    if (pattern.tracks.includes(id) || pattern.tracks.length >= MAX_TRACKS) return false;
    pattern.tracks.push(id);
    pattern.mixer[id] = defaultChannel();
    pattern.fx.sends[id] = defaultSends(id);
    for (const sec of Object.values(pattern.sections)) if (sec) sec.steps[id] = emptyRow(sec.length);
    applyMixer();
    emitPattern();
    return true;
  }

  function removeTrack(id) {
    if (!pattern.tracks.includes(id) || pattern.tracks.length <= 1) return false;
    pattern.tracks = pattern.tracks.filter((t) => t !== id);
    delete pattern.mixer[id];
    delete pattern.fx.sends[id];
    for (const sec of Object.values(pattern.sections)) if (sec) delete sec.steps[id];
    applyMixer(); // the channel's gate closes, so anything still ringing fades out
    emitPattern();
    return true;
  }

  function moveTrack(id, toIndex) {
    assertTrack(id);
    const list = pattern.tracks.filter((t) => t !== id);
    const i = Math.max(0, Math.min(list.length, Math.round(Number(toIndex)) || 0));
    list.splice(i, 0, id);
    if (list.every((t, k) => t === pattern.tracks[k])) return i;
    pattern.tracks = list;
    emitPattern();
    return i;
  }

  // ---- steps ----

  function toggleStep(id, step) {
    assertTrack(id);
    const i = assertStep(step);
    const row = editRows()[id];
    row[i] = row[i] ? null : defaultStep(id, i);
    emitPattern();
    return !!row[i];
  }

  function setStep(id, step, partial) {
    assertTrack(id);
    const i = assertStep(step);
    const row = editRows()[id];
    const next = partial === null ? null : normalizeStep({ ...(row[i] || defaultStep(id, i)), ...partial }, id, i);
    if (JSON.stringify(next) !== JSON.stringify(row[i])) { row[i] = next; emitPattern(); }
    return copyStep(next);
  }

  function getStep(id, step) {
    assertTrack(id);
    return copyStep(editRows()[id][assertStep(step)]);
  }

  // ---- sections ----

  function setEditSection(name) {
    assertSection(name);
    if (name !== editSection) { editSection = name; emitPattern(); }
    return editSection;
  }

  function setSectionLength(name, length) {
    assertSection(name);
    if (!SECTION_LENGTHS.includes(length)) throw new Error(`Bad length: ${length}`);
    const sec = pattern.sections[name];
    if (sec.length === length) return length;
    for (const id of pattern.tracks) {
      const row = sec.steps[id];
      sec.steps[id] = length > sec.length
        ? [...row, ...row.map((s) => copyStep(s))]
        : row.slice(0, length);
    }
    sec.length = length;
    emitPattern();
    return length;
  }

  function setSectionB(on, { copyFrom = 'A' } = {}) {
    if (on) {
      if (pattern.sections.B) return true;
      const from = pattern.sections[copyFrom];
      pattern.sections.B = from ? structuredClone(from) : {
        length: pattern.sections.A.length,
        steps: Object.fromEntries(pattern.tracks.map((id) => [id, emptyRow(pattern.sections.A.length)])),
      };
    } else {
      if (!pattern.sections.B) return false;
      pattern.sections.B = null;
      pattern.chain = ['A'];
      editSection = 'A';
    }
    emitPattern();
    return !!pattern.sections.B;
  }

  function setChain(list) {
    if (!Array.isArray(list)) throw new Error('Chain must be a list');
    const next = list.filter((n) => n === 'A' || (n === 'B' && pattern.sections.B)).slice(0, MAX_CHAIN);
    if (!next.length) throw new Error('Chain needs at least one section');
    if (next.join() !== pattern.chain.join()) { pattern.chain = next; emitPattern(); }
    return [...next];
  }

  // ---- audition ----

  function firstNote(id) {
    for (const name of ['A', 'B']) {
      const hit = pattern.sections[name]?.steps[id]?.find(Boolean);
      if (hit) return hit.p;
    }
    return DEFAULT_BASS_NOTE;
  }

  function playNow(id, opts) {
    const t = context.currentTime + 0.005;
    const p = opts.p ?? (isPitched(id) ? firstNote(id) : 0);
    playVoice(context, mixer.auditionInput(id), id, t, auditionVoices, {
      p, v: opts.v, samples: sampleVoices,
    });
  }

  const clock = {
    get bpm() { return pattern.bpm; },
    setBpm,
    get secondsPerStep() { return spbNow(); },
    get swing() { return pattern.swing; },
    get isPlaying() { return playing; },
  };

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
      if (!pattern.sections[editSection]) editSection = 'A';
      applyMixer();
      applyMasterVolume();
      applyFx();
      if (pattern.bpm !== prevBpm) emitState();
      emitPattern();
    },

    addTrack,
    removeTrack,
    moveTrack,
    toggleStep,
    setStep,
    getStep,
    /** Shortcut for setStep('bass', step, { p: midi }). */
    setBassNote(step, midi) {
      assertBassNote(midi);
      return setStep('bass', step, { p: midi }).p;
    },

    get editSection() { return editSection; },
    setEditSection,
    setSectionLength,
    setSectionB,
    setChain,

    /** Play a sound now, ignoring mute/solo. Any voice or sample id. Call from a user gesture. */
    trigger(id, opts = {}) {
      if (!isTrackId(id)) throw new Error(`Unknown track: ${id}`);
      const o = { ...opts };
      if (o.midi != null) { o.p = o.midi; delete o.midi; }
      if (o.p != null && isPitched(id)) assertBassNote(o.p);
      if (context && context.state === 'running') { playNow(id, o); return; }
      resume().then(() => playNow(id, o)).catch((e) => console.error(e));
    },

    /** map: { [smpId]: { buffer, start, end, gain, pitch, reverse, fadeIn, fadeOut } } */
    setSampleVoices(map) {
      sampleVoices = { ...(map || {}) };
      registerSampleVoices(sampleVoices);
    },
    get sampleVoices() { return sampleVoices; },

    setBpm,
    setSwing,
    setTrackVolume,
    setMute,
    setSolo,
    setTrackSwing,
    setTrackNudge,
    setMasterVolume,
    setFx,
    setTrackSend,

    /** Step in the playing section, -1 when stopped. */
    getCurrentStep() {
      const loc = playing ? scheduler.getCurrentInfo() : null;
      return loc ? loc.step : -1;
    },
    /** { section, step, chainIndex } of what is sounding now, or null. */
    getPlayPosition() {
      const loc = playing ? scheduler.getCurrentInfo() : null;
      return loc ? { section: loc.section, step: loc.step, chainIndex: loc.chainIndex } : null;
    },
    /** Context time of the next bar line (16 steps, counted across the chain) at or after minTime; null when stopped. */
    getNextBarTime(minTime = context ? context.currentTime : 0) {
      return playing && scheduler.running ? scheduler.getNextBarTime(minTime) : null;
    },
    /**
     * Loop position (step counted across the chain) and pass that play at the
     * grid time `time`, e.g. a take's bar 1; null when stopped. Pass both to
     * offline renders (startPos, startPass) so they continue from there.
     */
    getLoopPositionAt(time) {
      const at = playing ? scheduler.getPositionAt(time) : null;
      return at ? { pos: at.step, pass: at.pass } : null;
    },
    /** No steps at or after this context time until the next start(); null clears. */
    setEndTime(time) {
      scheduler.endTime = Number.isFinite(time) ? time : Infinity;
    },
    /** Play at this bpm without changing the pattern (null = pattern bpm). Fractions are kept. */
    setTempoOverride(bpm) {
      const v = Number(bpm);
      tempoOverride = bpm == null || !Number.isFinite(v) ? null : Math.min(MAX_BPM, Math.max(MIN_BPM, v));
      applyFx();
    },
    get tempoOverride() { return tempoOverride; },
    /** A bar line lands on each { at, period? } context time while playing; null clears. start() and stop() clear it. */
    setBarAnchors(list) {
      scheduler.setAnchors(list);
    },
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
