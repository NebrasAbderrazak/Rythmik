// Sampler: sources (file, mic, booth take), regions and auto-chop, sample voices
// registered with the engine, IndexedDB persistence and project files.
import { encodeWav } from './wav.js';
import { createSampleStore } from './sampleStore.js';
import { clearTrack } from './groove.js';

export const MAX_SOURCES = 8;
export const MAX_SOURCE_SECONDS = 30;
export const MAX_SAMPLES = 16;
export const MAX_SAMPLE_SECONDS = 10;
export const MAX_RECORD_SECONDS = 10;
export const MIN_SAMPLE_SECONDS = 0.01;
export const SAMPLE_DEFAULTS = Object.freeze({ gain: 0.8, pitch: 0, reverse: false, fadeIn: 0, fadeOut: 0.01 });

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_PEAK_COLUMNS = 8192;
const SAVE_DELAY_MS = 800;
const STORE_LIMIT_BYTES = 50 * 1024 * 1024;
const DECODE_RATE = 48000; // only when no AudioContext exists yet
const NAME_LENGTH = 40;
const SAMPLE_ID = /^smp-[a-z0-9]{1,24}$/;
const MIN_RATE = 8000;
const MAX_RATE = 192000;
// project import: at most 16 samples of 10 s, stereo, at 48 kHz worth of audio
const MAX_IMPORT_VALUES = MAX_SAMPLES * MAX_SAMPLE_SECONDS * 48000 * 2;
const MAX_IMPORT_CHARS = Math.ceil((MAX_IMPORT_VALUES * 2 + MAX_SAMPLES * 64) / 3) * 4 + 1024 * 1024;

const fromDb = (x) => 10 ** (x / 20);
const SILENT = fromDb(-50); // a clip with a lower peak is empty
const TRIM_REL = fromDb(-40); // under the clip's peak counts as silence when trimming
const TRIM_FLOOR = fromDb(-60);

// onset detection
const HOP_SECONDS = 0.0025;
const RISE_DB = 6; // energy jump against the window just before
const RANGE_DB = 50; // frames this far under the loudest one are silence
const HIT_DB = 40; // hits quieter than this under the loudest one are ignored
const MIN_GAP_SECONDS = 0.04;
const REF_SECONDS = 0.025; // the level a hit must rise above: the loudest window this far back (> a bass cycle)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const round3 = (x) => Math.round(x * 1000) / 1000;
const round4 = (x) => Math.round(x * 10000) / 10000;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const cleanName = (n) => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH) : '');
const baseName = (n) => cleanName(typeof n === 'string' ? n.replace(/\.[^.]*$/, '') : '');
const notProject = () => new Error('not-a-project');

export function peakOf(x, from = 0, to = x.length) {
  let p = 0;
  for (let i = from; i < to; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

function monoOf(buffer, from = 0, to = buffer.length) {
  const out = new Float32Array(Math.max(0, to - from));
  const n = buffer.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[from + i] / n;
  }
  return out;
}

/** [from, to) of x without leading/trailing silence (with a little air), or null when it is all silence. */
export function trimSilence(x, sampleRate, { pre = 0.01, post = 0.06 } = {}) {
  const peak = peakOf(x);
  if (peak < SILENT) return null;
  const thr = Math.max(peak * TRIM_REL, TRIM_FLOOR);
  let a = 0;
  while (Math.abs(x[a]) < thr) a++;
  let b = x.length - 1;
  while (Math.abs(x[b]) < thr) b--;
  return {
    from: Math.max(0, a - Math.round(pre * sampleRate)),
    to: Math.min(x.length, b + 1 + Math.round(post * sampleRate)),
  };
}

// first sample of the hit found in frame k: louder than both a share of the hit's
// peak and the level just before it
function refineOnset(x, k, H, refDb, sampleRate) {
  const from = Math.max(0, (k - 1) * H);
  const to = Math.min(x.length, (k + 2) * H + Math.round(0.01 * sampleRate));
  const pk = peakOf(x, k * H, to);
  let thr = Math.max(0.2 * pk, 2.5 * fromDb(refDb));
  if (thr > pk) thr = 0.9 * pk;
  let i = from;
  while (i < to && Math.abs(x[i]) < thr) i++;
  if (i >= to) return k * H;
  return Math.max(from, i - Math.round(0.0005 * sampleRate));
}

// short-window energy in dB per hop (windows of two hops), floored RANGE_DB under the top
function levels(x, H) {
  const n = Math.ceil(x.length / H);
  const L = new Float32Array(n);
  let top = -Infinity;
  for (let k = 0; k < n; k++) {
    const a = k * H;
    const b = Math.min(x.length, a + 2 * H);
    let e = 0;
    for (let i = a; i < b; i++) e += x[i] * x[i];
    L[k] = 10 * Math.log10(e / (2 * H) + 1e-20);
    if (L[k] > top) top = L[k];
  }
  const floor = top - RANGE_DB;
  for (let k = 0; k < n; k++) if (L[k] < floor) L[k] = floor;
  return { L, top, floor };
}

// windows k-2 back to REF_SECONDS ago (window k-2 is the last one not overlapping k)
function reference(lv, k, back) {
  let r = lv.floor;
  for (let j = Math.max(0, k - back); j <= k - 2; j++) if (lv.L[j] > r) r = lv.L[j];
  return r;
}

/**
 * Hits in a mono signal: short-window energy that jumps by RISE_DB or more, in
 * the signal or in its first difference (which favours clicks and hats over a
 * ringing bass).
 * @returns {{ at: number, strength: number }[]} at in samples; strength = loudness in dB
 */
export function findOnsets(x, sampleRate) {
  const H = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
  if (!x.length) return [];
  const plain = levels(x, H);
  if (plain.top < 20 * Math.log10(SILENT)) return [];
  const d = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) d[i] = x[i] - x[i - 1];
  const diff = levels(d, H);
  const { L, top } = plain;
  const n = L.length;
  const back = Math.max(2, Math.round((REF_SECONDS * sampleRate) / H));
  const gap = Math.max(1, Math.round((MIN_GAP_SECONDS * sampleRate) / H));
  const out = [];
  let last = -Infinity;
  for (let k = 0; k < n; k++) {
    if (k - last < gap) continue;
    const refPlain = reference(plain, k, back);
    const byPlain = L[k] - refPlain >= RISE_DB;
    const refDiff = byPlain ? 0 : reference(diff, k, back);
    if (!byPlain && diff.L[k] - refDiff < RISE_DB) continue;
    let loud = L[k];
    for (let j = k + 1; j < Math.min(n, k + 8); j++) if (L[j] > loud) loud = L[j];
    if (loud < top - HIT_DB) continue;
    const at = byPlain ? refineOnset(x, k, H, refPlain, sampleRate) : refineOnset(d, k, H, refDiff, sampleRate);
    out.push({ at, strength: loud });
    last = k;
  }
  return out;
}

