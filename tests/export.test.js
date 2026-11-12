import { describe, it, expect, vi } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  renderBeat, beatTail, EXPORT_BARS, DEFAULT_TAIL,
} from '../src/audio/export.js';
import { PRESETS } from '../src/audio/presets.js';
import { emptyPattern, normalizePattern, defaultStep } from '../src/audio/pattern.js';
import V3 from './fixtures/v3-presets.json';
import { encodeWav } from '../src/audio/wav.js';
import {
  STEPS, TRACK_IDS, VOICE_IDS, SWING_FACTOR, secondsPerStep,
} from '../src/audio/constants.js';

// offline renders with convolution reverb are slow in Node under load
vi.setConfig({ testTimeout: 30000 });

const SR = 44100;
const beat = (pattern, opts) => renderBeat(pattern, { sampleRate: SR, OfflineAudioContext, ...opts });
const barSeconds = (bpm) => STEPS * secondsPerStep(bpm);
const dbfs = (x) => 20 * Math.log10(x);

function peak(buf, from = 0, to = buf.length) {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = from; i < to; i++) p = Math.max(p, Math.abs(d[i]));
  }
  return p;
}

/** First sample above threshold (any channel), or -1. */
function firstOnset(buf, threshold = 0.02, from = 0) {
  let first = -1;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = from; i < d.length; i++) {
      if (Math.abs(d[i]) > threshold) { if (first < 0 || i < first) first = i; break; }
    }
  }
  return first;
}

function single(bpm, track, step, swing = 0) {
  const p = emptyPattern(bpm);
  p.swing = swing;
  p.sections.A.steps[track][step] = defaultStep(track, step);
  return p;
}

