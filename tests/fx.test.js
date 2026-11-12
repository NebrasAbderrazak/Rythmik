import { describe, it, expect, vi } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { renderPatternOffline } from '../src/audio/offline.js';
import { createEngine, TRACKS } from '../src/audio/engine.js';
import { PRESETS } from '../src/audio/presets.js';
import {
  emptyPattern, normalizePattern, parsePattern, serializePattern, PATTERN_VERSION,
} from '../src/audio/pattern.js';
import {
  defaultFx, filterSettings, createSweepFilter, impulseResponse, echoSeconds, ECHO_TIMES, DEFAULT_SENDS,
} from '../src/audio/fx.js';

vi.setConfig({ testTimeout: 30000 });

const SR = 44100;
const on = (...idx) => Array.from({ length: 16 }, (_, i) => idx.includes(i));
const render = (pattern, opts = {}) =>
  renderPatternOffline(pattern, { bars: 1, sampleRate: SR, OfflineAudioContext, ...opts });

function peak(buf) {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) p = Math.max(p, Math.abs(x));
  return p;
}
function energy(buf, from = 0, to = buf.length) {
  let e = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = Math.max(0, from); i < Math.min(d.length, to); i++) e += d[i] * d[i];
  }
  return e;
}
// first difference: a crude high-pass, enough to compare bright vs dark
function hfEnergy(buf) {
  let e = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 1; i < d.length; i++) e += (d[i] - d[i - 1]) ** 2;
  }
  return e;
}

