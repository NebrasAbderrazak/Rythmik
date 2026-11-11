import { describe, it, expect } from 'vitest';
import {
  emptyPattern, normalizePattern, serializePattern, parsePattern,
} from '../src/audio/pattern.js';
import { PRESETS } from '../src/audio/presets.js';
import { TRACKS, BASS_NOTES } from '../src/audio/engine.js';

const on = (...idx) => Array.from({ length: 16 }, (_, i) => idx.includes(i));
const ids = TRACKS.map((t) => t.id);

describe('pattern', () => {
  it('emptyPattern defaults', () => {
    const p = emptyPattern();
    expect(p.version).toBe(2);
    expect(p.bpm).toBe(104);
    expect(p.swing).toBe(0);
    expect(p.master).toBe(0.8);
    expect(Object.keys(p.steps)).toEqual(ids);
    expect(Object.keys(p.mixer)).toEqual(ids);
    for (const id of ids) {
      expect(p.steps[id]).toEqual(new Array(16).fill(false));
      expect(p.mixer[id]).toEqual({ volume: 0.8, mute: false, solo: false });
    }
    expect(p.bassNotes).toEqual(new Array(16).fill(33));
  });

  it('normalizePattern upgrades an old 4-track pattern', () => {
    const legacy = {
      bpm: 104,
      steps: { kick: on(0, 3, 8, 11), snare: on(4, 12), hat: on(0, 2), bass: on(0, 6) },
      bassNotes: [33, 33, 33, 33, 33, 33, 36, 36, 36, 40, 40, 38, 38, 38, 36, 36],
    };
    const p = normalizePattern(legacy);
    expect(p.version).toBe(2);
    expect(p.bpm).toBe(104);
    expect(p.swing).toBe(0);
    expect(p.steps.kick).toEqual(legacy.steps.kick);
    expect(p.steps.bass).toEqual(legacy.steps.bass);
    for (const id of ['clap', 'openhat', 'rim', 'shaker']) expect(p.steps[id]).toEqual(new Array(16).fill(false));
    expect(p.bassNotes).toEqual(legacy.bassNotes);
    expect(p.mixer.bass).toEqual({ volume: 0.8, mute: false, solo: false });
    p.steps.kick[1] = true;
    expect(legacy.steps.kick[1]).toBe(false);
  });

  it('normalizePattern clamps bad values', () => {
    const p = normalizePattern({
      bpm: 999, swing: 5, master: -1,
      steps: { kick: [true, 'yes', 1, null], bogus: on(0) },
      bassNotes: [34, 100, 'x', 0, 45.2],
      mixer: { kick: { volume: 7, mute: 'true', solo: true }, snare: 'loud' },
    });
    expect(p.bpm).toBe(180);
    expect(p.swing).toBe(0.6);
    expect(p.master).toBe(0);
    expect(p.steps.kick.slice(0, 4)).toEqual([true, false, true, false]);
    expect(p.steps.bogus).toBeUndefined();
    const valid = BASS_NOTES.map((n) => n.midi);
    for (const n of p.bassNotes) expect(valid).toContain(n);
    expect(p.bassNotes.slice(0, 5)).toEqual([33, 52, 33, 33, 45]);
    expect(p.mixer.kick).toEqual({ volume: 1, mute: false, solo: true });
    expect(p.mixer.snare).toEqual({ volume: 0.8, mute: false, solo: false });
    expect(normalizePattern(null)).toEqual(emptyPattern());
    expect(normalizePattern({ bpm: 60 - 5 }).bpm).toBe(60);
  });

  it('serialize/parse round-trip', () => {
    for (const { pattern } of Object.values(PRESETS)) {
      const text = serializePattern(pattern);
      expect(text).toContain('\n  "version": 2');
      expect(parsePattern(text)).toEqual(pattern);
    }
    const custom = normalizePattern(PRESETS.trap.pattern);
    custom.mixer.rim.mute = true;
    custom.swing = 0.45;
    custom.bassNotes[5] = 52;
    expect(parsePattern(serializePattern(custom))).toEqual(custom);
  });

  it('parsePattern accepts an old file', () => {
    const p = parsePattern(JSON.stringify({ bpm: 90, steps: { kick: on(0) }, bassNotes: new Array(16).fill(36) }));
    expect(p.version).toBe(2);
    expect(p.bpm).toBe(90);
    expect(p.steps.kick[0]).toBe(true);
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
    expect(p.steps.kick).toEqual(on(0, 8));
    expect(p.steps.snare).toEqual(on(4, 12));
    for (const id of ['clap', 'hat', 'rim']) expect(p.steps[id]).toEqual(new Array(16).fill(false));
    expect(p.bassNotes).toEqual(new Array(16).fill(33));
    expect(p.mixer.kick).toEqual({ volume: 0.8, mute: false, solo: false });
    expect(p.mixer.snare.volume).toBe(0.5);
  });

  it('parsePattern rejects garbage', () => {
    const bad = [
      '', '   ', 'not json', '{"steps": ', 'null', '42', '"text"', '[]', '[1,2,3]',
      '{}', '{"bpm": 100}', '{"steps": []}', '{"steps": {"kick": "x"}}',
      '{"steps": {"unknown": []}}', '{"steps": {"kick": []}, "version": "two"}',
      '{"steps": {"kick": null, "clap": {}}}',
    ];
    for (const text of bad) {
      expect(() => parsePattern(text), text).toThrow('Not a Rythmik pattern file.');
    }
    expect(() => parsePattern(undefined)).toThrow('Not a Rythmik pattern file.');
    expect(() => parsePattern('{"version": 3, "steps": {"kick": []}}'))
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
