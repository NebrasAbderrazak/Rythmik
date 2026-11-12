import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  STORAGE_KEY,
  BROKEN_KEY,
  savePattern,
  loadSavedPattern,
  createAutosave,
  readPatternFile,
} from '../src/ui/persistence.js';
import { emptyPattern } from '../src/audio/pattern.js';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: vi.fn((k, v) => map.set(k, String(v))),
    removeItem: (k) => map.delete(k),
  };
}

function throwingStorage() {
  const quota = new Error('QuotaExceededError');
  quota.name = 'QuotaExceededError';
  return {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw quota;
    },
  };
}

function samplePattern() {
  const p = emptyPattern(123);
  const A = p.sections.A.steps;
  A.kick[0] = { v: 1, r: 2, c: 0.5, p: 3, f: true };
  A.bass[4] = { v: 0.8, r: 1, c: 1, p: 36, f: false };
  p.swing = 0.3;
  p.mixer.snare.mute = true;
  return p;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('savePattern / loadSavedPattern', () => {
  it('saves and loads a pattern', () => {
    const storage = memoryStorage();
    expect(savePattern(samplePattern(), storage)).toBe(true);
    expect(storage.map.has(STORAGE_KEY)).toBe(true);
    const loaded = loadSavedPattern(storage);
    expect(loaded.bpm).toBe(123);
    expect(loaded.version).toBe(4);
    expect(loaded.sections.A.steps.kick[0]).toEqual({ v: 1, r: 2, c: 0.5, p: 3, f: true });
    expect(loaded.sections.A.steps.bass[4]).toMatchObject({ p: 36 });
    expect(loaded.swing).toBeCloseTo(0.3);
    expect(loaded.mixer.snare.mute).toBe(true);
  });

  it('upgrades a beat saved by an older version', () => {
    const storage = memoryStorage();
    const steps = { kick: [true, ...new Array(15).fill(false)], bass: new Array(16).fill(false) };
    steps.bass[4] = true;
    const notes = new Array(16).fill(33);
    notes[4] = 36;
    storage.map.set(STORAGE_KEY, JSON.stringify({ version: 3, bpm: 95, steps, bassNotes: notes }));
    const loaded = loadSavedPattern(storage);
    expect(loaded.version).toBe(4);
    expect(loaded.chain).toEqual(['A']);
    expect(loaded.sections.A.steps.kick[0]).toBeTruthy();
    expect(loaded.sections.A.steps.bass[4].p).toBe(36);
  });

  it('returns null when nothing is saved', () => {
    expect(loadSavedPattern(memoryStorage())).toBeNull();
  });

  it('returns null when storage is unavailable', () => {
    expect(loadSavedPattern(null)).toBeNull();
    expect(savePattern(samplePattern(), null)).toBe(false);
  });

  it('returns null for corrupt data', () => {
    const storage = memoryStorage();
    for (const junk of ['{not json', '[]', '42', '{"hello":"world"}', '   ']) {
      storage.map.set(STORAGE_KEY, junk);
      expect(loadSavedPattern(storage)).toBeNull();
    }
  });

  it('keeps an unreadable saved beat under its own key and says so', () => {
    const storage = memoryStorage();
    storage.map.set(STORAGE_KEY, '{"version": 4, "sections": ');
    const onBroken = vi.fn();
    expect(loadSavedPattern(storage, { onBroken })).toBeNull();
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(storage.map.get(BROKEN_KEY)).toBe('{"version": 4, "sections": ');
    expect(storage.map.get(STORAGE_KEY)).toBe('{"version": 4, "sections": ');
  });

  it('handles a storage that throws', () => {
    const storage = throwingStorage();
    expect(() => savePattern(samplePattern(), storage)).not.toThrow();
    expect(savePattern(samplePattern(), storage)).toBe(false);
    expect(loadSavedPattern(storage)).toBeNull();
  });
});

describe('createAutosave', () => {
  it('debounces writes', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const autosave = createAutosave(storage, { delay: 300 });
    for (let bpm = 90; bpm <= 100; bpm++) autosave.schedule(emptyPattern(bpm));
    vi.advanceTimersByTime(299);
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(loadSavedPattern(storage).bpm).toBe(100);
  });

  it('flush writes once', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const autosave = createAutosave(storage, { delay: 300 });
    autosave.schedule(emptyPattern(140));
    expect(autosave.flush()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(autosave.flush()).toBe(false);
  });

  it('does not throw when the write fails', () => {
    vi.useFakeTimers();
    const autosave = createAutosave(throwingStorage(), { delay: 300 });
    autosave.schedule(emptyPattern());
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
  });
});

describe('readPatternFile', () => {
  const file = (text) => ({ size: text.length, text: async () => text });

  it('parses an exported pattern', async () => {
    const storage = memoryStorage();
    savePattern(samplePattern(), storage);
    const p = await readPatternFile(file(storage.map.get(STORAGE_KEY)));
    expect(p.bpm).toBe(123);
  });

  it('rejects junk', async () => {
    await expect(readPatternFile(file('nope'))).rejects.toThrow('Not a Rythmik pattern file.');
  });

  it('rejects oversized files', async () => {
    await expect(readPatternFile({ size: 10 * 1024 * 1024, text: async () => '' })).rejects.toThrow(/too large/);
  });
});
