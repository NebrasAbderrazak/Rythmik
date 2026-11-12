import { describe, it, expect, vi, afterEach } from 'vitest';
import { OfflineAudioContext, AudioContext, AudioWorkletNode } from 'node-web-audio-api';
import { createEngine } from '../src/audio/engine.js';
import { createBooth } from '../src/audio/booth.js';
import {
  createRemix, createDeckChain, gridSteps, beatTempo, muffleHz, normalizeRemix,
  SPEED_PRESETS, REMIX_PRESETS, MIN_SPEED, MAX_SPEED, DEFAULT_REMIX,
} from '../src/audio/remix.js';
import { detectBpm, createTapTempo } from '../src/audio/tempo.js';
import { timeStretch } from '../src/audio/stretch.js';
import { Scheduler } from '../src/audio/scheduler.js';
import { measureChainDelay } from '../src/audio/takes.js';
import { renderPatternOffline } from '../src/audio/offline.js';
import { encodeWav } from '../src/audio/wav.js';
import { emptyPattern } from '../src/audio/pattern.js';
import { REVERB_SECONDS, REVERB_PREDELAY } from '../src/audio/fx.js';

vi.setConfig({ testTimeout: 30000 });

const SR = 44100;
const on = (...idx) => Array.from({ length: 16 }, (_, i) => idx.includes(i));
const noDetect = async () => ({ bpm: null, confidence: 0 });

function makeBuffer(seconds, fill, channels = 1, sr = SR) {
  const buf = new OfflineAudioContext(channels, 1, sr).createBuffer(channels, Math.round(seconds * sr), sr);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = fill(i / sr, c, i);
  }
  return buf;
}

const sine = (f, amp = 0.5) => (t) => amp * Math.sin(2 * Math.PI * f * t);

/** Short decaying burst on every beat (accent on the bar), optional quiet off-beat hats. */
function clickTrack(bpm, seconds, { offset = 0.05, hats = false, sr = SR } = {}) {
  const beat = 60 / bpm;
  const n = Math.round(seconds * sr);
  const d = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let k = 0, t = offset; t < seconds; k++, t += beat / 2) {
    const onBeat = k % 2 === 0;
    if (!onBeat && !hats) continue;
    const i0 = Math.round(t * sr);
    const amp = onBeat ? (k % 8 === 0 ? 0.9 : 0.6) : 0.2;
    for (let j = 0; j < sr * 0.06 && i0 + j < n; j++) {
      d[i0 + j] += amp * Math.exp(-j / (sr * 0.01)) * (onBeat ? Math.sin((2 * Math.PI * 70 * j) / sr) : rnd());
    }
  }
  return makeBuffer(seconds, (t, c, i) => d[i]);
}

const wavOf = (buf) => encodeWav(buf, { bitDepth: 16 });

function offlineEngine(pattern = emptyPattern(120)) {
  const engine = createEngine({ context: new OfflineAudioContext(2, SR, SR) });
  engine.setPattern(pattern);
  return engine;
}

async function loadedRemix(buffer, { engine = offlineEngine(), ...opts } = {}) {
  const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect, ...opts });
  await remix.load(wavOf(buffer), { name: 'song.wav' });
  return { engine, remix };
}

function peak(buf) {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    for (const x of buf.getChannelData(c)) p = Math.max(p, Math.abs(x));
  }
  return p;
}

// average frequency from rising zero crossings between a and b seconds
function frequency(data, sr, a, b) {
  let first = -1, last = -1, count = 0;
  for (let i = Math.round(a * sr) + 1; i < Math.round(b * sr); i++) {
    if (data[i - 1] < 0 && data[i] >= 0) {
      const x = i - 1 + data[i - 1] / (data[i - 1] - data[i]);
      if (first < 0) first = x;
      last = x;
      count++;
    }
  }
  return ((count - 1) * sr) / (last - first);
}

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

/** Offline context whose clock the test moves by hand (ctl.now). */
function instrumentedContext() {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const ctl = { now: 0 };
  Object.defineProperty(ctx, 'state', { configurable: true, get: () => 'running' });
  Object.defineProperty(ctx, 'currentTime', { configurable: true, get: () => ctl.now });
  ctx.resume = async () => {};
  // drop the overrides so the context can render
  ctl.release = () => {
    delete ctx.state; delete ctx.currentTime; delete ctx.resume;
  };
  return { ctx, ctl };
}

const ticks = () => new Promise((r) => setTimeout(r, 80));

