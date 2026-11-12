import {
  STEPS, TRACK_IDS, DEFAULT_BPM, DEFAULT_VOLUME, DEFAULT_MASTER, DEFAULT_BASS_NOTE,
  clampBpm, clampSwing, clampUnit, snapBassNote,
} from './constants.js';
import { defaultFx, normalizeFx } from './fx.js';

export const PATTERN_VERSION = 3;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function emptyPattern(bpm = DEFAULT_BPM) {
  const steps = {};
  const mixer = {};
  for (const id of TRACK_IDS) {
    steps[id] = new Array(STEPS).fill(false);
    mixer[id] = { volume: DEFAULT_VOLUME, mute: false, solo: false };
  }
  return {
    version: PATTERN_VERSION,
    bpm: clampBpm(bpm),
    swing: 0,
    master: DEFAULT_MASTER,
    steps,
    bassNotes: new Array(STEPS).fill(DEFAULT_BASS_NOTE),
    mixer,
    fx: defaultFx(),
  };
}

/** Deep copy in the current shape; fills defaults, clamps, upgrades old patterns (v1/v2: fx off). */
export function normalizePattern(p) {
  const src = isObject(p) ? p : {};
  const out = emptyPattern(clampBpm(src.bpm));
  out.swing = clampSwing(src.swing, 0);
  out.master = clampUnit(src.master, DEFAULT_MASTER);

  const steps = isObject(src.steps) ? src.steps : {};
  for (const id of TRACK_IDS) {
    const row = steps[id];
    if (Array.isArray(row)) for (let i = 0; i < STEPS; i++) out.steps[id][i] = row[i] === true || row[i] === 1;
  }

  if (Array.isArray(src.bassNotes)) {
    for (let i = 0; i < STEPS; i++) {
      const v = src.bassNotes[i];
      const n = typeof v === 'number' ? v : Number.NaN;
      if (Number.isFinite(n)) out.bassNotes[i] = snapBassNote(Math.round(n));
    }
  }

  const mixer = isObject(src.mixer) ? src.mixer : {};
  for (const id of TRACK_IDS) {
    const ch = isObject(mixer[id]) ? mixer[id] : {};
    out.mixer[id] = {
      volume: clampUnit(ch.volume, DEFAULT_VOLUME),
      mute: ch.mute === true,
      solo: ch.solo === true,
    };
  }
  out.fx = normalizeFx(src.fx);
  return out;
}

export function serializePattern(p) {
  return JSON.stringify(normalizePattern(p), null, 2) + '\n';
}

const NOT_A_PATTERN = 'Not a Rythmik pattern file.';

/** Throws an Error with a user-facing message if the text is not a pattern. */
export function parsePattern(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error(NOT_A_PATTERN);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(NOT_A_PATTERN);
  }
  if (!isObject(data) || !isObject(data.steps)) throw new Error(NOT_A_PATTERN);
  if (data.version !== undefined) {
    if (!Number.isInteger(data.version) || data.version < 1) throw new Error(NOT_A_PATTERN);
    if (data.version > PATTERN_VERSION) {
      throw new Error('This pattern was made by a newer version of Rythmik.');
    }
  }
  // broken individual rows/fields just fall back to defaults
  if (!TRACK_IDS.some((id) => Array.isArray(data.steps[id]))) throw new Error(NOT_A_PATTERN);
  return normalizePattern(data);
}
