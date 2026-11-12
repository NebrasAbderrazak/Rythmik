import { describe, it, expect, vi } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { renderPatternOffline } from '../src/audio/offline.js';
import { PRESETS } from '../src/audio/presets.js';
import {
  createEngine, TRACKS, STEPS, BASS_NOTES, MIN_BPM, MAX_BPM,
} from '../src/audio/engine.js';
import { swingOffset, volumeToGain } from '../src/audio/constants.js';
import { Scheduler } from '../src/audio/scheduler.js';

// offline renders with convolution reverb are slow in Node under load
vi.setConfig({ testTimeout: 30000 });

const SR = 44100;
const preset = PRESETS.afroBass.pattern;
const on = (...idx) => Array.from({ length: 16 }, (_, i) => idx.includes(i));

function stats(buffer) {
  let peak = 0, sum = 0, n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += d[i] * d[i];
      n++;
    }
  }
  const rms = Math.sqrt(sum / n);
  return { peak, rms, peakDb: 20 * Math.log10(peak), rmsDb: 20 * Math.log10(rms) };
}

/** Onsets: first sample above threshold after >= `gap` quiet samples. */
function findOnsets(data, threshold, gap) {
  const onsets = [];
  let quiet = gap;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) {
      if (quiet >= gap) onsets.push(i);
      quiet = 0;
    } else quiet++;
  }
  return onsets;
}

const render = (pattern, opts = {}) =>
  renderPatternOffline(pattern, { bars: 2, sampleRate: SR, OfflineAudioContext, ...opts });

describe('preset renders', () => {
  for (const [key, { name, pattern }] of Object.entries(PRESETS)) {
    if (key === 'empty') {
      it('empty preset is silent', async () => {
        expect(name).toBe('Empty');
        expect(Object.values(pattern.steps).flat().some(Boolean)).toBe(false);
        const s = stats(await render(pattern, { bars: 1, tail: 0.1 }));
        expect(s.peak).toBe(0);
      });
      continue;
    }
    it(`${name} is audible and does not clip`, async () => {
      const buf = await render(pattern);
      const s = stats(buf);
      expect(s.rms).toBeGreaterThan(0.02);
      expect(s.peak).toBeLessThan(1.0);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        expect(buf.getChannelData(c).every(Number.isFinite)).toBe(true);
      }
    });
  }

  it('preset tempos and swing', () => {
    expect(Object.keys(PRESETS)).toEqual(['afroBass', 'trap', 'boomBap', 'empty']);
    expect(PRESETS.afroBass.pattern.bpm).toBe(104);
    expect(PRESETS.trap.pattern.bpm).toBe(140);
    expect(PRESETS.boomBap.pattern.bpm).toBe(90);
    expect(PRESETS.boomBap.pattern.swing).toBeGreaterThanOrEqual(0.25);
    expect(PRESETS.boomBap.pattern.swing).toBeLessThanOrEqual(0.35);
    for (const { pattern } of Object.values(PRESETS)) {
      expect(pattern.version).toBe(3);
      for (const n of pattern.bassNotes) expect(BASS_NOTES.map((b) => b.midi)).toContain(n);
    }
  });
});

describe('voices', () => {
  for (const { id } of TRACKS) {
    it(`${id} is audible on its own`, async () => {
      const s = stats(await render({ steps: { [id]: on(0, 4, 8, 12) } }, { bars: 1 }));
      expect(s.rms).toBeGreaterThan(0.001);
      expect(s.peak).toBeLessThan(1.0);
    });
  }

  it('closed hat chokes a ringing open hat', async () => {
    const tailEnergy = (buf, from, to) => {
      const d = buf.getChannelData(0);
      let e = 0;
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) e += d[i] * d[i];
      return e;
    };
    const spb = 60 / 120 / 4;
    const opts = { bars: 1, masterChain: false, tail: 0.5 };
    const ringing = await render({ bpm: 120, steps: { openhat: on(0) } }, opts);
    const choked = await render({ bpm: 120, steps: { openhat: on(0), hat: on(1) } }, opts);
    // closed hat is gone by ~0.2 s, open hat alone rings to ~0.37 s
    const a = tailEnergy(ringing, spb + 0.08, 0.36);
    const b = tailEnergy(choked, spb + 0.08, 0.36);
    expect(a).toBeGreaterThan(1e-4);
    expect(b).toBeLessThan(a * 0.01);
  });
});