/**
 * Regions of x from each hit to just before the next (or where the sound dies
 * out), near-silent ones skipped; the `max` loudest are kept, in time order.
 * @returns {{ start: number, end: number }[]} in samples
 */
export function chopSignal(x, sampleRate, { max = 8 } = {}) {
  const hits = findOnsets(x, sampleRate);
  const peak = peakOf(x);
  const longest = Math.round(MAX_SAMPLE_SECONDS * sampleRate);
  const regions = [];
  for (let i = 0; i < hits.length; i++) {
    const from = hits[i].at;
    let to = i + 1 < hits.length ? hits[i + 1].at - Math.round(0.001 * sampleRate) : x.length;
    to = Math.min(to, from + longest);
    if (to <= from) continue;
    const rp = peakOf(x, from, to);
    if (rp < Math.max(SILENT, peak * TRIM_REL)) continue;
    const thr = Math.max(rp * TRIM_REL, TRIM_FLOOR);
    let end = to - 1;
    while (end > from && Math.abs(x[end]) < thr) end--;
    to = Math.min(to, end + 1 + Math.round(0.02 * sampleRate));
    if (to - from < MIN_SAMPLE_SECONDS * sampleRate) continue;
    regions.push({ start: from, end: to, strength: hits[i].strength });
  }
  const m = clamp(Math.floor(num(max, 8)), 1, MAX_SAMPLES);
  return regions
    .sort((a, b) => b.strength - a.strength)
    .slice(0, m)
    .sort((a, b) => a.start - b.start)
    .map(({ start, end }) => ({ start, end }));
}