// where a rim shot on step 0 first crosses 0.01 in a plain beat render (master chain delay + attack)
async function rimOnset() {
  const beat = await renderPatternOffline(
    { ...emptyPattern(120), steps: { rim: on(0) } },
    { bars: 1, sampleRate: SR, OfflineAudioContext, tail: 0.5 },
  );
  return findOnsets(beat.getChannelData(0), 0.01, SR / 4)[0] / SR;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('load', () => {
  it('decodes a file and reports info; whole song looped', async () => {
    const { remix } = await loadedRemix(makeBuffer(2, sine(220), 2));
    expect(remix.loaded).toBe(true);
    expect(remix.info).toEqual({ name: 'song.wav', duration: 2, sampleRate: SR, channels: 2 });
    expect(remix.loop).toEqual({ start: 0, end: 2, enabled: true });
    remix.unload();
    expect(remix.loaded).toBe(false);
    expect(remix.info).toBe(null);
  });

  it('accepts File-like objects and takes their name', async () => {
    const remix = createRemix(offlineEngine(), { OfflineAudioContext, detectBpm: noDetect });
    const data = wavOf(makeBuffer(1, sine(220)));
    await remix.load({ name: 'beat.wav', arrayBuffer: async () => data });
    expect(remix.info.name).toBe('beat.wav');
  });

  it("rejects junk with 'decode-failed' and keeps the current song", async () => {
    const { remix } = await loadedRemix(makeBuffer(1, sine(220)));
    await expect(remix.load(new Uint8Array([1, 2, 3, 4, 5]).buffer)).rejects.toThrow('decode-failed');
    await expect(remix.load(null)).rejects.toThrow('decode-failed');
    expect(remix.info.duration).toBe(1);
  });

  it("rejects songs over 15 minutes with 'too-long'", async () => {
    const engine = offlineEngine();
    const long = { duration: 15 * 60 + 1, length: 10, sampleRate: SR, numberOfChannels: 1 };
    engine.context.decodeAudioData = async () => long;
    const remix = createRemix(engine, { detectBpm: noDetect });
    await expect(remix.load(new ArrayBuffer(8))).rejects.toThrow('too-long');
    expect(remix.loaded).toBe(false);
  });

  it("a second load while decoding rejects with 'busy'", async () => {
    const remix = createRemix(offlineEngine(), { OfflineAudioContext, detectBpm: noDetect });
    const wav = wavOf(makeBuffer(1, sine(220)));
    const first = remix.load(wav.slice(0));
    await expect(remix.load(wav.slice(0))).rejects.toThrow('busy');
    await first;
  });

  it('decodes without an AudioContext yet', async () => {
    const engine = createEngine();
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
    await remix.load(wavOf(makeBuffer(1, sine(220))));
    expect(engine.context).toBe(null);
    expect(remix.info.duration).toBeCloseTo(1, 2);
  });

  it('detects the tempo after load and reports it', async () => {
    const engine = offlineEngine();
    const remix = createRemix(engine, { OfflineAudioContext });
    const changed = new Promise((resolve) => {
      remix.onChange(() => { if (remix.sourceBpm != null) resolve(); });
    });
    await remix.load(wavOf(clickTrack(92, 12)));
    expect(remix.bpmBusy).toBe(true);
    await changed;
    expect(Math.abs(remix.sourceBpm - 92)).toBeLessThanOrEqual(1);
    expect(remix.bpmConfidence).toBeGreaterThan(0.5);
    remix.setSpeed(0.85);
    expect(remix.effectiveBpm).toBe(Math.round(remix.sourceBpm * 0.85 * 10) / 10);
  });

  it('a manual BPM wins over a detection still running', async () => {
    let finish;
    const detect = () => new Promise((r) => { finish = r; });
    const { remix } = await loadedRemix(makeBuffer(1, sine(220)), { detectBpm: detect });
    await flush();
    expect(remix.setSourceBpm(101.27)).toBe(101.27); // kept exact; only effectiveBpm is rounded
    expect(remix.effectiveBpm).toBe(101.3);
    finish({ bpm: 140, confidence: 0.9 });
    await flush();
    expect(remix.sourceBpm).toBe(101.27);
    expect(remix.setSourceBpm(10)).toBe(40);
    expect(remix.setSourceBpm(999)).toBe(220);
    expect(remix.setSourceBpm('x')).toBe(220);
    expect(remix.setSourceBpm(null)).toBe(null);
  });

  it('getPeaks covers the song per column', async () => {
    // left half quiet, right half loud
    const { remix } = await loadedRemix(makeBuffer(2, (t) => (t < 1 ? 0.1 : 0.8) * Math.sin(2 * Math.PI * 100 * t)));
    const { min, max } = remix.getPeaks(4);
    expect(min.length).toBe(4);
    expect(max[0]).toBeCloseTo(0.1, 2);
    expect(max[3]).toBeCloseTo(0.8, 2);
    expect(min[3]).toBeCloseTo(-0.8, 2);
    expect(remix.getPeaks(0).max.length).toBe(1);
    expect(remix.getPeaks('x').max.length).toBe(1);
    expect(remix.getPeaks(1e9).max.length).toBe(8192);
    expect(remix.getPeaks(3.7).max.length).toBe(3);
  });
});

describe('loop and settings', () => {
  it('clamps the loop to the song, at least 0.5 s, in order', async () => {
    const { remix } = await loadedRemix(makeBuffer(4, sine(220)));
    expect(remix.setLoop(-5, 100)).toEqual({ start: 0, end: 4, enabled: true });
    expect(remix.setLoop(3, 1)).toEqual({ start: 1, end: 3, enabled: true });
    expect(remix.setLoop(2, 2.1)).toEqual({ start: 2, end: 2.5, enabled: true });
    expect(remix.setLoop(3.9, 5)).toEqual({ start: 3.5, end: 4, enabled: true });
    expect(remix.setLoop('x', 3)).toEqual({ start: 3, end: 3.5, enabled: true });
    expect(remix.setLoopEnabled(false)).toBe(false);
    expect(remix.loop.enabled).toBe(false);
  });

  it('clamps speed, keeps junk out, presets', async () => {
    const { remix } = await loadedRemix(makeBuffer(1, sine(220)));
    expect(remix.setSpeed(0.1)).toBe(MIN_SPEED);
    expect(remix.setSpeed(9)).toBe(MAX_SPEED);
    expect(remix.setSpeed('fast')).toBe(MAX_SPEED);
    expect(remix.setSpeed(0.8504)).toBe(0.85);
    expect(SPEED_PRESETS.map((p) => p.speed)).toEqual([0.75, 0.85, 1, 1.25]);
    for (const p of SPEED_PRESETS) expect(remix.setSpeed(p.speed)).toBe(p.speed);

    expect(Object.keys(REMIX_PRESETS)).toEqual(['original', 'slowedReverb', 'nightcore']);
    remix.setFx('volume', 0.5);
    const s = remix.applyPreset('slowedReverb');
    expect(s).toMatchObject({ speed: 0.85, keepPitch: false, reverb: 0.5, volume: 0.5 });
    expect(s.muffle).toBeGreaterThan(0);
    expect(s.muffle).toBeLessThan(0.4);
    expect(remix.applyPreset('original')).toMatchObject({ speed: 1, reverb: 0, muffle: 0, bass: 0 });
    expect(() => remix.applyPreset('loud')).toThrow();
    expect(() => remix.setFx('wobble', 1)).toThrow();
    expect(remix.setFx('reverb', 2)).toBe(1);
    expect(remix.setFx('muffle', -1)).toBe(0);
    expect(remix.setFx('bass', 'x')).toBe(0);
  });

  it('beat sync needs a BPM', async () => {
    const { remix } = await loadedRemix(makeBuffer(1, sine(220)));
    expect(remix.setBeatSync(true)).toBe(false);
    remix.setSourceBpm(100);
    expect(remix.setBeatSync(true)).toBe(true);
    expect(remix.settings.beatSync).toBe(true);
  });

  it('setSettings restores and normalizes; onChange fires', async () => {
    const { remix } = await loadedRemix(makeBuffer(1, sine(220)));
    const cb = vi.fn();
    remix.onChange(cb);
    const s = remix.setSettings({ speed: 1.2, keepPitch: true, reverb: 0.3, bass: 5, junk: 1 });
    expect(s).toEqual({ ...DEFAULT_REMIX, speed: 1.2, keepPitch: true, reverb: 0.3, bass: 1 });
    expect(cb).toHaveBeenCalled();
    expect(normalizeRemix(null)).toEqual(DEFAULT_REMIX);
  });

  it('beat tempo folds into the beat range', () => {
    expect(beatTempo(92, 0.85)).toBeCloseTo(78.2, 9);
    expect(beatTempo(70, 0.5)).toBeCloseTo(70, 9);
    expect(beatTempo(180, 1.5)).toBeCloseTo(135, 9);
    expect(beatTempo(null, 1)).toBe(null);
  });
});

describe('time stretch', () => {
  it('keeps pitch and makes it len / speed long; stereo stays in sync', async () => {
    const n = SR * 2;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
      R[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR + 0.7);
    }
    for (const speed of [0.8, 1.25]) {
      const [l, r] = await timeStretch([L, R], SR, speed);
      expect(l.length).toBe(Math.round(n / speed));
      expect(frequency(l, SR, 0.3, l.length / SR - 0.3)).toBeCloseTo(440, 0);
      // the 0.7 rad offset between channels survives
      let dot = 0, ll = 0, rr = 0;
      for (let i = SR / 4; i < l.length - SR / 4; i++) { dot += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i]; }
      expect(dot / Math.sqrt(ll * rr)).toBeCloseTo(Math.cos(0.7), 2);
    }
  });

  it('keeps timing: a click lands at its time / speed', async () => {
    const x = new Float32Array(SR * 2);
    const at = SR;
    for (let j = 0; j < 200; j++) x[at + j] = Math.exp(-j / 40) * Math.sin(j * 0.5);
    const [y] = await timeStretch([x], SR, 0.8);
    let best = 0;
    for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[best])) best = i;
    expect(Math.abs(best - at / 0.8) / SR).toBeLessThan(0.01);
  });

  it('can be cancelled', async () => {
    let cancelled = false;
    const job = timeStretch([new Float32Array(SR * 3)], SR, 0.8, {
      isCancelled: () => cancelled, yield: () => { cancelled = true; return Promise.resolve(); },
    });
    await expect(job).rejects.toThrow('stretch-cancelled');
  });
});

