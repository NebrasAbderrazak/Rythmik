import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OfflineAudioContext, AudioContext, AudioWorkletNode,
} from 'node-web-audio-api';
import { createEngine } from '../src/audio/engine.js';
import { createBooth, mapMicError, listInputDevices } from '../src/audio/booth.js';
import { createCapture } from '../src/audio/capture.js';
import {
  measureChainDelay, makeTake, vocalGain, PRE_ROLL,
} from '../src/audio/takes.js';
import { renderPatternOffline } from '../src/audio/offline.js';
import { PRESETS } from '../src/audio/presets.js';
import { emptyPattern } from '../src/audio/pattern.js';

const SR = 44100;
const on = (...idx) => Array.from({ length: 16 }, (_, i) => idx.includes(i));
const beatSec = (bpm) => 60 / bpm;

function peak(buf) {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    for (const x of buf.getChannelData(c)) p = Math.max(p, Math.abs(x));
  }
  return p;
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

/** Mono "vocal" with a short click on every beat, `delaySec` late (as if heard + captured late). */
function clickTake({ bpm, bars, sampleRate, delaySec }) {
  const len = Math.round(bars * 4 * beatSec(bpm) * sampleRate);
  const x = new Float32Array(len);
  const positions = [];
  for (let k = 0; k < bars * 4; k++) {
    const i = Math.round(k * beatSec(bpm) * sampleRate) + Math.round(delaySec * sampleRate);
    if (i >= len) continue;
    positions.push(i);
    for (let j = 0; j < 64 && i + j < len; j++) x[i + j] = 0.6 * Math.exp(-j / 12) * (j % 2 ? -1 : 1);
  }
  return { samples: x, positions };
}

function offlineBooth(pattern = emptyPattern(120)) {
  const engine = createEngine({ context: new OfflineAudioContext(2, SR, SR) });
  engine.setPattern(pattern);
  const booth = createBooth(engine, { OfflineAudioContext });
  return { engine, booth };
}

async function settledLatency(booth, sr) {
  await measureChainDelay(sr, OfflineAudioContext);
  await Promise.resolve();
  return booth.latencyMs;
}

describe('takes', () => {
  it('names, selects newest, selectTake and deleteTake', () => {
    const { booth } = offlineBooth();
    const changes = vi.fn();
    booth.onChange(changes);
    const opts = { bpm: 120, bars: 2, sampleRate: SR };
    const a = booth.importTake(new Float32Array(100), opts);
    const b = booth.importTake(new Float32Array(100), opts);
    const c = booth.importTake(new Float32Array(100), opts);
    expect(booth.takes.map((t) => t.name)).toEqual(['Take 1', 'Take 2', 'Take 3']);
    expect(booth.selectedTakeId).toBe(c.id);
    expect(a.duration).toBeCloseTo(4, 6);
    expect(a.bars).toBe(2);
    expect(a.bpm).toBe(120);

    booth.selectTake(a.id);
    expect(booth.selectedTakeId).toBe(a.id);
    booth.selectTake('nope');
    expect(booth.selectedTakeId).toBe(a.id);

    booth.deleteTake(b.id); // not selected: selection stays
    expect(booth.selectedTakeId).toBe(a.id);
    booth.deleteTake(a.id); // selected: falls back to newest remaining
    expect(booth.selectedTakeId).toBe(c.id);
    booth.deleteTake('nope');
    booth.deleteTake(c.id);
    expect(booth.takes).toEqual([]);
    expect(booth.selectedTakeId).toBe(null);
    expect(booth.importTake(new Float32Array(10), opts).name).toBe('Take 4');
    expect(changes).toHaveBeenCalled();

    // takes is a copy
    booth.takes[0].name = 'x';
    expect(booth.takes[0].name).toBe('Take 4');
  });

  it('render without a take rejects', async () => {
    const { booth } = offlineBooth();
    await expect(booth.renderMix()).rejects.toThrow('no-take');
  });
});

