// Stand-ins for the engine, booth, sampler and remix deck so the UI can mount without Web Audio.
import { vi } from 'vitest';
import { normalizePattern, emptyPattern, normalizeStep, defaultStep } from '../../src/audio/pattern.js';
import { VOICE_PRESETS } from '../../src/audio/voice.js';

const MAX_TRACKS = 16;
const MAX_CHAIN = 8;

// Follows the pattern v4 engine contract (docs/ENGINE_API.md) on plain pattern data.
export function fakeEngine() {
  let pattern = normalizePattern(emptyPattern(100));
  let editSection = 'A';
  const patternCbs = [];
  const stateCbs = [];
  const emitState = () => stateCbs.forEach((cb) => cb({ isPlaying: engine.isPlaying, bpm: pattern.bpm }));
  const emitPattern = () => patternCbs.forEach((cb) => cb(structuredClone(pattern)));
  const commit = () => {
    pattern = normalizePattern(pattern);
    if (!pattern.sections[editSection]) editSection = 'A';
    emitPattern();
  };
  const section = () => pattern.sections[editSection] || pattern.sections.A;
  const engine = {
    context: null,
    isPlaying: false,
    /** what getPlayPosition() returns while playing; tests set it */
    playPosition: null,
    setPattern: vi.fn((p) => {
      pattern = normalizePattern(p);
      if (!pattern.sections[editSection]) editSection = 'A';
      emitPattern();
    }),
    getPattern: () => structuredClone(pattern),
    addTrack: vi.fn((id) => {
      if (pattern.tracks.includes(id) || pattern.tracks.length >= MAX_TRACKS) return false;
      pattern.tracks.push(id);
      commit();
      return pattern.tracks.includes(id);
    }),
    removeTrack: vi.fn((id) => {
      if (!pattern.tracks.includes(id) || pattern.tracks.length < 2) return false;
      pattern.tracks = pattern.tracks.filter((t) => t !== id);
      commit();
      return true;
    }),
    moveTrack: vi.fn((id, to) => {
      const from = pattern.tracks.indexOf(id);
      if (from < 0) return false;
      pattern.tracks.splice(from, 1);
      pattern.tracks.splice(Math.max(0, Math.min(pattern.tracks.length, to)), 0, id);
      commit();
      return true;
    }),
    toggleStep: vi.fn((id, i) => {
      const row = section().steps[id];
      row[i] = row[i] ? null : defaultStep(id, i);
      emitPattern();
      return !!row[i];
    }),
    setStep: vi.fn((id, i, partial) => {
      const row = section().steps[id];
      row[i] = partial === null ? null : normalizeStep({ ...(row[i] || defaultStep(id, i)), ...partial }, id, i);
      emitPattern();
      return row[i] ? { ...row[i] } : null;
    }),
    getStep: (id, i) => {
      const s = section().steps[id]?.[i];
      return s ? { ...s } : null;
    },
    get editSection() {
      return editSection;
    },
    setEditSection: vi.fn((name) => {
      if (pattern.sections[name]) editSection = name;
      return editSection;
    }),
    setSectionLength: vi.fn((name, len) => {
      const sec = pattern.sections[name];
      if (!sec || sec.length === len) return;
      for (const id of Object.keys(sec.steps)) {
        const row = sec.steps[id];
        sec.steps[id] = len > sec.length ? [...row, ...structuredClone(row)] : row.slice(0, len);
      }
      sec.length = len;
      commit();
    }),
    setSectionB: vi.fn((on, { copyFrom = 'A' } = {}) => {
      if (on) {
        pattern.sections.B = structuredClone(pattern.sections[copyFrom] || pattern.sections.A);
      } else {
        pattern.sections.B = null;
        pattern.chain = ['A'];
      }
      commit();
    }),
    setChain: vi.fn((list) => {
      pattern.chain = list.filter((n) => pattern.sections[n]).slice(0, MAX_CHAIN);
      commit();
      return [...pattern.chain];
    }),
    setTrackSwing: vi.fn((id, x) => {
      pattern.mixer[id].swing = x;
      commit();
      return x;
    }),
    setTrackNudge: vi.fn((id, x) => {
      pattern.mixer[id].nudge = x;
      commit();
      return x;
    }),
    getPlayPosition: () => (engine.isPlaying ? engine.playPosition : null),
    setBassNote(i, midi) {
      return engine.setStep('bass', i, { p: midi });
    },
    trigger: vi.fn(),
    setBpm(n) {
      pattern.bpm = n;
      emitPattern();
      return n;
    },
    setSwing: vi.fn((x) => {
      pattern.swing = x;
      emitPattern();
      return x;
    }),
    setTrackVolume() {},
    setMute(t, on) {
      pattern.mixer[t].mute = on;
      emitPattern();
    },
    setSolo() {},
    setMasterVolume(v) {
      pattern.master = v;
      emitPattern();
    },
    setFx: vi.fn((name, v) => {
      pattern.fx = { ...(pattern.fx || {}), [name]: v };
      emitPattern();
      return v;
    }),
    setTrackSend: vi.fn((t, kind, v) => {
      const fx = (pattern.fx ||= {});
      fx.sends ||= {};
      fx.sends[t] = { ...(fx.sends[t] || {}), [kind]: v };
      emitPattern();
      return v;
    }),
    start: vi.fn(() => {
      engine.isPlaying = true;
      emitState();
      return Promise.resolve();
    }),
    stop: vi.fn(() => {
      engine.isPlaying = false;
      emitState();
    }),
    getCurrentStep: () => (engine.isPlaying && engine.playPosition ? engine.playPosition.step : -1),
    resume: () => Promise.resolve(),
    onStateChange(cb) {
      stateCbs.push(cb);
      return () => {};
    },
    onPatternChange(cb) {
      patternCbs.push(cb);
      return () => {};
    },
  };
  return engine;
}