function noise(n, amp = 0.3) {
  let a = 7;
  return Float32Array.from({ length: n }, () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return amp * ((a / 4294967296) * 2 - 1);
  });
}
function sourceOf(ctx, x) {
  const buf = ctx.createBuffer(1, x.length, ctx.sampleRate);
  buf.copyToChannel(x, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

function goertzel(d, f, sr) {
  const w = (2 * Math.PI * f) / sr;
  let re = 0, im = 0;
  for (let i = 0; i < d.length; i++) { re += d[i] * Math.cos(w * i); im -= d[i] * Math.sin(w * i); }
  return Math.hypot(re, im);
}

function single(bpm, id, fx = {}, sends = {}) {
  const p = emptyPattern(bpm);
  p.steps[id] = on(0);
  Object.assign(p.fx, fx);
  for (const t of TRACKS) p.fx.sends[t.id] = { reverb: 0, echo: 0 };
  p.fx.sends[id] = { reverb: 0, echo: 0, ...sends };
  return p;
}

describe('pattern v3 fx', () => {
  it('defaults are off with sensible sends', () => {
    const p = emptyPattern();
    expect(PATTERN_VERSION).toBe(3);
    expect(p.version).toBe(3);
    expect(p.fx).toEqual(defaultFx());
    expect(p.fx).toMatchObject({ reverb: 0, echo: 0, echoTime: '1/8', filter: 0, drive: 0 });
    expect(p.fx.sends.kick).toEqual({ reverb: 0, echo: 0 });
    expect(p.fx.sends.bass).toEqual({ reverb: 0, echo: 0 });
    for (const id of ['snare', 'clap', 'rim', 'openhat']) expect(p.fx.sends[id].reverb).toBeGreaterThan(0);
  });

  it('v1 and v2 patterns load with effects off', () => {
    const v1 = normalizePattern({ bpm: 90, steps: { kick: on(0) } });
    const v2 = parsePattern(JSON.stringify({ version: 2, bpm: 90, steps: { kick: on(0) }, mixer: {} }));
    for (const p of [v1, v2]) {
      expect(p.version).toBe(3);
      expect(p.fx).toEqual(defaultFx());
    }
  });

  it('junk fx shapes fall back to defaults', () => {
    for (const fx of [[], null, 'loud', 3, { sends: null }, { sends: [] }, { echoTime: 8 }, { echoTime: {} }]) {
      expect(normalizePattern({ steps: {}, fx }).fx, JSON.stringify(fx)).toEqual(defaultFx());
    }
    const p = normalizePattern({ steps: {}, fx: { echoTime: '1/16', reverb: 0.4, sends: null } });
    expect(p.fx.echoTime).toBe('1/8');
    expect(p.fx.reverb).toBe(0.4);
    expect(p.fx.sends).toEqual(defaultFx().sends);
  });

  it('clamps and repairs fx', () => {
    const p = normalizePattern({
      steps: {},
      fx: {
        reverb: 3, echo: -1, echoTime: '1/2', filter: -7, drive: 'x',
        sends: { snare: { reverb: 2, echo: null }, kick: 'no', bogus: { reverb: 1 } },
      },
    });
    expect(p.fx).toMatchObject({ reverb: 1, echo: 0, echoTime: '1/8', filter: -1, drive: 0 });
    expect(p.fx.sends.snare).toEqual({ reverb: 1, echo: DEFAULT_SENDS.snare.echo });
    expect(p.fx.sends.kick).toEqual(DEFAULT_SENDS.kick);
    expect(p.fx.sends.bogus).toBeUndefined();
    expect(ECHO_TIMES).toEqual(['1/8', '3/16', '1/4']);
  });

  it('presets carry fx and round-trip', () => {
    expect(PRESETS.afroBass.pattern.fx.reverb).toBeGreaterThan(0);
    expect(PRESETS.trap.pattern.fx.echo).toBeGreaterThan(0);
    expect(PRESETS.trap.pattern.fx.sends.hat.echo).toBeGreaterThan(0);
    expect(PRESETS.trap.pattern.fx.sends.clap.echo).toBeGreaterThan(0);
    expect(PRESETS.boomBap.pattern.fx.drive).toBeGreaterThan(0);
    expect(PRESETS.boomBap.pattern.fx.reverb).toBeGreaterThan(0);
    expect(PRESETS.empty.pattern.fx).toEqual(defaultFx());
    for (const { pattern } of Object.values(PRESETS)) {
      expect(pattern.fx.sends.kick).toEqual({ reverb: 0, echo: 0 });
      expect(parsePattern(serializePattern(pattern))).toEqual(pattern);
    }
  });
});

describe('engine fx controls', () => {
  it('setFx / setTrackSend clamp, store and emit only on change', () => {
    const engine = createEngine({ context: new OfflineAudioContext(2, SR, SR) });
    const seen = [];
    engine.onPatternChange((p) => seen.push(p));
    expect(engine.setFx('reverb', 0.5)).toBe(0.5);
    expect(engine.setFx('reverb', 0.5)).toBe(0.5);
    expect(seen.length).toBe(1);
    expect(engine.setFx('filter', -3)).toBe(-1);
    expect(engine.setFx('drive', 2)).toBe(1);
    expect(engine.setFx('echoTime', '3/16')).toBe('3/16');
    expect(engine.setFx('echoTime', 'nope')).toBe('3/16');
    expect(engine.setFx('echo', 'x')).toBe(0);
    expect(seen.length).toBe(4);
    expect(engine.setTrackSend('snare', 'echo', 0.7)).toBe(0.7);
    expect(engine.setTrackSend('snare', 'echo', 0.7)).toBe(0.7);
    expect(seen.length).toBe(5);
    expect(engine.getPattern().fx).toMatchObject({ reverb: 0.5, filter: -1, drive: 1, echoTime: '3/16' });
    expect(engine.getPattern().fx.sends.snare.echo).toBe(0.7);
    expect(seen.at(-1).fx.sends.snare.echo).toBe(0.7);
    expect(() => engine.setFx('chorus', 1)).toThrow();
    expect(() => engine.setTrackSend('snare', 'chorus', 1)).toThrow();
    expect(() => engine.setTrackSend('cowbell', 'echo', 1)).toThrow();

    engine.setPattern(PRESETS.trap.pattern);
    expect(engine.getPattern().fx).toEqual(PRESETS.trap.pattern.fx);
  });
});

describe('beat effects change the sound', () => {
  it('filter: low-pass darkens, high-pass thins', async () => {
    const hats = emptyPattern(120);
    hats.steps.hat = on(0, 2, 4, 6, 8, 10, 12, 14);
    hats.steps.kick = on(0, 8);
    const dry = await render(hats, { masterChain: false });
    const lp = await render({ ...hats, fx: { ...hats.fx, filter: -0.8 } }, { masterChain: false });
    const hp = await render({ ...hats, fx: { ...hats.fx, filter: 0.8 } }, { masterChain: false });
    expect(hfEnergy(lp) / hfEnergy(dry)).toBeLessThan(0.05);
    // the kick is mostly low end, so total energy drops a lot with the high-pass
    expect(energy(hp) / energy(dry)).toBeLessThan(0.3);
    expect(filterSettings(-1, SR)).toMatchObject({ type: 'lowpass' });
    expect(filterSettings(-1, SR).frequency).toBeLessThan(250);
    expect(filterSettings(1, SR)).toMatchObject({ type: 'highpass' });
    expect(filterSettings(0.5, SR).frequency).toBeLessThan(filterSettings(1, SR).frequency);
  });

  it('filter at 0 is bypassed: identical to no filter', async () => {
    const x = noise(SR / 2);
    const run = async (withFilter) => {
      const ctx = new OfflineAudioContext(1, x.length, SR);
      const src = sourceOf(ctx, x);
      if (withFilter) {
        const f = createSweepFilter(ctx);
        src.connect(f.input);
        f.output.connect(ctx.destination);
        f.set(0, false);
      } else src.connect(ctx.destination);
      src.start(0);
      return (await ctx.startRendering()).getChannelData(0);
    };
    const a = await run(true);
    const b = await run(false);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(20 * Math.log10(diff || 1e-12)).toBeLessThan(-90);
  });

  it('a filter sweep from -1 to +1 through 0 has no steps', async () => {
    const x = Float32Array.from({ length: SR }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 500 * i) / SR));
    const ctx = new OfflineAudioContext(1, x.length, SR);
    const src = sourceOf(ctx, x);
    const f = createSweepFilter(ctx);
    src.connect(f.input);
    f.output.connect(ctx.destination);
    f.set(-1, false);
    src.start(0);
    // 41 knob positions, one every 20 ms, landing exactly on 0 halfway
    for (let k = 1; k <= 40; k++) {
      const v = Math.round((-1 + k * 0.05) * 100) / 100;
      ctx.suspend(0.05 + k * 0.02).then(() => { f.set(v, true); ctx.resume(); });
    }
    const y = (await ctx.startRendering()).getChannelData(0);
    const step = (d) => {
      let m = 0;
      for (let i = 1; i < d.length; i++) m = Math.max(m, Math.abs(d[i] - d[i - 1]));
      return m;
    };
    expect(step(y)).toBeLessThan(step(x) * 1.5);
  });

  it('echo repeats a single hit at the synced delay time', async () => {
    const bpm = 120;
    const delay = echoSeconds(bpm, '1/4');
    expect(delay).toBeCloseTo(0.5, 9);
    const p = single(bpm, 'rim', { echo: 1, echoTime: '1/4' }, { echo: 1 });
    const wet = await render(p, { masterChain: false, tail: 1.5 });
    const dry = await render({ ...p, fx: { ...p.fx, echo: 0 } }, { masterChain: false, tail: 1.5 });
    const d = wet.getChannelData(0);
    const win = (t) => [Math.round((t - 0.02) * SR), Math.round((t + 0.06) * SR)];
    // a repeat right at 0.5 s and another at 1.0 s; nothing in the dry render there
    expect(energy(wet, ...win(delay))).toBeGreaterThan(energy(dry, ...win(delay)) * 100 + 1e-6);
    expect(energy(wet, ...win(2 * delay))).toBeGreaterThan(1e-5);
    let at = 0;
    for (let i = Math.round(0.3 * SR); i < Math.round(0.7 * SR); i++) if (Math.abs(d[i]) > Math.abs(d[at])) at = i;
    expect(Math.abs(at / SR - delay)).toBeLessThan(0.01);
    expect(peak(wet)).toBeLessThan(1);
  });

  it('reverb leaves a tail after a single hit', async () => {
    const p = single(120, 'snare', { reverb: 1 }, { reverb: 1 });
    const wet = await render(p, { masterChain: false, tail: 2 });
    const dry = await render({ ...p, fx: { ...p.fx, reverb: 0 } }, { masterChain: false, tail: 2 });
    const from = Math.round(0.8 * SR);
    const to = Math.round(1.6 * SR);
    expect(energy(dry, from, to)).toBeLessThan(1e-6);
    expect(energy(wet, from, to)).toBeGreaterThan(1e-3);
    expect(wet.getChannelData(0)[Math.round(1.0 * SR)]).not.toBe(wet.getChannelData(1)[Math.round(1.0 * SR)]); // stereo
    expect(peak(wet)).toBeLessThan(1);
  });

  it('drive adds harmonics without getting louder', async () => {
    // 808 on A1 (55 Hz): compare the 3rd harmonic to the fundamental on the sustain
    const p = single(120, 'bass');
    const clean = await render(p, { masterChain: false });
    const driven = await render({ ...p, fx: { ...p.fx, drive: 1 } }, { masterChain: false });
    const third = (b) => {
      const d = b.getChannelData(0).subarray(Math.round(0.1 * SR), Math.round(0.3 * SR));
      return goertzel(d, 165, SR) / goertzel(d, 55, SR);
    };
    // the 808 has a little grit of its own
    expect(third(driven)).toBeGreaterThan(third(clean) * 2);
    expect(peak(driven)).toBeLessThan(peak(clean) * 1.3);
    expect(peak(driven)).toBeLessThan(1);
  });

  it('a track with send 0 gets no reverb or echo', async () => {
    // kick sends nothing, snare everything; render each alone with fx full up
    const base = emptyPattern(120);
    base.steps.kick = on(0);
    base.fx = { ...base.fx, reverb: 1, echo: 1, echoTime: '1/8' };
    base.fx.sends.kick = { reverb: 0, echo: 0 };
    base.fx.sends.snare = { reverb: 1, echo: 1 };
    const kickFx = await render(base, { masterChain: false, tail: 2 });
    const kickDry = await render({ ...base, fx: defaultFx() }, { masterChain: false, tail: 2 });
    const a = kickFx.getChannelData(0);
    const b = kickDry.getChannelData(0);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBeLessThan(1e-4);

    const snare = { ...base, steps: { ...base.steps, kick: on(), snare: on(0) } };
    const snareFx = await render(snare, { masterChain: false, tail: 2 });
    expect(energy(snareFx, Math.round(1.2 * SR), Math.round(2.5 * SR))).toBeGreaterThan(1e-3);
  });

  it('nothing clips with every effect at max', async () => {
    const steps = {};
    const mixer = {};
    const sends = {};
    for (const { id } of TRACKS) {
      steps[id] = new Array(16).fill(true);
      mixer[id] = { volume: 1 };
      sends[id] = { reverb: 1, echo: 1 };
    }
    for (const filter of [-1, 0, 1]) {
      const fx = { reverb: 1, echo: 1, echoTime: '3/16', filter, drive: 1, sends };
      const buf = await render({ bpm: 180, master: 1, steps, mixer, fx }, { bars: 2, tail: 1 });
      const pk = peak(buf);
      expect(pk).toBeLessThan(1);
      expect(pk).toBeGreaterThan(0.05);
    }
    for (const { name, pattern } of Object.values(PRESETS)) {
      if (name === 'Empty') continue;
      const hot = normalizePattern(pattern);
      hot.master = 1;
      for (const ch of Object.values(hot.mixer)) ch.volume = 1;
      Object.assign(hot.fx, { reverb: 1, echo: 1, drive: 1, filter: 0.3 });
      expect(peak(await render(hot, { bars: 2 }))).toBeLessThan(1);
    }
  });
});

describe('impulse response', () => {
  it('is generated once per sample rate, stereo, pre-delayed and decaying', () => {
    const a = impulseResponse(SR);
    expect(impulseResponse(SR)).toBe(a);
    expect(impulseResponse(48000)).not.toBe(a);
    const [l, r] = a;
    expect(l.length).toBe(Math.round(0.02 * SR) + Math.round(2.2 * SR));
    expect(l.slice(0, Math.round(0.02 * SR)).every((x) => x === 0)).toBe(true);
    const rms = (d, t0, t1) => {
      let e = 0;
      const i0 = Math.round(t0 * SR), i1 = Math.round(t1 * SR);
      for (let i = i0; i < i1; i++) e += d[i] * d[i];
      return Math.sqrt(e / (i1 - i0));
    };
    expect(rms(l, 0.05, 0.15) / rms(l, 1.9, 2.1)).toBeGreaterThan(100);
    expect(l[5000]).not.toBe(r[5000]);
  });
});