describe('renderBeat', () => {
  it('length is bars * bar duration + tail', async () => {
    const pattern = normalizePattern(V3.boomBap);
    for (const bars of [1, 2]) {
      const buf = await beat(pattern, { bars, tail: 0.5 });
      expect(Math.abs(buf.length - (bars * barSeconds(pattern.bpm) + 0.5) * SR)).toBeLessThanOrEqual(1);
    }
  });

  it('defaults to 4 bars and the default tail', async () => {
    const pattern = emptyPattern(140);
    pattern.sections.A.steps.kick[0] = defaultStep('kick');
    const buf = await beat(pattern);
    expect(DEFAULT_TAIL).toBe(1.5);
    expect(Math.abs(buf.length - (4 * barSeconds(pattern.bpm) + DEFAULT_TAIL) * SR)).toBeLessThanOrEqual(1);
  });

  it('the default tail grows to cover echo and reverb', () => {
    const p = emptyPattern(60);
    expect(beatTail(p)).toBe(DEFAULT_TAIL);
    p.fx.reverb = 0.5;
    expect(beatTail(p)).toBeGreaterThanOrEqual(2.2);
    p.fx.echo = 0.5;
    p.fx.echoTime = '1/4';
    // 7 repeats of a 1 s echo to get 60 dB down
    expect(beatTail(p)).toBeGreaterThanOrEqual(7);
    for (const id of TRACK_IDS) p.fx.sends[id] = { reverb: 0, echo: 0 };
    expect(beatTail(p)).toBe(DEFAULT_TAIL);
  });

  it('rejects unsupported bar counts', async () => {
    expect(EXPORT_BARS).toEqual([1, 2, 4, 8, 16]);
    await expect(beat(PRESETS.trap.pattern, { bars: 3 })).rejects.toThrow(RangeError);
  });

  it('Empty renders silence', async () => {
    expect(peak(await beat(PRESETS.empty.pattern, { bars: 1 }))).toBe(0);
  });

  for (const key of ['afroBass', 'trap', 'boomBap']) {
    const { name, pattern } = PRESETS[key];
    it(`${name} is audible and peaks below 1.0`, async () => {
      const p = peak(await beat(pattern, { bars: 2 }));
      expect(p).toBeGreaterThan(0.05);
      expect(p).toBeLessThan(1);
    });
  }

  it('all tracks muted renders all zeros', async () => {
    const p = normalizePattern(PRESETS.trap.pattern);
    for (const id of p.tracks) p.mixer[id].mute = true;
    expect(peak(await beat(p, { bars: 1 }))).toBe(0);
  });

  it('every pad of every voice on at full volume and master at 180 BPM stays <= 1.0', async () => {
    const p = normalizePattern({ ...emptyPattern(180), tracks: VOICE_IDS });
    p.master = 1;
    for (const id of VOICE_IDS) {
      p.sections.A.steps[id] = Array.from({ length: 16 }, () => ({ ...defaultStep(id), v: 1 }));
      p.mixer[id].volume = 1;
    }
    const pk = peak(await beat(p, { bars: 2 }));
    expect(pk).toBeGreaterThan(0.1);
    expect(pk).toBeLessThanOrEqual(1);
  });

  describe('onset timing', () => {
    const tol = 0.002 * SR;
    // each voice is measured against itself on step 0, which cancels the
    // fixed master-chain delay and the voice's own attack
    for (const bpm of [60, 120, 180]) {
      it(`kick on step 0 and hat on step 4 land on the grid at ${bpm} BPM`, async () => {
        const spb = secondsPerStep(bpm);
        const kick = await beat(single(bpm, 'kick', 0), { bars: 2, tail: 0.2 });
        const latency = firstOnset(kick);
        expect(latency).toBeGreaterThanOrEqual(0);
        expect(latency / SR).toBeLessThan(0.03);
        const bar = barSeconds(bpm) * SR;
        const secondKick = firstOnset(kick, 0.02, Math.round(bar - 0.01 * SR));
        expect(Math.abs(secondKick - (bar + latency))).toBeLessThanOrEqual(tol);

        const hatRef = firstOnset(await beat(single(bpm, 'hat', 0), { bars: 1, tail: 0.2 }));
        const hat = firstOnset(await beat(single(bpm, 'hat', 4), { bars: 1, tail: 0.2 }));
        expect(Math.abs(hat - (4 * spb * SR + hatRef))).toBeLessThanOrEqual(tol);
      });
    }

    it('swing 0.3 shifts odd steps by swing * spb * 5/6 and leaves even steps', async () => {
      const bpm = 120;
      const spb = secondsPerStep(bpm);
      const at = async (step, swing) =>
        firstOnset(await beat(single(bpm, 'hat', step, swing), { bars: 1, tail: 0.2 }));
      const shift = 0.3 * spb * SWING_FACTOR * SR;
      expect(SWING_FACTOR).toBeCloseTo(5 / 6);
      expect(Math.abs((await at(5, 0.3)) - (await at(5, 0)) - shift)).toBeLessThanOrEqual(tol);
      expect(Math.abs((await at(4, 0.3)) - (await at(4, 0)))).toBeLessThanOrEqual(1);
    });
  });

  it('encodes to a WAV with matching rate, channels and length', async () => {
    const pattern = normalizePattern(V3.afroBass);
    const bars = 2, tail = 0.5;
    const buf = await beat(pattern, { bars, tail });
    const view = new DataView(encodeWav(buf));
    const channels = view.getUint16(22, true);
    const blockAlign = view.getUint16(32, true);
    expect(view.getUint32(24, true)).toBe(SR);
    expect(channels).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    const frames = view.getUint32(40, true) / blockAlign;
    expect(frames).toBe(buf.length);
    expect(Math.abs(frames - (bars * barSeconds(pattern.bpm) + tail) * SR)).toBeLessThanOrEqual(1);
  });

  describe('default tail covers the ring-out', () => {
    const endLevel = async (pattern) => {
      const buf = await beat(pattern, { bars: 1 });
      return dbfs(peak(buf, buf.length - Math.round(0.05 * SR)) || 1e-12);
    };

    it('Trap decays below -60 dBFS by the end', async () => {
      expect(await endLevel(normalizePattern(V3.trap))).toBeLessThan(-60);
    });

    for (const id of ['bass', 'openhat']) {
      it(`${id} on the last step at 180 BPM, full volume, decays below -60 dBFS`, async () => {
        const p = single(180, id, 15);
        p.master = 1;
        p.mixer[id].volume = 1;
        expect(await endLevel(p)).toBeLessThan(-60);
      });
    }

    it('the level check is meaningful: a 0.9 s tail still rings', async () => {
      const p = single(180, 'bass', 15);
      p.master = 1;
      p.mixer.bass.volume = 1;
      const buf = await beat(p, { bars: 1, tail: 0.9 });
      expect(dbfs(peak(buf, buf.length - Math.round(0.05 * SR)))).toBeGreaterThan(-60);
    });
  });
});