describe('latency compensation', () => {
  it('renderVocal puts clicks back on the beat, offset shifts them', async () => {
    const { booth } = offlineBooth();
    const bpm = 120;
    const L = await settledLatency(booth, SR);
    expect(booth.autoLatencyMs).toBeGreaterThan(5); // master chain delay
    const { samples } = clickTake({ bpm, bars: 2, sampleRate: SR, delaySec: L / 1000 });
    booth.importTake(samples, { bpm, bars: 2, sampleRate: SR });

    const dry = await booth.renderVocal();
    expect(dry.numberOfChannels).toBe(1);
    expect(dry.length).toBe(Math.round(4 * SR));
    const onsets = findOnsets(dry.getChannelData(0), 0.05, 1000);
    const expected = Array.from({ length: 8 }, (_, k) => Math.round(k * beatSec(bpm) * SR));
    expect(onsets.length).toBe(8);
    onsets.forEach((o, k) => expect(Math.abs(o - expected[k])).toBeLessThanOrEqual(1));
    expect(peak(dry)).toBeCloseTo(0.6, 3); // not boosted

    booth.setLatencyOffset(booth.latencyOffsetMs + 20);
    const shifted = findOnsets((await booth.renderVocal()).getChannelData(0), 0.05, 1000);
    const shift = Math.round(0.02 * SR);
    // first click moved before 0 and is cut
    expect(shifted.length).toBe(7);
    shifted.forEach((o, k) => expect(Math.abs(o - (expected[k + 1] - shift))).toBeLessThanOrEqual(1));
  });

  it('offset is clamped to -200..200 ms', () => {
    const { booth } = offlineBooth();
    expect(booth.setLatencyOffset(500)).toBe(200);
    expect(booth.setLatencyOffset(-999)).toBe(-200);
    expect(booth.setLatencyOffset('x')).toBe(-200);
    expect(booth.latencyMs).toBeGreaterThanOrEqual(-PRE_ROLL * 1000);
  });

  it('renderVocal scales down a hot take and never boosts', async () => {
    const { booth } = offlineBooth();
    const hot = new Float32Array(SR).fill(0);
    hot[1000] = 1.8;
    booth.importTake(hot, { bpm: 120, bars: 2, sampleRate: SR });
    expect(peak(await booth.renderVocal())).toBeCloseTo(0.99, 4);
  });
});

describe('renderMix', () => {
  it('beat + take is non-silent, below 0 dBFS, with a tail', async () => {
    const { booth } = offlineBooth(PRESETS.afroBass.pattern);
    const bpm = 104;
    const L = await settledLatency(booth, SR);
    const { samples } = clickTake({ bpm, bars: 2, sampleRate: SR, delaySec: L / 1000 });
    booth.importTake(samples, { bpm, bars: 2, sampleRate: SR });
    const mix = await booth.renderMix();
    const p = peak(mix);
    console.log(`[mix] peak ${p.toFixed(4)} (${(20 * Math.log10(p)).toFixed(2)} dBFS)`);
    expect(mix.numberOfChannels).toBe(2);
    expect(mix.sampleRate).toBe(SR);
    expect(mix.length).toBe(Math.ceil((2 * 4 * beatSec(bpm) + 1) * SR));
    expect(p).toBeGreaterThan(0.1);
    expect(p).toBeLessThan(1);
  });

  it('vocal clicks land where the beat lands', async () => {
    const bpm = 120;
    const { booth } = offlineBooth(emptyPattern(bpm));
    const L = await settledLatency(booth, SR);
    const { samples } = clickTake({ bpm, bars: 2, sampleRate: SR, delaySec: L / 1000 });
    booth.importTake(samples, { bpm, bars: 2, sampleRate: SR });
    const mix = await booth.renderMix();
    const vocal = findOnsets(mix.getChannelData(0), 0.02, 2000);

    const beat = await renderPatternOffline(
      { ...emptyPattern(bpm), steps: { rim: on(0, 4, 8, 12) } },
      { bars: 2, sampleRate: SR, OfflineAudioContext, tail: 1 },
    );
    const rim = findOnsets(beat.getChannelData(0), 0.02, 2000);
    expect(vocal.length).toBe(8);
    expect(rim.length).toBe(8);
    vocal.forEach((o, k) => expect(Math.abs(o - rim[k]) / SR).toBeLessThan(0.0015));
  });

  it('uses the take tempo, not the current one', async () => {
    const { engine, booth } = offlineBooth(emptyPattern(90));
    booth.importTake(new Float32Array(10), { bpm: 120, bars: 2, sampleRate: SR });
    engine.setBpm(150);
    const mix = await booth.renderMix();
    expect(mix.length).toBe(Math.ceil((4 + 1) * SR));
  });
});