describe('render', () => {
  it('speed shifts the pitch; keep pitch holds it, same length', async () => {
    const { remix } = await loadedRemix(makeBuffer(3, sine(440, 0.3)));
    remix.setSpeed(0.8);
    const shifted = await remix.render();
    expect(shifted.length).toBe(Math.ceil((3 / 0.8 + 0.1) * SR));
    expect(frequency(shifted.getChannelData(0), SR, 0.5, 3)).toBeCloseTo(352, 0);

    remix.setKeepPitch(true);
    expect(remix.stretchBusy).toBe(true);
    const kept = await remix.render();
    expect(kept.length).toBe(shifted.length);
    expect(frequency(kept.getChannelData(0), SR, 0.5, 3)).toBeCloseTo(440, 0);
  });

  it('loop only, with reverb tail: right length, not silent, never clips', async () => {
    const { remix } = await loadedRemix(makeBuffer(4, (t) => 0.99 * Math.sign(Math.sin(2 * Math.PI * 55 * t)), 2));
    remix.setLoop(1, 3);
    remix.applyPreset('slowedReverb');
    remix.setFx('bass', 1);
    remix.setFx('volume', 1);
    const out = await remix.render();
    const tail = REVERB_SECONDS + REVERB_PREDELAY;
    expect(out.numberOfChannels).toBe(2);
    expect(out.length).toBe(Math.ceil((2 / 0.85 + tail) * SR));
    const p = peak(out);
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(1);
    // the reverb rings past the loop
    const after = out.getChannelData(0).subarray(Math.round((2 / 0.85 + 0.3) * SR), Math.round((2 / 0.85 + 0.6) * SR));
    expect(Math.max(...after.map(Math.abs))).toBeGreaterThan(0.001);

    const whole = await remix.render({ loopOnly: false });
    expect(whole.length).toBe(Math.ceil((4 / 0.85 + tail) * SR));
  });

  it('muffle at 0 is bypassed, at 1 the highs are gone', async () => {
    const level = async (muffle) => {
      const ctx = new OfflineAudioContext(1, SR / 2, SR);
      const chain = createDeckChain(ctx, ctx.destination);
      chain.apply({ ...DEFAULT_REMIX, muffle }, false);
      const src = ctx.createBufferSource();
      src.buffer = makeBuffer(0.5, sine(8000, 0.5));
      src.connect(chain.input);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      return { out, rms: Math.sqrt(out.slice(SR / 10).reduce((a, x) => a + x * x, 0) / (out.length - SR / 10)) };
    };
    const dry = await level(0);
    const input = makeBuffer(0.5, sine(8000, 0.5)).getChannelData(0);
    const gain = dry.out[1000] / input[1000];
    let maxErr = 0;
    for (let i = 0; i < input.length; i++) maxErr = Math.max(maxErr, Math.abs(dry.out[i] - input[i] * gain));
    expect(maxErr).toBeLessThan(1e-4); // no filter in the path, not even a 20 kHz one
    const muffled = await level(1);
    expect(muffled.rms / dry.rms).toBeLessThan(0.01);
    expect(muffleHz(1, SR)).toBeCloseTo(500, 6);
    expect(muffleHz(0, SR)).toBe(19845);
  });

  it('with the beat: bars from the loop start at the effective tempo', async () => {
    const pattern = { ...emptyPattern(100), steps: { rim: on(0) } };
    const { remix } = await loadedRemix(makeBuffer(6, () => 0), { engine: offlineEngine(pattern) });
    remix.setLoop(1, 5);
    remix.setSourceBpm(100);
    remix.setSpeed(1.2); // 120 bpm: a bar is 2 s
    remix.setBeatSync(true);
    const out = await remix.render();
    const onsets = findOnsets(out.getChannelData(0), 0.01, SR / 4).map((i) => i / SR);
    const rim = await rimOnset();
    expect(onsets.length).toBe(2);
    expect(Math.abs(onsets[0] - rim)).toBeLessThan(0.0015);
    expect(Math.abs(onsets[1] - rim - 2)).toBeLessThan(0.0015);
    expect((await remix.render({ withBeat: false })).getChannelData(0).every((x) => x === 0)).toBe(true);
  });
});

