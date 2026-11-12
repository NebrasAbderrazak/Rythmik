import { describe, it, expect } from 'vitest';
import {
  emptyPattern, normalizePattern, serializePattern, parsePattern, defaultStep, loopLength, locate,
} from '../src/audio/pattern.js';
import { TRACKS, BASS_NOTES, VOICES, VOICE_IDS } from '../src/audio/engine.js';
import V3 from './fixtures/v3-presets.json';

const on = (...idx) => Array.from({ length: 16 }, (_, i) => idx.includes(i));
const ids = TRACKS.map((t) => t.id);
const row = (p, id, section = 'A') => p.sections[section].steps[id];
const hits = (r) => r.map(Boolean);
const channel = { volume: 0.8, mute: false, solo: false, swing: null, nudge: 0 };

describe('pattern v4', () => {
  it('emptyPattern defaults', () => {
    const p = emptyPattern();
    expect(p.version).toBe(4);
    expect(p.bpm).toBe(104);
    expect(p.swing).toBe(0);
    expect(p.master).toBe(0.8);
    expect(p.tracks).toEqual(ids);
    expect(p.chain).toEqual(['A']);
    expect(p.sections.B).toBe(null);
    expect(p.sections.A.length).toBe(16);
    expect(Object.keys(p.mixer)).toEqual(ids);
    expect(Object.keys(p.fx.sends)).toEqual(ids);
    for (const id of ids) {
      expect(row(p, id)).toEqual(new Array(16).fill(null));
      expect(p.mixer[id]).toEqual(channel);
    }
  });

  it('voices', () => {
    expect(VOICE_IDS).toEqual([
      'kick', 'snare', 'clap', 'hat', 'openhat', 'rim', 'shaker', 'bass',
      'tomlo', 'tomhi', 'crash', 'ride', 'cowbell', 'conga', 'snap', 'logdrum',
    ]);
    expect(VOICES.find((v) => v.id === 'logdrum')).toEqual({ id: 'logdrum', name: 'Log drum', group: 'bass', pitched: true });
    expect(VOICES.filter((v) => v.pitched).map((v) => v.id)).toEqual(['bass', 'logdrum']);
  });

  it('upgrades an old 4-track pattern', () => {
    const legacy = {
      bpm: 104,
      steps: { kick: on(0, 3, 8, 11), snare: on(4, 12), hat: on(0, 2, 3), bass: on(0, 6) },
      bassNotes: [33, 33, 33, 33, 33, 33, 36, 36, 36, 40, 40, 38, 38, 38, 36, 36],
    };
    const p = normalizePattern(legacy);
    expect(p.version).toBe(4);
    expect(p.tracks).toEqual(ids);
    expect(p.chain).toEqual(['A']);
    expect(hits(row(p, 'kick'))).toEqual(legacy.steps.kick);
    expect(row(p, 'kick')[0]).toEqual({ v: 0.8, r: 1, c: 1, p: 0, f: false });
    expect(row(p, 'bass')[6].p).toBe(36);
    expect(row(p, 'bass')[0].p).toBe(33);
    // hats keep the old accent shape: 0.85 / 0.7 / 0.5 of a normal hit
    expect(row(p, 'hat').slice(0, 4).map((s) => s?.v ?? null)).toEqual([0.68, null, 0.56, 0.4]);
    for (const id of ['clap', 'openhat', 'rim', 'shaker']) expect(row(p, id)).toEqual(new Array(16).fill(null));
    expect(p.mixer.bass).toEqual(channel);
    row(p, 'kick')[1] = defaultStep('kick');
    expect(legacy.steps.kick[1]).toBe(false);
  });

  it('upgrades v3 files with mixer and fx', () => {
    const p = normalizePattern(V3.trap);
    expect(p.mixer.clap.volume).toBe(0.82);
    expect(p.fx.echo).toBe(0.35);
    expect(p.fx.sends.clap).toEqual(V3.trap.fx.sends.clap);
    expect(row(p, 'bass')[10].p).toBe(40);
  });

  it('clamps steps and channels', () => {
    const p = normalizePattern({
      version: 4,
      bpm: 999, swing: 5, master: -1,
      tracks: ['kick', 'kick', 'bogus', 'smp-ab12', 'bass', 'smp-../x', 'logdrum'],
      mixer: {
        kick: { volume: 7, mute: 'true', solo: true, swing: 3, nudge: -2 },
        bass: { swing: 'x', nudge: 0.25 },
      },
      sections: {
        A: {
          length: 32,
          steps: {
            kick: [{ v: 3, r: 9, c: -1, p: 40, f: 1 }, true, 'yes', 1, null, { r: 2.4, p: -3.6 }],
            bass: [{ p: 34 }, { p: 100 }, { p: 'x' }],
            logdrum: [{ p: 45 }],
            bogus: on(0),
          },
        },
        B: { length: 12, steps: { kick: [true] } },
      },
      chain: ['A', 'B', 'C', 'B', 'A', 'A', 'A', 'A', 'A', 'A'],
    });
    expect(p.bpm).toBe(180);
    expect(p.swing).toBe(0.6);
    expect(p.master).toBe(0);
    expect(p.tracks).toEqual(['kick', 'smp-ab12', 'bass', 'logdrum']);
    expect(p.sections.A.length).toBe(32);
    expect(row(p, 'kick').length).toBe(32);
    expect(row(p, 'kick')[0]).toEqual({ v: 1, r: 4, c: 0, p: 12, f: false });
    expect(row(p, 'kick')[1]).toEqual(defaultStep('kick'));
    expect(row(p, 'kick')[2]).toBe(null);
    expect(row(p, 'kick')[3]).toEqual(defaultStep('kick'));
    expect(row(p, 'kick')[5]).toEqual({ v: 0.8, r: 2, c: 1, p: -4, f: false });
    const valid = BASS_NOTES.map((n) => n.midi);
    expect(row(p, 'bass').slice(0, 3).map((s) => s.p)).toEqual([33, 52, 33]);
    for (const s of row(p, 'bass')) if (s) expect(valid).toContain(s.p);
    expect(row(p, 'logdrum')[0].p).toBe(45);
    expect(row(p, 'smp-ab12')).toEqual(new Array(32).fill(null));
    expect(p.sections.A.steps.bogus).toBeUndefined();
    expect(p.sections.B.length).toBe(16);
    expect(p.chain).toEqual(['A', 'B', 'B', 'A', 'A', 'A', 'A', 'A']);
    expect(p.mixer.kick).toEqual({ volume: 1, mute: false, solo: true, swing: 0.6, nudge: -0.5 });
    expect(p.mixer.bass).toEqual({ ...channel, nudge: 0.25 });
    expect(p.mixer['smp-ab12']).toEqual(channel);
    expect(p.fx.sends['smp-ab12']).toEqual({ reverb: 0.2, echo: 0.15 });
    expect(normalizePattern(null)).toEqual(emptyPattern());
    expect(normalizePattern({ bpm: 60 - 5 }).bpm).toBe(60);
  });

  it('a chain naming a missing B falls back to A', () => {
    const p = normalizePattern({ ...emptyPattern(), chain: ['B', 'B'] });
    expect(p.chain).toEqual(['A']);
    const q = normalizePattern({ ...emptyPattern(), tracks: [], chain: [] });
    expect(q.tracks).toEqual(ids);
  });

  it('loop length and positions across the chain', () => {
    const p = emptyPattern();
    p.sections.A.length = 32;
    p.sections.B = { length: 16, steps: {} };
    p.chain = ['A', 'B', 'A'];
    expect(loopLength(p)).toBe(80);
    expect(locate(p, 0)).toEqual({ chainIndex: 0, section: 'A', step: 0 });
    expect(locate(p, 31)).toEqual({ chainIndex: 0, section: 'A', step: 31 });
    expect(locate(p, 32)).toEqual({ chainIndex: 1, section: 'B', step: 0 });
    expect(locate(p, 50)).toEqual({ chainIndex: 2, section: 'A', step: 2 });
    expect(locate(p, 80)).toEqual({ chainIndex: 0, section: 'A', step: 0 });
  });

  it('serialize/parse round-trip', () => {
    for (const old of Object.values(V3)) {
      const pattern = normalizePattern(old);
      const text = serializePattern(pattern);
      expect(text).toContain('\n  "version": 4');
      expect(parsePattern(text)).toEqual(pattern);
    }
    const custom = normalizePattern(V3.trap);
    custom.mixer.rim.mute = true;
    custom.mixer.hat.nudge = -0.2;
    custom.swing = 0.45;
    custom.sections.A.steps.bass[5] = { v: 1, r: 2, c: 0.5, p: 52, f: true };
    custom.sections.B = structuredClone(custom.sections.A);
    custom.chain = ['A', 'A', 'B'];
    expect(parsePattern(serializePattern(custom))).toEqual(custom);
  });

  it('parsePattern accepts old files', () => {
    const p = parsePattern(JSON.stringify({ bpm: 90, steps: { kick: on(0) }, bassNotes: new Array(16).fill(36) }));
    expect(p.version).toBe(4);
    expect(p.bpm).toBe(90);
    expect(row(p, 'kick')[0]).toEqual(defaultStep('kick'));
    for (const version of [1, 2, 3]) {
      expect(row(parsePattern(JSON.stringify({ version, steps: { snare: on(4) } })), 'snare')[4]).toBeTruthy();
    }
  });

  it('parsePattern repairs broken rows', () => {
    const text = JSON.stringify({
      version: 2, bpm: 'fast', swing: 'lots',
      steps: { kick: on(0, 8), clap: null, hat: 'xx', rim: { a: 1 }, snare: on(4, 12) },
      bassNotes: 'nope',
      mixer: { kick: null, snare: { volume: 0.5 } },
    });
    const p = parsePattern(text);
    expect(p.bpm).toBe(104);
    expect(p.swing).toBe(0);
    expect(hits(row(p, 'kick'))).toEqual(on(0, 8));
    expect(hits(row(p, 'snare'))).toEqual(on(4, 12));
    for (const id of ['clap', 'hat', 'rim']) expect(row(p, id)).toEqual(new Array(16).fill(null));
    expect(p.mixer.kick).toEqual(channel);
    expect(p.mixer.snare.volume).toBe(0.5);
  });

  it('parsePattern rejects garbage', () => {
    const bad = [
      '', '   ', 'not json', '{"steps": ', 'null', '42', '"text"', '[]', '[1,2,3]',
      '{}', '{"bpm": 100}', '{"steps": []}', '{"steps": {"kick": "x"}}',
      '{"steps": {"unknown": []}}', '{"steps": {"kick": []}, "version": "two"}',
      '{"steps": {"kick": null, "clap": {}}}', '{"version": 4, "steps": {"kick": []}}',
      '{"version": 4, "sections": {}}', '{"version": 4, "sections": {"A": []}}',
    ];
    for (const text of bad) {
      expect(() => parsePattern(text), text).toThrow('Not a Rythmik pattern file.');
    }
    expect(() => parsePattern(undefined)).toThrow('Not a Rythmik pattern file.');
    expect(() => parsePattern('{"version": 5, "sections": {"A": {}}}'))
      .toThrow('This pattern was made by a newer version of Rythmik.');
    try {
      parsePattern('{oops');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message.length).toBeLessThan(80);
      expect(e.message).not.toMatch(/JSON|position|token/i);
    }
  });
});