describe('mic', () => {
  const engine = () => createEngine({ context: new OfflineAudioContext(2, SR, SR) });

  it('maps errors', () => {
    const err = (name) => Object.assign(new Error('x'), { name });
    expect(mapMicError(err('NotAllowedError')).message).toBe('mic-denied');
    expect(mapMicError(err('SecurityError')).message).toBe('mic-denied');
    expect(mapMicError(err('NotFoundError')).message).toBe('mic-unavailable');
    expect(mapMicError(err('NotReadableError')).message).toBe('mic-busy');
    expect(mapMicError(err('OverconstrainedError')).message).toBe('mic-unavailable');
    expect(mapMicError(undefined).message).toBe('mic-unavailable');
  });

  it('openMic rejects with mic-denied / mic-unavailable', async () => {
    const reject = (name) => () => Promise.reject(Object.assign(new Error('x'), { name }));
    await expect(createBooth(engine(), { getUserMedia: reject('NotAllowedError') }).openMic())
      .rejects.toThrow('mic-denied');
    await expect(createBooth(engine(), { getUserMedia: reject('NotFoundError') }).openMic())
      .rejects.toThrow('mic-unavailable');
    // no navigator.mediaDevices in node
    await expect(createBooth(engine()).openMic()).rejects.toThrow('mic-unavailable');
  });

  it('requests raw mono audio', async () => {
    const gum = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
    await createBooth(engine(), { getUserMedia: gum }).openMic().catch(() => {});
    const c = gum.mock.calls[0][0];
    expect(c.audio.echoCancellation).toBe(false);
    expect(c.audio.noiseSuppression).toBe(false);
    expect(c.audio.autoGainControl).toBe(false);
    expect(c.audio.channelCount).toEqual({ ideal: 1 });
    expect(c.video).toBe(false);
  });

  it('record() without an open mic rejects', async () => {
    await expect(createBooth(engine()).record()).rejects.toThrow('mic-closed');
  });
});

describe('capture worklet', () => {
  it('captures exactly the requested frames', async () => {
    const sr = 48000;
    const ctx = new OfflineAudioContext(1, sr, sr);
    const imp = ctx.createBuffer(1, sr, sr);
    const d = imp.getChannelData(0);
    for (let i = 0; i < sr; i++) d[i] = i / sr; // ramp: value encodes the frame
    const src = ctx.createBufferSource();
    src.buffer = imp;
    const capture = await createCapture(ctx, { AudioWorkletNode });
    expect(capture.kind).toBe('worklet');
    src.connect(capture.node);
    src.start(0);
    const from = 10007; // not on a render quantum boundary
    const to = 30011;
    const got = capture.record(from, to);
    await ctx.startRendering();
    const data = await got;
    expect(data.length).toBe(to - from);
    for (const i of [0, 1, 500, to - from - 1]) expect(data[i]).toBeCloseTo((from + i) / sr, 6);
    capture.dispose();
  });
});

describe('script processor fallback', () => {
  it('captures the requested range to within one block', async () => {
    const sr = 48000;
    const ctx = new OfflineAudioContext(1, sr, sr);
    const ramp = ctx.createBuffer(1, sr, sr);
    const d = ramp.getChannelData(0);
    for (let i = 0; i < sr; i++) d[i] = i / sr;
    const src = ctx.createBufferSource();
    src.buffer = ramp;
    const capture = await createCapture(ctx, { forceScriptProcessor: true });
    expect(capture.kind).toBe('script-processor');
    src.connect(capture.node);
    src.start(0);
    const got = capture.record(10000, 30000);
    await ctx.startRendering();
    const data = await got;
    expect(data.length).toBe(20000);
    expect(Math.abs(data[5000] * sr - 15000)).toBeLessThanOrEqual(2 * 2048);
    capture.dispose();
  });
});

