import { describe, it, expect, vi } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { renderPatternOffline } from '../src/audio/offline.js';
import { renderBeat } from '../src/audio/export.js';
import {
  createEngine, VOICES, VOICE_IDS, TRACKS, MAX_TRACKS,
} from '../src/audio/engine.js';
import { normalizePattern, emptyPattern, defaultStep } from '../src/audio/pattern.js';
import { secondsPerStep } from '../src/audio/constants.js';
import { snapToAnchors } from '../src/audio/scheduler.js';
import { gridSteps } from '../src/audio/remix.js';
import { playSample } from '../src/audio/samplevoice.js';
import {
  humanize, randomizeTrack, makeFill, clearTrack,
} from '../src/audio/groove.js';
import V3 from './fixtures/v3-presets.json';
import V3_RENDERS from './fixtures/v3-renders.json';

vi.setConfig({ testTimeout: 30000 });

const SR = 44100;
const DRY = { masterChain: false, OfflineAudioContext, sampleRate: SR };

function peakOf(buf, from = 0, to = buf.length) {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = from; i < to; i++) p = Math.max(p, Math.abs(d[i]));
  }
  return p;
}

function onsets(buf, threshold = 0.02, gapSeconds = 0.012) {
  const d = buf.getChannelData(0);
  const gap = Math.round(gapSeconds * SR);
  const out = [];
  let quiet = gap;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > threshold) {
      if (quiet >= gap) out.push(i);
      quiet = 0;
    } else quiet++;
  }
  return out;
}

/** A one-track v4 pattern; `steps` maps index -> partial step. */
function pattern(id, steps, { bpm = 120, length = 16, mixer = {}, swing = 0 } = {}) {
  const p = normalizePattern({ ...emptyPattern(bpm), tracks: [id] });
  p.swing = swing;
  p.sections.A = { length, steps: { [id]: new Array(length).fill(null) } };
  for (const [i, s] of Object.entries(steps)) p.sections.A.steps[id][i] = { ...defaultStep(id, +i), ...s };
  Object.assign(p.mixer[id], mixer);
  p.fx.sends[id] = { reverb: 0, echo: 0 };
  return normalizePattern(p);
}

const render = (p, opts = {}) => renderPatternOffline(p, { ...DRY, bars: 1, tail: 0.3, ...opts });

describe('v3 patterns sound the same in v4', () => {
  for (const key of ['afroBass', 'trap', 'boomBap']) {
    it(`${key}`, async () => {
      const ref = V3_RENDERS[key];
      const buf = await renderPatternOffline(normalizePattern(V3[key]), {
        bars: 2, sampleRate: SR, OfflineAudioContext,
      });
      expect(buf.length).toBe(ref.length);
      let worst = 0;
      for (let c = 0; c < ref.rms.length; c++) {
        const d = buf.getChannelData(c);
        ref.rms[c].forEach((want, w) => {
          const from = w * ref.window;
          const to = Math.min(d.length, from + ref.window);
          let e = 0;
          for (let i = from; i < to; i++) e += d[i] * d[i];
          const got = Math.sqrt(e / (to - from));
          worst = Math.max(worst, Math.abs(got - want) / Math.max(want, 1e-3));
        });
      }
      expect(worst).toBeLessThan(1e-3);
    });
  }
});