describe('mixer and swing', () => {
  it('swing delays odd 16ths only', async () => {
    const bpm = 100;
    const spb = 60 / bpm / 4;
    const base = { bpm, steps: { rim: on(0, 1, 2, 3, 4, 5, 6, 7) } };
    const onsets = async (swing) => {
      const buf = await render({ ...base, swing }, { bars: 1, masterChain: false, tail: 0.2 });
      return findOnsets(buf.getChannelData(0), 0.02, Math.round(0.02 * SR));
    };
    const straight = await onsets(0);
    expect(straight.length).toBe(8);
    for (const swing of [0.3, 0.6]) {
      const swung = await onsets(swing);
      expect(swung.length).toBe(8);
      const expectedMs = swing * spb * (5 / 6) * 1000;
      expect(swingOffset(1, swing, spb) * 1000).toBeCloseTo(expectedMs, 9);
      for (let i = 0; i < 8; i++) {
        const shiftMs = ((swung[i] - straight[i]) / SR) * 1000;
        const want = i % 2 ? expectedMs : 0;
        expect(Math.abs(shiftMs - want)).toBeLessThan(0.5);
      }
    }
  });

  it('mute silences a track', async () => {
    const p = structuredClone(preset);
    p.mixer.kick.mute = true;
    const s = stats(await render(p, { tracks: ['kick'] }));
    expect(s.peak).toBe(0);
  });

  it('solo isolates tracks', async () => {
    const p = structuredClone(preset);
    p.mixer.snare.solo = true;
    p.mixer.bass.solo = true;
    const soloed = await render(p, { masterChain: false });
    const only = await render(p, { masterChain: false, tracks: ['snare', 'bass'] });
    const a = soloed.getChannelData(0);
    const b = only.getChannelData(0);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    expect(stats(soloed).rms).toBeGreaterThan(0.01);
    expect(maxDiff).toBeLessThan(1e-6);

    // mute wins over solo
    p.mixer.snare.mute = true;
    p.mixer.bass.mute = true;
    expect(stats(await render(p, { masterChain: false })).peak).toBe(0);
  });

  it('volume curve', async () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(0.8)).toBeCloseTo(1, 9);
    expect(volumeToGain(0.4)).toBeCloseTo(0.25, 9);
    const loud = { steps: { snare: on(0) }, mixer: { snare: { volume: 0.8 } } };
    const soft = { steps: { snare: on(0) }, mixer: { snare: { volume: 0.4 } } };
    const opts = { bars: 1, masterChain: false };
    const ratio = stats(await render(soft, opts)).peak / stats(await render(loud, opts)).peak;
    expect(ratio).toBeCloseTo(0.25, 3);
  });

  it('kick lands on the swung grid', async () => {
    const spb = 60 / preset.bpm / 4;
    const expected = [];
    for (let bar = 0; bar < 2; bar++) {
      preset.steps.kick.forEach((hit, i) => {
        if (hit) expected.push(Math.round(((bar * 16 + i) * spb + swingOffset(i, preset.swing, spb)) * SR));
      });
    }
    const onsetErrorsMs = async (masterChain) => {
      const buf = await render(preset, { tracks: ['kick'], masterChain });
      const onsets = findOnsets(buf.getChannelData(0), 0.02, Math.round(0.05 * SR));
      expect(onsets.length).toBe(expected.length);
      return onsets.map((o, i) => ((o - expected[i]) / SR) * 1000);
    };
    const dry = await onsetErrorsMs(false);
    for (const e of dry) expect(Math.abs(e)).toBeLessThan(2);

    // the compressors add a fixed delay
    const wet = await onsetErrorsMs(true);
    const latency = wet[0];
    const jitter = Math.max(...wet.map((e) => Math.abs(e - latency)));
    expect(latency).toBeGreaterThanOrEqual(-2);
    expect(latency).toBeLessThan(30);
    expect(jitter).toBeLessThan(2);
  });

  it('renders an old 4-track pattern', async () => {
    const legacy = {
      bpm: 104,
      steps: { kick: on(0, 8), snare: on(4, 12), hat: on(0, 2, 4, 6), bass: on(0) },
      bassNotes: new Array(16).fill(36),
    };
    const s = stats(await render(legacy, { bars: 1 }));
    expect(s.rms).toBeGreaterThan(0.01);
    expect(s.peak).toBeLessThan(1);
  });
});

