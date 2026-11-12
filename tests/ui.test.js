import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRoute, routeHash, ROUTES, DEFAULT_ROUTE } from '../src/ui/router.js';
import { ADVANCED_KEY, TOURED_KEY, loadAdvanced, saveAdvanced, hasToured, markToured } from '../src/ui/settings.js';
import { HELP, HELP_KEYS, GUIDE_SECTIONS, GUIDE_RECIPES, PRESET_INFO } from '../src/ui/help.js';
import { PRESETS } from '../src/audio/presets.js';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
const throwing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('parseRoute', () => {
  it('reads known routes', () => {
    expect(parseRoute('#beat')).toBe('beat');
    expect(parseRoute('#booth')).toBe('booth');
    expect(parseRoute('#guide')).toBe('guide');
    expect(parseRoute('#remix')).toBe('remix');
    expect(parseRoute('#/booth')).toBe('booth');
    expect(parseRoute('#BOOTH')).toBe('booth');
    expect(parseRoute('#booth?x=1')).toBe('booth');
  });

  it('falls back to beat', () => {
    for (const h of ['', '#', '#nope', undefined, null, '#effects']) expect(parseRoute(h)).toBe(DEFAULT_ROUTE);
    expect(DEFAULT_ROUTE).toBe('beat');
  });

  it('round-trips with routeHash', () => {
    for (const r of ROUTES) expect(parseRoute(routeHash(r))).toBe(r);
    expect(routeHash('nope')).toBe('#beat');
  });
});

describe('advanced and tour flags', () => {
  it('advanced defaults to off and persists', () => {
    const s = memoryStorage();
    expect(loadAdvanced(s)).toBe(false);
    saveAdvanced(s, true);
    expect(s.map.get(ADVANCED_KEY)).toBe('1');
    expect(loadAdvanced(s)).toBe(true);
    saveAdvanced(s, false);
    expect(loadAdvanced(s)).toBe(false);
  });

  it('ignores junk and broken storage', () => {
    const s = memoryStorage();
    s.map.set(ADVANCED_KEY, 'maybe');
    expect(loadAdvanced(s)).toBe(false);
    expect(loadAdvanced(null)).toBe(false);
    expect(loadAdvanced(throwing)).toBe(false);
    expect(saveAdvanced(throwing, true)).toBe(false);
  });

  it('tour is marked once', () => {
    const s = memoryStorage();
    expect(hasToured(s)).toBe(false);
    markToured(s);
    expect(s.map.get(TOURED_KEY)).toBe('1');
    expect(hasToured(s)).toBe(true);
  });
});

describe('help dictionary', () => {
  const uiDir = join(import.meta.dirname, '../src/ui');
  const source = readdirSync(uiDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(uiDir, f), 'utf8'))
    .join('\n');
  const used = new Set([...source.matchAll(/\bhelp(?:Tip|Label)\(\s*'([\w-]+)'/g)].map((m) => m[1]));
  // Mode and voice preset buttons look their keys up from a map.
  for (const m of source.matchAll(/\b[A-Z]+_HELP = \{([^}]+)\}/g)) for (const k of m[1].matchAll(/: '(\w+)'/g)) used.add(k[1]);

  it('finds the help calls in the UI', () => {
    expect(used.size).toBeGreaterThan(15);
  });

  it('has an entry for every key the UI renders', () => {
    for (const key of used) expect(HELP, `missing help for "${key}"`).toHaveProperty(key);
  });

  it('every entry is used by a control and listed in the guide', () => {
    const inGuide = new Set(GUIDE_SECTIONS.flatMap((s) => s.keys));
    for (const key of HELP_KEYS) {
      expect(used.has(key), `"${key}" has no ? button`).toBe(true);
      expect(inGuide.has(key), `"${key}" missing from the guide`).toBe(true);
    }
    for (const key of inGuide) expect(HELP).toHaveProperty(key);
  });

  // Every control that renders a "?" in the UI.
  const CONTROL_IDS = [
    'modeBeat', 'modeBooth', 'advanced', 'play', 'tempo', 'presets', 'undo', 'pads', 'sounds',
    'swing', 'master', 'volume', 'mute', 'solo', 'bassNotes', 'exportBeat', 'beatBars', 'patternFile',
    'input', 'mic', 'monitoring', 'level', 'takeBars', 'countIn', 'record', 'latency', 'latencyOffset',
    'takes', 'takePlay', 'takeDelete', 'previewStop', 'exportMix', 'exportVocal', 'vocalFx',
    'effects', 'fxSpace', 'fxEcho', 'fxEchoTime', 'fxFilter', 'fxDrive', 'fxSends',
    'voice', 'voiceClean', 'voiceRobot', 'voiceTuned', 'voiceRadio', 'voiceHall', 'voiceLofi',
    'voiceKey', 'voiceScale', 'voiceTune', 'voiceRetune', 'voiceReverb', 'voiceEcho',
    'modeRemix', 'recordOver', 'remixLoad', 'remixRemove', 'remixDeck', 'remixWave', 'remixLoop',
    'remixMarkStart', 'remixMarkEnd', 'remixSlowedReverb', 'remixNightcore', 'remixOriginal', 'remixSpeed', 'remixSpeedFine', 'remixKeepPitch',
    'remixSpace', 'remixMuffle', 'remixBass', 'remixVolume', 'remixSongBpm', 'remixTap',
    'remixManualBpm', 'remixHalfDouble', 'remixBeatSync', 'remixExport', 'remixExportRange',
  ];

  it('every control id has help text and a ? in the UI', () => {
    for (const id of CONTROL_IDS) {
      expect(HELP, id).toHaveProperty(id);
      expect(used.has(id), `"${id}" has no ? button`).toBe(true);
    }
    expect(new Set(CONTROL_IDS)).toEqual(new Set(HELP_KEYS));
  });

  it('covers the controls beginners asked about', () => {
    for (const key of ['swing', 'master', 'volume', 'mute', 'solo', 'bassNotes', 'tempo', 'presets', 'countIn', 'takeBars', 'monitoring', 'latency', 'takes', 'exportMix', 'exportVocal', 'exportBeat', 'input']) {
      expect(HELP).toHaveProperty(key);
    }
  });

  it('entries are one short sentence', () => {
    for (const [key, h] of Object.entries(HELP)) {
      expect(h.term, key).toBeTruthy();
      expect(h.text.length, key).toBeLessThan(200);
      expect(h.text.endsWith('.'), key).toBe(true);
      expect(h.text.slice(0, -1).includes('. '), `${key} has more than one sentence`).toBe(false);
    }
  });

  it('describes every preset and has recipes', () => {
    for (const key of Object.keys(PRESETS)) expect(PRESET_INFO[key], key).toBeTruthy();
    expect(GUIDE_RECIPES.length).toBeGreaterThanOrEqual(4);
    expect(GUIDE_RECIPES.some((r) => r.title === 'Get the robot voice')).toBe(true);
  });
});