describe('step features', () => {
  it('velocity scales the level', async () => {
    const loud = peakOf(await render(pattern('rim', { 0: { v: 0.8 } })));
    const soft = peakOf(await render(pattern('rim', { 0: { v: 0.4 } })));
    // the envelopes end at a fixed floor, so not exactly linear
    expect(soft / loud).toBeCloseTo(0.5, 1);
  });

  it('rolls are evenly spaced inside the step and get a little softer', async () => {
    const bpm = 60;
    const spb = secondsPerStep(bpm);
    for (const r of [2, 3, 4]) {
      const buf = await render(pattern('rim', { 4: { r } }, { bpm }));
      const hits = onsets(buf, 0.01);
      expect(hits.length).toBe(r);
      hits.forEach((at, k) => {
        expect(Math.abs(at / SR - (4 * spb + (k * spb) / r))).toBeLessThan(0.0015);
      });
      const peaks = hits.map((at) => peakOf(buf, at, at + Math.round(0.03 * SR)));
      for (let k = 1; k < r; k++) {
        expect(peaks[k]).toBeLessThan(peaks[k - 1]);
        expect(peaks[k]).toBeGreaterThan(peaks[k - 1] * 0.8);
      }
    }
  });

  it('chance is repeatable for the same pattern and varies between passes', async () => {
    const steps = {};
    for (let i = 0; i < 16; i += 2) steps[i] = { c: 0.5 };
    const p = pattern('rim', steps, { bpm: 120 });
    const a = await render(p, { bars: 4 });
    const b = await render(p, { bars: 4 });
    const da = a.getChannelData(0);
    const db = b.getChannelData(0);
    for (let i = 0; i < da.length; i += 7) if (da[i] !== db[i]) throw new Error(`differs at ${i}`);

    const spb = secondsPerStep(120);
    const bars = [0, 1, 2, 3].map((bar) => onsets(a, 0.01)
      .filter((at) => at / SR >= bar * 16 * spb - 0.002 && at / SR < (bar + 1) * 16 * spb - 0.002)
      .map((at) => Math.round(at / SR / spb) % 16));
    const total = bars.flat().length;
    expect(total).toBeGreaterThan(8);
    expect(total).toBeLessThan(26);
    expect(new Set(bars.map((x) => x.join())).size).toBeGreaterThan(1);

    const always = await render(pattern('rim', { 0: { c: 1 } }), { bars: 4 });
    expect(onsets(always, 0.01).length).toBe(4);
    const never = await render(pattern('rim', { 0: { c: 0 } }), { bars: 4 });
    expect(peakOf(never)).toBe(0);
  });

  it('a flam is a softer hit about 20 ms before the main one', async () => {
    const spb = secondsPerStep(120);
    const at = (t) => Math.round(t * SR);
    const flam = await render(pattern('rim', { 4: { f: true } }));
    const plain = await render(pattern('rim', { 4: {} }));
    const first = onsets(flam, 0.01)[0];
    expect(Math.abs(first / SR - (4 * spb - 0.02))).toBeLessThan(0.0015);
    expect(peakOf(plain, 0, at(4 * spb - 0.001))).toBe(0);
    const grace = peakOf(flam, first, at(4 * spb - 0.001));
    const main = peakOf(plain, at(4 * spb), at(4 * spb + 0.03));
    expect(grace).toBeGreaterThan(main * 0.3);
    expect(grace).toBeLessThan(main * 0.8);
  });

  it('pitch moves a drum up and down', async () => {
    const hz = async (p) => {
      const buf = await render(pattern('conga', { 0: { p } }), { tail: 0.2 });
      const d = buf.getChannelData(0);
      let crossings = 0;
      const a = Math.round(0.03 * SR), b = Math.round(0.13 * SR);
      for (let i = a + 1; i < b; i++) if (d[i - 1] < 0 && d[i] >= 0) crossings++;
      return crossings / 0.1;
    };
    const base = await hz(0);
    expect((await hz(12)) / base).toBeCloseTo(2, 1);
    expect((await hz(-12)) / base).toBeCloseTo(0.5, 1);
  });

  it('nudge and per-track swing move one track only', async () => {
    const bpm = 100;
    const spb = secondsPerStep(bpm);
    const at = async (mixer, step = 4, swing = 0) => {
      const hits = onsets(await render(pattern('rim', { [step]: {} }, { bpm, mixer, swing })), 0.01);
      expect(hits.length).toBe(1);
      return hits[0] / SR;
    };
    const plain = await at({});
    expect(Math.abs(plain - 4 * spb)).toBeLessThan(0.0015);
    expect((await at({ nudge: -0.25 })) - plain).toBeCloseTo(-0.25 * spb, 3);
    expect((await at({ nudge: 0.5 })) - plain).toBeCloseTo(0.5 * spb, 3);
    // odd step: pattern swing 0.6, track override 0 plays straight
    const swung = await at({}, 5, 0.6);
    const straight = await at({ swing: 0 }, 5, 0.6);
    expect(straight).toBeCloseTo(5 * spb, 3);
    expect(swung - straight).toBeCloseTo(0.6 * spb * (5 / 6), 3);
    // the first step of a render can't go before the start
    expect(await at({ nudge: -0.5 }, 0)).toBeLessThan(0.0015);
  });

  it('32 steps and a chain play in order', async () => {
    const bpm = 120;
    const spb = secondsPerStep(bpm);
    const p = pattern('rim', { 20: {} }, { bpm, length: 32 });
    p.sections.B = { length: 16, steps: { rim: new Array(16).fill(null) } };
    p.sections.B.steps.rim[4] = defaultStep('rim');
    p.chain = ['A', 'B'];
    // the loop is 48 steps = 3 bars; 6 bars play it twice
    const buf = await render(normalizePattern(p), { bars: 6 });
    expect(buf.length).toBe(Math.round((6 * 16 * spb + 0.3) * SR));
    const want = [20, 36, 68, 84].map((s) => s * spb);
    const got = onsets(buf, 0.01).map((i) => i / SR);
    expect(got.length).toBe(4);
    got.forEach((t, k) => expect(Math.abs(t - want[k])).toBeLessThan(0.0015));
  });

  it('808 slides and the closed hat still chokes the open hat', async () => {
    let oscillators = 0;
    class Counting extends OfflineAudioContext {
      createOscillator() { oscillators++; return super.createOscillator(); }
    }
    await render(pattern('bass', { 0: { p: 33 }, 1: { p: 40 } }), { OfflineAudioContext: Counting });
    expect(oscillators).toBe(1);

    const p = normalizePattern({ ...emptyPattern(120), tracks: ['openhat', 'hat'] });
    p.sections.A.steps.openhat[0] = defaultStep('openhat');
    p.sections.A.steps.hat[1] = defaultStep('hat', 1);
    const choked = await render(p, { tail: 0.5 });
    p.sections.A.steps.hat[1] = null;
    const ringing = await render(p, { tail: 0.5 });
    const tail = (buf) => peakOf(buf, Math.round(0.25 * SR), Math.round(0.35 * SR));
    expect(tail(ringing)).toBeGreaterThan(0.01);
    expect(tail(choked)).toBeLessThan(tail(ringing) * 0.05);
  });
});