function scanPeaks(buffer, from, to, cols) {
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const len = to - from;
  if (len <= 0) return { min, max };
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < cols; i++) {
    const a = from + Math.floor((i * len) / cols);
    const b = Math.min(to, Math.max(a + 1, from + Math.floor(((i + 1) * len) / cols)));
    let lo = Infinity, hi = -Infinity;
    for (const d of chans) {
      for (let j = a; j < b; j++) {
        const v = d[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[i] = lo === Infinity ? 0 : lo;
    max[i] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

// ---- base64 and WAV (project files) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

export function toBase64(bytes) {
  const parts = [];
  const CHUNK = 3 * 4096;
  for (let o = 0; o < bytes.length; o += CHUNK) {
    const end = Math.min(bytes.length, o + CHUNK);
    let s = '';
    for (let i = o; i < end; i += 3) {
      const a = bytes[i], b = i + 1 < end ? bytes[i + 1] : 0, c = i + 2 < end ? bytes[i + 2] : 0;
      const n = (a << 16) | (b << 8) | c;
      s += B64[n >> 18] + B64[(n >> 12) & 63]
        + (i + 1 < end ? B64[(n >> 6) & 63] : '=') + (i + 2 < end ? B64[n & 63] : '=');
    }
    parts.push(s);
  }
  return parts.join('');
}

export function fromBase64(text) {
  const s = text.replace(/\s+/g, '');
  if (s.length % 4) throw notProject();
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const ch = s.charCodeAt(i + j);
      let v = ch < 128 ? B64_INDEX[ch] : -1;
      if (ch === 61 && i + j >= s.length - pad) v = 0; // '='
      if (v < 0) throw notProject();
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** 16-bit PCM WAV (mono or stereo) to { channels: Float32Array[], sampleRate }. */
export function parseWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw notProject();
  let fmt = null;
  let data = null;
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ' && size >= 16) {
      fmt = { format: v.getUint16(o + 8, true), channels: v.getUint16(o + 10, true),
        sampleRate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === 'data') {
      data = { offset: o + 8, size: Math.min(size, bytes.length - o - 8) };
    }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.channels > 2
    || fmt.sampleRate < MIN_RATE || fmt.sampleRate > MAX_RATE) throw notProject();
  const frames = Math.floor(data.size / (2 * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0, p = data.offset; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++, p += 2) channels[c][i] = v.getInt16(p, true) / 32768;
  }
  return { channels, sampleRate: fmt.sampleRate };
}

function toInt16(d) {
  const out = new Int16Array(d.length);
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    out[i] = x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x * 32768) || 0;
  }
  return out;
}

function fromInt16(d) {
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = d[i] / 32768;
  return out;
}

async function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input.slice(0);
  if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  if (input && typeof input.arrayBuffer === 'function') return input.arrayBuffer();
  throw new Error('decode-failed');
}

async function readText(input) {
  if ((input?.size ?? input?.byteLength ?? input?.length ?? 0) > MAX_IMPORT_CHARS) throw notProject();
  if (typeof input === 'string') return input;
  if (input && typeof input.text === 'function') return input.text();
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return new TextDecoder().decode(input);
  throw notProject();
}

/**
 * @param engine from createEngine(); uses context, resume(), master, trigger(),
 *   setSampleVoices(map) and removeTrack(id) when present
 * @param [opts] booth (mic recording and takes), store (from createSampleStore; null =
 *   memory only), indexedDB, OfflineAudioContext, AudioBuffer, saveDelay (ms)
 */