describe('engine', () => {
  it('constants and track order', () => {
    expect(STEPS).toBe(16);
    expect(MIN_BPM).toBe(60);
    expect(MAX_BPM).toBe(180);
    expect(TRACKS.map((t) => t.id)).toEqual(['kick', 'snare', 'clap', 'hat', 'openhat', 'rim', 'shaker', 'bass']);
    expect(TRACKS.map((t) => t.name)).toEqual(['Kick', 'Snare', 'Clap', 'Closed hat', 'Open hat', 'Rim', 'Shaker', '808 bass']);
    expect(BASS_NOTES[0]).toEqual({ midi: 33, name: 'A1' });
    expect(BASS_NOTES.slice(0, 3).map((n) => n.name)).toEqual(['A1', 'B1', 'C2']);
    expect(BASS_NOTES.at(-1).midi - 33).toBeGreaterThanOrEqual(18);
  });

  it('editing, controls and events', () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const engine = createEngine({ context: ctx });
    expect(engine.context).toBe(ctx);
    expect(engine.master).toBeTruthy();
    expect(engine.output).toBeTruthy();
    expect(engine.getCurrentStep()).toBe(-1);

    const states = [];
    const patterns = [];
    const offState = engine.onStateChange((s) => states.push(s));
    const offPattern = engine.onPatternChange((p) => patterns.push(p));

    engine.setPattern(PRESETS.boomBap.pattern);
    expect(engine.clock.bpm).toBe(90);
    expect(engine.clock.secondsPerStep).toBeCloseTo(60 / 90 / 4, 9);
    expect(patterns.length).toBe(1);
    expect(patterns[0]).toEqual(PRESETS.boomBap.pattern);
    expect(states.at(-1)).toEqual({ isPlaying: false, bpm: 90 });
    expect(engine.master.gain.value).toBeCloseTo(0.7, 3);

    const p = engine.getPattern();
    p.steps.kick[1] = true;
    p.mixer.kick.volume = 0;
    expect(engine.getPattern().steps.kick[1]).toBe(false);
    expect(engine.getPattern().mixer.kick.volume).toBe(PRESETS.boomBap.pattern.mixer.kick.volume);

    expect(engine.toggleStep('clap', 1)).toBe(true);
    expect(engine.toggleStep('clap', 1)).toBe(false);
    expect(() => engine.toggleStep('nope', 0)).toThrow();
    expect(() => engine.toggleStep('kick', 16)).toThrow();

    expect(engine.setBassNote(3, 45)).toBe(45);
    expect(engine.getPattern().bassNotes[3]).toBe(45);
    expect(() => engine.setBassNote(3, 34)).toThrow(); // A#1 not in A minor
    expect(() => engine.setBassNote(3, 60)).toThrow();
    expect(() => engine.trigger('bass', { midi: 34 })).toThrow();

    expect(engine.setBpm(500)).toBe(180);
    expect(engine.setBpm(10)).toBe(60);
    expect(engine.setBpm(99.6)).toBe(100);
    expect(engine.setBpm('abc')).toBe(100);

    expect(engine.setSwing(2)).toBe(0.6);
    expect(engine.setSwing(-1)).toBe(0);
    expect(engine.setSwing(0.25)).toBe(0.25);
    expect(engine.clock.swing).toBe(0.25);

    expect(engine.setTrackVolume('hat', 1.5)).toBe(1);
    expect(engine.setTrackVolume('hat', -3)).toBe(0);
    expect(engine.setMute('rim', 1)).toBe(true);
    expect(engine.setSolo('shaker', true)).toBe(true);
    expect(engine.setMasterVolume(2)).toBe(1);
    expect(() => engine.setMute('nope', true)).toThrow();

    const last = patterns.at(-1);
    expect(last.bpm).toBe(100);
    expect(last.swing).toBe(0.25);
    expect(last.master).toBe(1);
    expect(last.mixer.hat.volume).toBe(0);
    expect(last.mixer.rim.mute).toBe(true);
    expect(last.mixer.shaker.solo).toBe(true);
    expect(last.bassNotes[3]).toBe(45);
    expect(last).toEqual(engine.getPattern());

    // no event when nothing changes
    const n = patterns.length;
    engine.setSwing(0.25);
    engine.setMute('rim', true);
    engine.setBpm(100);
    expect(patterns.length).toBe(n);

    offState();
    offPattern();
    engine.setBpm(120);
    engine.toggleStep('kick', 2);
    expect(states.at(-1).bpm).toBe(100);
    expect(patterns.length).toBe(n);
  });

  it('setPattern upgrades an old 4-track pattern', () => {
    const engine = createEngine({ context: new OfflineAudioContext(2, SR, SR) });
    engine.setPattern({ bpm: 95, steps: { kick: on(0), snare: on(4), hat: on(2), bass: on(0) }, bassNotes: new Array(16).fill(38) });
    const p = engine.getPattern();
    expect(p.version).toBe(3);
    expect(p.bpm).toBe(95);
    expect(p.steps.clap).toEqual(new Array(16).fill(false));
    expect(p.bassNotes[0]).toBe(38);
    expect(p.mixer.kick).toEqual({ volume: 0.8, mute: false, solo: false });
  });
});

