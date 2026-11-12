import { describe, it, expect, vi } from 'vitest';
import { OfflineAudioContext, AudioWorkletNode } from 'node-web-audio-api';
import {
  createSampler, chopSignal, findOnsets, trimSilence, toBase64, fromBase64, parseWav,
  MAX_SOURCES, MAX_SAMPLES,
} from '../src/audio/sampler.js';
import { createSampleStore } from '../src/audio/sampleStore.js';
import { createBooth } from '../src/audio/booth.js';
import { encodeWav } from '../src/audio/wav.js';
import { emptyPattern, normalizePattern } from '../src/audio/pattern.js';

vi.setConfig({ testTimeout: 20000 });

const SR = 48000;

function fakeEngine(extra = {}) {
  const context = new OfflineAudioContext(2, 128, SR);
  return {
    context,
    master: context.destination,
    resume: async () => context,
    setSampleVoices: vi.fn(),
    removeTrack: vi.fn(),
    trigger: vi.fn(),
    ...extra,
  };
}

function wavFile(channels, sampleRate = SR, name = 'loop.wav') {
  const bytes = encodeWav({
    numberOfChannels: channels.length, sampleRate, length: channels[0].length, getChannelData: (c) => channels[c],
  });
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.slice(0) };
}

function sine(seconds, sampleRate = SR, amp = 0.5, hz = 220) {
  const x = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return x;
}

// decaying noise bursts at the given times (s), with optional quiet noise floor
function hits(seconds, times, { amps = [], decay = 0.05, noise = 0, sampleRate = SR, seed = 1 } = {}) {
  let r = seed;
  const rand = () => { r = (r * 16807) % 2147483647; return r / 2147483647 * 2 - 1; };
  const x = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < x.length; i++) x[i] = noise * rand();
  times.forEach((t, k) => {
    const a = amps[k] ?? 0.7;
    const at = Math.round(t * sampleRate);
    for (let j = 0; at + j < x.length && j < sampleRate; j++) x[at + j] += a * Math.exp(-j / (decay * sampleRate)) * rand();
  });
  return x;
}

function fakeBooth(take = null) {
  const booth = {
    micOpen: false,
    openMic: vi.fn(async () => { booth.micOpen = true; }),
    clip: null,
    captureClip: vi.fn(async () => booth.clip),
    cancelClip: vi.fn(),
    getTakeAudio: vi.fn((id) => {
      if (!take || id !== 'take-1') throw new Error('no-take');
      return take;
    }),
  };
  return booth;
}

function fakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  return {
    open(name) {
      const req = {};
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) {
          const stores = new Map();
          db = {
            objectStoreNames: { contains: (n) => stores.has(n) },
            createObjectStore: (n) => stores.set(n, new Map()),
            close() {},
            transaction(n) {
              const map = stores.get(n);
              const tx = {};
              const op = (fn) => {
                const r = {};
                later(() => { r.result = fn(); later(() => tx.oncomplete?.()); });
                return r;
              };
              tx.objectStore = () => ({
                get: (k) => op(() => (map.has(k) ? structuredClone(map.get(k)) : undefined)),
                put: (v, k) => op(() => { map.set(k, structuredClone(v)); return k; }),
                delete: (k) => op(() => { map.delete(k); }),
              });
              return tx;
            },
          };
          dbs.set(name, db);
        }
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const memoryStore = () => createSampleStore({ indexedDB: fakeIndexedDB() });

describe('sources', () => {
  it('decodes a file into a source', async () => {
    const sampler = createSampler(fakeEngine(), { store: null });
    const src = await sampler.fromFile(wavFile([sine(1)], SR, 'my loop.wav'));
    expect(src.name).toBe('my loop');
    expect(src.duration).toBeCloseTo(1, 3);
    expect(sampler.sources).toEqual([src]);
  });

  it('decodes before an AudioContext exists', async () => {
    const sampler = createSampler(fakeEngine({ context: null }), { store: null, OfflineAudioContext });
    const src = await sampler.fromFile(wavFile([sine(0.5), sine(0.5)]));
    expect(src.channels).toBe(2);
  });

  it('rejects garbage, sources over 30 s and a ninth source', async () => {
    const sampler = createSampler(fakeEngine(), { store: null });
    const junk = { name: 'x.mp3', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    await expect(sampler.fromFile(junk)).rejects.toThrow('decode-failed');
    await expect(sampler.fromFile(wavFile([new Float32Array(31 * 8000)], 8000))).rejects.toThrow('too-long');
    for (let i = 0; i < MAX_SOURCES; i++) await sampler.fromFile(wavFile([sine(0.05)]));
    await expect(sampler.fromFile(wavFile([sine(0.05)]))).rejects.toThrow('too-many');
    sampler.removeSource(sampler.sources[0].id);
    await expect(sampler.fromFile(wavFile([sine(0.05)]))).resolves.toBeTruthy();
  });

  it('records through the booth mic, opens it first and trims silence', async () => {
    const booth = fakeBooth();
    const x = new Float32Array(SR * 2);
    x.set(sine(0.5), SR / 2);
    booth.clip = { samples: x, sampleRate: SR };
    const sampler = createSampler(fakeEngine(), { store: null, booth });
    const src = await sampler.record({ seconds: 30 });
    expect(booth.openMic).toHaveBeenCalled();
    expect(booth.captureClip).toHaveBeenCalledWith({ seconds: 10 });
    expect(src.name).toBe('Mic 1');
    expect(src.duration).toBeGreaterThan(0.5);
    expect(src.duration).toBeLessThan(0.6);
    booth.clip = { samples: new Float32Array(SR), sampleRate: SR };
    await expect(sampler.record()).rejects.toThrow('silent');
    booth.clip = null; // cancelled
    expect(await sampler.record()).toBe(null);
    expect(sampler.recording).toBe(false);
  });

  it('a cancel while the mic opens stops the recording before it starts', async () => {
    const booth = fakeBooth();
    let opened;
    booth.openMic = vi.fn(() => new Promise((r) => { opened = r; }));
    const sampler = createSampler(fakeEngine(), { store: null, booth });
    const pending = sampler.record();
    expect(sampler.recording).toBe(true);
    sampler.cancelRecord();
    opened();
    expect(await pending).toBe(null);
    expect(booth.captureClip).not.toHaveBeenCalled();
    expect(sampler.recording).toBe(false);
  });

  it('uses a booth take as a source', () => {
    const x = new Float32Array(SR);
    x.set(sine(0.25), SR / 4);
    const sampler = createSampler(fakeEngine(), { store: null, booth: fakeBooth({ samples: x, sampleRate: SR, name: 'Take 1' }) });
    const src = sampler.fromTake('take-1');
    expect(src.name).toBe('Take 1');
    expect(src.duration).toBeGreaterThan(0.25);
    expect(src.duration).toBeLessThan(0.35);
    expect(() => sampler.fromTake('nope')).toThrow('no-take');
  });

  it('peaks cover the source and a sample region', async () => {
    const sampler = createSampler(fakeEngine(), { store: null });
    const x = new Float32Array(SR);
    x.fill(0.5, SR / 2);
    const src = await sampler.fromFile(wavFile([x]));
    const p = sampler.getPeaks(src.id, 100);
    expect(p.max.length).toBe(100);
    expect(p.max[10]).toBe(0);
    expect(p.max[90]).toBeCloseTo(0.5, 3);
    expect(sampler.getPeaks(src.id, 100)).toBe(p); // cached
    const id = sampler.createSample(src.id, { start: 0.5, end: 1 });
    expect(Math.min(...sampler.getPeaks(id, 50).max)).toBeCloseTo(0.5, 3);
    expect(sampler.getPeaks('missing', 10).max.length).toBe(0);
  });
});

describe('chop', () => {
  it('finds each hit within 5 ms', () => {
    const times = [0.1, 0.35, 0.6, 0.73, 1.1, 1.5];
    const x = hits(2, times, { amps: [0.8, 0.5, 0.6, 0.3, 0.9, 0.4], noise: 0.001 });
    const regions = chopSignal(x, SR, { max: 16 });
    expect(regions.length).toBe(times.length);
    regions.forEach((r, k) => {
      expect(Math.abs(r.start / SR - times[k])).toBeLessThan(0.005);
      if (k + 1 < times.length) expect(r.end / SR).toBeLessThanOrEqual(times[k + 1]);
    });
  });

  it('finds quiet hats over a ringing 808', () => {
    const times = [0.05, 0.3, 0.55, 0.8];
    const x = hits(1.2, times.slice(1), { amps: [0.15, 0.15, 0.15], decay: 0.01 });
    const at = Math.round(times[0] * SR);
    for (let j = 0; at + j < x.length; j++) {
      x[at + j] += 0.8 * Math.exp(-j / (0.6 * SR)) * Math.sin((2 * Math.PI * 50 * j) / SR);
    }
    const onsets = findOnsets(x, SR).map((o) => o.at / SR);
    expect(onsets.length).toBe(4);
    onsets.forEach((t, k) => expect(Math.abs(t - times[k])).toBeLessThan(0.005));
  });

  it('keeps the loudest `max` regions in time order and skips near-silent ones', () => {
    const times = [0.1, 0.4, 0.7, 1.0, 1.3];
    const x = hits(1.6, times, { amps: [0.2, 0.9, 0.3, 0.8, 0.0002] });
    const all = chopSignal(x, SR, { max: 8 });
    expect(all.length).toBe(4); // the -74 dB one is not a hit
    const two = chopSignal(x, SR, { max: 2 }).map((r) => r.start / SR);
    expect(two.length).toBe(2);
    expect(Math.abs(two[0] - 0.4)).toBeLessThan(0.005);
    expect(Math.abs(two[1] - 1.0)).toBeLessThan(0.005);
  });

  it('chop() returns seconds within the source, silence gives nothing', async () => {
    const sampler = createSampler(fakeEngine(), { store: null });
    const src = await sampler.fromFile(wavFile([hits(1, [0.2, 0.6])]));
    const regions = sampler.chop(src.id);
    expect(regions.length).toBe(2);
    expect(Math.abs(regions[0].start - 0.2)).toBeLessThan(0.005);
    expect(regions[1].end).toBeLessThanOrEqual(src.duration);
    const part = sampler.chop(src.id, { start: 0.5 });
    expect(part.length).toBe(1);
    expect(Math.abs(part[0].start - 0.6)).toBeLessThan(0.005);
    expect(chopSignal(new Float32Array(SR), SR)).toEqual([]);
    expect(() => sampler.chop('nope')).toThrow('no-source');
  });
});

describe('samples', () => {
  async function withSource(seconds = 12) {
    const engine = fakeEngine();
    const sampler = createSampler(engine, { store: null });
    const src = await sampler.fromFile(wavFile([sine(seconds, 8000)], 8000));
    return { engine, sampler, src };
  }

  it('creates up to 16 samples of at most 10 s', async () => {
    const { sampler, src } = await withSource();
    const id = sampler.createSample(src.id, { start: 1, end: 12 });
    expect(id).toMatch(/^smp-[a-z0-9]+$/);
    const s = sampler.samples[0];
    expect(s.start).toBe(1);
    expect(s.end).toBe(11);
    expect(s.duration).toBe(10);
    expect(s.sourceId).toBe(src.id);
    for (let i = 1; i < MAX_SAMPLES; i++) sampler.createSample(src.id, { start: 0, end: 0.5 });
    expect(new Set(sampler.samples.map((x) => x.id)).size).toBe(MAX_SAMPLES);
    expect(() => sampler.createSample(src.id)).toThrow('too-many');
    expect(() => sampler.createSample('nope')).toThrow('no-source');
  });

  it('update clamps every setting', async () => {
    const { sampler, src } = await withSource(4);
    const id = sampler.createSample(src.id, { start: 1, end: 2 });
    let s = sampler.update(id, { gain: 3, pitch: 30, fadeIn: 0.8, fadeOut: 0.8, name: '  Kick   2 ' });
    expect(s.gain).toBe(1);
    expect(s.pitch).toBe(12);
    expect(s.fadeIn + s.fadeOut).toBeLessThanOrEqual(1);
    expect(s.fadeIn).toBeCloseTo(0.5, 3);
    expect(s.name).toBe('Kick 2');
    s = sampler.update(id, { gain: -1, pitch: -40.4, reverse: 1, start: -5, end: 99 });
    expect(s.gain).toBe(0);
    expect(s.pitch).toBe(-12);
    expect(s.reverse).toBe(true);
    expect(s.start).toBe(0);
    expect(s.end).toBe(4);
    s = sampler.update(id, { start: 3.5, end: 1 });
    expect(s.start).toBe(3.5);
    expect(s.end).toBeCloseTo(3.51, 4);
    expect(sampler.update(id, { gain: 'loud' }).gain).toBe(0);
    expect(sampler.update('nope', { gain: 1 })).toBe(null);
  });

  it('passes every sample to the engine; remove drops the track', async () => {
    const { engine, sampler, src } = await withSource(2);
    const a = sampler.createSample(src.id, { start: 0, end: 1 });
    const b = sampler.createSample(src.id, { start: 1, end: 2 });
    sampler.update(b, { reverse: true, pitch: -5 });
    let map = engine.setSampleVoices.mock.calls.at(-1)[0];
    expect(Object.keys(map)).toEqual([a, b]);
    expect(map[b]).toMatchObject({ start: 1, end: 2, reverse: true, pitch: -5, gain: 0.8 });
    expect(map[b].buffer.duration).toBeCloseTo(2, 3);
    expect(map[a].reverse).toBe(false);
    expect(sampler.audition(a)).toBe(true);
    expect(engine.trigger).toHaveBeenCalledWith(a);
    sampler.remove(a);
    expect(engine.removeTrack).toHaveBeenCalledWith(a);
    map = engine.setSampleVoices.mock.calls.at(-1)[0];
    expect(Object.keys(map)).toEqual([b]);
  });

  it('works with an engine that has no sample support yet', async () => {
    const engine = { context: new OfflineAudioContext(1, 128, SR), resume: async () => null };
    const sampler = createSampler(engine, { store: null });
    const src = await sampler.fromFile(wavFile([sine(0.5)]));
    const id = sampler.createSample(src.id);
    expect(sampler.audition(id)).toBe(false);
    expect(sampler.remove(id)).toBe(true);
  });

  it('samples outlive a removed source on a copy of their region only', async () => {
    const { engine, sampler, src } = await withSource(12);
    const id = sampler.createSample(src.id, { start: 3, end: 4 });
    const before = engine.setSampleVoices.mock.calls.at(-1)[0][id];
    const ref = before.buffer.getChannelData(0)[3 * before.buffer.sampleRate + 100];
    sampler.removeSource(src.id);
    expect(sampler.sources).toEqual([]);
    const s = sampler.getSample(id);
    expect(s.sourceId).toBe(null);
    expect(s.start).toBe(0);
    expect(s.duration).toBeCloseTo(1, 3);
    const def = engine.setSampleVoices.mock.calls.at(-1)[0][id];
    expect(def.buffer.duration).toBeCloseTo(1, 3);
    expect(def.buffer.getChannelData(0)[100]).toBe(ref);
    expect(sampler.update(id, { end: 50 }).end).toBeCloseTo(1, 3);
  });

  it('remove clears the row when the engine keeps it (last track)', async () => {
    const { engine, sampler, src } = await withSource(2);
    const id = sampler.createSample(src.id);
    let pattern = emptyPattern(100);
    pattern.tracks = [id];
    pattern.sections.A.steps = { [id]: Array.from({ length: 16 }, (_, i) => (i % 4 ? null : { v: 0.8 })) };
    pattern = normalizePattern(pattern);
    expect(pattern.sections.A.steps[id].filter(Boolean).length).toBe(4);
    engine.removeTrack.mockReturnValue(false);
    engine.getPattern = () => structuredClone(pattern);
    engine.setPattern = vi.fn();
    sampler.remove(id);
    const next = engine.setPattern.mock.calls[0][0];
    expect(next.tracks).toEqual([id]);
    expect(next.sections.A.steps[id].every((x) => x === null)).toBe(true);
  });

  it('playRegion clears its state when the context cannot start', async () => {
    const { engine, sampler, src } = await withSource(1);
    engine.resume = () => Promise.reject(new Error('nope'));
    await expect(sampler.playRegion(src.id)).rejects.toThrow('nope');
    expect(sampler.previewSourceId).toBe(null);
  });
});

describe('project files', () => {
  it('base64 and WAV helpers round trip', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 1000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 255);
      const text = toBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64'));
      expect([...fromBase64(text)]).toEqual([...bytes]);
    }
    const x = sine(0.01);
    const wav = new Uint8Array(encodeWav({ numberOfChannels: 1, sampleRate: SR, length: x.length, getChannelData: () => x }));
    const back = parseWav(wav);
    expect(back.sampleRate).toBe(SR);
    expect(Math.abs(back.channels[0][100] - x[100])).toBeLessThan(1e-4);
  });

  it('exports used samples and imports them back with the pattern', async () => {
    const engine = fakeEngine();
    const sampler = createSampler(engine, { store: null });
    const src = await sampler.fromFile(wavFile([sine(1), sine(1, SR, 0.25)]));
    const used = sampler.createSample(src.id, { start: 0.25, end: 0.75, name: 'Vox' });
    const unused = sampler.createSample(src.id, { start: 0, end: 0.1 });
    sampler.update(used, { gain: 0.5, pitch: 3, reverse: true, fadeIn: 0.01, fadeOut: 0.05 });
    const pattern = { version: 4, bpm: 90, tracks: ['kick', used] };
    const blob = await sampler.exportProject(pattern);
    const json = JSON.parse(await blob.text());
    expect(json.app).toBe('rythmik');
    expect(json.version).toBe(1);
    expect(json.samples.map((s) => s.id)).toEqual([used]);
    expect(json.samples[0].id).not.toBe(unused);

    const engine2 = fakeEngine();
    const other = createSampler(engine2, { store: null });
    const back = await other.importProject(blob);
    expect(back).toEqual(pattern);
    const [s] = other.samples;
    expect(s).toMatchObject({ id: used, name: 'Vox', gain: 0.5, pitch: 3, reverse: true, fadeIn: 0.01, fadeOut: 0.05, start: 0 });
    expect(s.duration).toBeCloseTo(0.5, 3);
    expect(other.sources.length).toBe(1);
    const def = engine2.setSampleVoices.mock.calls.at(-1)[0][used];
    expect(def.buffer.numberOfChannels).toBe(2);
    const orig = sine(1);
    const i = 1000;
    expect(Math.abs(def.buffer.getChannelData(0)[i] - orig[i + 0.25 * SR])).toBeLessThan(1e-3);
  });

  it('rejects bad files and keeps the library', async () => {
    const sampler = createSampler(fakeEngine(), { store: null });
    const src = await sampler.fromFile(wavFile([sine(0.5)]));
    const id = sampler.createSample(src.id);
    const bad = [
      'not json',
      '[]',
      JSON.stringify({ app: 'other', version: 1, pattern: {}, samples: [] }),
      JSON.stringify({ app: 'rythmik', version: 2, pattern: {}, samples: [] }),
      JSON.stringify({ app: 'rythmik', version: 1, pattern: null, samples: [] }),
      JSON.stringify({ app: 'rythmik', version: 1, pattern: {}, samples: [{ id: 'smp-a', wav: '!!!!' }] }),
      JSON.stringify({ app: 'rythmik', version: 1, pattern: {}, samples: [{ id: 'kick', wav: '' }] }),
      JSON.stringify({ app: 'rythmik', version: 1, pattern: {}, samples: [{ id: 'smp-a', wav: toBase64(new Uint8Array(50)) }] }),
      42,
    ];
    const lowRate = wavFile([new Float32Array(100)], 4000);
    bad.push(JSON.stringify({
      app: 'rythmik', version: 1, pattern: {},
      samples: [{ id: 'smp-a', wav: toBase64(new Uint8Array(await lowRate.arrayBuffer())) }],
    }));
    for (const b of bad) await expect(sampler.importProject(b)).rejects.toThrow('not-a-project');
    expect(sampler.samples.map((s) => s.id)).toEqual([id]);
    const ok = await sampler.importProject(JSON.stringify({ app: 'rythmik', version: 1, pattern: { tracks: [] } }));
    expect(ok).toEqual({ tracks: [] });
    expect(sampler.samples).toEqual([]);
  });

  it('rejects projects with more audio than 16 samples could hold', async () => {
    const sampler = createSampler(fakeEngine(), { store: null });
    const big = wavFile([new Float32Array(192000 * 10)], 192000);
    const wav = toBase64(new Uint8Array(await big.arrayBuffer()));
    const samples = Array.from({ length: 9 }, (_, i) => ({ id: `smp-${i}`, wav }));
    await expect(sampler.importProject(JSON.stringify({ app: 'rythmik', version: 1, pattern: {}, samples })))
      .rejects.toThrow('not-a-project');
    const two = samples.slice(0, 2);
    await expect(sampler.importProject(JSON.stringify({ app: 'rythmik', version: 1, pattern: {}, samples: two })))
      .resolves.toEqual({});
    expect(sampler.samples.length).toBe(2);
  });
});

