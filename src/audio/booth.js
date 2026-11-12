// Rap booth: mic input, count-in, bar-aligned recording, takes, voice effects, preview, export.
import { createCapture } from './capture.js';
import {
  PRE_ROLL, POST_ROLL, MIN_LATENCY_MS, MAX_LATENCY_MS, barSeconds, makeTake,
  alignedPeak, alignedSamples, takeLatencyMs, renderMix, renderVocal, renderProcessedVocal,
  measureChainDelay, peakOf,
} from './takes.js';
import {
  VOICE_PRESETS, DEFAULT_VOICE, normalizeVoice, tuningKey, correctPitch, detectPitch, createVoiceChain,
  measureVoiceDelay, voiceTail,
} from './voice.js';

export const BAR_CHOICES = [2, 4, 8, 16];
export const MIN_LATENCY_OFFSET = -200;
export const MAX_LATENCY_OFFSET = 200;
export { encodeWav } from './wav.js';

// knob drags on tune/retune/key: wait for a pause before (re)starting a tuning run
const RETUNE_DEBOUNCE_MS = 150;
const wallClock = () => globalThis.performance?.now() ?? Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEAD = 0.15; // s from record()/playTake() to the first scheduled sound
const MIN_LEAD = 0.05; // s; a downbeat closer than this is skipped
const STOP_MARGIN = 0.25; // s after the take before a booth-started beat stops (scheduling already ended)
const MONITOR_TAU = 0.015;
// browsers' DynamicsCompressor look-ahead is 6 ms each; used until measured
const DEFAULT_CHAIN_DELAY = 0.012;

const SILENCE = 10 ** (-70 / 20); // -70 dBFS

const MIC_ERRORS = ['mic-denied', 'mic-unavailable', 'mic-busy'];
const DENIED = ['NotAllowedError', 'SecurityError', 'PermissionDeniedError'];
// in use by another app, or blocked by the OS (Windows privacy settings)
const BUSY = ['NotReadableError', 'TrackStartError', 'AbortError'];
// the requested deviceId is gone
const MISSING = ['OverconstrainedError', 'NotFoundError', 'DevicesNotFoundError'];

export function mapMicError(e) {
  if (e && MIC_ERRORS.includes(e.message)) return e;
  if (DENIED.includes(e?.name)) return new Error('mic-denied');
  if (BUSY.includes(e?.name)) return new Error('mic-busy');
  return new Error('mic-unavailable');
}

// '' (before permission) and Chrome's 'default' both mean the system default
const normId = (id) => (!id || id === 'default' ? null : String(id));

function micConstraints(deviceId) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 1 },
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

/**
 * audioinput devices for a picker. Chrome's 'default' entry comes first as
 * isDefault; its 'communications' entry is dropped. Labels are empty until mic
 * permission is granted, so they fall back to 'Microphone N'.
 */