describe('scheduler swing', () => {
  it('swung steps play late and the playhead follows', () => {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 };
    const spb = 0.1;
    const swing = 0.6; // odd steps +0.05 s
    const events = [];
    const s = new Scheduler({
      getContext: () => ctx,
      getSecondsPerStep: () => spb,
      getStepOffset: (step, d) => swingOffset(step, swing, d),
      onStep: (step, time) => events.push({ step, time }),
    });
    s.start(0);
    const advanceTo = (t) => {
      while (ctx.currentTime < t - 1e-9) { ctx.currentTime += 0.005; vi.advanceTimersByTime(5); }
    };
    advanceTo(0.5);
    expect(events[0]).toEqual({ step: 0, time: 0 });
    expect(events[1].step).toBe(1);
    expect(events[1].time).toBeCloseTo(0.15, 9);
    expect(events[2].time).toBeCloseTo(0.2, 9);
    s.stop(); events.length = 0; ctx.currentTime = 0; s.start(0);
    advanceTo(0.12);
    expect(s.getCurrentStep()).toBe(0);
    advanceTo(0.16);
    expect(s.getCurrentStep()).toBe(1);
    advanceTo(0.21);
    expect(s.getCurrentStep()).toBe(2);
    s.stop();
    vi.useRealTimers();
  });
});

describe('look-ahead scheduler', () => {
  it('schedules ahead on the audio clock', async () => {
    const { vi } = await import('vitest');
    const { Scheduler } = await import('../src/audio/scheduler.js');
    vi.useFakeTimers();
    const ctx = { currentTime: 0 };
    let spb = 0.1;
    const events = [];
    const s = new Scheduler({
      getContext: () => ctx,
      getSecondsPerStep: () => spb,
      onStep: (step, time) => events.push({ step, time }),
    });
    s.start(0.05);
    const advance = (sec) => {
      for (let t = 0; t < sec; t += 0.025) { ctx.currentTime += 0.025; vi.advanceTimersByTime(25); }
    };
    advance(0.5);
    expect(events.at(-1).time).toBeLessThan(ctx.currentTime + 0.1 + 1e-9);
    expect(events[0]).toEqual({ step: 0, time: 0.05 });
    expect(s.getCurrentStep()).toBe(4); // 0.05 + 4*0.1 = 0.45 <= 0.5 < 0.55
    spb = 0.05;
    advance(0.5);
    for (let i = 1; i < events.length; i++) {
      const d = events[i].time - events[i - 1].time;
      expect(d === 0.1 || d === 0.05 || Math.abs(d - 0.1) < 1e-9 || Math.abs(d - 0.05) < 1e-9).toBe(true);
      expect(events[i].step).toBe((events[i - 1].step + 1) % 16);
    }
    s.stop();
    expect(s.getCurrentStep()).toBe(-1);
    vi.useRealTimers();
  });
});