describe('storage', () => {
  it('saves and restores samples through IndexedDB', async () => {
    const store = memoryStore();
    const engine = fakeEngine();
    const sampler = createSampler(engine, { store });
    const src = await sampler.fromFile(wavFile([hits(3, [0.5, 2])]));
    const a = sampler.createSample(src.id, { start: 0.5, end: 1 });
    const b = sampler.createSample(src.id, { start: 2, end: 2.5 });
    sampler.update(b, { pitch: -7, reverse: true });
    expect(await sampler.save()).toBe(true);

    const engine2 = fakeEngine();
    const next = createSampler(engine2, { store });
    expect(await next.restore()).toBe(true);
    const before = sampler.samples;
    const after = next.samples;
    expect(after.map((s) => s.id)).toEqual([a, b]);
    // the source comes back trimmed to what the samples use (0.5..2.5 s)
    expect(after.map((s) => s.duration)).toEqual(before.map((s) => s.duration));
    expect(after[1]).toMatchObject({ pitch: -7, reverse: true });
    expect(next.sources.length).toBe(1);
    expect(next.sources[0].duration).toBeCloseTo(2, 2);
    const def = engine2.setSampleVoices.mock.calls.at(-1)[0][a];
    const orig = engine.setSampleVoices.mock.calls.at(-1)[0][a];
    const k = Math.round(0.01 * SR);
    expect(def.buffer.getChannelData(0)[Math.round(def.start * SR) + k])
      .toBeCloseTo(orig.buffer.getChannelData(0)[Math.round(orig.start * SR) + k], 3);
  });

  it('saves on its own a moment after a change', async () => {
    const store = memoryStore();
    const sampler = createSampler(fakeEngine(), { store, saveDelay: 10 });
    const src = await sampler.fromFile(wavFile([sine(0.5)]));
    sampler.createSample(src.id);
    await new Promise((r) => setTimeout(r, 100));
    const { data } = await store.load();
    expect(data.samples.length).toBe(1);
  });

  it('works in memory without IndexedDB', async () => {
    const throwing = { open() { throw new Error('SecurityError'); } };
    for (const indexedDB of [null, throwing, { open: () => { const r = {}; setTimeout(() => r.onerror?.(), 0); return r; } }]) {
      const store = createSampleStore({ indexedDB });
      expect(await store.load()).toEqual({ ok: false, data: null });
      expect(await store.save({ x: 1 })).toBe(false);
      const sampler = createSampler(fakeEngine(), { store, saveDelay: 0 });
      expect(await sampler.restore()).toBe(false);
      const src = await sampler.fromFile(wavFile([sine(0.2)]));
      sampler.createSample(src.id);
      expect(await sampler.save()).toBe(false);
      expect(sampler.samples.length).toBe(1);
      expect(sampler.storage).toBe('unavailable');
    }
    expect(createSampler(fakeEngine(), { store: null }).storage).toBe('unavailable');
  });

  it('tells an empty store from one it cannot read', async () => {
    expect(await memoryStore().load()).toEqual({ ok: true, data: null });
  });

  it('reports storage state', async () => {
    const sampler = createSampler(fakeEngine(), { store: memoryStore(), saveDelay: 10000 });
    expect(await sampler.restore()).toBe(false);
    expect(sampler.storage).toBe('saved');
    const src = await sampler.fromFile(wavFile([sine(0.2)]));
    sampler.createSample(src.id);
    expect(sampler.storage).toBe('unsaved');
    expect(await sampler.save()).toBe(true);
    expect(sampler.storage).toBe('saved');
    sampler.dispose();
  });

  it('never overwrites a library it could not read', async () => {
    const idb = fakeIndexedDB();
    const first = createSampler(fakeEngine(), { store: createSampleStore({ indexedDB: idb }) });
    const src = await first.fromFile(wavFile([sine(0.5)]));
    const old = first.createSample(src.id);
    expect(await first.save()).toBe(true);

    // the next session cannot open the database at first
    let failing = 1;
    const flaky = {
      open(...args) {
        if (failing-- > 0) {
          const r = {};
          setTimeout(() => r.onerror?.(), 0);
          return r;
        }
        return idb.open(...args);
      },
    };
    const next = createSampler(fakeEngine(), { store: createSampleStore({ indexedDB: flaky }), saveDelay: 10000 });
    expect(await next.restore()).toBe(false);
    expect(next.storage).toBe('unavailable');
    const src2 = await next.fromFile(wavFile([sine(0.3)]));
    const added = next.createSample(src2.id);
    expect(await next.save()).toBe(true); // reads first (the stored sample comes back), then writes both
    expect(next.samples.map((s) => s.id).sort()).toEqual([old, added].sort());
    const data = (await createSampleStore({ indexedDB: idb }).load()).data;
    expect(data.samples.map((s) => s.id).sort()).toEqual([old, added].sort());

    // a database that never opens is left alone
    const dead = { open() { const r = {}; setTimeout(() => r.onerror?.(), 0); return r; } };
    const third = createSampler(fakeEngine(), { store: createSampleStore({ indexedDB: dead }), saveDelay: 10000 });
    const src3 = await third.fromFile(wavFile([sine(0.3)]));
    third.createSample(src3.id);
    expect(await third.save()).toBe(false);
    expect((await createSampleStore({ indexedDB: idb }).load()).data.samples.length).toBe(2);
    next.dispose();
    third.dispose();
  });
});