describe('beat grid anchors', () => {
  it('gridSteps restarts bar 1 on every loop wrap', () => {
    // 120 bpm (bar 2 s), loop 3 s, 8 s long
    const steps = gridSteps(0, 0.125, [{ at: 3, period: 3 }], 8);
    expect(steps.filter((s) => s.step === 0).map((s) => s.time)).toEqual([0, 2, 3, 5, 6]);
    // no flam: the step just before a wrap is dropped when closer than half a step
    const tight = gridSteps(0, 0.125, [{ at: 0.95 }], 2);
    expect(tight.map((s) => s.time).slice(0, 9)).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.95]);
  });

  it('the realtime scheduler follows the same anchors', () => {
    const ctl = { now: 0 };
    const played = [];
    const s = new Scheduler({
      getContext: () => ({ currentTime: ctl.now }),
      getSecondsPerStep: () => 0.125,
      onStep: (step, time) => played.push({ step, time }),
      preferWorker: false,
    });
    s.start(0, 0);
    s.setAnchors([{ at: 3, period: 3 }]);
    for (ctl.now = 0; ctl.now < 7.9; ctl.now += 0.05) s._tick();
    s.stop();
    const downbeats = played.filter((p) => p.step === 0).map((p) => Math.round(p.time * 1000) / 1000);
    expect(downbeats).toEqual([0, 2, 3, 5, 6]);
  });
});

describe('deck transport (manual clock)', () => {
  async function deck(seconds = 4) {
    const { ctx, ctl } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    engine.setPattern({ ...emptyPattern(90), steps: { rim: on(0) } });
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
    await remix.load(wavOf(makeBuffer(seconds, sine(220))));
    return { ctx, ctl, engine, remix };
  }

  it('play/stop, position follows speed and wraps on the loop', async () => {
    const { ctl, remix } = await deck();
    remix.setLoop(1, 3);
    await remix.play();
    expect(remix.isPlaying).toBe(true);
    expect(remix.getPosition()).toBe(1); // starts 0.1 s ahead, still at the loop start
    ctl.now = 1.1;
    expect(remix.getPosition()).toBeCloseTo(2, 9);
    ctl.now = 2.6; // 2.5 s in: wrapped once
    expect(remix.getPosition()).toBeCloseTo(1.5, 9);
    remix.setSpeed(0.5); // restarts at the same position, 30 ms ahead
    ctl.now = 2.63 + 2;
    expect(remix.getPosition()).toBeCloseTo(1.5 + 0.03 + 1, 6);
    remix.stop();
    expect(remix.isPlaying).toBe(false);
    expect(remix.getPosition()).toBe(null);
  });

  it('beat sync: tempo override, bar 1 on the loop start, re-aligned on each wrap; stop clears it', async () => {
    const { ctl, engine, remix } = await deck(8);
    remix.setLoop(1, 4); // 3 s
    remix.setSourceBpm(100);
    remix.setSpeed(1.2); // 120 bpm, 2 s bars
    expect(remix.effectiveBpm).toBe(120);
    remix.setBeatSync(true);
    await remix.play(); // loop start at 0.1
    await flush();
    expect(engine.isPlaying).toBe(true);
    expect(engine.tempoOverride).toBeCloseTo(120, 9);
    expect(engine.getPattern().bpm).toBe(90);
    expect(engine.getNextBarTime(0)).toBeCloseTo(0.1, 9);
    expect(engine.getNextBarTime(0.2)).toBeCloseTo(2.1, 9);
    // the loop wraps at 0.1 + 3 / 1.2 = 2.6 s, before the next bar line at 4.1
    for (const now of [0.5, 1, 1.5, 2, 2.4, 2.55]) { ctl.now = now; await ticks(); }
    expect(engine.getNextBarTime(2.2)).toBeCloseTo(2.6, 9);
    remix.stop();
    expect(engine.isPlaying).toBe(false);
    expect(engine.tempoOverride).toBe(null);
  });

  it('moving the loop away from the playhead restarts the song and the beat on the new loop start', async () => {
    const { ctl, engine, remix } = await deck(8);
    remix.setSourceBpm(120);
    remix.setBeatSync(true);
    await remix.play();
    await flush();
    ctl.now = 1.3;
    remix.setLoop(4, 6);
    await flush();
    expect(remix.getPosition()).toBe(4);
    expect(engine.isPlaying).toBe(true);
    expect(engine.getNextBarTime(1.3)).toBeCloseTo(1.4, 9);
    remix.stop();
  });

  it('a playing user beat is restarted in sync; turning sync off stops only the beat', async () => {
    const { engine, remix } = await deck();
    remix.setSourceBpm(120);
    await engine.start();
    remix.setBeatSync(true);
    await remix.play();
    await flush();
    expect(engine.isPlaying).toBe(true);
    expect(engine.getNextBarTime(0)).toBeCloseTo(0.1, 9);
    remix.setBeatSync(false);
    expect(engine.isPlaying).toBe(false);
    expect(remix.isPlaying).toBe(true);
    remix.stop();
  });

  it('the user stopping the beat gives it back; the deck keeps playing', async () => {
    const { engine, remix } = await deck();
    remix.setSourceBpm(120);
    remix.setBeatSync(true);
    await remix.play();
    await flush();
    engine.stop();
    expect(engine.tempoOverride).toBe(null);
    expect(remix.isPlaying).toBe(true);
    remix.stop();
    expect(engine.isPlaying).toBe(false);
  });

  it('beat sync off: play and stop leave the transport alone', async () => {
    const { engine, remix } = await deck();
    remix.setSourceBpm(120);
    await engine.start();
    await remix.play();
    remix.stop();
    expect(engine.isPlaying).toBe(true);
    expect(engine.tempoOverride).toBe(null);
    engine.stop();
  });

  it('keep pitch: plays the old sound until the stretch is ready, then switches', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const stretchSpy = vi.fn(async (chans, sr, speed) => {
      await gate;
      return chans.map((c) => new Float32Array(Math.round(c.length / speed)));
    });
    const { ctx } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect, timeStretch: stretchSpy });
    await remix.load(wavOf(makeBuffer(2, sine(220))));
    const created = vi.spyOn(ctx, 'createBufferSource');
    await remix.play();
    expect(created).toHaveBeenCalledTimes(1);
    remix.setSpeed(0.8);
    expect(created).toHaveBeenCalledTimes(2); // pitch follows speed: restarts right away
    remix.setKeepPitch(true);
    expect(remix.stretchBusy).toBe(true);
    await flush();
    // the plain sound at 0.8 has the wrong pitch: it stops, the deck waits for the stretch
    expect(remix.pending).toBe(true);
    expect(remix.isPlaying).toBe(true);
    expect(created).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 300));
    expect(stretchSpy).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await flush();
    expect(remix.stretchBusy).toBe(false);
    expect(remix.pending).toBe(false);
    expect(created).toHaveBeenCalledTimes(3);
    const src = created.mock.results[2].value;
    expect(src.playbackRate.value).toBe(1);
    expect(src.loopEnd).toBeCloseTo(2 / 0.8, 6);
    remix.stop();
  });
});

