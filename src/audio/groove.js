// Step tools: humanize, randomize, fill, clear. Pure: each takes a pattern and
// returns a new normalized one. Pass a seed for repeatable results; without one
// every call is different.
import { BASS_NOTES, MAX_TRACKS, isTrackId } from './constants.js';
import { normalizePattern, normalizeStep, defaultStep, emptyRow } from './pattern.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const newSeed = () => Math.floor(Math.random() * 4294967296);
const rngFor = (seed) => mulberry32(Number.isFinite(seed) ? seed : newSeed());
const round3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sectionsOf = (p) => Object.keys(p.sections).filter((n) => p.sections[n]);

const MAX_HUMAN_V = 0.15; // velocity, at amount 1
const MAX_HUMAN_T = 0.08; // steps (10 ms at 120 BPM)

/**
 * Small random velocity and timing changes per step. Timing goes into the
 * step's `t` (steps, +/-), not the track nudge; downbeats move half as much.
 */
export function humanize(pattern, amount = 0.5, { seed } = {}) {
  const p = normalizePattern(pattern);
  const a = clamp(Number(amount) || 0, 0, 1);
  const rnd = rngFor(seed);
  const jitter = () => rnd() * 2 - 1;
  for (const name of sectionsOf(p)) {
    const sec = p.sections[name];
    for (const id of p.tracks) {
      sec.steps[id] = sec.steps[id].map((s, i) => {
        if (!s) return null;
        const tight = i % 4 === 0 ? 0.5 : 1;
        return normalizeStep({
          ...s,
          v: clamp(s.v + jitter() * MAX_HUMAN_V * a, 0.1, 1),
          t: jitter() * MAX_HUMAN_T * a * tight,
        }, id, i);
      });
    }
  }
  return normalizePattern(p);
}

// how likely each 16th is for a kind of voice, bar position 0..15
const SHAPES = {
  kick: [10, 0.5, 2, 3, 2, 0.5, 3, 2, 5, 0.5, 3, 3, 2, 0.5, 3, 1.5],
  backbeat: [0.3, 0.3, 0.5, 0.3, 10, 0.5, 0.5, 1, 0.3, 0.5, 0.5, 0.5, 10, 0.5, 1, 1],
  hat: [4, 1.5, 4, 1.5, 4, 1.5, 4, 1.5, 4, 1.5, 4, 1.5, 4, 1.5, 4, 1.5],
  openhat: [0.2, 0.2, 4, 0.2, 0.2, 0.2, 4, 0.2, 0.2, 0.2, 4, 0.2, 0.2, 0.2, 5, 0.5],
  crash: [10, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0],
  perc: [1, 1, 2, 3, 1, 2, 3, 1, 1, 2, 3, 1, 1, 3, 2, 1],
};

const SHAPE_OF = {
  kick: 'kick', bass: 'kick', logdrum: 'perc',
  snare: 'backbeat', clap: 'backbeat', snap: 'backbeat',
  hat: 'hat', shaker: 'hat', ride: 'hat',
  openhat: 'openhat', crash: 'crash',
};

function randomRow(id, length, density, rnd) {
  const shape = SHAPES[SHAPE_OF[id] || 'perc'];
  const weights = Array.from({ length }, (_, i) => shape[i % 16]);
  const mean = weights.reduce((a, b) => a + b, 0) / length;
  const d = clamp(Number(density) || 0, 0, 1);
  const row = emptyRow(length);
  const notes = BASS_NOTES.slice(0, 8).map((n) => n.midi);
  for (let i = 0; i < length; i++) {
    const strong = shape[i % 16] >= 10;
    // the strongest beats (kick on 1, snare on 2 and 4) stay put at any density
    const chance = strong && d > 0 ? 1 : clamp((d * weights[i]) / mean, 0, 0.95);
    if (rnd() >= chance) continue;
    const s = defaultStep(id, i);
    if (!strong && SHAPE_OF[id] === 'backbeat' && rnd() < 0.7) s.v = 0.45; // ghost notes
    if (SHAPE_OF[id] === 'hat' && d > 0.4 && rnd() < 0.08) s.r = rnd() < 0.6 ? 2 : 3;
    if (id === 'bass' || id === 'logdrum') {
      // mostly the root, sometimes a step of the scale
      s.p = rnd() < 0.6 ? notes[0] : notes[Math.floor(rnd() * notes.length)];
    }
    row[i] = s;
  }
  return row;
}

