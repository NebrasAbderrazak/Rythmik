import {
  STEPS, TRACK_IDS, DEFAULT_BPM, DEFAULT_VOLUME, DEFAULT_MASTER, DEFAULT_BASS_NOTE, DEFAULT_VELOCITY,
  MAX_TRACKS, SECTION_LENGTHS, MAX_CHAIN, MAX_ROLL, MAX_PITCH, MAX_NUDGE,
  clampBpm, clampSwing, clampUnit, snapBassNote, isPitched, isTrackId, grooveVelocity,
} from './constants.js';
import { defaultFx, normalizeFx } from './fx.js';

export const PATTERN_VERSION = 4;
export const SECTION_NAMES = ['A', 'B'];
export const MAX_STEP_SHIFT = 0.25;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const round3 = (x) => Math.round(x * 1000) / 1000;

function defaultVelocity(id, step) {
  return id === 'hat' || id === 'shaker' ? round3(grooveVelocity(step) * DEFAULT_VELOCITY) : DEFAULT_VELOCITY;
}

/** The step a click turns on: normal velocity (hats keep their accent shape), no roll, always plays. */
export function defaultStep(id, step = 0) {
  return { v: defaultVelocity(id, step), r: 1, c: 1, p: isPitched(id) ? DEFAULT_BASS_NOTE : 0, f: false };
}

function normalizePitch(id, value, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
  if (n === null) return fallback;
  if (isPitched(id)) return snapBassNote(n);
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, n));
}

/** null for off; true/1 or an object for on. */
export function normalizeStep(x, id, step = 0) {
  if (x === true || x === 1) return defaultStep(id, step);
  if (!isObject(x)) return null;
  const d = defaultStep(id, step);
  const r = Number(x.r);
  const out = {
    v: round3(clampUnit(x.v, d.v)),
    r: Number.isFinite(r) ? Math.max(1, Math.min(MAX_ROLL, Math.round(r))) : 1,
    c: round3(clampUnit(x.c, d.c)),
    p: normalizePitch(id, x.p, d.p),
    f: x.f === true,
  };
  // micro timing from humanize, in steps; only stored when set
  const t = round3(clampUnit(x.t, 0, -MAX_STEP_SHIFT, MAX_STEP_SHIFT));
  if (t !== 0) out.t = t;
  return out;
}

export const emptyRow = (length = STEPS) => new Array(length).fill(null);

export function emptySection(tracks, length = STEPS) {
  const steps = {};
  for (const id of tracks) steps[id] = emptyRow(length);
  return { length, steps };
}

export const defaultChannel = () => ({
  volume: DEFAULT_VOLUME, mute: false, solo: false, swing: null, nudge: 0,
});

export function emptyPattern(bpm = DEFAULT_BPM) {
  const tracks = [...TRACK_IDS];
  const mixer = {};
  for (const id of tracks) mixer[id] = defaultChannel();
  return {
    version: PATTERN_VERSION,
    bpm: clampBpm(bpm),
    swing: 0,
    master: DEFAULT_MASTER,
    fx: defaultFx(tracks),
    tracks,
    mixer,
    sections: { A: emptySection(tracks), B: null },
    chain: ['A'],
  };
}

function normalizeSection(src, tracks) {
  const s = isObject(src) ? src : {};
  const length = SECTION_LENGTHS.includes(s.length) ? s.length : STEPS;
  const steps = isObject(s.steps) ? s.steps : {};
  const out = emptySection(tracks, length);
  for (const id of tracks) {
    const row = steps[id];
    if (!Array.isArray(row)) continue;
    for (let i = 0; i < length; i++) out.steps[id][i] = normalizeStep(row[i], id, i);
  }
  return out;
}

function normalizeTracks(list) {
  const out = [];
  if (Array.isArray(list)) {
    for (const id of list) if (isTrackId(id) && !out.includes(id) && out.length < MAX_TRACKS) out.push(id);
  }
  return out.length ? out : [...TRACK_IDS];
}