export function createSampler(engine, opts = {}) {
  const booth = opts.booth || null;
  const store = opts.store === undefined ? createSampleStore(opts) : opts.store;
  const saveDelay = opts.saveDelay ?? SAVE_DELAY_MS;
  const Offline = () => opts.OfflineAudioContext || globalThis.OfflineAudioContext;

  // a clip is an audio buffer; listed clips are the sources. Samples keep their
  // clip alive after its source is removed.
  const clips = new Map(); // id -> { id, name, buffer, listed }
  const samples = new Map(); // id -> { id, name, clip, start, end, gain, pitch, reverse, fadeIn, fadeOut }
  const peakCache = new WeakMap(); // buffer -> Map(key -> peaks)
  const pcmCache = new WeakMap(); // buffer -> stored copy of the used span
  const listeners = new Set();
  let clipCount = 0;
  let micCount = 0;
  let recording = null; // { cancelled } while record() runs
  let regionPreview = null;
  let saveTimer = null;
  let saving = Promise.resolve(true);
  let restoring = null;
  let loaded = false; // the store was read once: only then may a save replace what it holds
  let dirty = false;
  let changeGen = 0;
  let storage = store ? 'saved' : 'unavailable';
  let decodeCtx = null;
  let disposed = false;

  const emit = () => {
    for (const cb of [...listeners]) {
      try { cb(); } catch (e) { console.error(e); }
    }
  };

  // ---- buffers ----

  function createBuffer(channels, length, sampleRate) {
    const ctx = engine.context;
    if (ctx && typeof ctx.createBuffer === 'function') return ctx.createBuffer(channels, length, sampleRate);
    const AB = opts.AudioBuffer || globalThis.AudioBuffer;
    if (typeof AB === 'function') return new AB({ numberOfChannels: channels, length, sampleRate });
    const Ctor = Offline();
    if (!Ctor) throw new Error('Web Audio API not supported');
    return new Ctor(1, 1, sampleRate).createBuffer(channels, length, sampleRate);
  }

  function bufferOf(channels, sampleRate) {
    const buf = createBuffer(channels.length, Math.max(1, channels[0].length), sampleRate);
    channels.forEach((d, c) => buf.copyToChannel(d, c));
    return buf;
  }

  function decodeContext() {
    if (engine.context) return engine.context;
    if (!decodeCtx) {
      const Ctor = Offline();
      if (!Ctor) throw new Error('Web Audio API not supported');
      decodeCtx = new Ctor(2, 1, DECODE_RATE);
    }
    return decodeCtx;
  }

  // ---- sources ----

  const listedCount = () => [...clips.values()].filter((c) => c.listed).length;
  const sourceInfo = (c) => ({
    id: c.id, name: c.name, duration: c.buffer.duration,
    channels: c.buffer.numberOfChannels, sampleRate: c.buffer.sampleRate,
  });

  function addClip(buffer, name, listed = true) {
    let buf = buffer;
    if (buf.numberOfChannels > 2) buf = bufferOf([monoOf(buf)], buf.sampleRate);
    const clip = { id: `src-${++clipCount}`, name: cleanName(name) || `Sound ${clipCount}`, buffer: buf, listed };
    clips.set(clip.id, clip);
    return clip;
  }

  function requireSource(id) {
    const c = clips.get(id);
    if (!c || !c.listed) throw new Error('no-source');
    return c;
  }

  function dropClipIfUnused(clip) {
    if (clip.listed) return;
    for (const s of samples.values()) if (s.clip === clip) return;
    clips.delete(clip.id);
  }

  /**
   * Decodes an audio file into a new source. Rejects Error('decode-failed' |
   * 'too-long' (over 30 s) | 'too-many' (8 sources)).
   */
  async function fromFile(file, { name } = {}) {
    if (listedCount() >= MAX_SOURCES) throw new Error('too-many');
    if ((file?.size ?? file?.byteLength ?? 0) > MAX_FILE_BYTES) throw new Error('too-long');
    let decoded = null;
    try {
      decoded = await decodeContext().decodeAudioData(await toArrayBuffer(file));
    } catch (e) {
      if (e?.message === 'Web Audio API not supported') throw e;
    }
    if (!decoded || !(decoded.length > 0)) throw new Error('decode-failed');
    if (decoded.duration > MAX_SOURCE_SECONDS + 0.05) throw new Error('too-long');
    if (listedCount() >= MAX_SOURCES) throw new Error('too-many');
    const clip = addClip(decoded, name ?? baseName(file?.name));
    emit();
    return sourceInfo(clip);
  }

  /**
   * Records from the booth's mic (opened if needed), up to 10 s, silence
   * trimmed. Resolves the new source, or null when cancelled. Rejects
   * Error('too-many' | 'busy' | 'silent' | 'no-mic' | a booth mic error).
   */
  async function record({ seconds = 4 } = {}) {
    if (!booth || typeof booth.captureClip !== 'function') throw new Error('no-mic');
    if (listedCount() >= MAX_SOURCES) throw new Error('too-many');
    if (recording) throw new Error('busy');
    const secs = clamp(num(seconds, 4), 0.1, MAX_RECORD_SECONDS);
    const r = { cancelled: false };
    recording = r;
    emit();
    try {
      if (!booth.micOpen) await booth.openMic(); // starts inside the user gesture
      if (r.cancelled || disposed) return null;
      const clip = await booth.captureClip({ seconds: secs });
      if (!clip || r.cancelled || disposed) return null;
      const span = trimSilence(clip.samples, clip.sampleRate);
      if (!span) throw new Error('silent');
      if (listedCount() >= MAX_SOURCES) throw new Error('too-many');
      const buf = bufferOf([clip.samples.slice(span.from, span.to)], clip.sampleRate);
      return sourceInfo(addClip(buf, `Mic ${++micCount}`));
    } finally {
      recording = null;
      emit();
    }
  }

  function cancelRecord() {
    if (!recording) return;
    recording.cancelled = true;
    booth?.cancelClip?.();
  }

  /**
   * A booth take (dry, latency compensated) as a new source, silence trimmed and
   * cut to 30 s. Throws Error('no-take' | 'too-many' | 'silent').
   */
  function fromTake(takeId) {
    if (!booth || typeof booth.getTakeAudio !== 'function') throw new Error('no-take');
    if (listedCount() >= MAX_SOURCES) throw new Error('too-many');
    const { samples: x, sampleRate, name } = booth.getTakeAudio(takeId);
    const span = trimSilence(x, sampleRate);
    if (!span) throw new Error('silent');
    const to = Math.min(span.to, span.from + Math.round(MAX_SOURCE_SECONDS * sampleRate));
    const clip = addClip(bufferOf([x.slice(span.from, to)], sampleRate), name || 'Take');
    emit();
    return sourceInfo(clip);
  }

  /**
   * Removes a source from the list. Samples made from it keep working on a copy
   * of their own region (their start/end can only move inside it from then on).
   */
  function removeSource(id) {
    const c = clips.get(id);
    if (!c || !c.listed) return false;
    if (regionPreview?.clip === c) stopRegion();
    clips.delete(id);
    const { buffer } = c;
    const sr = buffer.sampleRate;
    for (const s of samples.values()) {
      if (s.clip !== c) continue;
      const a = clamp(Math.floor(s.start * sr), 0, buffer.length);
      const b = clamp(Math.ceil(s.end * sr), a, buffer.length);
      const chans = Array.from({ length: buffer.numberOfChannels }, (_, k) => buffer.getChannelData(k).slice(a, b));
      const off = a / sr;
      s.clip = addClip(bufferOf(chans, sr), c.name, false);
      s.start = Math.max(0, round4(s.start - off));
      s.end = Math.min(s.clip.buffer.duration, round4(s.end - off));
      fitFades(s);
    }
    changed();
    return true;
  }

  // ---- peaks and chop ----

  /**
   * min/max per column (1..8192) over all channels. id: a source (whole source,
   * or range { start, end } in seconds) or a sample (its region). Cached; do not modify.
   */
  function getPeaks(id, columns, range = {}) {
    const n = Math.floor(Number(columns));
    const cols = Number.isFinite(n) ? clamp(n, 1, MAX_PEAK_COLUMNS) : 1;
    const s = samples.get(id);
    const c = s ? s.clip : clips.get(id);
    if (!c || (!s && !c.listed)) return { min: new Float32Array(0), max: new Float32Array(0) };
    const buf = c.buffer;
    const sr = buf.sampleRate;
    const lo = s ? s.start : 0;
    const hi = s ? s.end : buf.duration;
    const a = Math.round(clamp(num(range?.start, lo), 0, buf.duration) * sr);
    const b = Math.round(clamp(num(range?.end, hi), 0, buf.duration) * sr);
    const key = `${cols}|${a}|${b}`;
    let cache = peakCache.get(buf);
    if (!cache) { cache = new Map(); peakCache.set(buf, cache); }
    let p = cache.get(key);
    if (!p) {
      if (cache.size >= 32) cache.clear();
      p = scanPeaks(buf, Math.min(a, b), Math.max(a, b), cols);
      cache.set(key, p);
    }
    return p;
  }

  /** Proposed regions at the hits of a source: [{ start, end }] in seconds. opts: max, start, end. */
  function chop(sourceId, { max = 8, start = 0, end } = {}) {
    const buf = requireSource(sourceId).buffer;
    const sr = buf.sampleRate;
    const a = Math.round(clamp(num(start, 0), 0, buf.duration) * sr);
    const b = Math.max(a, Math.round(clamp(num(end, buf.duration), 0, buf.duration) * sr));
    return chopSignal(monoOf(buf, a, b), sr, { max }).map((r) => ({
      start: round4((a + r.start) / sr),
      end: Math.min(buf.duration, round4((a + r.end) / sr)),
    }));
  }

  // ---- samples ----

  function newSampleId() {
    for (;;) {
      const bytes = new Uint8Array(6);
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      const id = `smp-${[...bytes].map((x) => (x % 36).toString(36)).join('')}`;
      if (!samples.has(id)) return id;
    }
  }

  function setRegion(s, start, end) {
    const dur = s.clip.buffer.duration;
    const a = clamp(start, 0, Math.max(0, dur - MIN_SAMPLE_SECONDS));
    const b = clamp(end, Math.min(dur, a + MIN_SAMPLE_SECONDS), Math.min(dur, a + MAX_SAMPLE_SECONDS));
    s.start = round4(a);
    s.end = Math.min(dur, round4(b));
  }

  function fitFades(s) {
    const len = s.end - s.start;
    let fi = clamp(num(s.fadeIn, 0), 0, len);
    let fo = clamp(num(s.fadeOut, 0), 0, len);
    if (fi + fo > len) {
      const k = len / (fi + fo);
      fi *= k;
      fo *= k;
    }
    s.fadeIn = Math.floor(fi * 1e4) / 1e4;
    s.fadeOut = Math.floor(fo * 1e4) / 1e4;
  }

  function applySettings(s, p) {
    if ('name' in p) { const n = cleanName(p.name); if (n) s.name = n; }
    if ('gain' in p) s.gain = round3(clamp(num(p.gain, s.gain), 0, 1));
    if ('pitch' in p) s.pitch = Math.round(clamp(num(p.pitch, s.pitch), -12, 12));
    if ('reverse' in p) s.reverse = !!p.reverse;
    if ('fadeIn' in p) s.fadeIn = num(p.fadeIn, s.fadeIn);
    if ('fadeOut' in p) s.fadeOut = num(p.fadeOut, s.fadeOut);
    if ('start' in p || 'end' in p) setRegion(s, num(p.start, s.start), num(p.end, s.end));
    fitFades(s);
  }

  function addSample(clip, settings, id = newSampleId()) {
    const s = { id, name: `Sample ${samples.size + 1}`, clip, ...SAMPLE_DEFAULTS, start: 0, end: clip.buffer.duration };
    setRegion(s, 0, clip.buffer.duration);
    applySettings(s, settings);
    samples.set(id, s);
    return s;
  }

  const sampleInfo = (s) => ({
    id: s.id, name: s.name, sourceId: s.clip.listed ? s.clip.id : null,
    start: s.start, end: s.end, duration: round4(s.end - s.start),
    gain: s.gain, pitch: s.pitch, reverse: s.reverse, fadeIn: s.fadeIn, fadeOut: s.fadeOut,
  });

  /** Returns the new id ('smp-xxxxxx'). Throws Error('no-source' | 'too-many' (16 samples)). */
  function createSample(sourceId, { start = 0, end, name } = {}) {
    const clip = requireSource(sourceId);
    if (samples.size >= MAX_SAMPLES) throw new Error('too-many');
    let k = 1;
    for (const s of samples.values()) if (s.clip === clip) k++;
    const s = addSample(clip, {
      name: cleanName(name) || `${clip.name} ${k}`,
      start: num(start, 0),
      end: num(end, clip.buffer.duration),
    });
    changed();
    return s.id;
  }

  /** gain 0..1, pitch -12..12, reverse, fadeIn/fadeOut (s), start/end (s, in the source), name. */
  function update(id, partial) {
    const s = samples.get(id);
    if (!s || !isObject(partial)) return null;
    applySettings(s, partial);
    changed();
    return sampleInfo(s);
  }

  /**
   * Deletes a sample and removes its track from the pattern. When the engine keeps
   * the row (the pattern's last track), the row's steps are cleared instead.
   */
  function remove(id) {
    const s = samples.get(id);
    if (!s) return false;
    samples.delete(id);
    dropClipIfUnused(s.clip);
    changed();
    if (typeof engine.removeTrack === 'function' && !engine.removeTrack(id)
      && typeof engine.getPattern === 'function' && typeof engine.setPattern === 'function') {
      const p = engine.getPattern();
      if (p?.tracks?.includes(id)) engine.setPattern(clearTrack(p, id));
    }
    return true;
  }

  function audition(id) {
    if (!samples.has(id) || typeof engine.trigger !== 'function') return false;
    engine.trigger(id);
    return true;
  }

  /** Plays part of a source as it is (no sample settings), e.g. while choosing a region. */
  async function playRegion(sourceId, { start = 0, end } = {}) {
    const clip = requireSource(sourceId);
    stopRegion();
    const p = { clip, src: null, gain: null };
    regionPreview = p;
    let ctx;
    try {
      ctx = await engine.resume();
    } catch (e) {
      if (regionPreview === p) { regionPreview = null; emit(); }
      throw e;
    }
    if (regionPreview !== p) return;
    const dur = clip.buffer.duration;
    const a = clamp(num(start, 0), 0, dur);
    const b = clamp(num(end, dur), a, dur);
    if (b - a < 0.005) { regionPreview = null; return; }
    const t = ctx.currentTime + 0.01;
    const src = ctx.createBufferSource();
    src.buffer = clip.buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(SAMPLE_DEFAULTS.gain, t + 0.003);
    g.gain.setValueAtTime(SAMPLE_DEFAULTS.gain, t + b - a - 0.003);
    g.gain.linearRampToValueAtTime(0, t + b - a);
    src.connect(g).connect(engine.master || ctx.destination);
    src.start(t, a, b - a);
    src.onended = () => { if (regionPreview === p) stopRegion(); };
    p.src = src;
    p.gain = g;
    emit();
  }

  function stopRegion() {
    const p = regionPreview;
    if (!p) return;
    regionPreview = null;
    if (p.src) {
      p.src.onended = null;
      try { p.src.stop(); } catch { /* not started */ }
      try { p.gain.disconnect(); } catch { /* already gone */ }
    }
    emit();
  }

  // ---- engine and change tracking ----

  function voiceMap() {
    const map = {};
    for (const s of samples.values()) {
      map[s.id] = {
        buffer: s.clip.buffer, start: s.start, end: s.end, gain: s.gain, pitch: s.pitch,
        reverse: s.reverse, fadeIn: s.fadeIn, fadeOut: s.fadeOut,
      };
    }
    return map;
  }

  function pushVoices() {
    if (typeof engine.setSampleVoices !== 'function') return;
    try { engine.setSampleVoices(voiceMap()); } catch (e) { console.error(e); }
  }

  function setStorage(next) {
    if (next !== storage) { storage = next; emit(); }
  }

  function changed({ save = true } = {}) {
    pushVoices();
    if (save && store) {
      dirty = true;
      changeGen++;
      if (storage === 'saved') storage = 'unsaved';
    }
    emit();
    if (save) scheduleSave();
  }

  // ---- persistence ----

  // what samples use of each clip, as 16-bit PCM; mono when stereo would not fit
  function snapshot() {
    const used = new Map();
    for (const s of samples.values()) {
      const { buffer } = s.clip;
      const a = clamp(Math.floor(s.start * buffer.sampleRate), 0, buffer.length);
      const b = clamp(Math.ceil(s.end * buffer.sampleRate), a, buffer.length);
      const u = used.get(s.clip);
      used.set(s.clip, u ? { from: Math.min(u.from, a), to: Math.max(u.to, b) } : { from: a, to: b });
    }
    let bytes = 0;
    for (const [c, u] of used) bytes += (u.to - u.from) * c.buffer.numberOfChannels * 2;
    const mono = bytes > STORE_LIMIT_BYTES;
    const data = { version: 1, clips: [], samples: [] };
    for (const [c, u] of used) {
      const { buffer } = c;
      const asMono = mono || buffer.numberOfChannels === 1;
      let pcm = pcmCache.get(buffer);
      if (!pcm || pcm.from !== u.from || pcm.to !== u.to || pcm.mono !== asMono) {
        const chans = asMono
          ? [monoOf(buffer, u.from, u.to)]
          : Array.from({ length: buffer.numberOfChannels }, (_, k) => buffer.getChannelData(k).subarray(u.from, u.to));
        pcm = { from: u.from, to: u.to, mono: asMono, channels: chans.map(toInt16) };
        pcmCache.set(buffer, pcm);
      }
      data.clips.push({ id: c.id, name: c.name, listed: c.listed, sampleRate: buffer.sampleRate, channels: pcm.channels });
    }
    for (const s of samples.values()) {
      const off = used.get(s.clip).from / s.clip.buffer.sampleRate;
      data.samples.push({
        id: s.id, name: s.name, clip: s.clip.id,
        start: Math.max(0, round4(s.start - off)), end: Math.max(0, round4(s.end - off)),
        gain: s.gain, pitch: s.pitch, reverse: s.reverse, fadeIn: s.fadeIn, fadeOut: s.fadeOut,
      });
    }
    return data;
  }

  function scheduleSave() {
    if (!store || disposed) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, saveDelay);
  }

  /**
   * Writes the library now (changes are also saved on their own a moment later).
   * Never writes before the store was read: a library that could not be loaded is
   * not overwritten; the read is retried first. Resolves false when nothing was stored.
   */
  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!store) return Promise.resolve(false);
    saving = saving.then(async () => {
      if (restoring) await restoring;
      if (!loaded) await restore();
      if (!loaded) { setStorage('unavailable'); return false; }
      const gen = changeGen;
      let ok = false;
      try { ok = await store.save(snapshot()); } catch { ok = false; }
      if (ok && gen === changeGen) dirty = false;
      setStorage(!ok ? 'unavailable' : dirty ? 'unsaved' : 'saved');
      return ok;
    });
    return saving;
  }

  // samples made before a late or retried read are written along with the stored ones
  function afterLoad() {
    setStorage(dirty ? 'unsaved' : 'saved');
    if (dirty && !saveTimer) scheduleSave();
  }

  function validClip(raw) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.channels)) return false;
    if (raw.channels.length < 1 || raw.channels.length > 2) return false;
    if (!raw.channels.every((d) => d instanceof Int16Array && d.length === raw.channels[0].length)) return false;
    return Number.isFinite(raw.sampleRate) && raw.sampleRate >= MIN_RATE && raw.sampleRate <= MAX_RATE;
  }

  /**
   * Loads the stored library and registers its samples. Samples already in memory
   * stay; stored ones with the same id are skipped. Resolves true when any came back.
   */
  function restore() {
    if (!store) return Promise.resolve(false);
    if (restoring) return restoring;
    const job = (async () => {
      let res = null;
      try { res = await store.load(); } catch { res = null; }
      if (!res?.ok) { setStorage('unavailable'); return false; }
      loaded = true;
      const { data } = res;
      if (disposed || !isObject(data) || data.version !== 1
        || !Array.isArray(data.clips) || !Array.isArray(data.samples)) {
        afterLoad();
        return false;
      }
      const raws = new Map();
      for (const c of data.clips) if (validClip(c)) raws.set(c.id, c);
      const made = new Map();
      let added = 0;
      for (const r of data.samples) {
        if (samples.size >= MAX_SAMPLES) break;
        if (!isObject(r) || typeof r.id !== 'string' || !SAMPLE_ID.test(r.id) || samples.has(r.id)) continue;
        const raw = raws.get(r.clip);
        if (!raw) continue;
        let clip = made.get(raw.id);
        if (!clip) {
          try {
            clip = addClip(bufferOf(raw.channels.map(fromInt16), raw.sampleRate), raw.name,
              raw.listed === true && listedCount() < MAX_SOURCES);
          } catch { continue; }
          made.set(raw.id, clip);
        }
        const { id, ...settings } = r;
        addSample(clip, settings, id);
        added++;
      }
      for (const clip of made.values()) dropClipIfUnused(clip);
      if (added) changed({ save: false });
      afterLoad();
      return added > 0;
    })();
    restoring = job;
    job.finally(() => { if (restoring === job) restoring = null; }).catch(() => {});
    return job;
  }

  // ---- project files ----

  /** Blob (application/json) with the pattern and every sample it uses as 16-bit WAV. */
  async function exportProject(pattern) {
    if (!isObject(pattern)) throw new Error('no-pattern');
    const used = new Set(Array.isArray(pattern.tracks) ? pattern.tracks : []);
    const list = [];
    for (const s of samples.values()) {
      if (!used.has(s.id)) continue;
      const { buffer } = s.clip;
      const a = clamp(Math.round(s.start * buffer.sampleRate), 0, buffer.length);
      const b = clamp(Math.round(s.end * buffer.sampleRate), a, buffer.length);
      const wav = encodeWav({
        numberOfChannels: buffer.numberOfChannels,
        sampleRate: buffer.sampleRate,
        length: b - a,
        getChannelData: (c) => buffer.getChannelData(c).subarray(a, b),
      }, { bitDepth: 16 });
      list.push({
        id: s.id,
        name: s.name,
        settings: { gain: s.gain, pitch: s.pitch, reverse: s.reverse, fadeIn: s.fadeIn, fadeOut: s.fadeOut },
        wav: toBase64(new Uint8Array(wav)),
      });
    }
    const json = JSON.stringify({ app: 'rythmik', version: 1, pattern, samples: list });
    return new Blob([json], { type: 'application/json' });
  }

  /**
   * Reads a project file (File, Blob, text or bytes), replaces the sample library
   * with its samples and returns the pattern for engine.setPattern. Rejects
   * Error('not-a-project') and leaves everything as it was.
   */
  async function importProject(input) {
    let data;
    try {
      data = JSON.parse(await readText(input));
    } catch {
      throw notProject();
    }
    const list = data?.samples ?? [];
    if (!isObject(data) || data.app !== 'rythmik' || data.version !== 1 || !isObject(data.pattern)
      || !Array.isArray(list) || list.length > MAX_SAMPLES) throw notProject();
    const ids = new Set();
    const parsed = [];
    let chars = 0;
    for (const r of list) {
      if (!isObject(r) || typeof r.id !== 'string' || !SAMPLE_ID.test(r.id) || ids.has(r.id)
        || typeof r.wav !== 'string') throw notProject();
      ids.add(r.id);
      chars += r.wav.length;
    }
    if (chars > MAX_IMPORT_CHARS) throw notProject();
    let values = 0;
    for (const r of list) {
      let wav;
      try { wav = parseWav(fromBase64(r.wav)); } catch { throw notProject(); }
      const frames = wav.channels[0].length;
      values += frames * wav.channels.length;
      if (frames / wav.sampleRate > MAX_SAMPLE_SECONDS + 0.01 || values > MAX_IMPORT_VALUES) throw notProject();
      parsed.push({ r, buffer: bufferOf(wav.channels, wav.sampleRate) });
    }
    if (restoring) await restoring;
    stopRegion();
    samples.clear();
    clips.clear();
    for (const { r, buffer } of parsed) {
      const name = cleanName(r.name) || 'Sample';
      const clip = addClip(buffer, name, listedCount() < MAX_SOURCES);
      addSample(clip, { ...(isObject(r.settings) ? r.settings : {}), name, start: 0, end: buffer.duration }, r.id);
    }
    changed();
    return data.pattern;
  }

  return {
    fromFile,
    record,
    cancelRecord,
    /** true while record() runs */
    get recording() { return !!recording; },
    fromTake,
    removeSource,
    /** [{ id, name, duration, channels, sampleRate }] */
    get sources() { return [...clips.values()].filter((c) => c.listed).map(sourceInfo); },
    getPeaks,
    chop,
    createSample,
    /** [{ id, name, sourceId (null once the source is removed), start, end, duration, gain, pitch, reverse, fadeIn, fadeOut }] */
    get samples() { return [...samples.values()].map(sampleInfo); },
    getSample(id) { const s = samples.get(id); return s ? sampleInfo(s) : null; },
    update,
    remove,
    audition,
    playRegion,
    stopRegion,
    get previewSourceId() { return regionPreview ? regionPreview.clip.id : null; },
    /**
     * 'saved' (nothing waiting), 'unsaved' (a change waits to be written), or
     * 'unavailable' (no storage, or the last read/write failed: in memory only,
     * retried on the next change)
     */
    get storage() { return storage; },
    save,
    restore,
    exportProject,
    importProject,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      if (saveTimer) save();
      disposed = true;
      stopRegion();
      cancelRecord();
      listeners.clear();
    },
  };
}