describe('new voices', () => {
  const extra = VOICES.filter((v) => !TRACKS.some((t) => t.id === v.id));

  it('8 new voices', () => {
    expect(extra.map((v) => v.id)).toEqual(['tomlo', 'tomhi', 'crash', 'ride', 'cowbell', 'conga', 'snap', 'logdrum']);
  });

  for (const { id } of extra) {
    it(`${id} is audible, below 0 dBFS and follows velocity`, async () => {
      const full = await render(pattern(id, { 0: { v: 1 }, 4: { v: 1 }, 8: { v: 1 } }), { tail: 1.8 });
      const pk = peakOf(full);
      expect(pk).toBeGreaterThan(0.05);
      expect(pk).toBeLessThan(1);
      expect(full.getChannelData(0).every(Number.isFinite)).toBe(true);
      const soft = peakOf(await render(pattern(id, { 0: { v: 0.4 } }), { tail: 1.8 }));
      // the log drum saturates, so it is not linear
      expect(soft).toBeLessThan(pk * (id === 'logdrum' ? 0.9 : 0.6));
    });
  }

  it('the log drum is short and pitched', async () => {
    const buf = await render(pattern('logdrum', { 0: { p: 33 } }), { tail: 1 });
    expect(peakOf(buf, Math.round(0.6 * SR))).toBeLessThan(0.001);
    const d = buf.getChannelData(0);
    let crossings = 0;
    const a = Math.round(0.04 * SR), b = Math.round(0.24 * SR);
    for (let i = a + 1; i < b; i++) if (d[i - 1] < 0 && d[i] >= 0) crossings++;
    // A1 played an octave up: 110 Hz
    expect(Math.abs(crossings / 0.2 - 110) / 110).toBeLessThan(0.1);
  });
});

function testSample(seconds = 0.2) {
  const ctx = new OfflineAudioContext(1, 1, SR);
  const buffer = ctx.createBuffer(1, Math.round(seconds * SR), SR);
  const d = buffer.getChannelData(0);
  // loud at the start, fading out: easy to tell forwards from reversed
  for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) * (1 - i / d.length);
  return buffer;
}

describe('sample voices', () => {
  const def = (o = {}) => ({
    buffer: testSample(), start: 0, end: 0.2, gain: 1, pitch: 0, reverse: false, fadeIn: 0, fadeOut: 0, ...o,
  });
  const smp = (o = {}) => {
    const p = pattern('smp-test', { 0: {} });
    return [p, { 'smp-test': def(o) }];
  };

  it('play in renderBeat, silent without a definition', async () => {
    const [p, samples] = smp();
    const buf = await renderBeat(p, { bars: 1, tail: 0.2, samples, sampleRate: SR, OfflineAudioContext });
    expect(peakOf(buf)).toBeGreaterThan(0.1);
    const none = await renderBeat(p, { bars: 1, tail: 0.2, samples: {}, sampleRate: SR, OfflineAudioContext });
    expect(peakOf(none)).toBe(0);
  });

  it('renderBeat uses the engine sample map by default', async () => {
    const [p, samples] = smp();
    const engine = createEngine({ context: new OfflineAudioContext(2, SR, SR) });
    engine.setSampleVoices(samples);
    expect(engine.sampleVoices['smp-test']).toBeTruthy();
    const buf = await renderBeat(p, { bars: 1, tail: 0.2, sampleRate: SR, OfflineAudioContext });
    expect(peakOf(buf)).toBeGreaterThan(0.1);
    engine.setSampleVoices({});
  });

  it('region, reverse, pitch and gain', async () => {
    const early = (buf) => peakOf(buf, 0, Math.round(0.03 * SR));
    const late = (buf) => peakOf(buf, Math.round(0.15 * SR), Math.round(0.19 * SR));
    const [p, fwd] = smp();
    const a = await render(p, { samples: fwd });
    expect(early(a)).toBeGreaterThan(late(a) * 3);
    const b = await render(p, { samples: smp({ reverse: true })[1] });
    expect(late(b)).toBeGreaterThan(early(b) * 3);

    // an octave up plays the region in half the time
    const lastSound = (buf) => {
      const d = buf.getChannelData(0);
      for (let i = d.length - 1; i >= 0; i--) if (Math.abs(d[i]) > 1e-4) return i / SR;
      return 0;
    };
    expect(lastSound(a)).toBeCloseTo(0.2, 1);
    const up = await render(p, { samples: smp({ pitch: 12 })[1] });
    expect(lastSound(up)).toBeCloseTo(0.1, 1);
    const region = await render(p, { samples: smp({ start: 0.05, end: 0.1 })[1] });
    expect(lastSound(region)).toBeCloseTo(0.05, 1);

    const half = await render(p, { samples: smp({ gain: 0.5 })[1] });
    expect(peakOf(half) / peakOf(a)).toBeCloseTo(0.5, 2);
  });

  it('playSample ignores an empty region', () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    expect(playSample(ctx, ctx.destination, 0, def({ start: 0.1, end: 0.1 }))).toBe(null);
    expect(playSample(ctx, ctx.destination, 0, null)).toBe(null);
  });
});