describe('record (realtime context, synthetic mic)', () => {
  let ctx;
  afterEach(async () => { if (ctx) await ctx.close(); ctx = null; });

  it('counts in, records the bars aligned to bar 1, stops the beat it started', async () => {
    ctx = new AudioContext({ sinkId: { type: 'none' }, latencyHint: 'interactive' });
    const sr = ctx.sampleRate;
    const engine = createEngine({ context: ctx });
    engine.setPattern({ ...PRESETS.trap.pattern, bpm: 180 });
    const micBus = ctx.createGain();
    const track = { stop: vi.fn(), getSettings: () => ({}) };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const booth = createBooth(engine, {
      getUserMedia: async () => stream,
      createSource: () => micBus,
      OfflineAudioContext,
      AudioWorkletNode,
    });
    await booth.openMic();
    expect(booth.micOpen).toBe(true);
    booth.setBars(2);
    expect(booth.setMonitoring(true)).toBe(true);
    booth.setMonitoring(false);

    const bpm = 180;
    const delay = 0.025; // pretend the rapper is heard/captured 25 ms late
    const clickBuf = ctx.createBuffer(1, 32, sr);
    clickBuf.getChannelData(0).fill(0.5);
    let scheduled = 0;
    const states = new Set();
    booth.onChange(() => {
      states.add(booth.state);
      const prog = booth.getRecordProgress();
      if (scheduled || !prog?.startTime) return;
      const f0 = Math.round(prog.startTime * sr);
      scheduled = 8;
      for (let k = 0; k < 8; k++) {
        const s = ctx.createBufferSource();
        s.buffer = clickBuf;
        s.connect(micBus);
        s.start((f0 + Math.round((k * beatSec(bpm) + delay) * sr)) / sr);
      }
    });
    const pending = booth.record();
    expect(booth.state).toBe('count-in');
    const take = await pending;
    expect(take).toBeTruthy();
    expect(take.name).toBe('Take 1');
    expect(take.bars).toBe(2);
    expect(take.bpm).toBe(180);
    expect(states.has('count-in')).toBe(true);
    expect(booth.state).toBe('idle');
    expect(engine.isPlaying).toBe(false);

    const L = booth.latencyMs;
    const vocal = (await booth.renderVocal()).getChannelData(0);
    const onsets = findOnsets(vocal, 0.1, 1000);
    const shift = Math.round((L / 1000) * sr);
    const expected = Array.from({ length: 8 }, (_, k) => Math.round((k * beatSec(bpm) + delay) * sr) - shift);
    expect(onsets.length).toBe(8);
    onsets.forEach((o, k) => expect(Math.abs(o - expected[k])).toBeLessThanOrEqual(1));
    // count-in clicks and the beat are not in the recording: only the 8 synthetic clicks
    // (each may smear by a sample from sub-sample start times)
    let nonZero = 0;
    for (const x of vocal) if (x !== 0) nonZero++;
    expect(nonZero).toBeLessThanOrEqual(8 * 34);

    booth.closeMic();
    expect(track.stop).toHaveBeenCalled();
    expect(booth.micOpen).toBe(false);
  }, 20000);

  it('cancel() drops the take and stops the beat', async () => {
    ctx = new AudioContext({ sinkId: { type: 'none' }, latencyHint: 'interactive' });
    const engine = createEngine({ context: ctx });
    const micBus = ctx.createGain();
    const stream = { getTracks: () => [], getAudioTracks: () => [] };
    const booth = createBooth(engine, {
      getUserMedia: async () => stream, createSource: () => micBus, OfflineAudioContext, AudioWorkletNode,
    });
    await booth.openMic();
    const pending = booth.record();
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.isPlaying).toBe(true);
    booth.cancel();
    expect(await pending).toBe(null);
    expect(booth.takes).toEqual([]);
    expect(booth.state).toBe('idle');
    expect(engine.isPlaying).toBe(false);
    booth.dispose();
  }, 10000);
});