/** A fresh row for one track in one section (default 'A'). */
export function randomizeTrack(pattern, id, { density = 0.3, seed, section = 'A' } = {}) {
  const p = normalizePattern(pattern);
  const sec = p.sections[section];
  if (!sec || !p.tracks.includes(id)) return p;
  sec.steps[id] = randomRow(id, sec.length, density, rngFor(seed));
  return normalizePattern(p);
}

/** Clears a track in one section, or in every section when none is given. */
export function clearTrack(pattern, id, { section } = {}) {
  const p = normalizePattern(pattern);
  for (const name of section ? [section] : sectionsOf(p)) {
    const sec = p.sections[name];
    if (sec?.steps[id]) sec.steps[id] = emptyRow(sec.length);
  }
  return p;
}

function ensureTrack(p, id) {
  if (p.tracks.includes(id)) return true;
  if (p.tracks.length >= MAX_TRACKS || !isTrackId(id)) return false;
  p.tracks.push(id);
  for (const name of sectionsOf(p)) p.sections[name].steps[id] = emptyRow(p.sections[name].length);
  return true;
}

// fill shapes over the last beat (4 steps): [track, velocity, roll] or null
const FILLS = [
  // snare 16ths, getting louder, last one a double
  [['snare', 0.5, 1], ['snare', 0.62, 1], ['snare', 0.75, 1], ['snare', 0.95, 2]],
  // snare doubles into the toms
  [['snare', 0.6, 2], ['snare', 0.75, 2], ['tomhi', 0.85, 1], ['tomlo', 1, 1]],
  // tom run down
  [['tomhi', 0.7, 1], ['tomhi', 0.8, 2], ['tomlo', 0.9, 1], ['tomlo', 1, 2]],
  // a snare roll that speeds up
  [['snare', 0.55, 1], ['snare', 0.65, 2], ['snare', 0.8, 3], ['snare', 0.95, 4]],
];

// these keep playing through the fill
const KEEP = new Set(['kick', 'hat', 'shaker', 'bass', 'logdrum', 'ride']);

/** B = a copy of `from` with a fill in its last beat; chain A A A B. */
export function makeFill(pattern, { from = 'A', seed } = {}) {
  const p = normalizePattern(pattern);
  const src = p.sections[from] || p.sections.A;
  const rnd = rngFor(seed);
  const hasToms = p.tracks.includes('tomhi') && p.tracks.includes('tomlo');
  let options = FILLS.filter((f) => hasToms || f.every((h) => h[0] === 'snare'));
  if (!p.tracks.includes('snare') && !ensureTrack(p, 'snare')) {
    options = hasToms ? FILLS.filter((f) => f.every((h) => h[0] !== 'snare')) : [];
  }
  const fill = options.length ? options[Math.floor(rnd() * options.length)] : null;

  const b = structuredClone(src);
  for (const id of p.tracks) b.steps[id] ??= emptyRow(b.length);
  const last = b.length - 4;
  if (fill) {
    for (const id of p.tracks) {
      if (KEEP.has(id)) continue;
      for (let i = last; i < b.length; i++) b.steps[id][i] = null;
    }
    fill.forEach(([id, v, r], k) => {
      b.steps[id][last + k] = { ...defaultStep(id, last + k), v, r };
    });
  }
  p.sections.B = b;
  p.chain = ['A', 'A', 'A', 'B'];
  return normalizePattern(p);
}
