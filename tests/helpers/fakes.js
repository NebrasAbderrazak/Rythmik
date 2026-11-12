// Stand-ins for the engine, booth and remix deck so the UI can mount without Web Audio.
import { vi } from 'vitest';
import { normalizePattern, emptyPattern } from '../../src/audio/pattern.js';
import { VOICE_PRESETS } from '../../src/audio/voice.js';

export function fakeEngine() {
  let pattern = normalizePattern(emptyPattern(100));
  const patternCbs = [];
  const stateCbs = [];
  const emitState = () => stateCbs.forEach((cb) => cb({ isPlaying: engine.isPlaying, bpm: pattern.bpm }));
  const emitPattern = () => patternCbs.forEach((cb) => cb(structuredClone(pattern)));
  const engine = {
    context: null,
    isPlaying: false,
    setPattern(p) {
      pattern = normalizePattern(p);
      emitPattern();
    },
    getPattern: () => structuredClone(pattern),
    toggleStep(t, i) {
      pattern.steps[t][i] = !pattern.steps[t][i];
      emitPattern();
      return pattern.steps[t][i];
    },
    setBassNote() {},
    trigger() {},
    setBpm(n) {
      pattern.bpm = n;
      emitPattern();
      return n;
    },
    setSwing() {},
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
    getCurrentStep: () => -1,
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