/**
 * OfflineAudioContext with controllable state/currentTime and a log of every
 * source's start/stop calls, so the realtime engine can be driven in node.
 */
function instrumentedContext(initialState = 'running') {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const ctl = { state: initialState, now: 0, resumeCalls: 0, sources: [] };
  Object.defineProperty(ctx, 'state', { configurable: true, get: () => ctl.state });
  Object.defineProperty(ctx, 'currentTime', { configurable: true, get: () => ctl.now });
  ctx.resume = async () => { ctl.resumeCalls++; ctl.state = 'running'; };
  for (const factory of ['createOscillator', 'createBufferSource']) {
    const orig = ctx[factory].bind(ctx);
    ctx[factory] = () => {
      const node = orig();
      const rec = { kind: factory, start: null, stops: [] };
      ctl.sources.push(rec);
      const start = node.start.bind(node);
      const stop = node.stop.bind(node);
      node.start = (t = 0) => { rec.start = t; return start(t); };
      node.stop = (t = 0) => { rec.stops.push(t); return stop(t); };
      return node;
    };
  }
  // drop the overrides so the context can render
  ctl.release = () => {
    delete ctx.state; delete ctx.currentTime; delete ctx.resume;
  };
  return { ctx, ctl };
}

const lastStop = (rec) => rec.stops.at(-1);

describe('transport', () => {
  it('stop cancels pending voices', async () => {
    const { ctx, ctl } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    engine.setPattern(preset);
    await engine.start(); // step 0 at 0.06
    expect(ctl.sources.some((s) => s.start > 0.02)).toBe(true);
    ctl.now = 0.02;
    engine.stop();
    for (const s of ctl.sources) {
      if (s.start > 0.02) expect(lastStop(s)).toBeLessThanOrEqual(0.02);
    }
    ctl.release();
    const s = stats(await ctx.startRendering());
    expect(s.peak).toBeLessThan(1e-4);
  });

  it('stop fades a ringing 808', async () => {
    const { ctx, ctl } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    engine.setPattern(preset);
    await engine.start();
    ctl.now = 0.08; // step 0 (kick + hat + 808 at 0.06) is now sounding
    engine.stop();
    for (const s of ctl.sources) {
      expect(lastStop(s)).toBeLessThan(0.08 + 0.6);
    }
    const bassLike = ctl.sources.filter((s) => s.kind === 'createOscillator' && s.stops.length > 1);
    expect(bassLike.length).toBe(1);
    expect(lastStop(bassLike[0])).toBeLessThanOrEqual(0.08 + 0.015);
  });

  it('audition does not choke the sequenced 808', async () => {
    const { ctx, ctl } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    engine.setPattern(preset);
    await engine.start();
    const seqBass = ctl.sources.filter((s) => s.kind === 'createOscillator' && s.start === 0.06);
    const before = Math.max(...seqBass.map(lastStop));
    expect(before).toBeGreaterThan(1.0);
    engine.trigger('bass');
    engine.trigger('bass');
    expect(Math.max(...seqBass.map(lastStop))).toBe(before);
    const auditions = ctl.sources.filter((s) => s.kind === 'createOscillator' && s.start === 0.005);
    expect(auditions.length).toBe(2);
    expect(lastStop(auditions[0])).toBeLessThan(0.05);
    engine.stop();
  });

  for (const state of ['suspended', 'interrupted']) {
    it(`start() resumes a context in state '${state}'`, async () => {
      const { ctx, ctl } = instrumentedContext(state);
      const engine = createEngine({ context: ctx });
      await engine.start();
      expect(ctl.resumeCalls).toBe(1);
      expect(engine.isPlaying).toBe(true);
      engine.stop();
      await engine.resume();
      expect(ctl.resumeCalls).toBe(1);
    });
  }
});