export async function listInputDevices(md) {
  if (!md || typeof md.enumerateDevices !== 'function') return [];
  const all = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const pseudo = all.find((d) => d.deviceId === 'default');
  const seen = new Set();
  const real = [];
  for (const d of all) {
    if (d.deviceId === 'default' || d.deviceId === 'communications' || seen.has(d.deviceId)) continue;
    seen.add(d.deviceId); // also collapses the blank ids listed before permission
    real.push(d);
  }
  const list = real.map((d, i) => ({
    deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}`, isDefault: false,
  }));
  if (pseudo) {
    const target = (pseudo.label || '').replace(/^default\s*-\s*/i, '')
      || (pseudo.groupId && real.find((d) => d.groupId === pseudo.groupId)?.label) || '';
    list.unshift({ deviceId: 'default', label: target ? `Default (${target})` : 'Default', isDefault: true });
  } else if (list.length) {
    list[0].isDefault = true; // Firefox/Safari list the default first
  }
  return list;
}

const disconnect = (n) => { try { n?.disconnect(); } catch { /* already gone */ } };
const stopTracks = (stream) => { for (const t of stream?.getTracks?.() || []) t.stop(); };

function scheduleClick(ctx, dest, time, accent) {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = accent ? 1760 : 1320;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0005, time + 0.05);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.06);
  return () => disconnect(g);
}

/**
 * @param engine from createEngine()
 * @param [opts] injection points: mediaDevices, getUserMedia(constraints), createSource(ctx, stream),
 *   OfflineAudioContext, AudioWorkletNode, forceScriptProcessor, now()
 */
export function createBooth(engine, opts = {}) {
  const mediaDevices = () => ('mediaDevices' in opts ? opts.mediaDevices : globalThis.navigator?.mediaDevices);
  const getUserMedia = opts.getUserMedia || ((constraints) => {
    const md = mediaDevices();
    // missing on http:// (insecure context) and in old engines
    if (!md || typeof md.getUserMedia !== 'function') return Promise.reject(new Error('mic-unavailable'));
    return md.getUserMedia(constraints);
  });
  const now = opts.now || (() => globalThis.performance?.now() ?? Date.now());
  const createSource = opts.createSource || ((ctx, stream) => ctx.createMediaStreamSource(stream));
  const Offline = () => opts.OfflineAudioContext || globalThis.OfflineAudioContext;

  let mic = null;
  let micGen = 0; // bumped by closeMic so a pending openMic gives up
  let opening = null;
  let monitoring = false;
  let bars = 4;
  let countIn = true;
  let offsetMs = 0;
  let chainDelay = null;
  const takes = [];
  let selectedId = null;
  let takeCount = 0;
  let rec = null;
  let preview = null;
  let preferredId = null; // null = system default
  let lastFallback = false;
  let silentSince = null;
  let voice = { ...DEFAULT_VOICE };
  let voicePreset = 'clean';
  const tuned = new Map(); // takeId -> { key, samples }
  const jobs = new Map(); // takeId -> { key, promise, cancelled }
  const pitches = new Map(); // takeId -> { lat, promise, cancelled }: pitch track, reused across tune settings
  const correct = opts.correctPitch || correctPitch;
  const detect = opts.detectPitch || detectPitch;
  let lastRetune = -Infinity;
  let waiting = 0; // callers holding off for the debounce
  const listeners = new Set();
  const deviceListeners = new Set();
  let deviceHandler = null;

  const emit = () => {
    for (const cb of [...listeners]) {
      try { cb(); } catch (e) { console.error(e); }
    }
  };

  const emitDevices = (ev) => {
    for (const cb of [...deviceListeners]) {
      try { cb(ev); } catch (e) { console.error(e); }
    }
  };

  function measureDelay(ctx) {
    if (chainDelay !== null || !ctx) return;
    measureChainDelay(ctx.sampleRate, Offline()).then((d) => {
      if (d !== null && chainDelay === null) { chainDelay = d; emit(); }
    });
  }
  measureDelay(engine.context);

  // ---- mic ----

  async function requestStream(deviceId) {
    try {
      return { stream: await getUserMedia(micConstraints(deviceId)), fallback: false };
    } catch (e) {
      if (!deviceId || !MISSING.includes(e?.name)) throw mapMicError(e);
    }
    try {
      return { stream: await getUserMedia(micConstraints(null)), fallback: true };
    } catch (e) {
      throw mapMicError(e);
    }
  }

  /** opts.deviceId: input to open; omitted = the last chosen one (system default at first). */
  async function openMic({ deviceId } = {}) {
    if (deviceId !== undefined) {
      const id = normId(deviceId);
      if (mic && id !== mic.deviceId) return setInputDevice(id);
      preferredId = id;
    }
    if (mic) return;
    if (opening) return opening;
    const gen = micGen;
    const want = preferredId;
    opening = (async () => {
      // both calls start inside the user gesture
      const resumed = engine.resume();
      resumed.catch(() => {});
      const { stream, fallback } = await requestStream(want);
      if (gen !== micGen) { stopTracks(stream); return; }
      const nodes = [];
      let capture = null;
      try {
        const ctx = await resumed;
        // a permission prompt can leave a fresh context suspended
        if (ctx.state === 'suspended' && typeof ctx.startRendering !== 'function') {
          ctx.resume().catch(() => {});
        }
        measureDelay(ctx);
        const source = createSource(ctx, stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        const monitor = ctx.createGain();
        monitor.gain.value = 0;
        // an analyser with no path to the destination may never be pulled
        const meterSink = ctx.createGain();
        meterSink.gain.value = 0;
        nodes.push(source, analyser, monitor, meterSink);
        // straight to the destination: monitoring skips the master chain's delay
        source.connect(monitor).connect(ctx.destination);
        source.connect(analyser).connect(meterSink).connect(ctx.destination);
        capture = await createCapture(ctx, opts);
        if (gen !== micGen) throw new Error('closed');
        source.connect(capture.node);
        const track = stream.getAudioTracks?.()[0] || null;
        mic = {
          ctx, stream, track, source, analyser, monitor, meterSink, capture,
          deviceId: fallback ? null : want,
          levelBuf: new Float32Array(analyser.fftSize),
        };
        silentSince = null;
        lastFallback = fallback;
        if (track) {
          track.onended = () => deviceLost(track);
          track.onmute = emit;
          track.onunmute = emit;
        }
        applyMonitor(false);
      } catch (e) {
        stopTracks(stream);
        capture?.dispose();
        nodes.forEach(disconnect);
        if (gen !== micGen) return;
        console.error(e);
        throw new Error('mic-unavailable');
      }
      emit();
      if (fallback) emitDevices({ reason: 'fallback', deviceId: want });
    })();
    try { await opening; } finally { opening = null; }
  }

  /** Remembers the input; reopens right away when the mic is open. Rejects with 'busy' while recording. */
  async function setInputDevice(deviceId) {
    if (rec) throw new Error('busy');
    const id = normId(deviceId);
    preferredId = id;
    if (opening) await opening.catch(() => {});
    if (!mic) return;
    if (rec) throw new Error('busy');
    if (mic.deviceId === id) return;
    const keepMonitor = monitoring;
    closeMic();
    await openMic();
    if (keepMonitor && mic) { monitoring = true; applyMonitor(false); emit(); }
  }

  function deviceLost(track) {
    if (!mic || mic.track !== track) return;
    const ev = { reason: 'device-lost', deviceId: mic.deviceId, label: track.label || '' };
    closeMic();
    emitDevices(ev);
  }

  /** cb({ reason: 'devicechange' | 'device-lost' | 'fallback', deviceId?, label? }); returns unsubscribe */
  function onDevicesChange(cb) {
    deviceListeners.add(cb);
    const md = mediaDevices();
    if (!deviceHandler && md && typeof md.addEventListener === 'function') {
      deviceHandler = () => emitDevices({ reason: 'devicechange' });
      md.addEventListener('devicechange', deviceHandler);
    }
    return () => {
      deviceListeners.delete(cb);
      if (!deviceListeners.size) detachDevices();
    };
  }

  function detachDevices() {
    if (!deviceHandler) return;
    mediaDevices()?.removeEventListener?.('devicechange', deviceHandler);
    deviceHandler = null;
  }

  function closeMic() {
    micGen++;
    if (rec) cancel();
    const changed = !!mic || monitoring;
    monitoring = false;
    const m = mic;
    mic = null;
    if (m) {
      if (m.track) { m.track.onended = null; m.track.onmute = null; m.track.onunmute = null; }
      stopTracks(m.stream);
      m.capture.dispose();
      [m.source, m.analyser, m.monitor, m.meterSink].forEach(disconnect);
    }
    silentSince = null;
    if (changed) emit();
  }

  function applyMonitor(smooth) {
    if (!mic) return;
    const g = mic.monitor.gain;
    const v = monitoring ? 1 : 0;
    if (smooth) {
      g.cancelScheduledValues(mic.ctx.currentTime);
      g.setTargetAtTime(v, mic.ctx.currentTime, MONITOR_TAU);
    } else g.value = v;
  }

  function getInputLevel() {
    if (!mic) return 0;
    mic.analyser.getFloatTimeDomainData(mic.levelBuf);
    let peak = 0;
    for (const x of mic.levelBuf) { const a = Math.abs(x); if (a > peak) peak = a; }
    if (peak >= SILENCE) silentSince = null;
    else if (silentSince === null) silentSince = now();
    return Math.min(1, peak);
  }

  function getMicStatus() {
    if (mic) getInputLevel();
    const t = mic?.track || null;
    const ctx = mic?.ctx || engine.context || null;
    return {
      open: !!mic,
      deviceId: mic ? mic.deviceId : preferredId,
      label: t?.label || '',
      muted: !!t?.muted,
      enabled: t ? t.enabled !== false : false,
      readyState: t?.readyState ?? null,
      contextState: ctx?.state ?? null,
      sampleRate: ctx?.sampleRate ?? null,
      silentForMs: mic && silentSince !== null ? Math.max(0, now() - silentSince) : 0,
      fallback: lastFallback,
    };
  }

  // ---- latency ----

  // The beat is scheduled at T but heard at T + master chain look-ahead +
  // output latency; the rapper follows what they hear, and the mic adds input
  // latency before capture. All of it lands in the take, so shift by the sum.
  function autoLatencyMs() {
    const ctx = engine.context;
    const base = ctx?.baseLatency || 0;
    const out = ctx?.outputLatency || 0;
    const input = Number(mic?.track?.getSettings?.().latency) || 0;
    const chain = chainDelay ?? DEFAULT_CHAIN_DELAY;
    return Math.round((base + out + input + chain) * 10000) / 10;
  }
  const latencyMs = () => Math.min(MAX_LATENCY_MS, Math.max(MIN_LATENCY_MS, autoLatencyMs() + offsetMs));

  // ---- recording ----

  async function record() {
    if (rec) throw new Error('busy');
    if (!mic) throw new Error('mic-closed');
    stopPreview();
    const r = { cancelled: false, timers: [], clicks: [], startedBeat: false };
    rec = r;
    emit();
    try {
      const ctx = await engine.resume();
      if (r.cancelled) return null;
      const bpm = engine.clock.bpm;
      const bar = barSeconds(bpm);
      const ahead = countIn ? bar : 0;
      if (engine.isPlaying) {
        await engine.start(); // waits for a start still in progress
      } else {
        r.startedBeat = true;
        await engine.start({ at: ctx.currentTime + LEAD + ahead });
      }
      if (r.cancelled || !mic) return null;
      // normally the `at` above; later if starting took too long
      const start = engine.getNextBarTime(ctx.currentTime + MIN_LEAD + ahead);
      if (start == null) { cancel(); return null; }
      Object.assign(r, {
        ctx, bpm, bar, bars, countIn, start, first: start - ahead, end: start + bars * bar,
      });
      if (r.startedBeat) engine.setEndTime(r.end);
      if (countIn) {
        for (let k = 0; k < 4; k++) {
          r.clicks.push(scheduleClick(ctx, engine.master, r.first + (k * bar) / 4, k === 0));
        }
      }
      const sr = ctx.sampleRate;
      const pre = Math.round(PRE_ROLL * sr);
      const from = Math.round(start * sr) - pre;
      const to = from + pre + Math.round(bars * bar * sr) + Math.round(POST_ROLL * sr);
      const at = (t) => Math.max(0, (t - ctx.currentTime) * 1000);
      r.timers.push(setTimeout(emit, at(start)));
      if (r.startedBeat) r.timers.push(setTimeout(() => { if (rec === r) stopOwnBeat(r); }, at(r.end + STOP_MARGIN)));
      const captured = mic.capture.record(from, to);
      emit(); // start time known
      const data = await captured;
      if (r.cancelled || !data) return null;

      finishRecording(r);
      const take = makeTake(data, {
        id: `take-${Date.now().toString(36)}-${++takeCount}`,
        name: `Take ${takeCount}`,
        bpm, bars: r.bars, sampleRate: sr,
        autoLatencyMs: autoLatencyMs(),
        offsetMs,
      });
      takes.push(take);
      selectedId = take.meta.id;
      emit();
      return metaOf(take);
    } catch (e) {
      if (rec === r) cancel();
      throw e;
    }
  }

  function stopOwnBeat(r) {
    if (!r.startedBeat || r.beatDone) return;
    r.beatDone = true;
    if (engine.isPlaying) engine.stop();
  }

  function finishRecording(r) {
    for (const t of r.timers) clearTimeout(t);
    stopOwnBeat(r);
    if (rec === r) rec = null;
  }

  function cancel() {
    const r = rec;
    if (!r) return;
    r.cancelled = true;
    for (const stop of r.clicks) stop();
    mic?.capture.cancel();
    finishRecording(r);
    emit();
  }

  function state() {
    if (!rec) return 'idle';
    const t = rec.ctx ? rec.ctx.currentTime : 0;
    return !rec.start || t < rec.start ? 'count-in' : 'recording';
  }

  function getRecordProgress() {
    const r = rec;
    if (!r) return null;
    const total = r.bars ?? bars;
    if (!r.start) return { bar: 0, beat: 0, totalBars: total, countIn: true, startTime: null };
    const t = r.ctx.currentTime;
    const beatLen = r.bar / 4;
    if (t < r.start) {
      const beat = r.countIn && t >= r.first ? Math.min(4, Math.floor((t - r.first) / beatLen) + 1) : 0;
      return { bar: 0, beat, totalBars: total, countIn: true, startTime: r.start };
    }
    const el = t - r.start;
    const bar = Math.min(total, Math.floor(el / r.bar) + 1);
    const beat = el >= total * r.bar ? 4 : Math.floor((el % r.bar) / beatLen) + 1;
    return { bar, beat, totalBars: total, countIn: false, startTime: r.start };
  }

  // user stopped the beat: drop the take (the post-roll alone doesn't matter)
  const offState = engine.onStateChange(({ isPlaying }) => {
    if (isPlaying) return;
    if (rec && !rec.beatDone && (!rec.end || rec.ctx.currentTime < rec.end)) cancel();
    if (preview?.withBeat) stopPreview();
  });

  // ---- takes ----

  const findTake = (id) => takes.find((t) => t.meta.id === id) || null;
  function requireTake(id) {
    const t = findTake(id ?? selectedId);
    if (!t) throw new Error('no-take');
    return t;
  }
  const latencyOf = (take) => takeLatencyMs(take, offsetMs);

  // peak follows the alignment; cached because the UI reads takes often
  function metaOf(take) {
    const lat = latencyOf(take);
    if (take.peakAt !== lat) { take.meta.peak = alignedPeak(take, lat); take.peakAt = lat; }
    return { ...take.meta, latencyMs: lat };
  }

  function selectTake(id) {
    if (!findTake(id) || id === selectedId) return;
    selectedId = id;
    emit();
  }

  function deleteTake(id) {
    const i = takes.findIndex((t) => t.meta.id === id);
    if (i < 0) return;
    if (preview?.id === id) stopPreview();
    const [t] = takes.splice(i, 1);
    t.raw = null;
    tuned.delete(id);
    dropPitch(id);
    const job = jobs.get(id);
    if (job) { job.cancelled = true; jobs.delete(id); }
    if (selectedId === id) selectedId = takes.length ? takes[takes.length - 1].meta.id : null;
    emit();
  }

  /**
   * samples: mono, sample 0 = bar 1 downbeat as captured (before latency
   * compensation). Uses the current device latency estimate.
   */
  function importTake(samples, { bpm = engine.clock.bpm, bars: n = bars, sampleRate } = {}) {
    const sr = sampleRate || engine.context?.sampleRate || 48000;
    const pre = Math.round(PRE_ROLL * sr);
    const len = Math.round(n * barSeconds(bpm) * sr);
    const raw = new Float32Array(pre + Math.max(len, samples.length) + Math.round(POST_ROLL * sr));
    raw.set(samples, pre);
    const take = makeTake(raw, {
      id: `take-${Date.now().toString(36)}-${++takeCount}`,
      name: `Take ${takeCount}`,
      bpm, bars: n, sampleRate: sr,
      autoLatencyMs: autoLatencyMs(),
      offsetMs,
    });
    takes.push(take);
    selectedId = take.meta.id;
    emit();
    return metaOf(take);
  }

  // ---- preview ----

  async function playTake(id, { withBeat = true } = {}) {
    const take = requireTake(id);
    if (rec) throw new Error('busy');
    stopPreview();
    const p = { id: take.meta.id, withBeat, startedBeat: false, override: false, nodes: null };
    preview = p;
    const ctx = await engine.resume();
    if (preview !== p) return;
    const lat = latencyOf(take);
    let samples, delay;
    try {
      [samples, delay] = await Promise.all([voiceSamples(take), voiceDelay(take.sampleRate)]);
    } catch (e) {
      if (preview === p) stopPreview();
      throw e;
    }
    if (preview !== p) return;
    let t0 = ctx.currentTime + MIN_LEAD;
    if (withBeat) {
      // the take only lines up at its own tempo; the pattern bpm is left alone
      engine.setTempoOverride(take.meta.bpm);
      p.override = true;
      if (engine.isPlaying) {
        await engine.start();
      } else {
        p.startedBeat = true;
        await engine.start({ at: ctx.currentTime + LEAD });
      }
      if (preview !== p) return;
      t0 = engine.getNextBarTime(ctx.currentTime + MIN_LEAD);
      if (t0 == null) { stopPreview(); return; }
      if (p.startedBeat) engine.setEndTime(t0 + take.meta.duration);
    }
    const buf = ctx.createBuffer(1, samples.length, take.sampleRate);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const chain = createVoiceChain(ctx, engine.master, {
      peak: peakOf(samples), bpm: take.meta.bpm, settings: voice, delay,
    });
    src.connect(chain.input);
    // early by the chain's look-ahead so the voice is heard on the beat
    src.start(Math.max(ctx.currentTime, t0 - delay / take.sampleRate));
    p.nodes = { src, chain };
    src.onended = () => { if (preview === p) stopPreview(voiceTail(voice, take.meta.bpm)); };
    emit();
  }

  /** ringOut: seconds to let reverb/echo tails finish (natural end only). */
  function stopPreview(ringOut = 0) {
    const p = preview;
    if (!p) return;
    preview = null;
    if (p.nodes) {
      const { src, chain } = p.nodes;
      src.onended = null;
      try { src.stop(); } catch { /* not started */ }
      disconnect(src);
      if (ringOut > 0) setTimeout(() => chain.dispose(), ringOut * 1000);
      else chain.dispose();
    }
    if (p.override) engine.setTempoOverride(null);
    if (p.startedBeat && engine.isPlaying) engine.stop();
    emit();
  }

  // ---- voice ----

  const voiceDelay = (sr) => measureVoiceDelay(sr, Offline());
  const voiceKey = (take) => `${latencyOf(take)}|${tuningKey(voice)}`;
  const cancelJobs = () => { for (const j of jobs.values()) j.cancelled = true; };

  /** Aligned samples of the take with the current pitch correction (cached per take). */
  async function voiceSamples(take) {
    for (;;) {
      const id = take.meta.id;
      if (!findTake(id)) throw new Error('no-take');
      const lat = latencyOf(take);
      if (!(voice.tune > 0)) return alignedSamples(take, lat);
      const key = voiceKey(take);
      const hit = tuned.get(id);
      if (hit?.key === key) return hit.samples;
      let job = jobs.get(id);
      if (!job || job.key !== key) {
        if (job) job.cancelled = true;
        const wait = lastRetune + RETUNE_DEBOUNCE_MS - wallClock();
        if (wait > 0) {
          if (++waiting === 1) emit();
          try { await sleep(wait); } finally { waiting--; }
          // the next pass normally starts a job right away (and emits); report idle otherwise
          Promise.resolve().then(() => { if (!waiting && !jobs.size) emit(); });
          continue;
        }
        job = startJob(take, key, lat, { ...voice });
      }
      try {
        return await job.promise;
      } catch (e) {
        // settings changed mid-run: go again with the new ones
        if (e?.message !== 'voice-cancelled') throw e;
      }
    }
  }

  // only a latency change, deleting the take or dispose() stops a detection run
  function pitchFor(take, lat, samples) {
    const id = take.meta.id;
    let e = pitches.get(id);
    if (e && e.lat === lat) return e.promise;
    if (e) e.cancelled = true;
    e = { lat, cancelled: false, promise: null };
    const entry = e;
    e.promise = detect(samples, take.sampleRate, { isCancelled: () => entry.cancelled });
    e.promise.catch(() => { if (pitches.get(id) === entry) pitches.delete(id); });
    pitches.set(id, e);
    return e.promise;
  }

  function dropPitch(id) {
    const e = pitches.get(id);
    if (e) { e.cancelled = true; pitches.delete(id); }
  }

  function startJob(take, key, lat, settings) {
    const id = take.meta.id;
    const job = { key, cancelled: false, promise: null };
    job.promise = (async () => {
      const samples = alignedSamples(take, lat);
      const pitch = await pitchFor(take, lat, samples);
      if (job.cancelled) throw new Error('voice-cancelled');
      const out = await correct(samples, take.sampleRate, settings, { isCancelled: () => job.cancelled, pitch });
      if (job.cancelled) throw new Error('voice-cancelled');
      tuned.set(id, { key, samples: out });
      return out;
    })().finally(() => {
      if (jobs.get(id) === job) { jobs.delete(id); emit(); }
    });
    job.promise.catch(() => {});
    jobs.set(id, job);
    emit();
    return job;
  }

  async function prepareVoice(id) {
    await voiceSamples(requireTake(id));
  }

  const voiceCopy = () => ({ ...voice, preset: voicePreset });
  const isPreset = (pid) => typeof pid === 'string' && Object.hasOwn(VOICE_PRESETS, pid);
  const matchesPreset = (v, pid) => isPreset(pid)
    && Object.entries(VOICE_PRESETS[pid].settings).every(([k, x]) => v[k] === x);

  function setVoice(v, presetId) {
    const changed = Object.keys(v).some((k) => v[k] !== voice[k]);
    if (!changed && presetId === voicePreset) return voiceCopy();
    const retuned = tuningKey(v) !== tuningKey(voice);
    voice = v;
    voicePreset = presetId;
    if (retuned) { cancelJobs(); lastRetune = wallClock(); }
    // tone, reverb and echo follow live; tuning applies from the next play
    preview?.nodes?.chain.apply(voice, true);
    emit();
    return voiceCopy();
  }

  function setVoicePreset(id) {
    if (!isPreset(id)) throw new Error(`Unknown voice preset: ${id}`);
    return setVoice(normalizeVoice({ ...voice, ...VOICE_PRESETS[id].settings }, voice), id);
  }

  function setVoiceSettings(partial) {
    const v = normalizeVoice(partial, voice);
    return setVoice(v, matchesPreset(v, voicePreset) ? voicePreset : null);
  }

  // ---- export ----

  async function mix(id) {
    const take = requireTake(id);
    const [samples, delay] = await Promise.all([voiceSamples(take), voiceDelay(take.sampleRate)]);
    return renderMix(engine.getPattern(), take, latencyOf(take), {
      OfflineAudioContext: Offline(), samples, voice: { ...voice }, voiceDelay: delay,
    });
  }

  async function vocal(id, { processed = false } = {}) {
    const take = requireTake(id);
    if (!processed) return renderVocal(take, latencyOf(take), { OfflineAudioContext: Offline() });
    const [samples, delay] = await Promise.all([voiceSamples(take), voiceDelay(take.sampleRate)]);
    return renderProcessedVocal(take, latencyOf(take), {
      OfflineAudioContext: Offline(), samples, voice: { ...voice }, voiceDelay: delay,
    });
  }

  return {
    openMic,
    closeMic,
    get micOpen() { return !!mic; },
    getInputLevel,
    getMicStatus,
    listInputs: () => listInputDevices(mediaDevices()),
    setInputDevice,
    onDevicesChange,
    /** open input, or the one the next openMic() uses; null = system default */
    get inputDeviceId() { return mic ? mic.deviceId : preferredId; },
    get inputLabel() { return mic?.track?.label || ''; },
    /** true when the last openMic() fell back to the default input */
    get lastFallback() { return lastFallback; },
    setMonitoring(on) {
      const next = !!on;
      if (next !== monitoring) { monitoring = next; applyMonitor(true); emit(); }
      return next;
    },
    get monitoring() { return monitoring; },

    setBars(n) {
      const v = Number(n);
      if (BAR_CHOICES.includes(v) && v !== bars) { bars = v; emit(); }
      return bars;
    },
    get bars() { return bars; },
    setCountIn(on) {
      const next = !!on;
      if (next !== countIn) { countIn = next; emit(); }
      return next;
    },
    get countIn() { return countIn; },
    record,
    cancel,
    get state() { return state(); },
    getRecordProgress,

    get takes() { return takes.map(metaOf); },
    get selectedTakeId() { return selectedId; },
    selectTake,
    deleteTake,
    importTake,
    playTake,
    stopPreview,
    get previewTakeId() { return preview ? preview.id : null; },

    /** For new takes on the current device; each take keeps its own estimate. */
    get latencyMs() { return latencyMs(); },
    get autoLatencyMs() { return autoLatencyMs(); },
    get latencyOffsetMs() { return offsetMs; },
    setLatencyOffset(ms) {
      const v = Number(ms);
      if (!Number.isFinite(v)) return offsetMs;
      const next = Math.round(Math.min(MAX_LATENCY_OFFSET, Math.max(MIN_LATENCY_OFFSET, v)));
      if (next !== offsetMs) { offsetMs = next; emit(); }
      return next;
    },

    renderMix: mix,
    renderVocal: vocal,

    /** { tune, retune, key, scale, tone, reverb, echo, preset } (preset: id, or null once edited) */
    get voice() { return voiceCopy(); },
    setVoicePreset,
    setVoiceSettings,
    prepareVoice,
    get voiceBusy() { return jobs.size > 0 || waiting > 0; },
    /** takes with a tuned result kept in memory */
    get voiceCacheSize() { return tuned.size; },

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      cancelJobs();
      for (const id of [...pitches.keys()]) dropPitch(id);
      stopPreview();
      closeMic();
      offState();
      detachDevices();
      deviceListeners.clear();
      listeners.clear();
    },
  };
}
