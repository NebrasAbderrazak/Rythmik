import { describe, it, expect, vi } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { PRESETS, PRESET_IDS, GENRES } from '../src/audio/presets.js';
import { normalizePattern } from '../src/audio/pattern.js';
import { renderBeat } from '../src/audio/export.js';
import {
  MIN_BPM, MAX_BPM, MAX_SWING, BASS_MIDI, VOICE_IDS,
} from '../src/audio/constants.js';

// offline renders with convolution reverb are slow in Node under load
vi.setConfig({ testTimeout: 60000 });

const SR = 22050;
const list = Object.values(PRESETS);
const grooves = list.filter((p) => p.id !== 'empty');
const genreIds = GENRES.map((g) => g.id);

function peak(buf) {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
  }
  return p;
}

const chainSteps = (pattern) => pattern.chain.flatMap((name) => {
  const sec = pattern.sections[name];
  return pattern.tracks.map((id) => ({ id, row: sec.steps[id] }));
});

describe('preset library', () => {
  it('ids are unique, keyed by id and keep the old ones', () => {
    expect(PRESET_IDS).toEqual(Object.keys(PRESETS));
    expect(new Set(PRESET_IDS).size).toBe(PRESET_IDS.length);
    for (const id of ['afroBass', 'trap', 'boomBap', 'empty']) expect(PRESETS[id], id).toBeTruthy();
    for (const [key, p] of Object.entries(PRESETS)) expect(p.id).toBe(key);
    expect(grooves.length).toBeGreaterThanOrEqual(25);
  });

  it('genres are valid, all used, and presets come in genre order', () => {
    expect(new Set(genreIds).size).toBe(genreIds.length);
    for (const g of GENRES) {
      expect(typeof g.name).toBe('string');
      expect(grooves.some((p) => p.genre === g.id), g.id).toBe(true);
    }
    const order = grooves.map((p) => genreIds.indexOf(p.genre));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(PRESET_IDS.at(-1)).toBe('empty');
  });

  it('names and descriptions read well', () => {
    const names = list.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of list) {
      expect(p.name.length, p.id).toBeGreaterThan(1);
      expect(p.description, p.id).toMatch(/^[A-Z].*\.$/);
      expect(p.description, p.id).not.toMatch(/[\u2013\u2014]/);
      if ('original' in p) expect(p.original, p.id).toBe(true);
    }
    for (const p of grooves) expect(p.description, p.id).toContain(`${p.pattern.bpm} BPM`);
    expect(list.filter((p) => p.original).length).toBeGreaterThanOrEqual(3);
  });
});

describe('preset patterns', () => {
  for (const p of list) {
    it(`${p.name} is a normalized v4 pattern`, () => {
      const { pattern } = p;
      expect(pattern.version).toBe(4);
      expect(normalizePattern(pattern)).toEqual(pattern);
      expect(pattern.bpm).toBeGreaterThanOrEqual(MIN_BPM);
      expect(pattern.bpm).toBeLessThanOrEqual(MAX_BPM);
      expect(pattern.swing).toBeGreaterThanOrEqual(0);
      expect(pattern.swing).toBeLessThanOrEqual(MAX_SWING);
      expect(new Set(pattern.tracks).size).toBe(pattern.tracks.length);
      for (const id of pattern.tracks) expect(VOICE_IDS, id).toContain(id);
      expect(pattern.chain.length).toBeGreaterThan(0);
      for (const name of pattern.chain) expect([16, 32]).toContain(pattern.sections[name]?.length);
    });
  }

  for (const p of grooves) {
    it(`${p.name} uses every track it lists, with sane steps`, () => {
      const { pattern } = p;
      expect(pattern.tracks.length).toBeLessThanOrEqual(10);
      for (const id of pattern.tracks) {
        const hits = chainSteps(pattern).filter((r) => r.id === id).flatMap((r) => r.row.filter(Boolean));
        expect(hits.length, `${p.id}.${id}`).toBeGreaterThan(0);
        for (const s of hits) {
          expect(s.v).toBeGreaterThan(0);
          expect(s.v).toBeLessThanOrEqual(1);
          if (id === 'bass' || id === 'logdrum') expect(BASS_MIDI, `${p.id}.${id}`).toContain(s.p);
          else expect(Math.abs(s.p)).toBeLessThanOrEqual(12);
        }
      }
      expect(pattern.fx.sends.kick).toEqual({ reverb: 0, echo: 0 });
      for (const id of pattern.tracks) expect(pattern.fx.sends[id], `${p.id}.${id}`).toBeTruthy();
    });
  }

  it('trap and drill use hat rolls and velocity', () => {
    for (const id of ['trap', 'ukDrill', 'nyDrill']) {
      const hats = chainSteps(PRESETS[id].pattern).filter((r) => r.id === 'hat').flatMap((r) => r.row.filter(Boolean));
      expect(hats.some((s) => s.r > 1), id).toBe(true);
      expect(new Set(hats.map((s) => s.v)).size, id).toBeGreaterThan(1);
    }
  });

  it('keeps the old presets recognizable', () => {
    expect(PRESETS.afroBass.pattern.bpm).toBe(104);
    expect(PRESETS.trap.pattern.bpm).toBe(140);
    expect(PRESETS.boomBap.pattern.bpm).toBe(90);
    expect(PRESETS.boomBap.pattern.swing).toBeGreaterThanOrEqual(0.25);
    expect(PRESETS.trap.pattern.fx.sends.hat.echo).toBeGreaterThan(0);
    expect(PRESETS.boomBap.pattern.fx.drive).toBeGreaterThan(0);
    expect(PRESETS.amapiano.pattern.tracks).toContain('logdrum');
  });
});

describe('preset renders', () => {
  for (const p of grooves) {
    it(`${p.name} renders 2 bars, audible and below 0 dBFS`, async () => {
      const buf = await renderBeat(p.pattern, { bars: 2, sampleRate: SR, OfflineAudioContext });
      const pk = peak(buf);
      expect(pk).toBeGreaterThan(0.05);
      expect(pk).toBeLessThan(1);
    });
  }

  it('Empty renders silence', async () => {
    const buf = await renderBeat(PRESETS.empty.pattern, { bars: 1, sampleRate: SR, OfflineAudioContext });
    expect(peak(buf)).toBe(0);
  });
});