describe('bars across the chain', () => {
  it('snapToAnchors lands on the nearest bar line of the loop', () => {
    const grid = { nextTime: 1.98, nextStep: 31 };
    snapToAnchors(grid, [{ at: 2 }], 0.125, 48);
    expect(grid).toEqual({ nextTime: 2, nextStep: 32 });
    const g2 = { nextTime: 0.99, nextStep: 47 };
    snapToAnchors(g2, [{ at: 1 }], 0.125, 48);
    expect(g2.nextStep).toBe(0);
  });

  it('gridSteps counts the whole loop', () => {
    const steps = gridSteps(0, 0.125, [], 8, 32);
    expect(steps.length).toBe(64);
    expect(steps[20].step).toBe(20);
    expect(steps[32]).toMatchObject({ step: 0, pass: 1 });
  });

  it('getNextBarTime counts 16-step bars inside a 32-step section', async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    Object.defineProperty(ctx, 'currentTime', { configurable: true, get: () => 0 });
    Object.defineProperty(ctx, 'state', { configurable: true, get: () => 'running' });
    const engine = createEngine({ context: ctx });
    engine.setPattern({ ...emptyPattern(120) });
    engine.setSectionLength('A', 32);
    await engine.start({ at: 0.5 });
    expect(engine.getNextBarTime(0)).toBe(0.5);
    expect(engine.getNextBarTime(0.6)).toBeCloseTo(2.5, 9);
    expect(engine.getNextBarTime(2.6)).toBeCloseTo(4.5, 9);
    engine.stop();
  });

  it('renderBeat bars are 16 steps whatever the chain', async () => {
    const p = pattern('rim', { 0: {} }, { length: 32 });
    const buf = await renderBeat(p, { bars: 1, tail: 0, sampleRate: SR, OfflineAudioContext });
    expect(buf.length).toBe(Math.round(16 * secondsPerStep(120) * SR));
  });
});

/** Realtime engine on an offline context with a fake clock and a log of source starts. */
function clockedContext() {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const ctl = { now: 0, starts: [] };
  Object.defineProperty(ctx, 'state', { configurable: true, get: () => 'running' });
  Object.defineProperty(ctx, 'currentTime', { configurable: true, get: () => ctl.now });
  for (const factory of ['createOscillator', 'createBufferSource']) {
    const orig = ctx[factory].bind(ctx);
    ctx[factory] = () => {
      const node = orig();
      const start = node.start.bind(node);
      node.start = (t = 0, ...rest) => { ctl.starts.push({ t, scheduledAt: ctl.now }); return start(t, ...rest); };
      return node;
    };
  }
  return { ctx, ctl };
}