describe('headroom, timing, slides', () => {
  it('no clipping with every fader at max', async () => {
    for (const { name, pattern } of Object.values(PRESETS)) {
      if (name === 'Empty') continue;
      const hot = structuredClone(pattern);
      hot.master = 1;
      for (const ch of Object.values(hot.mixer)) ch.volume = 1;
      const s = stats(await render(hot));
      expect(s.peak).toBeLessThan(1.0);
    }
    const steps = {};
    const mixer = {};
    for (const { id } of TRACKS) { steps[id] = new Array(16).fill(true); mixer[id] = { volume: 1 }; }
    const s = stats(await render({ bpm: 180, master: 1, steps, mixer }));
    expect(s.peak).toBeLessThan(1.0);
  }, 30000);

  it('every voice lands on the grid', async () => {
    const bpm = 120;
    const spb = 60 / bpm / 4;
    for (const { id } of TRACKS) {
      const steps = id === 'bass' ? [0, 8] : [0, 4, 8, 12];
      const expected = [];
      for (let bar = 0; bar < 2; bar++) for (const i of steps) expected.push(Math.round((bar * 16 + i) * spb * SR));
      const errorsMs = async (masterChain) => {
        const buf = await render({ bpm, steps: { [id]: on(...steps) } }, { masterChain });
        const d = buf.getChannelData(0);
        const thr = 0.1 * stats(buf).peak;
        const onsets = findOnsets(d, thr, Math.round(0.05 * SR));
        expect(onsets.length, id).toBe(expected.length);
        return onsets.map((o, i) => ((o - expected[i]) / SR) * 1000);
      };
      const dry = await errorsMs(false);
      for (const e of dry) {
        expect(e, id).toBeGreaterThanOrEqual(-0.1);
        expect(e, id).toBeLessThan(2);
      }
      const wet = await errorsMs(true);
      const latency = Math.min(...wet);
      const jitter = Math.max(...wet) - latency;
      expect(latency, id).toBeLessThan(30);
      expect(jitter, id).toBeLessThan(2);
    }
  });

  it('engine swings odd steps', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, ctl } = instrumentedContext();
      const engine = createEngine({ context: ctx });
      engine.setPattern({ bpm: 120, swing: 0.36, steps: { rim: new Array(16).fill(true) } });
      await engine.start();
      for (let t = 0; t < 1.2; t += 0.025) { ctl.now += 0.025; vi.advanceTimersByTime(25); }
      engine.stop();
      const spb = 60 / 120 / 4;
      const off = 0.36 * spb * (5 / 6);
      const starts = [...new Set(ctl.sources.filter((s) => s.kind === 'createOscillator').map((s) => s.start))]
        .sort((a, b) => a - b);
      expect(starts.length).toBeGreaterThanOrEqual(8);
      starts.forEach((t, i) => {
        const want = 0.06 + i * spb + (i % 2 ? off : 0);
        expect(Math.abs(t - want)).toBeLessThan(1e-9);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('808 slide is legato', async () => {
    let oscillators = 0;
    class Counting extends OfflineAudioContext {
      createOscillator() { oscillators++; return super.createOscillator(); }
    }
    const notes = new Array(16).fill(33);
    notes[1] = 40; // E2
    const buf = await render(
      { bpm: 120, steps: { bass: on(0, 1) }, bassNotes: notes },
      { bars: 1, masterChain: false, tail: 0.5, OfflineAudioContext: Counting },
    );
    expect(oscillators).toBe(1);
    const d = buf.getChannelData(0);
    const rmsAt = (t0, t1) => {
      let s = 0; const a = Math.round(t0 * SR), b = Math.round(t1 * SR);
      for (let i = a; i < b; i++) s += d[i] * d[i];
      return Math.sqrt(s / (b - a));
    };
    const before = rmsAt(0.1, 0.125);
    for (let t = 0.12; t < 0.2; t += 0.004) {
      expect(rmsAt(t, t + 0.0182)).toBeGreaterThan(before * 0.6);
    }
    const a = Math.round(0.3 * SR), b = Math.round(0.5 * SR);
    let crossings = 0;
    for (let i = a + 1; i < b; i++) if (d[i - 1] < 0 && d[i] >= 0) crossings++;
    const hz = crossings / 0.2;
    expect(Math.abs(hz - 82.41) / 82.41).toBeLessThan(0.08);
  });

  it('ticks from a Worker when available', async () => {
    const { createTicker } = await import('../src/audio/ticker.js');
    expect(createTicker(25, () => {}).kind).toBe('timeout');

    class FakeWorker {
      constructor(url) { this.url = url; this.id = null; FakeWorker.last = this; }
      postMessage({ cmd, interval }) {
        clearInterval(this.id);
        if (cmd === 'start') this.id = setInterval(() => this.onmessage?.({ data: 'tick' }), interval);
      }
      terminate() { clearInterval(this.id); }
    }
    const saved = globalThis.Worker;
    globalThis.Worker = FakeWorker;
    vi.useFakeTimers();
    try {
      const ctx = { currentTime: 0 };
      let ticks = 0;
      const s = new Scheduler({ getContext: () => ctx, getSecondsPerStep: () => 0.1, onStep: () => { ticks++; } });
      s.start(0);
      expect(s.tickerKind).toBe('worker');
      expect(FakeWorker.last.url).toMatch(/^blob:/);
      for (let i = 0; i < 20; i++) { ctx.currentTime += 0.025; vi.advanceTimersByTime(25); }
      expect(ticks).toBeGreaterThanOrEqual(5);
      s.stop();
      const n = ticks;
      ctx.currentTime += 1; vi.advanceTimersByTime(1000);
      expect(ticks).toBe(n);
    } finally {
      vi.useRealTimers();
      globalThis.Worker = saved;
    }
  });
});

describe('aligned start', () => {
  const ticks = () => new Promise((r) => setTimeout(r, 80));

  it('start({ at }) puts step 0 exactly there', async () => {
    const { ctx, ctl } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    engine.setPattern({ ...preset, bpm: 120 });
    const p = engine.start({ at: 0.5 });
    expect(engine.start()).toBe(p); // a start in progress is shared
    await p;
    expect(engine.getNextBarTime(0)).toBe(0.5);
    ctl.now = 0.45;
    await ticks();
    const starts = ctl.sources.map((s) => s.start).filter((t) => t !== null);
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.min(...starts)).toBe(0.5);
    expect(Math.round(0.5 * SR)).toBe(22050);
    expect(engine.getNextBarTime(0.6)).toBeCloseTo(2.5, 9);
    engine.stop();
  });

  it('setEndTime stops scheduling at the end of the take', async () => {
    const { ctx, ctl } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    engine.setPattern({ ...preset, bpm: 120 });
    await engine.start({ at: 0.1 });
    engine.setEndTime(2.1); // one bar
    for (const now of [0.5, 1, 1.5, 2, 2.5, 3]) { ctl.now = now; await ticks(); }
    const starts = ctl.sources.map((s) => s.start).filter((t) => t !== null);
    expect(Math.max(...starts)).toBeLessThan(2.1);
    expect(Math.max(...starts)).toBeGreaterThan(1.5);
    engine.stop();
  });

  it('tempo override leaves the pattern alone', async () => {
    const { ctx } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    engine.setPattern({ ...preset, bpm: 90 });
    const changes = vi.fn();
    engine.onPatternChange(changes);
    engine.setTempoOverride(120);
    await engine.start({ at: 0.2 });
    expect(engine.getNextBarTime(0.3)).toBeCloseTo(2.2, 9);
    expect(engine.clock.bpm).toBe(90);
    expect(engine.getPattern().bpm).toBe(90);
    engine.setTempoOverride(null);
    expect(engine.clock.secondsPerStep).toBeCloseTo(60 / 90 / 4, 9);
    expect(changes).not.toHaveBeenCalled();
    engine.stop();
  });
});