// Follows the sampler contract: samples are plain records, project files are JSON text.
export function fakeSampler(engine = null) {
  const listeners = [];
  let count = 0;
  let sources = [];
  let samples = [];
  const emit = () => listeners.forEach((cb) => cb());
  const addSource = (name, duration = 2) => {
    const src = { id: `src-${++count}`, name, duration, channels: 1, sampleRate: 48000 };
    sources.push(src);
    emit();
    return src;
  };
  const sampler = {
    get sources() {
      return sources.map((s) => ({ ...s }));
    },
    get samples() {
      return samples.map((s) => ({ ...s }));
    },
    recording: false,
    previewSourceId: null,
    fromFile: vi.fn(async (file) => addSource(file?.name ?? 'File')),
    record: vi.fn(async () => addSource('Mic')),
    cancelRecord: vi.fn(),
    fromTake: vi.fn((takeId) => addSource(`Take ${takeId}`)),
    removeSource: vi.fn((id) => {
      sources = sources.filter((s) => s.id !== id);
      emit();
    }),
    getPeaks: (id, n) => ({ min: new Float32Array(n), max: new Float32Array(n) }),
    chop: vi.fn(() => [{ start: 0, end: 0.5 }, { start: 0.5, end: 1 }]),
    createSample: vi.fn((sourceId, { start = 0, end = 1, name } = {}) => {
      if (samples.length >= 16) throw new Error('too-many');
      const id = `smp-${++count}`;
      samples.push({
        id, name: name ?? `Sample ${samples.length + 1}`, sourceId, start, end, duration: end - start,
        gain: 0.8, pitch: 0, reverse: false, fadeIn: 0, fadeOut: 0.01,
      });
      emit();
      return id;
    }),
    /** test helper: adds a ready sample with this id */
    addSample(id, name) {
      samples.push({ id, name, sourceId: null, start: 0, end: 1, duration: 1, gain: 0.8, pitch: 0, reverse: false, fadeIn: 0, fadeOut: 0.01 });
      emit();
    },
    getSample(id) {
      const s = samples.find((x) => x.id === id);
      return s ? { ...s } : null;
    },
    update: vi.fn((id, partial) => {
      samples = samples.map((s) => (s.id === id ? { ...s, ...partial } : s));
      emit();
    }),
    remove: vi.fn((id) => {
      samples = samples.filter((s) => s.id !== id);
      engine?.removeTrack?.(id);
      emit();
    }),
    audition: vi.fn(),
    playRegion: vi.fn(),
    stopRegion: vi.fn(),
    save: vi.fn(async () => true),
    restore: vi.fn(async () => false),
    exportProject: vi.fn(
      async (pattern) => new Blob([JSON.stringify({ app: 'rythmik', version: 1, pattern, samples: [] })], { type: 'application/json' }),
    ),
    importProject: vi.fn(async (input) => {
      const text = typeof input === 'string' ? input : await input.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('not-a-project');
      }
      if (data?.app !== 'rythmik' || !data.pattern) throw new Error('not-a-project');
      return data.pattern;
    }),
    onChange(cb) {
      listeners.push(cb);
      return () => {};
    },
    emit,
    dispose() {},
  };
  return sampler;
}

export function fakeBooth() {
  const booth = {
    state: 'idle',
    micOpen: false,
    takes: [],
    selectedTakeId: null,
    previewTakeId: null,
    bars: 4,
    countIn: true,
    latencyOffsetMs: 0,
    autoLatencyMs: 12,
    latencyMs: 12,
    monitoring: false,
    inputDeviceId: null,
    inputLabel: '',
    lastFallback: false,
    listeners: [],
    voiceBusy: false,
    backing: 'beat',
    setBacking: vi.fn((kind) => {
      if (booth.state !== 'idle') throw new Error('busy');
      booth.backing = kind;
      booth.emit();
      return kind;
    }),
    voiceState: { ...VOICE_PRESETS.clean.settings, key: 'A', scale: 'minor' },
    get voice() {
      return { ...booth.voiceState };
    },
    setVoicePreset: vi.fn((id) => {
      booth.voiceState = { ...booth.voiceState, ...VOICE_PRESETS[id].settings };
    }),
    setVoiceSettings: vi.fn((partial) => {
      booth.voiceState = { ...booth.voiceState, ...partial };
    }),
    prepareVoice: vi.fn(() => Promise.resolve()),
    renderMix: vi.fn(() => Promise.resolve(null)),
    renderVocal: vi.fn(() => Promise.resolve(null)),
    setBars() {},
    setCountIn() {},
    setLatencyOffset(ms) {
      booth.latencyOffsetMs = ms;
    },
    setInputDevice: () => Promise.resolve(),
    listInputs: () => Promise.resolve([]),
    onChange(cb) {
      booth.listeners.push(cb);
      return () => {};
    },
    emit() {
      booth.listeners.forEach((cb) => cb());
    },
    onDevicesChange: () => () => {},
    getMicStatus: () => ({ open: booth.micOpen }),
    getInputLevel: () => 0,
    getRecordProgress: () => null,
    record: vi.fn(() => Promise.resolve(null)),
    cancel: vi.fn(),
    dispose() {},
  };
  return booth;
}