describe('realtime sequencing', () => {
  it('a negative nudge is scheduled ahead of time, every step', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, ctl } = clockedContext();
      const engine = createEngine({ context: ctx });
      const p = pattern('snap', Object.fromEntries([...Array(16).keys()].map((i) => [i, {}])), {
        bpm: 60, mixer: { nudge: -0.5 },
      });
      engine.setPattern(p);
      await engine.start();
      for (let t = 0; t < 3; t += 0.025) { ctl.now += 0.025; vi.advanceTimersByTime(25); }
      engine.stop();
      const spb = secondsPerStep(60);
      const starts = [...new Set(ctl.starts.filter((s) => s.t > 0).map((s) => s.t))].sort((a, b) => a - b);
      expect(starts.length).toBeGreaterThanOrEqual(10);
      // step 0 can't play before the start; the rest sound half a step early
      expect(starts[0]).toBeCloseTo(0.06, 9);
      starts.slice(1).forEach((t, k) => expect(t).toBeCloseTo(0.06 + (k + 1) * spb - 0.5 * spb, 9));
      for (const s of ctl.starts) expect(s.t).toBeGreaterThanOrEqual(s.scheduledAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits to the playing section apply on the next pass', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, ctl } = clockedContext();
      const engine = createEngine({ context: ctx });
      engine.setPattern(pattern('rim', { 0: {} }, { bpm: 120 }));
      await engine.start({ at: 0.1 });
      const tick = (until) => { while (ctl.now < until) { ctl.now += 0.025; vi.advanceTimersByTime(25); } };
      tick(0.5);
      engine.toggleStep('rim', 8); // 0.1 + 8 * 0.125 = 1.1, still ahead
      engine.setSectionLength('A', 32);
      tick(2.2);
      const pos = engine.getPlayPosition();
      expect(pos).toMatchObject({ section: 'A', chainIndex: 0 });
      expect(pos.step).toBe(Math.floor((2.2 - 0.1) / 0.125) % 32);
      expect(engine.getCurrentStep()).toBe(pos.step);
      engine.stop();
      expect(engine.getPlayPosition()).toBe(null);
      const starts = [...new Set(ctl.starts.map((s) => s.t))].sort((a, b) => a - b);
      // 0.1 (step 0), 1.1 (step 8), 2.1 (step 16 = copy of step 0 after 16 -> 32)
      expect(starts.filter((t) => t > 0.05 && t < 2.2).map((t) => Math.round(t * 10) / 10)).toEqual([0.1, 1.1, 2.1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('engine pattern editing', () => {
  const make = () => {
    const engine = createEngine({ context: new OfflineAudioContext(2, SR, SR) });
    const changes = [];
    engine.onPatternChange((p) => changes.push(p));
    return { engine, changes };
  };

  it('tracks: add, remove, move, limits', () => {
    const { engine, changes } = make();
    expect(engine.addTrack('conga')).toBe(true);
    expect(engine.addTrack('conga')).toBe(false);
    expect(() => engine.addTrack('nope')).toThrow();
    expect(engine.addTrack('smp-abc')).toBe(true);
    let p = engine.getPattern();
    expect(p.tracks.slice(-2)).toEqual(['conga', 'smp-abc']);
    expect(p.mixer['smp-abc']).toEqual({ volume: 0.8, mute: false, solo: false, swing: null, nudge: 0 });
    expect(p.fx.sends.conga).toBeTruthy();
    expect(p.sections.A.steps.conga).toEqual(new Array(16).fill(null));
    for (const id of VOICE_IDS) engine.addTrack(id);
    expect(engine.getPattern().tracks.length).toBe(MAX_TRACKS);
    expect(engine.addTrack('smp-more')).toBe(false);

    expect(engine.removeTrack('conga')).toBe(true);
    expect(engine.removeTrack('conga')).toBe(false);
    p = engine.getPattern();
    expect(p.tracks).not.toContain('conga');
    expect(p.mixer.conga).toBeUndefined();
    expect(p.fx.sends.conga).toBeUndefined();

    expect(engine.moveTrack('smp-abc', 0)).toBe(0);
    expect(engine.getPattern().tracks[0]).toBe('smp-abc');
    expect(changes.length).toBeGreaterThan(5);
    expect(() => engine.toggleStep('conga', 0)).toThrow();
  });

  it('steps: toggle, set, get, bass shortcut', () => {
    const { engine, changes } = make();
    expect(engine.toggleStep('kick', 0)).toBe(true);
    expect(engine.getStep('kick', 0)).toEqual({ v: 0.8, r: 1, c: 1, p: 0, f: false });
    expect(engine.setStep('kick', 0, { v: 1, r: 3, c: 0.5, f: true, p: 30 })).toEqual({ v: 1, r: 3, c: 0.5, p: 12, f: true });
    expect(engine.setStep('snare', 4, { v: 0.5 })).toMatchObject({ v: 0.5, r: 1 });
    expect(engine.getStep('snare', 4)).toMatchObject({ v: 0.5 });
    expect(engine.setStep('snare', 4, null)).toBe(null);
    expect(engine.getStep('snare', 4)).toBe(null);
    expect(engine.toggleStep('kick', 0)).toBe(false);
    expect(() => engine.toggleStep('kick', 16)).toThrow();
    expect(engine.setBassNote(3, 45)).toBe(45);
    expect(engine.getStep('bass', 3).p).toBe(45);
    expect(() => engine.setBassNote(3, 34)).toThrow();
    const n = changes.length;
    engine.setStep('bass', 3, { p: 45 });
    expect(changes.length).toBe(n);
  });

  it('sections, lengths and chain', () => {
    const { engine } = make();
    engine.toggleStep('kick', 0);
    engine.toggleStep('snare', 4);
    expect(engine.setSectionLength('A', 32)).toBe(32);
    let p = engine.getPattern();
    expect(p.sections.A.steps.kick[16]).toEqual(p.sections.A.steps.kick[0]);
    expect(p.sections.A.steps.snare[20]).toBeTruthy();
    engine.toggleStep('kick', 31);
    engine.setSectionLength('A', 16);
    p = engine.getPattern();
    expect(p.sections.A.length).toBe(16);
    expect(p.sections.A.steps.kick.length).toBe(16);

    expect(() => engine.setEditSection('B')).toThrow();
    expect(engine.setChain(['A', 'B'])).toEqual(['A']); // no B yet
    expect(engine.setSectionB(true)).toBe(true);
    expect(engine.getPattern().sections.B.steps.kick[0]).toBeTruthy();
    expect(engine.setEditSection('B')).toBe('B');
    expect(engine.editSection).toBe('B');
    engine.toggleStep('kick', 0);
    p = engine.getPattern();
    expect(p.sections.B.steps.kick[0]).toBe(null);
    expect(p.sections.A.steps.kick[0]).toBeTruthy();
    expect(engine.setChain(['A', 'A', 'B', 'X'])).toEqual(['A', 'A', 'B']);
    expect(engine.setChain(new Array(12).fill('A')).length).toBe(8);
    engine.setChain(['A', 'B']);
    expect(engine.setSectionB(false)).toBe(false);
    p = engine.getPattern();
    expect(p.sections.B).toBe(null);
    expect(p.chain).toEqual(['A']);
    expect(engine.editSection).toBe('A');
    engine.setSectionB(true, { copyFrom: null });
    expect(engine.getPattern().sections.B.steps.snare.every((s) => s === null)).toBe(true);
  });

  it('per-track swing and nudge', () => {
    const { engine } = make();
    expect(engine.setTrackSwing('hat', 0.3)).toBe(0.3);
    expect(engine.setTrackSwing('hat', 9)).toBe(0.6);
    expect(engine.setTrackSwing('hat', null)).toBe(null);
    expect(engine.setTrackNudge('snare', -0.2)).toBe(-0.2);
    expect(engine.setTrackNudge('snare', -3)).toBe(-0.5);
    const p = engine.getPattern();
    expect(p.mixer.hat.swing).toBe(null);
    expect(p.mixer.snare.nudge).toBe(-0.5);
  });

  it('trigger takes p and v for any voice or sample', () => {
    const { ctx, ctl } = clockedContext();
    const engine = createEngine({ context: ctx });
    engine.trigger('logdrum', { p: 40, v: 1 });
    engine.trigger('crash', { p: -3 });
    engine.trigger('smp-missing'); // silent, no throw
    engine.trigger('bass', { midi: 45 });
    expect(() => engine.trigger('bass', { p: 34 })).toThrow();
    expect(() => engine.trigger('nope')).toThrow();
    expect(ctl.starts.length).toBeGreaterThan(3);
  });
});

describe('groove tools', () => {
  const base = () => {
    const p = normalizePattern(V3.boomBap);
    p.tracks.push('tomhi', 'tomlo');
    return normalizePattern(p);
  };

  it('humanize nudges velocity and timing a little, repeatably', () => {
    const p = base();
    const a = humanize(p, 1, { seed: 7 });
    expect(humanize(p, 1, { seed: 7 })).toEqual(a);
    expect(humanize(p, 1, { seed: 8 })).not.toEqual(a);
    let moved = 0;
    for (const id of p.tracks) {
      p.sections.A.steps[id].forEach((s, i) => {
        const h = a.sections.A.steps[id][i];
        expect(!!h).toBe(!!s);
        if (!s) return;
        expect(Math.abs(h.v - s.v)).toBeLessThanOrEqual(0.15 + 1e-9);
        expect(Math.abs(h.t || 0)).toBeLessThanOrEqual(0.08 + 1e-9);
        if (h.v !== s.v || h.t) moved++;
      });
    }
    expect(moved).toBeGreaterThan(10);
    expect(a.mixer).toEqual(p.mixer);
    expect(humanize(p, 0, { seed: 1 })).toEqual(p);
  });

  it('randomizeTrack keeps the downbeat for the kick and follows density', () => {
    const p = base();
    const count = (q, id) => q.sections.A.steps[id].filter(Boolean).length;
    for (let seed = 1; seed < 20; seed++) {
      const q = randomizeTrack(p, 'kick', { density: 0.3, seed });
      expect(q.sections.A.steps.kick[0]).toBeTruthy();
      expect(q.sections.A.steps.snare).toEqual(p.sections.A.steps.snare);
      const s = randomizeTrack(p, 'snare', { density: 0.2, seed });
      expect(s.sections.A.steps.snare[4] && s.sections.A.steps.snare[12]).toBeTruthy();
    }
    expect(randomizeTrack(p, 'hat', { seed: 3 })).toEqual(randomizeTrack(p, 'hat', { seed: 3 }));
    let sparse = 0, dense = 0;
    for (let seed = 1; seed < 20; seed++) {
      sparse += count(randomizeTrack(p, 'hat', { density: 0.15, seed }), 'hat');
      dense += count(randomizeTrack(p, 'hat', { density: 0.7, seed }), 'hat');
    }
    expect(dense).toBeGreaterThan(sparse * 2);
    const bass = randomizeTrack(p, 'bass', { density: 0.5, seed: 4 });
    for (const s of bass.sections.A.steps.bass) if (s) expect(s.p).toBeGreaterThanOrEqual(33);
    expect(count(randomizeTrack(p, 'rim', { density: 0, seed: 1 }), 'rim')).toBe(0);
  });

  it('makeFill puts a roll in the last beat of B and chains A A A B', () => {
    const p = base();
    for (let seed = 1; seed < 10; seed++) {
      const q = makeFill(p, { seed });
      expect(q.chain).toEqual(['A', 'A', 'A', 'B']);
      expect(q.sections.A).toEqual(p.sections.A);
      const b = q.sections.B;
      for (let i = 0; i < 12; i++) for (const id of q.tracks) expect(b.steps[id][i]).toEqual(p.sections.A.steps[id][i]);
      const fill = ['snare', 'tomhi', 'tomlo'].flatMap((id) => b.steps[id].slice(12).filter(Boolean));
      expect(fill.length).toBeGreaterThanOrEqual(4);
      expect(fill.some((s) => s.r > 1)).toBe(true);
      expect(b.steps.kick).toEqual(p.sections.A.steps.kick);
    }
    // without toms the fill stays on the snare
    const plain = makeFill(normalizePattern(V3.trap), { seed: 2 });
    expect(plain.sections.B.steps.snare.slice(12).every(Boolean)).toBe(true);
  });

  it('clearTrack empties a row', () => {
    const p = makeFill(base(), { seed: 1 });
    const q = clearTrack(p, 'snare');
    expect(q.sections.A.steps.snare.some(Boolean)).toBe(false);
    expect(q.sections.B.steps.snare.some(Boolean)).toBe(false);
    const onlyB = clearTrack(p, 'snare', { section: 'B' });
    expect(onlyB.sections.A.steps.snare.some(Boolean)).toBe(true);
    expect(onlyB.sections.B.steps.snare.some(Boolean)).toBe(false);
  });
});

describe('review fixes', () => {
  const tickTo = (ctl, until) => {
    while (ctl.now < until - 1e-9) { ctl.now += 0.005; vi.advanceTimersByTime(5); }
  };

  it('the playhead waits for swung steps', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, ctl } = clockedContext();
      const engine = createEngine({ context: ctx });
      engine.setPattern(pattern('rim', { 0: {}, 1: {} }, { bpm: 120, swing: 0.6 }));
      await engine.start({ at: 0.1 });
      // step 1: grid 0.225, swung by 0.6 * 0.125 * 5/6 = 0.0625 to 0.2875
      tickTo(ctl, 0.25);
      expect(engine.getCurrentStep()).toBe(0);
      tickTo(ctl, 0.29);
      expect(engine.getCurrentStep()).toBe(1);
      expect(engine.getPlayPosition()).toEqual({ section: 'A', step: 1, chainIndex: 0 });
      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a loop that shrinks while playing rests until the next bar line and starts a new pass', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, ctl } = clockedContext();
      const engine = createEngine({ context: ctx });
      const every = Object.fromEntries([...Array(32).keys()].map((i) => [i, {}]));
      engine.setPattern(pattern('rim', every, { bpm: 120, length: 32 }));
      await engine.start({ at: 0.1 });
      const spb = 0.125;
      tickTo(ctl, 0.1 + 20 * spb); // around step 20 of 32
      engine.setSectionLength('A', 16);
      ctl.starts.length = 0;
      tickTo(ctl, 0.1 + 40 * spb);
      const starts = [...new Set(ctl.starts.map((s) => s.t))].sort((a, b) => a - b);
      // what was already scheduled may still play; then nothing until bar 3 at step 32
      const later = starts.filter((t) => t > 0.1 + 22 * spb);
      expect(later[0]).toBeCloseTo(0.1 + 32 * spb, 9);
      for (let k = 1; k < later.length; k++) expect(later[k] - later[k - 1]).toBeCloseTo(spb, 9);
      expect(engine.getLoopPositionAt(0.1 + 36 * spb)).toEqual({ pos: 4, pass: 1 });
      expect(engine.getNextBarTime(0.1 + 33 * spb)).toBeCloseTo(0.1 + 48 * spb, 9);
      engine.stop();
      expect(engine.getLoopPositionAt(1)).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the export tail covers long voices and samples on the last step', async () => {
    const { beatTail, DEFAULT_TAIL } = await import('../src/audio/export.js');
    expect(beatTail(pattern('rim', { 15: {} }))).toBe(DEFAULT_TAIL);
    expect(beatTail(pattern('crash', { 15: {} }))).toBeGreaterThan(1.62 + 0.2);
    const long = { 'smp-test': { buffer: testSample(4), start: 0, end: 4, pitch: 0 } };
    const p = pattern('smp-test', { 15: {} });
    expect(beatTail(p, long)).toBeGreaterThan(4);
    const down = pattern('smp-test', { 15: { p: -12 } });
    expect(beatTail(down, long)).toBeGreaterThan(8);
    expect(beatTail(p, {})).toBe(DEFAULT_TAIL);

    const buf = await renderBeat(pattern('crash', { 15: {} }), { bars: 1, sampleRate: SR, OfflineAudioContext });
    expect(peakOf(buf, buf.length - Math.round(0.05 * SR))).toBeLessThan(0.001);
  });

  it('the log drum is monophonic and slides between adjacent notes', async () => {
    const run = async (steps) => {
      const log = [];
      class Logging extends OfflineAudioContext {
        createOscillator() {
          const o = super.createOscillator();
          const rec = { stops: [] };
          log.push(rec);
          const stop = o.stop.bind(o);
          o.stop = (t) => { rec.stops.push(t); return stop(t); };
          return o;
        }
      }
      await render(pattern('logdrum', steps), { OfflineAudioContext: Logging });
      return log;
    };
    const slide = await run({ 0: { p: 33 }, 1: { p: 40 } });
    expect(slide.length).toBe(2); // one voice: body + wood
    const same = await run({ 0: { p: 33 }, 1: { p: 33 } });
    expect(same.length).toBe(4);
    // the first note is choked when the second starts
    expect(Math.min(...same[0].stops)).toBeLessThan(0.125 + 0.02);
  });

  it('an 808 only slides from a note that actually played', async () => {
    let oscillators = 0;
    class Counting extends OfflineAudioContext {
      createOscillator() { oscillators++; return super.createOscillator(); }
    }
    await render(pattern('bass', { 0: { p: 33 }, 1: { p: 40, c: 0 }, 2: { p: 43 } }), { OfflineAudioContext: Counting });
    expect(oscillators).toBe(2);
    oscillators = 0;
    await render(pattern('bass', { 0: { p: 33 }, 1: { p: 40 }, 2: { p: 43 } }), { OfflineAudioContext: Counting });
    expect(oscillators).toBe(1);
  });

  it('a take mix starts where the loop was at its bar 1', async () => {
    const { makeTake, renderMix } = await import('../src/audio/takes.js');
    const p = pattern('rim', { 16: {} }, { length: 32 });
    const opts = { bpm: 120, bars: 1, sampleRate: SR };
    const silent = new Float32Array(Math.round(3 * SR));
    const at = (take) => renderMix(p, take, 0, { OfflineAudioContext, sampleVoices: {} });
    const fromStart = await at(makeTake(silent, { ...opts, id: 'a', name: 'a' }));
    const fromMiddle = await at(makeTake(silent, { ...opts, id: 'b', name: 'b', loop: { pos: 16, pass: 3 } }));
    expect(peakOf(fromStart)).toBe(0);
    const first = onsets(fromMiddle, 0.01)[0] / SR;
    expect(first).toBeLessThan(0.03);

    // chance follows the pass the take heard
    const chancy = pattern('rim', Object.fromEntries([...Array(16).keys()].map((i) => [i, { c: 0.5 }])));
    const hits = async (pass) => onsets(await renderMix(chancy, makeTake(silent, {
      ...opts, id: 'c', name: 'c', loop: { pos: 0, pass },
    }), 0, { OfflineAudioContext }), 0.01).length;
    const counts = await Promise.all([0, 1, 2, 3].map(hits));
    expect(new Set(counts).size).toBeGreaterThan(1);
    const direct = await renderPatternOffline(chancy, { ...DRY, bars: 1, startPass: 2, tail: 0.3 });
    expect(onsets(direct, 0.01).length).toBe(counts[2]);
  });

  it('mixer channels of removed tracks are freed', async () => {
    vi.useFakeTimers();
    try {
      const { createMixer } = await import('../src/audio/sequence.js');
      const ctx = new OfflineAudioContext(2, SR, SR);
      const mixer = createMixer(ctx, ctx.destination);
      const ch = { volume: 0.8, mute: false, solo: false };
      mixer.apply({ kick: ch, conga: ch }, false);
      const gate = mixer.channels.conga.gate;
      const spy = vi.spyOn(gate, 'disconnect');
      mixer.apply({ kick: ch }, true);
      expect(mixer.channels.conga).toBeUndefined();
      expect(mixer.channels.kick).toBeTruthy();
      expect(spy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(13000);
      expect(spy).toHaveBeenCalled();
      expect(mixer.input('conga')).not.toBe(gate); // added back: a fresh channel
    } finally {
      vi.useRealTimers();
    }
  });
});