describe('detectBpm and tap tempo', () => {
  it.each([[92, false], [140, false], [92, true], [140, true]])('click track at %d BPM (hats: %s)', async (bpm, hats) => {
    const { bpm: found, confidence } = await detectBpm(clickTrack(bpm, 20, { hats }));
    expect(Math.abs(found - bpm)).toBeLessThanOrEqual(1);
    expect(confidence).toBeGreaterThan(0.5);
  });

  it('noise has low confidence; silence and short clips give null', async () => {
    let seed = 3;
    const noise = makeBuffer(15, () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5);
    expect((await detectBpm(noise)).confidence).toBeLessThan(0.2);
    expect(await detectBpm(makeBuffer(10, () => 0))).toEqual({ bpm: null, confidence: 0 });
    expect(await detectBpm(makeBuffer(1, sine(100)))).toEqual({ bpm: null, confidence: 0 });
  });

  it('tap tempo averages taps and resets after a pause', () => {
    const tap = createTapTempo();
    expect(tap.tap(0)).toBe(null);
    expect(tap.tap(500)).toBe(120);
    expect(tap.tap(1000)).toBe(120);
    expect(tap.tap(1520)).toBe(118.4);
    expect(tap.tap(5000)).toBe(null); // > 2 s gap: starts over
    expect(tap.tap(5600)).toBe(100);
    tap.reset();
    expect(tap.count).toBe(0);
  });
});