describe('booth clips and take audio', () => {
  it('captureClip records raw mic audio for the given seconds', async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const engine = {
      context: ctx, resume: async () => ctx, master: ctx.destination, onStateChange: () => () => {}, clock: { bpm: 120 },
    };
    const track = { stop: vi.fn(), getSettings: () => ({}) };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const remix = { isPlaying: true, stop: vi.fn(() => { remix.isPlaying = false; }), onChange: () => () => {} };
    const booth = createBooth(engine, {
      remix,
      getUserMedia: async () => stream,
      OfflineAudioContext,
      AudioWorkletNode,
      createSource: (c) => {
        const osc = c.createOscillator();
        osc.start(0);
        return osc;
      },
    });
    await booth.openMic();
    const take = booth.importTake(new Float32Array(100), { bpm: 120, bars: 2, sampleRate: SR });
    const pending = booth.captureClip({ seconds: 0.25 });
    expect(booth.capturingClip).toBe(true);
    await expect(booth.record()).rejects.toThrow('busy');
    expect(() => booth.setBacking('beat')).toThrow('busy');
    await expect(booth.playTake(take.id)).rejects.toThrow('busy');
    expect(remix.stop).toHaveBeenCalled();
    await ctx.startRendering();
    const clip = await pending;
    expect(clip.sampleRate).toBe(SR);
    expect(clip.samples.length).toBe(Math.round(0.25 * SR));
    let p = 0;
    for (const x of clip.samples) p = Math.max(p, Math.abs(x));
    expect(p).toBeGreaterThan(0.5);
    expect(booth.capturingClip).toBe(false);
    booth.dispose();
  });

  it('getTakeAudio returns the compensated take', () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const engine = {
      context: ctx, resume: async () => ctx, onStateChange: () => () => {}, clock: { bpm: 120 },
    };
    const booth = createBooth(engine, { OfflineAudioContext });
    const x = new Float32Array(SR * 4);
    x[SR] = 1;
    const meta = booth.importTake(x, { bpm: 120, bars: 2, sampleRate: SR });
    const audio = booth.getTakeAudio(meta.id);
    expect(audio.sampleRate).toBe(SR);
    expect(audio.name).toBe('Take 1');
    expect(audio.samples.length).toBe(4 * SR);
    const at = audio.samples.indexOf(1);
    expect(at).toBe(SR - Math.round((meta.latencyMs / 1000) * SR));
    expect(() => booth.getTakeAudio('nope')).toThrow('no-take');
  });

  it('trimSilence keeps a little air around the sound', () => {
    const x = new Float32Array(SR);
    x.fill(0.5, 10000, 20000);
    const span = trimSilence(x, SR);
    expect(span.from).toBe(10000 - 480);
    expect(span.to).toBe(20000 + 2880);
    expect(trimSilence(new Float32Array(100), SR)).toBe(null);
  });
});