/** Engine on an OfflineAudioContext whose resume() resolves before rendering. */
function offlineMicBooth(seconds = 0.5, boothOpts = {}) {
  const ctx = new OfflineAudioContext(1, Math.round(seconds * SR), SR);
  const engine = createEngine({ context: ctx });
  engine.resume = async () => ctx;
  const track = { stop: vi.fn(), getSettings: () => ({}) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const booth = createBooth(engine, {
    getUserMedia: async () => stream, OfflineAudioContext, AudioWorkletNode, ...boothOpts,
  });
  return { ctx, engine, booth, track };
}

describe('monitoring', () => {
  for (const on of [false, true]) {
    it(`monitoring ${on ? 'on: mic is audible' : 'off: destination stays silent'}`, async () => {
      const { ctx, booth } = offlineMicBooth(0.5, {
        createSource: (c) => {
          const osc = c.createOscillator();
          osc.start(0);
          return osc;
        },
      });
      await booth.openMic();
      booth.setMonitoring(on);
      const out = await ctx.startRendering();
      const tail = out.getChannelData(0).subarray(Math.round(0.2 * SR));
      let p = 0;
      for (const x of tail) p = Math.max(p, Math.abs(x));
      if (on) expect(p).toBeGreaterThan(0.5);
      else expect(p).toBe(0);
    });
  }

  it('closeMic resets monitoring', async () => {
    const { booth } = offlineMicBooth(0.5, { createSource: (c) => c.createGain() });
    await booth.openMic();
    booth.setMonitoring(true);
    booth.closeMic();
    expect(booth.monitoring).toBe(false);
  });
});

describe('mic lifecycle', () => {
  it('dispose() during a pending getUserMedia stops the stream when it arrives', async () => {
    let resolve;
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const { booth } = offlineMicBooth(0.5, {
      getUserMedia: () => new Promise((r) => { resolve = r; }),
      createSource: (c) => c.createGain(),
    });
    const opening = booth.openMic();
    booth.dispose();
    resolve(stream);
    await opening;
    expect(track.stop).toHaveBeenCalled();
    expect(booth.micOpen).toBe(false);
  });

  it('a failed setup disconnects the mic nodes and stops the tracks', async () => {
    let source;
    const { booth, track } = offlineMicBooth(0.5, {
      createSource: (c) => {
        source = c.createGain();
        vi.spyOn(source, 'disconnect');
        return source;
      },
      AudioWorkletNode: class { constructor() { throw new Error('boom'); } },
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(booth.openMic()).rejects.toThrow('mic-unavailable');
    expect(source.disconnect).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(booth.micOpen).toBe(false);
    quiet.mockRestore();
  });
});

describe('takes keep their own latency', () => {
  it('a device change after recording does not move existing takes', async () => {
    const { engine, booth } = offlineBooth();
    const ctx = engine.context;
    Object.defineProperty(ctx, 'outputLatency', { configurable: true, value: 0.05 });
    const L = await settledLatency(booth, SR);
    const { samples } = clickTake({ bpm: 120, bars: 2, sampleRate: SR, delaySec: L / 1000 });
    const take = booth.importTake(samples, { bpm: 120, bars: 2, sampleRate: SR });
    expect(take.autoLatencyMs).toBeCloseTo(booth.autoLatencyMs, 6);
    const before = findOnsets((await booth.renderVocal()).getChannelData(0), 0.05, 1000);

    // e.g. switched to Bluetooth headphones
    Object.defineProperty(ctx, 'outputLatency', { configurable: true, value: 0.2 });
    expect(booth.latencyMs).toBeCloseTo(L + 150, 6);
    const after = findOnsets((await booth.renderVocal()).getChannelData(0), 0.05, 1000);
    expect(after).toEqual(before);
    expect(before[0]).toBe(0);
  });

  it('take peak ignores the pre/post roll', () => {
    const pre = Math.round(PRE_ROLL * SR);
    const len = 4 * SR; // 2 bars at 120
    const raw = new Float32Array(pre + len + SR).fill(0.1);
    raw[pre - 10] = 0.9; // count-in bleed before bar 1
    raw[pre + len + 100] = 0.9; // noise after the last bar
    const take = makeTake(raw, { id: 'a', name: 'A', bpm: 120, bars: 2, sampleRate: SR });
    expect(take.meta.peak).toBeCloseTo(0.1, 6);
    expect(vocalGain(take.meta.peak)).toBeCloseTo(4, 6);
  });
});

describe('renderMix side effects', () => {
  it('leaves the project pattern unchanged', async () => {
    const { engine, booth } = offlineBooth(PRESETS.boomBap.pattern);
    const before = engine.getPattern();
    booth.importTake(new Float32Array(10), { bpm: 120, bars: 2, sampleRate: SR });
    await booth.renderMix();
    expect(engine.getPattern()).toEqual(before);
  });
});

describe('realtime booth (synthetic mic)', () => {
  let ctx;
  afterEach(async () => { if (ctx) await ctx.close(); ctx = null; });

  function realtimeBooth(pattern) {
    ctx = new AudioContext({ sinkId: { type: 'none' }, latencyHint: 'interactive' });
    const engine = createEngine({ context: ctx });
    if (pattern) engine.setPattern(pattern);
    const micBus = ctx.createGain();
    const track = { stop: vi.fn(), getSettings: () => ({}) };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const booth = createBooth(engine, {
      getUserMedia: async () => stream, createSource: () => micBus, OfflineAudioContext, AudioWorkletNode,
    });
    return { engine, booth, track, micBus };
  }

  it('count-in and beat never reach a silent mic: take is all zeros', async () => {
    const { engine, booth } = realtimeBooth({ ...PRESETS.trap.pattern, bpm: 180 });
    await booth.openMic();
    booth.setBars(2);
    const take = await booth.record();
    expect(take).toBeTruthy();
    expect(take.peak).toBe(0);
    const v = (await booth.renderVocal()).getChannelData(0);
    expect(v.every((x) => x === 0)).toBe(true);
    expect(engine.isPlaying).toBe(false);
    booth.dispose();
  }, 20000);

  it('closeMic mid-recording resolves null, stops tracks and the beat', async () => {
    const { engine, booth, track } = realtimeBooth();
    await booth.openMic();
    const pending = booth.record();
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.isPlaying).toBe(true);
    booth.closeMic();
    expect(await pending).toBe(null);
    expect(track.stop).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
    expect(booth.state).toBe('idle');
    expect(booth.takes).toEqual([]);
  }, 10000);

  it('playTake withBeat plays at the take tempo and leaves the project bpm alone', async () => {
    const { engine, booth } = realtimeBooth(emptyPattern(90));
    const changes = vi.fn();
    engine.onPatternChange(changes);
    booth.importTake(new Float32Array(10), { bpm: 120, bars: 2, sampleRate: ctx.sampleRate });
    await booth.playTake(undefined, { withBeat: true });
    expect(booth.previewTakeId).toBeTruthy();
    expect(engine.isPlaying).toBe(true);
    expect(engine.clock.secondsPerStep).toBeCloseTo(60 / 120 / 4, 9);
    booth.stopPreview();
    expect(engine.isPlaying).toBe(false);
    expect(engine.clock.bpm).toBe(90);
    expect(engine.getPattern().bpm).toBe(90);
    expect(engine.clock.secondsPerStep).toBeCloseTo(60 / 90 / 4, 9);
    expect(changes).not.toHaveBeenCalled();
    booth.dispose();
  }, 10000);

  it('records on a real downbeat right after Play (start still in progress)', async () => {
    const { engine, booth } = realtimeBooth(emptyPattern(180));
    await booth.openMic();
    booth.setBars(2);
    booth.setCountIn(false);
    engine.start(); // not awaited
    const pending = booth.record();
    await new Promise((r) => setTimeout(r, 50));
    const prog = booth.getRecordProgress();
    expect(prog.startTime).not.toBe(null);
    expect(engine.getNextBarTime(prog.startTime - 1e-6)).toBeCloseTo(prog.startTime, 9);
    booth.cancel();
    expect(await pending).toBe(null);
    expect(engine.isPlaying).toBe(true); // the user's beat keeps going
    engine.stop();
    booth.dispose();
  }, 10000);
});

// ---- input devices ----

const dev = (deviceId, label = '', groupId = '') => ({ kind: 'audioinput', deviceId, label, groupId });

function fakeTrack(label = 'Mic') {
  return {
    label, muted: false, enabled: true, readyState: 'live', onended: null,
    stop: vi.fn(function stop() { this.readyState = 'ended'; }),
    getSettings: () => ({}),
  };
}

/** mediaDevices stub: exact ids not in `present` throw OverconstrainedError. */
function fakeMediaDevices({ devices = [], present = null, fail = null } = {}) {
  const handlers = new Set();
  const tracks = [];
  return {
    tracks,
    handlers,
    enumerateDevices: vi.fn(async () => devices),
    getUserMedia: vi.fn(async (c) => {
      if (fail) throw Object.assign(new Error('x'), { name: fail });
      const id = c.audio.deviceId?.exact;
      if (id && present && !present.includes(id)) {
        throw Object.assign(new Error('x'), { name: 'OverconstrainedError', constraint: 'deviceId' });
      }
      const track = fakeTrack(id ? `Mic ${id}` : 'Default mic');
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    }),
    addEventListener: vi.fn((type, h) => handlers.add(h)),
    removeEventListener: vi.fn((type, h) => handlers.delete(h)),
    fire: () => handlers.forEach((h) => h()),
  };
}

function deviceBooth(md, extra = {}) {
  return offlineMicBooth(0.5, {
    mediaDevices: md, getUserMedia: undefined, createSource: (c) => c.createGain(), ...extra,
  });
}

describe('listInputs', () => {
  it('falls back to numbered labels before permission and collapses blank ids', async () => {
    const md = fakeMediaDevices({
      devices: [dev(''), dev(''), { kind: 'audiooutput', deviceId: '', label: '' }],
    });
    expect(await listInputDevices(md)).toEqual([{ deviceId: '', label: 'Microphone 1', isDefault: true }]);
  });

  it('numbers unlabeled devices; first is default without a pseudo entry', async () => {
    const md = fakeMediaDevices({ devices: [dev('a'), dev('b', 'USB Mic'), dev('c')] });
    const { booth } = deviceBooth(md);
    expect(await booth.listInputs()).toEqual([
      { deviceId: 'a', label: 'Microphone 1', isDefault: true },
      { deviceId: 'b', label: 'USB Mic', isDefault: false },
      { deviceId: 'c', label: 'Microphone 3', isDefault: false },
    ]);
  });

  it("keeps Chrome's 'default' as the default entry and drops 'communications'", async () => {
    const md = fakeMediaDevices({
      devices: [
        dev('default', 'Default - Microphone (Realtek(R) Audio)', 'g1'),
        dev('communications', 'Communications - Microphone (Realtek(R) Audio)', 'g1'),
        dev('r1', 'Microphone (Realtek(R) Audio)', 'g1'),
        dev('u1', 'USB Mic', 'g2'),
      ],
    });
    expect(await listInputDevices(md)).toEqual([
      { deviceId: 'default', label: 'Default (Microphone (Realtek(R) Audio))', isDefault: true },
      { deviceId: 'r1', label: 'Microphone (Realtek(R) Audio)', isDefault: false },
      { deviceId: 'u1', label: 'USB Mic', isDefault: false },
    ]);
    // an unlabeled default entry borrows its group's label
    const md2 = fakeMediaDevices({ devices: [dev('default', '', 'g2'), dev('u1', 'USB Mic', 'g2')] });
    expect((await listInputDevices(md2))[0].label).toBe('Default (USB Mic)');
  });

  it('no mediaDevices: empty list', async () => {
    expect(await listInputDevices(undefined)).toEqual([]);
  });
});

describe('input selection', () => {
  it('openMic passes the exact deviceId; default ids pass none', async () => {
    const md = fakeMediaDevices({ present: ['u1'] });
    const { booth } = deviceBooth(md);
    await booth.openMic({ deviceId: 'u1' });
    const c = md.getUserMedia.mock.calls[0][0].audio;
    expect(c.deviceId).toEqual({ exact: 'u1' });
    expect(c.echoCancellation).toBe(false);
    expect(booth.inputDeviceId).toBe('u1');
    expect(booth.inputLabel).toBe('Mic u1');
    expect(booth.lastFallback).toBe(false);
    booth.closeMic();
    expect(booth.inputDeviceId).toBe('u1'); // remembered for the next openMic()
    await booth.openMic();
    expect(md.getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'u1' });
    booth.closeMic();
    await booth.openMic({ deviceId: 'default' });
    expect(md.getUserMedia.mock.calls[2][0].audio.deviceId).toBeUndefined();
    expect(booth.inputDeviceId).toBe(null);
  });

  it('a missing device falls back to the default input and reports it', async () => {
    const md = fakeMediaDevices({ present: [] });
    const { booth } = deviceBooth(md);
    const events = [];
    booth.onDevicesChange((e) => events.push(e));
    await booth.openMic({ deviceId: 'gone' });
    expect(booth.micOpen).toBe(true);
    expect(md.getUserMedia).toHaveBeenCalledTimes(2);
    expect(md.getUserMedia.mock.calls[1][0].audio.deviceId).toBeUndefined();
    expect(booth.lastFallback).toBe(true);
    expect(booth.inputDeviceId).toBe(null);
    expect(booth.getMicStatus().fallback).toBe(true);
    expect(events).toEqual([{ reason: 'fallback', deviceId: 'gone' }]);
  });

  it('NotFoundError for an exact id also falls back', async () => {
    const md = fakeMediaDevices();
    md.getUserMedia.mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), { name: 'NotFoundError' });
    });
    const { booth } = deviceBooth(md);
    await booth.openMic({ deviceId: 'gone' });
    expect(booth.micOpen).toBe(true);
    expect(booth.lastFallback).toBe(true);
  });

  it('setInputDevice swaps the open mic, stops old tracks, keeps monitoring', async () => {
    const md = fakeMediaDevices({ present: ['a', 'b'] });
    const { booth } = deviceBooth(md);
    await booth.openMic({ deviceId: 'a' });
    booth.setMonitoring(true);
    const [oldTrack] = md.tracks;
    await booth.setInputDevice('b');
    expect(oldTrack.stop).toHaveBeenCalled();
    expect(oldTrack.onended).toBe(null);
    expect(booth.micOpen).toBe(true);
    expect(booth.inputDeviceId).toBe('b');
    expect(booth.inputLabel).toBe('Mic b');
    expect(booth.monitoring).toBe(true);
    expect(md.getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'b' });
    // same device: no reopen
    await booth.setInputDevice('b');
    expect(md.getUserMedia).toHaveBeenCalledTimes(2);
    // openMic with another id while open also swaps
    await booth.openMic({ deviceId: 'a' });
    expect(booth.inputDeviceId).toBe('a');
    expect(md.tracks[1].stop).toHaveBeenCalled();
  });

  it('setInputDevice while closed only remembers the choice', async () => {
    const md = fakeMediaDevices({ present: ['b'] });
    const { booth } = deviceBooth(md);
    await booth.setInputDevice('b');
    expect(md.getUserMedia).not.toHaveBeenCalled();
    expect(booth.inputDeviceId).toBe('b');
    await booth.openMic();
    expect(md.getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'b' });
  });

  it('device-lost: track ended closes the mic and reports it', async () => {
    const md = fakeMediaDevices({ present: ['u1'] });
    const { booth } = deviceBooth(md);
    const events = [];
    const off = booth.onDevicesChange((e) => events.push(e));
    await booth.openMic({ deviceId: 'u1' });
    const [track] = md.tracks;
    track.onended();
    expect(booth.micOpen).toBe(false);
    expect(track.stop).toHaveBeenCalled();
    expect(events).toEqual([{ reason: 'device-lost', deviceId: 'u1', label: 'Mic u1' }]);

    md.fire();
    expect(events[1]).toEqual({ reason: 'devicechange' });
    off();
    expect(md.handlers.size).toBe(0);
  });

  it('maps getUserMedia errors', async () => {
    for (const [name, msg] of [
      ['NotReadableError', 'mic-busy'],
      ['NotAllowedError', 'mic-denied'],
      ['SecurityError', 'mic-denied'],
      ['NotFoundError', 'mic-unavailable'],
    ]) {
      const { booth } = deviceBooth(fakeMediaDevices({ fail: name }));
      await expect(booth.openMic()).rejects.toThrow(msg);
      expect(booth.micOpen).toBe(false);
    }
    // the default fallback can fail too
    const { booth } = deviceBooth(fakeMediaDevices({ fail: 'NotFoundError' }));
    await expect(booth.openMic({ deviceId: 'gone' })).rejects.toThrow('mic-unavailable');
  });

  it('getMicStatus reports the track and context', async () => {
    const md = fakeMediaDevices({ present: ['u1'] });
    const { booth } = deviceBooth(md);
    expect(booth.getMicStatus()).toMatchObject({ open: false, label: '', silentForMs: 0 });
    await booth.openMic({ deviceId: 'u1' });
    md.tracks[0].muted = true;
    expect(booth.getMicStatus()).toMatchObject({
      open: true, deviceId: 'u1', label: 'Mic u1', muted: true, enabled: true,
      readyState: 'live', sampleRate: SR, fallback: false,
    });
    expect(typeof booth.getMicStatus().contextState).toBe('string');
  });
});

