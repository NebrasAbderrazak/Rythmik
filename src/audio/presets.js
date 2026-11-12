// one bar of 16th notes each
import { normalizePattern, emptyPattern } from './pattern.js';
import { TRACK_IDS } from './constants.js';

const on = (...idx) => Array.from({ length: 16 }, (_, i) => idx.includes(i));
const mix = (levels) => Object.fromEntries(
  Object.entries(levels).map(([id, volume]) => [id, { volume, mute: false, solo: false }]),
);

// [reverb, echo] per track; tracks not listed send nothing
const sends = (levels) => Object.fromEntries(
  TRACK_IDS.map((id) => [id, { reverb: levels[id]?.[0] ?? 0, echo: levels[id]?.[1] ?? 0 }]),
);

const A1 = 33, C2 = 36, D2 = 38, E2 = 40, G2 = 43, A2 = 45;

// tresillo kick push, ghost snare into 3, rim clave figure, soft 16th shaker
const afroBass = {
  name: 'Afro bass',
  pattern: normalizePattern({
    bpm: 104,
    swing: 0.12,
    master: 0.8,
    steps: {
      kick:    on(0, 3, 8, 11),
      snare:   on(4, 7, 12),
      clap:    on(4, 12),
      hat:     on(0, 2, 3, 4, 6, 8, 10, 11, 12, 15),
      openhat: on(14),
      rim:     on(3, 6, 10, 13),
      shaker:  on(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15),
      bass:    on(0, 3, 6, 9, 11, 14),
    },
    //          0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15
    bassNotes: [A1, A1, A1, A1, A1, A1, C2, C2, C2, E2, E2, D2, D2, D2, C2, C2],
    mixer: mix({
      kick: 0.8, snare: 0.72, clap: 0.5, hat: 0.7, openhat: 0.55,
      rim: 0.58, shaker: 0.42, bass: 0.8,
    }),
    fx: { reverb: 0.3, echo: 0, echoTime: '3/16', filter: 0, drive: 0 },
  }),
};

// half-time, clap on 3; adjacent 808 steps slide (E2 -> A1, A2 -> G2)
const trap = {
  name: 'Trap',
  pattern: normalizePattern({
    bpm: 140,
    swing: 0,
    master: 0.8,
    steps: {
      kick:    on(0, 3, 10),
      snare:   on(8),
      clap:    on(8),
      hat:     on(0, 2, 3, 4, 8, 10, 12, 13, 14, 15),
      openhat: on(6),
      rim:     on(15),
      shaker:  on(),
      bass:    on(0, 3, 10, 11, 13, 14),
    },
    //          0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15
    bassNotes: [A1, A1, A1, A1, A1, A1, A1, A1, A1, A1, E2, A1, A1, A2, G2, A1],
    mixer: mix({
      kick: 0.78, snare: 0.45, clap: 0.82, hat: 0.6, openhat: 0.5,
      rim: 0.5, shaker: 0.6, bass: 0.86,
    }),
    fx: {
      reverb: 0, echo: 0.35, echoTime: '3/16', filter: 0, drive: 0,
      sends: sends({ hat: [0, 0.3], clap: [0.2, 0.35] }),
    },
  }),
};

// swing 0.3 is roughly MPC 62%
const boomBap = {
  name: 'Boom bap',
  pattern: normalizePattern({
    bpm: 90,
    swing: 0.3,
    master: 0.8,
    steps: {
      kick:    on(0, 7, 10),
      snare:   on(4, 12),
      clap:    on(),
      hat:     on(0, 2, 4, 6, 8, 9, 10, 12),
      openhat: on(14),
      rim:     on(13),
      shaker:  on(3, 7, 11, 15),
      bass:    on(0, 10),
    },
    //          0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15
    bassNotes: [A1, A1, A1, A1, A1, A1, A1, A1, A1, A1, C2, A1, A1, A1, A1, A1],
    mixer: mix({
      kick: 0.9, snare: 0.85, clap: 0.6, hat: 0.66, openhat: 0.58,
      rim: 0.55, shaker: 0.45, bass: 0.78,
    }),
    fx: { reverb: 0.2, echo: 0, echoTime: '1/8', filter: 0, drive: 0.3 },
  }),
};

const empty = {
  name: 'Empty',
  pattern: emptyPattern(),
};

export const PRESETS = { afroBass, trap, boomBap, empty };
