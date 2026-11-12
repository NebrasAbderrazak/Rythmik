// Stand-ins for the engine and booth so the UI can mount without Web Audio.
import { vi } from 'vitest';
import { normalizePattern, emptyPattern } from '../../src/audio/pattern.js';

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
    cancel: vi.fn(),
    dispose() {},
  };
  return booth;
}

export function polyfillDom() {
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
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