describe('booth over the remix', () => {
  async function setup({ speed = 1, loop = [1, 5], song } = {}) {
    const engine = offlineEngine(emptyPattern(100));
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
    await remix.load(wavOf(song || makeBuffer(8, () => 0)));
    remix.setLoop(...loop);
    const booth = createBooth(engine, { OfflineAudioContext, remix });
    remix.setSpeed(speed);
    return { engine, remix, booth };
  }

  it('setBacking needs a remix with a song and a BPM', async () => {
    const plain = createBooth(offlineEngine());
    expect(plain.backing).toBe('beat');
    expect(() => plain.setBacking('remix')).toThrow('no-remix');
    expect(() => plain.setBacking('vinyl')).toThrow();

    const { remix, booth } = await setup();
    expect(() => booth.setBacking('remix')).toThrow('no-bpm');
    remix.setSourceBpm(120);
    expect(booth.setBacking('remix')).toBe('remix');
    remix.unload();
    expect(booth.backing).toBe('beat');
  });

  it('takes keep a snapshot of the remix at its tempo', async () => {
    const { remix, booth } = await setup({ speed: 0.8 });
    remix.setSourceBpm(120);
    booth.setBacking('remix');
    const take = booth.importTake(new Float32Array(100), { bars: 2, sampleRate: SR });
    expect(take.bpm).toBeCloseTo(96, 9);
    expect(take.duration).toBeCloseTo(2 * 2.5, 9);
    expect(take.backing).toMatchObject({ type: 'remix', name: 'Untitled', speed: 0.8, sourceBpm: 120 });
    expect(take.backing.loop).toEqual({ start: 1, end: 5, enabled: true });
    expect(take.backing.buffer).toBeUndefined();
    booth.setBacking('beat');
    expect(booth.importTake(new Float32Array(10), { bars: 2, sampleRate: SR }).backing).toEqual({ type: 'beat' });
  });

  it('renderMix puts bar 1 on the loop start at the take tempo, even after the deck changed', async () => {
    // a click on every beat of a 120 BPM song, starting at the loop start (1 s)
    const song = makeBuffer(8, (t) => {
      const k = Math.round((t - 1) / 0.5);
      const dt = t - (1 + k * 0.5);
      return k >= 0 && dt >= 0 && dt < 0.004 ? 0.8 : 0;
    });
    const { remix, booth } = await setup({ speed: 0.8, song });
    remix.setSourceBpm(120);
    booth.setBacking('remix');
    await measureChainDelay(SR, OfflineAudioContext);
    booth.importTake(new Float32Array(10), { bars: 2, sampleRate: SR });
    remix.setSpeed(1.25); // must not move the take
    remix.setLoop(0, 2);
    const mix = await booth.renderMix();
    const beat = 60 / 96;
    const delay = await measureChainDelay(SR, OfflineAudioContext);
    const onsets = findOnsets(mix.getChannelData(0), 0.05, SR / 10).filter((i) => i / SR < 8 * beat - 0.05);
    expect(onsets.length).toBe(8);
    onsets.forEach((o, k) => expect(Math.abs(o / SR - delay - k * beat)).toBeLessThan(0.0015));
    // take length + the default mix tail
    expect(Math.abs(mix.length - Math.ceil((2 * 4 * beat + 1) * SR))).toBeLessThanOrEqual(1);
  });

  it('vocal and song line up in the mix', async () => {
    const song = makeBuffer(8, (t) => {
      const k = Math.round((t - 1) / 0.5);
      const dt = t - (1 + k * 0.5);
      return k >= 0 && dt >= 0 && dt < 0.004 ? 0.5 : 0;
    });
    const { remix, booth } = await setup({ speed: 1, song });
    remix.setSourceBpm(120);
    booth.setBacking('remix');
    await measureChainDelay(SR, OfflineAudioContext);
    await Promise.resolve();
    const L = booth.latencyMs;
    const vocal = new Float32Array(SR * 4);
    for (let k = 0; k < 8; k++) {
      const i = Math.round((k * 0.5 + L / 1000) * SR);
      for (let j = 0; j < 64; j++) vocal[i + j] = 0.6 * Math.exp(-j / 12) * (j % 2 ? -1 : 1);
    }
    booth.importTake(vocal, { bars: 2, sampleRate: SR });
    const mix = await booth.renderMix();
    const delay = await measureChainDelay(SR, OfflineAudioContext);
    // song and voice merge into one onset per beat when they line up
    const onsets = findOnsets(mix.getChannelData(0), 0.02, 2000).filter((i) => i / SR < 4 - 0.05);
    expect(onsets.length).toBe(8);
    onsets.forEach((o, k) => expect(Math.abs(o / SR - delay - k * 0.5)).toBeLessThan(0.0015));
  });

  it('loop shorter than the take: the song loops and a synced beat restarts on each wrap', async () => {
    const engine = offlineEngine({ ...emptyPattern(100), steps: { rim: on(0) } });
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
    await remix.load(wavOf(makeBuffer(8, () => 0)));
    remix.setLoop(1, 4); // 3 s
    remix.setSourceBpm(120);
    remix.setBeatSync(true);
    const booth = createBooth(engine, { OfflineAudioContext, remix });
    booth.setBacking('remix');
    booth.importTake(new Float32Array(10), { bars: 4, sampleRate: SR }); // 8 s
    const mix = await booth.renderMix();
    const rim = await rimOnset();
    const onsets = findOnsets(mix.getChannelData(0), 0.01, SR / 4).map((i) => Math.round((i / SR - rim) * 1000) / 1000);
    expect(onsets).toEqual([0, 2, 3, 5, 6]);
  });

  it('records over the remix: count-in, bar 1 on the loop start, stops the deck it started', async () => {
    const ctx = new AudioContext({ sinkId: { type: 'none' }, latencyHint: 'interactive' });
    try {
      const sr = ctx.sampleRate;
      const engine = createEngine({ context: ctx });
      engine.setPattern({ ...emptyPattern(90), steps: { rim: on(0) } });
      const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
      await remix.load(wavOf(makeBuffer(6, sine(110, 0.2), 1, sr)));
      remix.setLoop(1, 3);
      remix.setSourceBpm(150);
      remix.setSpeed(1.2); // 180 BPM: 1.33 s bars
      remix.setBeatSync(true);
      const micBus = ctx.createGain();
      const track = { stop: vi.fn(), getSettings: () => ({}) };
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      const booth = createBooth(engine, {
        remix, getUserMedia: async () => stream, createSource: () => micBus, OfflineAudioContext, AudioWorkletNode,
      });
      await booth.openMic();
      booth.setBars(2);
      booth.setBacking('remix');

      const bpm = 180;
      const delay = 0.05; // pretend the rapper is heard/captured 50 ms late
      const clickBuf = ctx.createBuffer(1, 32, sr);
      clickBuf.getChannelData(0).fill(0.5);
      let scheduled = false;
      let sawDeck = false;
      booth.onChange(() => {
        const prog = booth.getRecordProgress();
        if (remix.isPlaying && engine.isPlaying) sawDeck = true;
        if (scheduled || !prog?.startTime) return;
        scheduled = true;
        const f0 = Math.round(prog.startTime * sr);
        for (let k = 0; k < 8; k++) {
          const src = ctx.createBufferSource();
          src.buffer = clickBuf;
          src.connect(micBus);
          src.start((f0 + Math.round(((k * 60) / bpm + delay) * sr)) / sr);
        }
      });
      expect(() => booth.setBacking('beat')).not.toThrow();
      booth.setBacking('remix');
      const pending = booth.record();
      expect(() => booth.setBacking('beat')).toThrow('busy');
      const take = await pending;
      expect(take.bpm).toBeCloseTo(180, 9);
      expect(take.backing).toMatchObject({ type: 'remix', speed: 1.2, beatSync: true });
      expect(sawDeck).toBe(true);
      expect(remix.isPlaying).toBe(false);
      expect(engine.isPlaying).toBe(false);
      expect(engine.tempoOverride).toBe(null);

      const vocal = (await booth.renderVocal()).getChannelData(0);
      const shift = Math.round((booth.latencyMs / 1000) * sr);
      const onsets = findOnsets(vocal, 0.1, 1000);
      expect(onsets.length).toBe(8);
      onsets.forEach((o, k) => expect(Math.abs(o - (Math.round(((k * 60) / bpm + delay) * sr) - shift))).toBeLessThanOrEqual(1));
      booth.dispose();
    } finally {
      await ctx.close();
    }
  }, 20000);

  it('the deck stopping mid-take drops it', async () => {
    const ctx = new AudioContext({ sinkId: { type: 'none' }, latencyHint: 'interactive' });
    try {
      const engine = createEngine({ context: ctx });
      const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
      await remix.load(wavOf(makeBuffer(4, sine(110, 0.2), 1, ctx.sampleRate)));
      remix.setSourceBpm(120);
      const stream = { getTracks: () => [], getAudioTracks: () => [] };
      const booth = createBooth(engine, {
        remix, getUserMedia: async () => stream, createSource: (c) => c.createGain(), OfflineAudioContext, AudioWorkletNode,
      });
      await booth.openMic();
      booth.setBacking('remix');
      const pending = booth.record();
      await new Promise((r) => setTimeout(r, 400));
      expect(remix.isPlaying).toBe(true);
      remix.stop();
      expect(await pending).toBe(null);
      expect(booth.state).toBe('idle');
      expect(booth.takes).toEqual([]);
      booth.dispose();
    } finally {
      await ctx.close();
    }
  }, 10000);
});