export function polyfillDom() {
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  // jsdom cannot navigate, so a download link's click would only log "Not implemented".
  const proto = HTMLAnchorElement.prototype;
  if (!proto.click.isDownloadStub) {
    const click = proto.click;
    proto.click = function () {
      if (this.hasAttribute('download')) return;
      click.call(this);
    };
    proto.click.isDownloadStub = true;
  }
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

export function goTo(hash) {
  history.pushState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function pressSpace(target) {
  const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

// Like the real deck, every setter is ignored while `locked` (the booth records over it).
export function fakeRemix() {
  const listeners = [];
  const remix = {
    locked: false,
    loaded: false,
    info: null,
    isPlaying: false,
    bpmBusy: false,
    stretchBusy: false,
    sourceBpm: null,
    bpmConfidence: 0,
    loop: { start: 0, end: 0, enabled: true },
    settings: { speed: 1, keepPitch: false, reverb: 0, muffle: 0, bass: 0, volume: 0.8, beatSync: false },
    get effectiveBpm() {
      return remix.sourceBpm == null ? null : Math.round(remix.sourceBpm * remix.settings.speed * 10) / 10;
    },
    load: vi.fn(async (file, { name } = {}) => {
      if (remix.locked) throw new Error('busy');
      remix.loaded = true;
      remix.info = { name: name ?? file?.name ?? 'Untitled', duration: 120, sampleRate: 48000, channels: 2 };
      remix.loop = { start: 0, end: 120, enabled: true };
      remix.emit();
      return remix.info;
    }),
    unload: vi.fn(() => {
      if (remix.locked) return;
      remix.stop();
      remix.loaded = false;
      remix.info = null;
      remix.sourceBpm = null;
      remix.emit();
    }),
    getPeaks: (n) => ({ min: new Float32Array(n), max: new Float32Array(n) }),
    play: vi.fn(() => {
      remix.isPlaying = true;
      remix.emit();
      return Promise.resolve();
    }),
    stop: vi.fn(() => {
      if (!remix.isPlaying) return;
      remix.isPlaying = false;
      remix.emit();
    }),
    getPosition: () => (remix.isPlaying ? remix.loop.start : null),
    setLoop: vi.fn((start, end) => {
      if (remix.locked) return { ...remix.loop };
      remix.loop = { ...remix.loop, start, end };
      remix.emit();
      return { ...remix.loop };
    }),
    setLoopEnabled: vi.fn((on) => {
      if (remix.locked) return remix.loop.enabled;
      remix.loop = { ...remix.loop, enabled: !!on };
      remix.emit();
      return !!on;
    }),
    update(partial) {
      if (remix.locked) return;
      remix.settings = { ...remix.settings, ...partial };
      if (remix.settings.beatSync && remix.sourceBpm == null) remix.settings.beatSync = false;
      remix.emit();
    },
    setSpeed: vi.fn((x) => remix.update({ speed: x })),
    setKeepPitch: vi.fn((on) => remix.update({ keepPitch: !!on })),
    setFx: vi.fn((name, v) => remix.update({ [name]: v })),
    applyPreset: vi.fn((id) => {
      const s = {
        original: { speed: 1, keepPitch: false, reverb: 0, muffle: 0, bass: 0 },
        slowedReverb: { speed: 0.85, keepPitch: false, reverb: 0.5, muffle: 0.2, bass: 0.15 },
        nightcore: { speed: 1.25, keepPitch: false, reverb: 0.1, muffle: 0, bass: 0 },
      }[id];
      remix.update(s);
    }),
    setSettings: vi.fn((partial) => remix.update(partial)),
    setSourceBpm: vi.fn((n) => {
      if (remix.locked) return remix.sourceBpm;
      remix.sourceBpm = n;
      remix.emit();
      return n;
    }),
    setBeatSync: vi.fn((on) => remix.update({ beatSync: !!on })),
    render: vi.fn(() => Promise.resolve(null)),
    onChange(cb) {
      listeners.push(cb);
      return () => {};
    },
    emit() {
      listeners.forEach((cb) => cb());
    },
    dispose() {},
  };
  return remix;
}
