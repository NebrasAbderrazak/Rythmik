import { describe, it, expect, vi } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  detectPitch, correctPitch, correctionRatios, createVoiceChain, measureVoiceDelay,
  normalizeVoice, VOICE_PRESETS, KEYS, SCALES, DEFAULT_VOICE, tuningKey,
} from '../src/audio/voice.js';
import { createEngine } from '../src/audio/engine.js';
import { createBooth } from '../src/audio/booth.js';
import { emptyPattern } from '../src/audio/pattern.js';
import { PRESETS } from '../src/audio/presets.js';
import { createMasterChain, applyMaster } from '../src/audio/sequence.js';

vi.setConfig({ testTimeout: 30000 });

const SR = 44100;
const A_MINOR = { tune: 1, retune: 0, key: 'A', scale: 'minor' };

function sine(f, seconds, amp = 0.5) {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / SR);
  return x;
}
// harmonic-rich tone, a bit like a voiced vowel; f(t) gives the pitch
function tone(f, seconds, amp = 0.4) {
  const x = new Float32Array(Math.round(seconds * SR));
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    ph += (2 * Math.PI * f(i / SR)) / SR;
    x[i] = amp * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) / 1.75;
  }
  return x;
}
function noise(seconds, amp = 0.2, seed = 1) {
  let a = seed;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  return Float32Array.from({ length: Math.round(seconds * SR) }, () => amp * (rnd() * 2 - 1));
}
const median = (arr) => {
  const v = [...arr].filter((x) => x > 0).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
};
// zero crossings per second / 2, on the middle of the signal
function zeroCrossHz(x) {
  const a = Math.round(x.length * 0.2), b = Math.round(x.length * 0.8);
  let first = -1, last = -1, n = 0;
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t; else n++;
      last = t;
    }
  }
  return (n * SR) / (last - first);
}
const maxJump = (x) => {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
const peakOf = (x) => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const midi = (f) => 69 + 12 * Math.log2(f / 440);
const A_MINOR_PCS = new Set([9, 11, 0, 2, 4, 5, 7]);
const distToScale = (m) => {
  let d = Infinity;
  for (let n = Math.floor(m) - 2; n <= Math.ceil(m) + 2; n++) {
    if (A_MINOR_PCS.has(((n % 12) + 12) % 12)) d = Math.min(d, Math.abs(m - n));
  }
  return d;
};

describe('pitch detection', () => {
  it('finds sines from 80 to 900 Hz and marks noise and silence unvoiced', async () => {
    for (const f of [82, 147, 220, 450, 880]) {
      const { f0, hop } = await detectPitch(sine(f, 0.5), SR);
      expect(hop).toBe(Math.round(0.005 * SR));
      expect(Math.abs(median(f0) / f - 1)).toBeLessThan(0.002);
    }
    const n = await detectPitch(noise(0.5), SR);
    expect(n.f0.filter((x) => x > 0).length / n.f0.length).toBeLessThan(0.05);
    const s = await detectPitch(new Float32Array(SR / 2), SR);
    expect(s.f0.every((x) => x === 0)).toBe(true);
  });
});

describe('pitch correction', () => {
  it('450 Hz snaps to A 440 in A minor (robot settings)', async () => {
    const x = sine(450, 1);
    const y = await correctPitch(x, SR, A_MINOR);
    const zc = zeroCrossHz(y);
    const yin = median((await detectPitch(y, SR)).f0);
    console.log(`[autotune] 450 Hz -> zero crossings ${zc.toFixed(2)} Hz, detector ${yin.toFixed(2)} Hz`);
    expect(Math.abs(zc / 440 - 1)).toBeLessThan(0.01);
    expect(Math.abs(yin / 440 - 1)).toBeLessThan(0.01);
    expect(y.length).toBe(x.length);
    expect(rms(y) / rms(x)).toBeGreaterThan(0.85);
    expect(rms(y) / rms(x)).toBeLessThan(1.15);
  });

  it('a note already in the scale keeps its pitch', async () => {
    for (const f of [440, 261.63, 196]) { // A4, C4, G3
      const y = await correctPitch(sine(f, 0.8), SR, A_MINOR);
      expect(Math.abs(zeroCrossHz(y) / f - 1)).toBeLessThan(0.003);
    }
    // F# is outside A minor but inside D major
    const fs = 369.99;
    const kept = await correctPitch(sine(fs, 0.8), SR, { ...A_MINOR, key: 'D', scale: 'major' });
    expect(Math.abs(zeroCrossHz(kept) / fs - 1)).toBeLessThan(0.003);
  });

  it('keeps length and makes no clicks', async () => {
    // voiced, gap, voiced: edges between shifted and untouched audio
    const parts = [tone(() => 452, 0.4), new Float32Array(SR * 0.1), tone(() => 300, 0.4)];
    const x = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { x.set(p, o); o += p.length; }
    // fade the edges of the input so any jump in the output comes from the shifter
    const ramp = Math.round(0.005 * SR);
    for (let i = 0; i < ramp; i++) {
      const g = i / ramp;
      x[i] *= g; x[parts[0].length - 1 - i] *= g;
      const s = parts[0].length + parts[1].length;
      x[s + i] *= g; x[x.length - 1 - i] *= g;
    }
    for (const settings of [A_MINOR, { ...A_MINOR, retune: 0.6, tune: 0.8 }]) {
      const y = await correctPitch(x, SR, settings);
      expect(Math.abs(y.length / x.length - 1)).toBeLessThan(0.01);
      expect(y.length).toBe(x.length);
      console.log(`[autotune] max jump in ${maxJump(x).toFixed(4)}, out ${maxJump(y).toFixed(4)}`);
      expect(maxJump(y)).toBeLessThan(maxJump(x) * 1.5);
    }
  });

  it('unvoiced noise passes through unchanged', async () => {
    const x = noise(0.6);
    const y = await correctPitch(x, SR, A_MINOR);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff = Math.max(diff, Math.abs(x[i] - y[i]));
    expect(diff).toBeLessThan(1e-6);
  });

  it('tune 0 is a plain copy', async () => {
    const x = sine(450, 0.3);
    const y = await correctPitch(x, SR, { ...A_MINOR, tune: 0 });
    expect(y).not.toBe(x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('robot settings turn a slow glide into steps on the scale', async () => {
    // 200 Hz -> 320 Hz over 2 s (G3 -> ~D#4 sharp)
    const x = tone((t) => 200 * (320 / 200) ** (t / 2), 2);
    const y = await correctPitch(x, SR, A_MINOR);
    const inTrack = (await detectPitch(x, SR)).f0;
    const outTrack = (await detectPitch(y, SR)).f0;
    const near = (track) => {
      const v = [...track].filter((f) => f > 0);
      return v.filter((f) => distToScale(midi(f)) < 0.15).length / v.length;
    };
    // plateaus: frames sitting on a scale note, grouped by note
    const notes = new Set([...outTrack].filter((f) => f > 0 && distToScale(midi(f)) < 0.15)
      .map((f) => Math.round(midi(f))));
    console.log(`[robot glide] frames on a scale note: in ${(near(inTrack) * 100).toFixed(0)}%, out ${(near(outTrack) * 100).toFixed(0)}%, notes ${[...notes].join(',')}`);
    expect(near(inTrack)).toBeLessThan(0.45);
    expect(near(outTrack)).toBeGreaterThan(0.85);
    expect(notes.size).toBeGreaterThanOrEqual(4);
  });

  it('retune smooths the correction; tune scales it', () => {
    const f0 = new Float32Array(200).fill(450);
    const hop = 0.005;
    const hard = correctionRatios(f0, hop, A_MINOR);
    const soft = correctionRatios(f0, hop, { ...A_MINOR, retune: 1 });
    const half = correctionRatios(f0, hop, { ...A_MINOR, tune: 0.5 });
    expect(hard[0]).toBeCloseTo(440 / 450, 6);
    expect(hard[199]).toBeCloseTo(440 / 450, 6);
    // a held note starts corrected; a change mid-note glides with retune
    expect(soft[0]).toBeCloseTo(440 / 450, 6);
    expect(Math.log2(half[100])).toBeCloseTo(Math.log2(440 / 450) / 2, 6);
    const jump = new Float32Array(200).fill(450);
    jump.fill(500, 100);
    const glided = correctionRatios(jump, hop, { ...A_MINOR, retune: 1 });
    const snapped = correctionRatios(jump, hop, A_MINOR);
    expect(snapped[101] * 500).toBeCloseTo(493.88, 1); // B4
    expect(Math.abs(glided[101] * 500 - 493.88)).toBeGreaterThan(3);
    expect(correctionRatios(new Float32Array(5), hop, A_MINOR).every((r) => r === 1)).toBe(true);
  });

  it('can be cancelled between slices', async () => {
    let calls = 0;
    const p = correctPitch(tone(() => 300, 3), SR, A_MINOR, {
      yield: () => Promise.resolve(),
      isCancelled: () => ++calls > 2,
    });
    await expect(p).rejects.toThrow('voice-cancelled');
  });

  it('8 bars at 104 BPM finish in reasonable time', async () => {
    const seconds = (8 * 4 * 60) / 104;
    const x = tone((t) => 160 + 50 * Math.sin(2 * Math.PI * 0.4 * t), seconds);
    let yields = 0;
    const t0 = performance.now();
    const y = await correctPitch(x, SR, A_MINOR, { yield: () => { yields++; return new Promise((r) => setTimeout(r, 0)); } });
    const ms = performance.now() - t0;
    console.log(`[autotune] 8 bars @104 (${seconds.toFixed(1)} s audio): ${ms.toFixed(0)} ms, ${yields} yields`);
    expect(y.length).toBe(x.length);
    expect(yields).toBeGreaterThan(5);
    expect(ms).toBeLessThan(20000); // loose: catches a big slowdown, not machine noise
  });

  it('short unvoiced gaps between runs do not click', async () => {
    // far from A so shifted and untouched audio drift apart quickly
    const x = sine(460, 1);
    const hop = Math.round(0.005 * SR);
    const track = (gap) => {
      const f0 = new Float32Array(Math.floor(x.length / hop) + 1).fill(460);
      f0.fill(0, 100, 100 + gap);
      return { f0, hop };
    };
    const jump = async (gap) => maxJump(await correctPitch(x, SR, A_MINOR, { pitch: track(gap) }));
    const base = await jump(0);
    for (const gap of [1, 2]) {
      const j = await jump(gap);
      console.log(`[autotune] ${gap}-frame gap: max step ${j.toFixed(4)} (no gap ${base.toFixed(4)})`);
      expect(j).toBeLessThan(base * 1.5);
    }
  });

  it('a long sustained note never blocks for long', async () => {
    const x = tone(() => 196, 40);
    const now = () => performance.now();
    let mark = now();
    let worst = 0;
    const yieldFn = () => {
      worst = Math.max(worst, now() - mark);
      return new Promise((r) => setTimeout(() => { mark = now(); r(); }, 0));
    };
    await correctPitch(x, SR, A_MINOR, { yield: yieldFn });
    worst = Math.max(worst, now() - mark);
    console.log(`[autotune] 40 s held note: longest slice ${worst.toFixed(1)} ms`);
    expect(worst).toBeLessThan(150); // target ~20 ms; loose for slow CI machines
  });
});

describe('voice settings and presets', () => {
  it('presets, keys, defaults', () => {
    expect(Object.keys(VOICE_PRESETS)).toEqual(['clean', 'robot', 'tuned', 'radio', 'hall', 'lofi']);
    for (const p of Object.values(VOICE_PRESETS)) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(normalizeVoice(p.settings)).toMatchObject(p.settings);
      expect(p.settings.key).toBeUndefined();
    }
    expect(VOICE_PRESETS.clean.settings).toMatchObject({ tune: 0, tone: 'clean', reverb: 0, echo: 0 });
    expect(VOICE_PRESETS.hall.settings.tone).toBe('full');
    expect(VOICE_PRESETS.robot.settings).toMatchObject({ tune: 1, retune: 0, tone: 'full' });
    expect(VOICE_PRESETS.robot.settings.echo).toBeGreaterThan(0);
    expect(VOICE_PRESETS.tuned.settings).toMatchObject({ tune: 0.8, retune: 0.6 });
    expect(VOICE_PRESETS.radio.settings.tone).toBe('radio');
    expect(VOICE_PRESETS.lofi.settings.tone).toBe('lofi');
    expect(VOICE_PRESETS.hall.settings.reverb).toBeGreaterThan(0.4);
    expect(KEYS.length).toBe(12);
    expect(SCALES).toEqual(['minor', 'major']);
    expect(DEFAULT_VOICE).toMatchObject({ key: 'A', scale: 'minor', tune: 0 });
    expect(normalizeVoice({ tune: 9, key: 'H', tone: 'tv', reverb: -1 })).toMatchObject({
      tune: 1, key: 'A', tone: 'clean', reverb: 0,
    });
    expect(tuningKey({ ...DEFAULT_VOICE, reverb: 1 })).toBe(tuningKey(DEFAULT_VOICE));
  });

  it('each tone is audible and below 0 dBFS at full master, reverb/echo add a tail', async () => {
    // syllables: 200 ms on, 100 ms off
    const x = tone(() => 220, 1.2, 0.9).map((v, i) => ((i / SR) % 0.3 < 0.2 ? v : 0));
    for (const t of ['clean', 'full', 'radio', 'lofi']) {
      for (const fx of [{ reverb: 0, echo: 0 }, { reverb: 1, echo: 1 }]) {
        const ctx = new OfflineAudioContext(2, SR * 3, SR);
        // through the master chain, as in the booth
        const master = createMasterChain(ctx);
        applyMaster(ctx, master.master, 1, false);
        const chain = createVoiceChain(ctx, master.master, {
          peak: 0.9, bpm: 100, settings: { ...DEFAULT_VOICE, tone: t, ...fx },
        });
        const buf = ctx.createBuffer(1, x.length, SR);
        buf.copyToChannel(x, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(chain.input);
        src.start(0);
        const out = await ctx.startRendering();
        const d = out.getChannelData(0);
        const pk = peakOf(d);
        const tail = rms(d.subarray(Math.round(1.8 * SR), Math.round(2.6 * SR)));
        console.log(`[voice ${t} reverb/echo ${fx.reverb}] peak ${pk.toFixed(3)} tail rms ${tail.toExponential(2)}`);
        expect(pk).toBeGreaterThan(0.1);
        expect(pk).toBeLessThan(1);
        if (fx.reverb) expect(tail).toBeGreaterThan(1e-3);
        else expect(tail).toBeLessThan(1e-4);
      }
    }
  });

  it('measures the voice chain delay in whole samples', async () => {
    const d = await measureVoiceDelay(SR, OfflineAudioContext);
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(SR * 0.02);
  });
});

describe('booth voice', () => {
  function offlineBooth(pattern = emptyPattern(120), opts = {}) {
    const engine = createEngine({ context: new OfflineAudioContext(2, SR, SR) });
    engine.setPattern(pattern);
    const booth = createBooth(engine, { OfflineAudioContext, ...opts });
    return { engine, booth };
  }

  it('presets and settings: copies, key kept, preset cleared on edit, events', () => {
    const { booth } = offlineBooth();
    const changes = vi.fn();
    booth.onChange(changes);
    expect(booth.voice).toMatchObject({ ...DEFAULT_VOICE, preset: 'clean' });
    booth.setVoiceSettings({ key: 'C', scale: 'major' });
    expect(booth.voice.preset).toBe('clean'); // key is not part of a preset
    booth.setVoicePreset('robot');
    expect(booth.voice).toMatchObject({ ...VOICE_PRESETS.robot.settings, key: 'C', scale: 'major', preset: 'robot' });
    const n = changes.mock.calls.length;
    booth.setVoicePreset('robot');
    booth.setVoiceSettings({ tune: 1 });
    expect(changes.mock.calls.length).toBe(n);
    expect(booth.setVoiceSettings({ reverb: 0.5 }).preset).toBe(null);
    expect(changes.mock.calls.length).toBe(n + 1);
    booth.voice.tune = 0;
    expect(booth.voice.tune).toBe(1);
    expect(() => booth.setVoicePreset('opera')).toThrow();
    for (const id of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(() => booth.setVoicePreset(id)).toThrow();
    }
    expect(booth.voice.preset).toBe(null);
  });

  it('prepareVoice caches per take and settings; only tuning changes recompute', async () => {
    const spy = vi.fn(correctPitch);
    const detect = vi.fn(detectPitch);
    const { booth } = offlineBooth(emptyPattern(120), { correctPitch: spy, detectPitch: detect });
    const take = booth.importTake(tone(() => 450, 1), { bpm: 120, bars: 1, sampleRate: SR });
    await booth.prepareVoice(take.id);
    expect(spy).not.toHaveBeenCalled(); // clean: nothing to tune

    booth.setVoicePreset('robot');
    const busy = [];
    booth.onChange(() => busy.push(booth.voiceBusy));
    const p = booth.prepareVoice();
    expect(booth.voiceBusy).toBe(true);
    await p;
    expect(booth.voiceBusy).toBe(false);
    expect(busy).toContain(true);
    expect(busy.at(-1)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    await booth.prepareVoice(take.id);
    booth.setVoiceSettings({ reverb: 0.4, tone: 'radio', echo: 0.3 });
    await booth.prepareVoice(take.id);
    expect(spy).toHaveBeenCalledTimes(1);

    booth.setVoiceSettings({ key: 'G' });
    await booth.prepareVoice(take.id);
    booth.setVoiceSettings({ retune: 0.7, tune: 0.5 });
    await booth.prepareVoice(take.id);
    expect(spy).toHaveBeenCalledTimes(3);
    // the pitch track is reused: only the ratios and the shifting run again
    expect(detect).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[2][3].pitch).toBeTruthy();
    booth.setLatencyOffset(10); // re-aligned take: new samples, new pitch track
    await booth.prepareVoice(take.id);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('a settings change mid-run restarts with the new settings', async () => {
    const seen = [];
    const slow = async (x, sr, settings, opts) => {
      seen.push(settings.key);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (opts.isCancelled()) throw new Error('voice-cancelled');
      }
      return Float32Array.from(x);
    };
    const { booth } = offlineBooth(emptyPattern(120), { correctPitch: slow });
    booth.importTake(new Float32Array(1000), { bpm: 120, bars: 1, sampleRate: SR });
    booth.setVoicePreset('robot');
    await new Promise((r) => setTimeout(r, 200)); // past the debounce
    const p = booth.prepareVoice();
    await new Promise((r) => setTimeout(r, 6));
    booth.setVoiceSettings({ key: 'E' });
    await p;
    expect(seen).toEqual(['A', 'E']);
    expect(booth.voiceBusy).toBe(false);
  });

  it('rapid tuning changes are debounced into one run', async () => {
    const spy = vi.fn(correctPitch);
    const { booth } = offlineBooth(emptyPattern(120), { correctPitch: spy });
    booth.importTake(tone(() => 450, 0.5), { bpm: 120, bars: 1, sampleRate: SR });
    booth.setVoicePreset('robot');
    const p = booth.prepareVoice();
    for (const key of ['B', 'C', 'D', 'E']) {
      await new Promise((r) => setTimeout(r, 20));
      booth.setVoiceSettings({ key });
    }
    await p;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2].key).toBe('E');
  });

  it('deleting a take mid-tuning rejects, clears busy and keeps nothing', async () => {
    const slow = async (x, sr, settings, opts) => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (opts.isCancelled()) throw new Error('voice-cancelled');
      }
      return Float32Array.from(x);
    };
    const { booth } = offlineBooth(emptyPattern(120), { correctPitch: slow });
    const take = booth.importTake(new Float32Array(1000), { bpm: 120, bars: 1, sampleRate: SR });
    booth.setVoicePreset('robot');
    await new Promise((r) => setTimeout(r, 200)); // past the debounce
    const p = booth.prepareVoice(take.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(booth.voiceBusy).toBe(true);
    booth.deleteTake(take.id);
    await expect(p).rejects.toThrow('no-take');
    expect(booth.voiceBusy).toBe(false);
    expect(booth.voiceCacheSize).toBe(0);
  });

  it('renderMix uses the processed voice and stays below 0 dBFS', async () => {
    const { booth } = offlineBooth(PRESETS.trap.pattern);
    const bpm = 140;
    const len = Math.round(2 * 4 * (60 / bpm) * SR);
    const x = tone((t) => 200 + 100 * t, len / SR, 0.9);
    booth.importTake(x, { bpm, bars: 2, sampleRate: SR });
    const dry = await booth.renderMix();
    booth.setVoicePreset('robot');
    const robot = await booth.renderMix();
    booth.setVoicePreset('hall');
    const hall = await booth.renderMix();
    const pk = (b) => peakOf(b.getChannelData(0));
    for (const b of [dry, robot, hall]) {
      expect(b.numberOfChannels).toBe(2);
      expect(pk(b)).toBeLessThan(1);
    }
    let diff = 0;
    const a = dry.getChannelData(0), b = robot.getChannelData(0);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBeGreaterThan(0.01);
    expect(hall.length).toBeGreaterThanOrEqual(dry.length);
  });

  it('renderVocal is dry by default; processed is the voice chain in stereo', async () => {
    const { booth } = offlineBooth();
    const x = tone(() => 450, 2, 0.5);
    booth.importTake(x, { bpm: 120, bars: 1, sampleRate: SR });
    booth.setVoicePreset('robot');
    const dry = await booth.renderVocal();
    expect(dry.numberOfChannels).toBe(1);
    expect(dry.length).toBe(2 * SR);
    const proc = await booth.renderVocal(undefined, { processed: true });
    expect(proc.numberOfChannels).toBe(2);
    expect(proc.length).toBeGreaterThan(2 * SR);
    const d = proc.getChannelData(0);
    expect(peakOf(d)).toBeLessThan(1);
    // tuned to A4: the detector on the processed vocal says 440
    const f = median((await detectPitch(d.slice(SR / 4, SR + SR / 2), SR)).f0);
    expect(Math.abs(f / 440 - 1)).toBeLessThan(0.01);
  });

  it('processed vocal lines up with the dry one (chain delay compensated)', async () => {
    const { booth } = offlineBooth();
    const x = new Float32Array(2 * SR);
    for (let k = 0; k < 4; k++) {
      const i = Math.round(k * 0.5 * SR) + 1000;
      for (let j = 0; j < 64; j++) x[i + j] = 0.6 * Math.exp(-j / 12) * (j % 2 ? -1 : 1);
    }
    booth.importTake(x, { bpm: 120, bars: 1, sampleRate: SR });
    const onset = (b) => b.getChannelData(0).findIndex((v) => Math.abs(v) > 0.02);
    const dry = await booth.renderVocal();
    // clean skips the compressor, the other tones go through it: both line up
    for (const tone of ['clean', 'full', 'radio']) {
      booth.setVoiceSettings({ tone });
      const proc = await booth.renderVocal(undefined, { processed: true });
      expect(Math.abs(onset(proc) - onset(dry)), tone).toBeLessThanOrEqual(Math.round(0.0015 * SR));
    }
  });

  it('clean tone is level only: no compression', async () => {
    // a loud and a quiet syllable keep their ratio
    const x = new Float32Array(SR);
    x.set(tone(() => 220, 0.3, 0.8), 0);
    x.set(tone(() => 220, 0.3, 0.1), SR / 2);
    const run = async (t) => {
      const ctx = new OfflineAudioContext(1, SR, SR);
      const chain = createVoiceChain(ctx, ctx.destination, { peak: 0.8, settings: { ...DEFAULT_VOICE, tone: t } });
      const buf = ctx.createBuffer(1, x.length, SR);
      buf.copyToChannel(x, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(chain.input);
      src.start(0);
      const d = (await ctx.startRendering()).getChannelData(0);
      return peakOf(d.subarray(0, SR / 2)) / peakOf(d.subarray(SR / 2));
    };
    expect(DEFAULT_VOICE.tone).toBe('clean');
    expect(await run('clean')).toBeCloseTo(8, 0);
    expect(await run('full')).toBeLessThan(6);
  });
});