describe('deck and booth together', () => {
  const contexts = [];
  afterEach(async () => {
    for (const c of contexts.splice(0)) await c.close();
  });

  async function realtime({ seconds = 6, bpm = 180, pattern = emptyPattern(180) } = {}) {
    const ctx = new AudioContext({ sinkId: { type: 'none' }, latencyHint: 'interactive' });
    contexts.push(ctx);
    const engine = createEngine({ context: ctx });
    engine.setPattern(pattern);
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
    await remix.load(wavOf(makeBuffer(seconds, sine(110, 0.2), 1, ctx.sampleRate)));
    remix.setSourceBpm(bpm);
    const track = { stop: vi.fn(), getSettings: () => ({}) };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const booth = createBooth(engine, {
      remix, getUserMedia: async () => stream, createSource: (c) => c.createGain(), OfflineAudioContext, AudioWorkletNode,
    });
    return { ctx, engine, remix, booth };
  }

  it('recording over the beat while the deck plays with beat sync: the take is kept, nothing is left running', async () => {
    const { engine, remix, booth } = await realtime();
    remix.setBeatSync(true);
    await remix.play();
    await flush();
    expect(engine.isPlaying).toBe(true);
    await booth.openMic();
    booth.setBars(2);
    booth.setCountIn(false);
    const take = await booth.record();
    expect(take).toBeTruthy();
    expect(take.bpm).toBe(180);
    expect(take.backing).toEqual({ type: 'beat' });
    expect(remix.isPlaying).toBe(false);
    expect(engine.isPlaying).toBe(false);
    expect(engine.tempoOverride).toBe(null);
    booth.dispose();
  }, 20000);

  it('previewing a beat take while the deck plays with beat sync plays the take at its tempo', async () => {
    const { ctx, engine, remix, booth } = await realtime({ pattern: emptyPattern(90) });
    remix.setBeatSync(true);
    await remix.play();
    await flush();
    booth.importTake(new Float32Array(10), { bpm: 120, bars: 2, sampleRate: ctx.sampleRate });
    await booth.playTake(undefined, { withBeat: true });
    expect(booth.previewTakeId).toBeTruthy();
    expect(remix.isPlaying).toBe(false);
    expect(engine.isPlaying).toBe(true);
    expect(engine.clock.secondsPerStep).toBeCloseTo(60 / 120 / 4, 9);
    booth.stopPreview();
    expect(engine.isPlaying).toBe(false);
    expect(engine.tempoOverride).toBe(null);
    booth.dispose();
  }, 20000);

  it('the deck is locked while a take is recorded over it', async () => {
    const { remix, booth } = await realtime();
    await booth.openMic();
    booth.setBars(2);
    booth.setBacking('remix');
    const flips = [];
    remix.onChange(() => { if (flips.at(-1) !== remix.locked) flips.push(remix.locked); });
    const before = remix.settings;
    const loop = remix.loop;
    const pending = booth.record();
    expect(remix.locked).toBe(true);
    expect(remix.setSpeed(0.7)).toBe(before.speed);
    expect(remix.setKeepPitch(true)).toBe(false);
    expect(remix.setFx('reverb', 1)).toBe(0);
    expect(remix.setBeatSync(true)).toBe(false);
    expect(remix.setSourceBpm(100)).toBe(180);
    expect(remix.applyPreset('nightcore')).toEqual(before);
    expect(remix.setSettings({ bass: 1 })).toEqual(before);
    expect(remix.setLoop(1, 2)).toEqual(loop);
    expect(remix.setLoopEnabled(false)).toBe(true);
    await expect(remix.load(wavOf(makeBuffer(1, sine(220))))).rejects.toThrow('busy');
    expect(() => remix.unload()).toThrow('busy');
    expect(await pending).toBeTruthy();
    expect(remix.locked).toBe(false);
    expect(flips).toEqual([true, false]);
    expect(remix.setSpeed(0.7)).toBe(0.7);
    booth.dispose();
  }, 20000);

  it('with the loop off the take ends on the last whole bar of the song; under one bar it is dropped', async () => {
    // 180 BPM: 1.33 s bars; from 1 s a 6 s song has 3 whole bars left
    const { remix, booth } = await realtime();
    await booth.openMic();
    booth.setBars(4);
    booth.setCountIn(false);
    remix.setLoopEnabled(false);
    remix.setLoop(1, 6);
    booth.setBacking('remix');
    const take = await booth.record();
    expect(take.bars).toBe(3);
    expect(take.duration).toBeCloseTo(4, 9);
    remix.setLoop(5, 6);
    expect(await booth.record()).toBe(null);
    expect(booth.takes.length).toBe(1);
    expect(remix.locked).toBe(false);
    booth.dispose();
  }, 20000);

  it('the booth goes back to the beat when the BPM is cleared', async () => {
    const engine = offlineEngine();
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
    await remix.load(wavOf(makeBuffer(2, sine(220))));
    remix.setSourceBpm(120);
    const booth = createBooth(engine, { OfflineAudioContext, remix });
    booth.setBacking('remix');
    const cb = vi.fn();
    booth.onChange(cb);
    remix.setSourceBpm(null);
    expect(booth.backing).toBe('beat');
    expect(cb).toHaveBeenCalled();
  });
});