describe('input devices (realtime)', () => {
  let ctx;
  afterEach(async () => { if (ctx) await ctx.close(); ctx = null; });

  it("setInputDevice while recording rejects with 'busy' and keeps the mic", async () => {
    ctx = new AudioContext({ sinkId: { type: 'none' }, latencyHint: 'interactive' });
    const engine = createEngine({ context: ctx });
    const md = fakeMediaDevices({ present: ['a', 'b'] });
    const booth = createBooth(engine, {
      mediaDevices: md, createSource: () => ctx.createGain(), OfflineAudioContext, AudioWorkletNode,
    });
    await booth.openMic({ deviceId: 'a' });
    const pending = booth.record();
    await expect(booth.setInputDevice('b')).rejects.toThrow('busy');
    expect(booth.inputDeviceId).toBe('a');
    expect(md.tracks[0].stop).not.toHaveBeenCalled();
    booth.cancel();
    expect(await pending).toBe(null);
    booth.dispose();
  }, 10000);

  it('silentForMs grows on a silent input and resets with signal', async () => {
    ctx = new AudioContext({ sinkId: { type: 'none' }, latencyHint: 'interactive' });
    const engine = createEngine({ context: ctx });
    const micBus = ctx.createGain();
    let t = 1000;
    const booth = createBooth(engine, {
      mediaDevices: fakeMediaDevices(), createSource: () => micBus,
      OfflineAudioContext, AudioWorkletNode, now: () => t,
    });
    await booth.openMic();
    await new Promise((r) => setTimeout(r, 100));
    expect(booth.getMicStatus().silentForMs).toBe(0); // first silent poll starts the clock
    t += 1500;
    expect(booth.getInputLevel()).toBe(0);
    t += 1600;
    const s = booth.getMicStatus();
    expect(s.silentForMs).toBe(3100);
    expect(s.contextState).toBe('running');

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.01; // -40 dBFS
    osc.connect(g).connect(micBus);
    osc.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(booth.getInputLevel()).toBeGreaterThan(0.005);
    expect(booth.getMicStatus().silentForMs).toBe(0);

    osc.stop();
    osc.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    booth.getInputLevel();
    t += 500;
    expect(booth.getMicStatus().silentForMs).toBe(500);
    booth.dispose();
  }, 10000);
});