function normalizeChannel(ch) {
  const c = isObject(ch) ? ch : {};
  const swing = c.swing === null || c.swing === undefined ? null : clampSwing(c.swing, null);
  return {
    volume: clampUnit(c.volume, DEFAULT_VOLUME),
    mute: c.mute === true,
    solo: c.solo === true,
    swing: swing === null ? null : round3(swing),
    nudge: round3(clampUnit(c.nudge, 0, -MAX_NUDGE, MAX_NUDGE)),
  };
}

// v1-v3: one bar of booleans for the original 8 tracks plus a bassNotes row
function upgradeSteps(src) {
  const steps = isObject(src.steps) ? src.steps : {};
  const notes = Array.isArray(src.bassNotes) ? src.bassNotes : [];
  const section = emptySection(TRACK_IDS);
  for (const id of TRACK_IDS) {
    const row = steps[id];
    if (!Array.isArray(row)) continue;
    for (let i = 0; i < STEPS; i++) {
      if (row[i] !== true && row[i] !== 1) continue;
      const step = defaultStep(id, i);
      if (id === 'bass') step.p = normalizePitch(id, notes[i], DEFAULT_BASS_NOTE);
      section.steps[id][i] = step;
    }
  }
  return section;
}

// a top-level steps object means the old shape, even when spread over a new pattern
const isV4 = (src) => isObject(src.sections) && !isObject(src.steps);

/** Deep copy in the current shape; fills defaults, clamps, upgrades v1-v3 patterns. */
export function normalizePattern(p) {
  const src = isObject(p) ? p : {};
  const out = emptyPattern(clampBpm(src.bpm));
  out.swing = clampSwing(src.swing, 0);
  out.master = clampUnit(src.master, DEFAULT_MASTER);

  if (isV4(src)) {
    out.tracks = normalizeTracks(src.tracks);
    out.sections.A = normalizeSection(src.sections.A, out.tracks);
    out.sections.B = isObject(src.sections.B) ? normalizeSection(src.sections.B, out.tracks) : null;
    const chain = Array.isArray(src.chain)
      ? src.chain.filter((n) => n === 'A' || (n === 'B' && out.sections.B)).slice(0, MAX_CHAIN)
      : [];
    out.chain = chain.length ? chain : ['A'];
  } else {
    out.sections.A = upgradeSteps(src);
  }

  const mixer = isObject(src.mixer) ? src.mixer : {};
  out.mixer = {};
  for (const id of out.tracks) out.mixer[id] = normalizeChannel(mixer[id]);
  out.fx = normalizeFx(src.fx, out.tracks);
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
  if (!isObject(data)) throw new Error(NOT_A_PATTERN);
  if (data.version !== undefined) {
    if (!Number.isInteger(data.version) || data.version < 1) throw new Error(NOT_A_PATTERN);
    if (data.version > PATTERN_VERSION) {
      throw new Error('This pattern was made by a newer version of Rythmik.');
    }
  }
  if (data.version === PATTERN_VERSION || isV4(data)) {
    if (!isObject(data.sections) || !isObject(data.sections.A)) throw new Error(NOT_A_PATTERN);
    return normalizePattern(data);
  }
  // broken individual rows/fields just fall back to defaults
  if (!isObject(data.steps) || !TRACK_IDS.some((id) => Array.isArray(data.steps[id]))) {
    throw new Error(NOT_A_PATTERN);
  }
  return normalizePattern(data);
}

/** Total steps in one pass of the chain. */
export function loopLength(p) {
  let n = 0;
  for (const name of p.chain) n += p.sections[name]?.length ?? 0;
  return n || STEPS;
}

/** Where loop position `pos` falls: { chainIndex, section, step }. */
export function locate(p, pos) {
  let rest = pos % loopLength(p);
  for (let i = 0; i < p.chain.length; i++) {
    const len = p.sections[p.chain[i]]?.length ?? 0;
    if (rest < len) return { chainIndex: i, section: p.chain[i], step: rest };
    rest -= len;
  }
  return { chainIndex: 0, section: 'A', step: rest % STEPS };
}