describe('remix guards', () => {
  function slowDecode(engine) {
    const ctl = {};
    const real = engine.context.decodeAudioData.bind(engine.context);
    engine.context.decodeAudioData = (data) => new Promise((r) => { ctl.finish = () => r(real(data)); });
    return ctl;
  }

  it("a load already decoding when the deck gets locked is refused with 'busy'", async () => {
    const engine = offlineEngine();
    const decode = slowDecode(engine);
    const remix = createRemix(engine, { detectBpm: noDetect });
    const pending = remix.load(wavOf(makeBuffer(1, sine(220))));
    await flush();
    remix.setLocked(true);
    decode.finish();
    await expect(pending).rejects.toThrow('busy');
    expect(remix.loaded).toBe(false);
  });

  it("files over 200 MB are refused before reading with 'too-large'", async () => {
    const remix = createRemix(offlineEngine(), { OfflineAudioContext, detectBpm: noDetect });
    const arrayBuffer = vi.fn();
    await expect(remix.load({ size: 201 * 1024 * 1024, arrayBuffer })).rejects.toThrow('too-large');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('dispose cancels a load in flight', async () => {
    const engine = offlineEngine();
    const decode = slowDecode(engine);
    const remix = createRemix(engine, { detectBpm: noDetect });
    const pending = remix.load(wavOf(makeBuffer(1, sine(220))));
    await flush();
    remix.dispose();
    decode.finish();
    await expect(pending).rejects.toThrow('cancelled');
    expect(remix.loaded).toBe(false);
  });

  it('dispose stops take previews and the beat they started', async () => {
    const { ctx } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
    await remix.load(wavOf(makeBuffer(2, sine(220))));
    remix.setSourceBpm(120);
    remix.setBeatSync(true);
    await remix.playSnapshot(remix.snapshot(), { at: 0.1, duration: 4 });
    await flush();
    expect(engine.isPlaying).toBe(true);
    remix.dispose();
    expect(engine.isPlaying).toBe(false);
    expect(engine.tempoOverride).toBe(null);
  });

  it('tap tempo clamps to 40..220 and ignores junk times', () => {
    const tap = createTapTempo();
    tap.tap(0);
    expect(tap.tap(100)).toBe(220);
    expect(tap.tap(Number.NaN)).toBe(220);
    expect(tap.count).toBe(2);
    tap.reset();
    expect(tap.tap('x')).toBe(null);
    tap.tap(0);
    expect(tap.tap(1900)).toBe(40);
  });

  it('a 4-minute song: tempo to within 0.05 BPM', async () => {
    const { bpm } = await detectBpm(clickTrack(97.3, 240, { hats: true }));
    expect(Math.abs(bpm - 97.3)).toBeLessThanOrEqual(0.05);
  });
});

describe('stretch memory and waiting', () => {
  it('writes into the given output arrays', async () => {
    // keep the buffer referenced: node-web-audio-api frees channel data with it
    const buf = makeBuffer(1, sine(440));
    const x = buf.getChannelData(0);
    const out = [new Float32Array(Math.round(x.length / 0.8))];
    const res = await timeStretch([x], SR, 0.8, { output: out });
    expect(res[0]).toBe(out[0]);
    expect(buf.length).toBe(SR);
    expect(peak({ numberOfChannels: 1, getChannelData: () => out[0] })).toBeGreaterThan(0.4);
  });

  it('keeps two speeds per song; an evicted one is stretched again and shows as busy', async () => {
    let gate = Promise.resolve();
    const spy = vi.fn(async (chans, sr, speed, o) => {
      await gate;
      return o.output;
    });
    const { remix } = await loadedRemix(makeBuffer(1, sine(220)), { timeStretch: spy });
    remix.setKeepPitch(true);
    for (const speed of [0.8, 0.9, 0.7]) {
      remix.setSpeed(speed);
      await remix.render();
    }
    expect(spy).toHaveBeenCalledTimes(3);
    await remix.render(); // 0.7 is cached
    expect(spy).toHaveBeenCalledTimes(3);
    let release;
    gate = new Promise((r) => { release = r; });
    remix.setSpeed(0.8); // evicted
    const changes = vi.fn();
    remix.onChange(changes);
    const job = remix.render();
    await flush();
    expect(remix.stretchBusy).toBe(true);
    expect(changes).toHaveBeenCalled();
    release();
    await job;
    await new Promise((r) => setTimeout(r, 300)); // the live debounce for 0.8 finds it cached
    expect(spy).toHaveBeenCalledTimes(4);
    expect(remix.stretchBusy).toBe(false);
  });

  it('play() with keep pitch waits for the stretch and never plays the plain sound', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const spy = vi.fn(async (chans, sr, speed, o) => { await gate; return o.output; });
    const { ctx } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect, timeStretch: spy });
    await remix.load(wavOf(makeBuffer(2, sine(220))));
    remix.setSettings({ speed: 0.8, keepPitch: true });
    const created = vi.spyOn(ctx, 'createBufferSource');
    const playing = remix.play();
    await flush();
    expect(remix.isPlaying).toBe(true);
    expect(remix.pending).toBe(true);
    expect(remix.getPosition()).toBe(0);
    expect(created).not.toHaveBeenCalled();
    release();
    await playing;
    expect(remix.pending).toBe(false);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.results[0].value.playbackRate.value).toBe(1);
    remix.stop();
    expect(remix.isPlaying).toBe(false);
  });
});

describe('restarts never click', () => {
  // largest sample-to-sample step of the output, with a burst of speed and loop changes 8 ms apart
  async function maxStep({ changes, hideHold = false }) {
    const { ctx, ctl } = instrumentedContext();
    const engine = createEngine({ context: ctx });
    const remix = createRemix(engine, { OfflineAudioContext, detectBpm: noDetect });
    await remix.load(wavOf(makeBuffer(4, sine(110, 0.5))));
    const proto = Object.getPrototypeOf(ctx.createGain().gain);
    const saved = Object.getOwnPropertyDescriptor(proto, 'cancelAndHoldAtTime');
    if (hideHold && saved) Object.defineProperty(proto, 'cancelAndHoldAtTime', { value: undefined, configurable: true });
    try {
      await remix.play();
      if (changes) {
        for (let k = 0; k < 12; k++) {
          ctl.now = 0.2 + k * 0.008;
          if (k % 2) remix.setSpeed(k % 4 === 1 ? 0.9 : 1);
          else remix.setLoop(0, 3.5 - k * 0.01);
        }
      }
    } finally {
      if (saved) Object.defineProperty(proto, 'cancelAndHoldAtTime', saved);
    }
    ctl.release();
    const out = (await ctx.startRendering()).getChannelData(0);
    let step = 0;
    for (let i = Math.round(0.15 * SR); i < Math.round(0.8 * SR); i++) step = Math.max(step, Math.abs(out[i] - out[i - 1]));
    return step;
  }

  it.each([false, true])('without cancelAndHoldAtTime: %s', async (hideHold) => {
    const baseline = await maxStep({ changes: false });
    const step = await maxStep({ changes: true, hideHold });
    expect(baseline).toBeGreaterThan(0);
    expect(step).toBeLessThan(baseline * 1.5);
  });
});
