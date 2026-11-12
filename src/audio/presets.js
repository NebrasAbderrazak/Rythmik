// Built-in grooves, grouped by genre. Typical genre patterns only, nothing copied from a record.
//
// Rows are step strings, one character per 16th note:
//   .  off      x  hit (0.8)      X  accent (1)      o  soft (0.5)      g  ghost (0.3)
//   2 3 4  a roll with that many hits inside the step    f  flam    ?  maybe (soft, plays half the time)
// Spaces and | are only there to make beats readable.
// Pitched rows are written as [steps, notes] with one note per hit (a single note fills every hit).
// 808 and log drum notes are MIDI notes from BASS_NOTES; drums and percussion take semitones.
import { normalizePattern, emptyPattern } from './pattern.js';
import { defaultSends } from './fx.js';

export const GENRES = [
  { id: 'hiphop', name: 'Hip-hop' },
  { id: 'afro', name: 'Afro' },
  { id: 'latin', name: 'Latin / Caribbean' },
  { id: 'electronic', name: 'Electronic' },
  { id: 'other', name: 'Other' },
];

// A natural minor
const A1 = 33, B1 = 35, C2 = 36, D2 = 38, E2 = 40, F2 = 41, G2 = 43;
const A2 = 45, B2 = 47, C3 = 48;

// row order in the grid
const VOICE_ORDER = [
  'kick', 'snare', 'clap', 'snap', 'rim', 'hat', 'openhat', 'ride', 'crash',
  'shaker', 'cowbell', 'conga', 'tomhi', 'tomlo', 'logdrum', 'bass',
];

const LEVELS = { x: 0.8, X: 1, o: 0.5, g: 0.3 };

function row(id, grid, notes) {
  const cells = grid.replace(/[\s|]/g, '');
  const out = [];
  let hit = 0;
  for (const ch of cells) {
    if (ch === '.') { out.push(null); continue; }
    let step;
    if (ch in LEVELS) step = { v: LEVELS[ch] };
    else if (ch === '2' || ch === '3' || ch === '4') step = { v: 0.7, r: Number(ch) };
    else if (ch === 'f') step = { v: 0.9, f: true };
    else if (ch === '?') step = { v: 0.5, c: 0.5 };
    else throw new Error(`presets: unknown step '${ch}' in ${id}`);
    if (notes) {
      const p = notes.length === 1 ? notes[0] : notes[hit];
      if (p === undefined) throw new Error(`presets: ${id} has more hits than notes`);
      step.p = p;
    }
    hit++;
    out.push(step);
  }
  if (notes && notes.length > 1 && notes.length !== hit) throw new Error(`presets: ${id} has more notes than hits`);
  return out;
}

function section(rows, tracks) {
  const parsed = {};
  for (const [id, spec] of Object.entries(rows)) {
    parsed[id] = Array.isArray(spec) ? row(id, spec[0], spec[1]) : row(id, spec);
  }
  const length = Object.values(parsed)[0].length;
  for (const [id, r] of Object.entries(parsed)) {
    if (r.length !== length || (length !== 16 && length !== 32)) {
      throw new Error(`presets: ${id} is ${r.length} steps, expected ${length} (16 or 32)`);
    }
  }
  const steps = {};
  for (const id of tracks) steps[id] = parsed[id] ?? new Array(length).fill(null);
  return { length, steps };
}

/**
 * mix: fader per voice (default 0.8). feel: per voice { swing, nudge }.
 * sends: per voice [reverb, echo], the rest keep their defaults.
 */
function groove({ bpm, swing = 0, master = 0.8, mix = {}, feel = {}, fx = {}, sends = {}, A, B = null, chain }) {
  const used = new Set([...Object.keys(A), ...Object.keys(B ?? {})]);
  const tracks = VOICE_ORDER.filter((id) => used.has(id));
  const mixer = {};
  const fxSends = {};
  for (const id of tracks) {
    mixer[id] = {
      volume: mix[id] ?? 0.8, mute: false, solo: false,
      swing: feel[id]?.swing ?? null, nudge: feel[id]?.nudge ?? 0,
    };
    fxSends[id] = sends[id] ? { reverb: sends[id][0], echo: sends[id][1] } : defaultSends(id);
  }
  return normalizePattern({
    version: 4,
    bpm,
    swing,
    master,
    tracks,
    mixer,
    sections: { A: section(A, tracks), B: B ? section(B, tracks) : null },
    chain: chain ?? (B ? ['A', 'B'] : ['A']),
    fx: { reverb: 0, echo: 0, echoTime: '1/8', filter: 0, drive: 0, ...fx, sends: fxSends },
  });
}

function preset({ id, name, genre, about, original = false, ...spec }) {
  const pattern = groove(spec);
  return {
    id, name, genre,
    description: `${about}, ${pattern.bpm} BPM.`,
    ...(original ? { original: true } : {}),
    pattern,
  };
}

const LIST = [
  // ---- hip-hop ----

  // swing 0.3 is roughly MPC 62%; the kick skips ahead of beat 3
  preset({
    id: 'boomBap', name: 'Boom bap', genre: 'hiphop',
    about: 'Dusty 90s head-nod drums with a hard snare and swung hats',
    bpm: 90, swing: 0.3,
    mix: { kick: 0.9, snare: 0.85, hat: 0.66, openhat: 0.58, rim: 0.55, shaker: 0.45, bass: 0.78 },
    fx: { reverb: 0.2, drive: 0.3 },
    A: {
      kick:    'X... ...x ..x. ....',
      snare:   '.... X... .... X..g',
      rim:     '.... .... .... .g..',
      hat:     'X.o. x.o. Xoo. x...',
      openhat: '.... .... .... ..o.',
      shaker:  '...o ...o ...o ...o',
      bass:    ['X... .... ..x. ....', [A1, C2]],
    },
  }),

  // lazy feel: the snare sits a little late and the hats swing harder than the kick
  preset({
    id: 'lofi', name: 'Lo-fi', genre: 'hiphop',
    about: 'Soft, lazy drums with a muffled tone for chill beats',
    bpm: 80, swing: 0.4,
    mix: { kick: 0.82, snare: 0.7, rim: 0.5, hat: 0.55, shaker: 0.4, bass: 0.7 },
    feel: { snare: { nudge: 0.12 }, hat: { swing: 0.45 } },
    fx: { reverb: 0.3, filter: -0.25, drive: 0.15 },
    A: {
      kick:   'X... ...o ..x. ...?',
      snare:  '.... X.g. ..g. X...',
      rim:    '.... .... ...? ....',
      hat:    'x.o. x.o. x.o. x.o?',
      shaker: '..o. ..o. ..o. ..o.',
      bass:   ['X... .... ..x. ..o.', [A1, F2, E2]],
    },
  }),

  // half-time, clap on 3; adjacent 808 steps slide (E2 -> A1, A2 -> G2)
  preset({
    id: 'trap', name: 'Trap', genre: 'hiphop',
    about: 'Half-time drums with rolling hi-hats and a deep 808',
    bpm: 140,
    mix: { kick: 0.78, snare: 0.45, clap: 0.82, hat: 0.6, openhat: 0.5, rim: 0.5, bass: 0.86 },
    fx: { echo: 0.35, echoTime: '3/16' },
    sends: { snare: [0.1, 0], hat: [0, 0.3], openhat: [0.1, 0], clap: [0.2, 0.35], rim: [0, 0.2] },
    A: {
      kick:    'X..x .... ..x. ....',
      snare:   '.... .... X... ....',
      clap:    '.... .... X... ....',
      rim:     '.... .... .... ...o',
      hat:     'X.xo x... X.x. x.34',
      openhat: '.... ..o. .... ....',
      bass:    ['X..x .... ..xx .xx.', [A1, A1, E2, A1, A2, G2]],
    },
  }),

  // kick dances around beat 3; triplet rolls give the bounce
  preset({
    id: 'trapBouncy', name: 'Trap (bouncy)', genre: 'hiphop',
    about: 'Playful trap with a skipping kick and triplet hat rolls',
    bpm: 150, swing: 0.12,
    mix: { kick: 0.8, clap: 0.8, snap: 0.5, hat: 0.58, openhat: 0.48, bass: 0.84 },
    fx: { echo: 0.25, echoTime: '3/16' },
    sends: { clap: [0.2, 0.3], hat: [0, 0.2] },
    A: {
      kick:    'X... ..x. .x.. ..x.',
      clap:    '.... .... X... ....',
      snap:    '.... .... .... ..o.',
      hat:     'x.x. 3.x. x.x. 3.x3',
      openhat: '..o. .... .... ....',
      bass:    ['X... ..x. .x.. ..x.', [A1, C2, A1, E2]],
    },
  }),

  // two bars: the second snare lands early, hats in 3+3+2 with rolls, sliding 808
  preset({
    id: 'ukDrill', name: 'UK drill', genre: 'hiphop',
    about: 'Dark two-bar drill groove with off-beat snares and sliding 808',
    bpm: 142,
    mix: { kick: 0.75, snare: 0.8, rim: 0.45, hat: 0.6, openhat: 0.45, bass: 0.88 },
    fx: { reverb: 0.15, echo: 0.2, echoTime: '3/16' },
    sends: { snare: [0.25, 0.15], hat: [0, 0.15] },
    A: {
      kick:    'X... .... .... .... | .... .... ..x. ....',
      snare:   '.... .... X... .... | .... ...X .... ..o.',
      rim:     '.... .... .... ..?. | .... .... .... ....',
      hat:     'x..x ..x. x..3 ..x. | x..x ..x. x..x .4x.',
      openhat: '.... .... .... .... | .... .... .... ..o.',
      bass:    ['X... .... .... ..x. | ..x. .... ..x. x...', [A1, G2, F2, A1, E2]],
    },
  }),

  // snare on 3 both bars, busier sliding 808 and more triplet rolls
  preset({
    id: 'nyDrill', name: 'NY drill', genre: 'hiphop',
    about: 'Aggressive drill drums with triplet hat rolls and a busy sliding 808',
    bpm: 144,
    mix: { kick: 0.78, snare: 0.6, clap: 0.78, hat: 0.58, openhat: 0.45, bass: 0.88 },
    fx: { echo: 0.2, echoTime: '3/16', drive: 0.15 },
    sends: { clap: [0.2, 0.25], hat: [0, 0.2] },
    A: {
      kick:    'X... .... ...x .... | ..x. .... ...x ....',
      snare:   '.... .... X... .... | .... .... X... ..g.',
      clap:    '.... .... X... .... | .... .... X... ....',
      hat:     'x..3 ..x. x..x ..3. | x..x ..3. x.3. 4.x.',
      openhat: '.... .... .... .... | .... .... .... ...o',
      bass:    ['X... ..x. ...x .x.. | ..x. ..x. ...x ..x.', [A1, A1, C2, D2, E2, D2, C2, B1]],
    },
  }),

  // cowbell riff over a distorted 808, clap on 2 and 4
  preset({
    id: 'phonk', name: 'Phonk', genre: 'hiphop',
    about: 'Gritty drums with a cowbell riff and a distorted 808',
    bpm: 130, swing: 0.1,
    mix: { kick: 0.8, clap: 0.75, hat: 0.55, openhat: 0.45, cowbell: 0.55, bass: 0.82 },
    fx: { reverb: 0.15, drive: 0.45 },
    sends: { cowbell: [0.15, 0.25] },
    A: {
      kick:    'X... ..x. ..x. ....',
      clap:    '.... X... .... X...',
      hat:     'x.x. x.xx x.x. x.2.',
      openhat: '.... .... .... ...o',
      cowbell: ['x..x ..x. x..x ..x.', [0, 0, 3, 0, 5, 3]],
      bass:    ['X... ..x. ..x. ...x', [A1, A1, C2, E2]],
    },
  }),

  // the kick bounces in 8ths around the back half of the bar
  preset({
    id: 'jerseyClub', name: 'Jersey club', genre: 'hiphop',
    about: 'Fast, bouncy club kicks with snare rolls for dance tracks',
    bpm: 140,
    mix: { kick: 0.82, clap: 0.72, snare: 0.55, hat: 0.5, openhat: 0.45, bass: 0.75 },
    sends: { clap: [0.2, 0.2] },
    fx: { reverb: 0.15, echo: 0.15 },
    A: {
      kick:    'X... X... X.x. X.x.',
      snare:   '.... .... .... ..o3',
      clap:    '.... X... .... X...',
      hat:     'x.x. x.x. x.x. x.x.',
      openhat: '..o. .... ..o. ....',
      bass:    ['X... .... X... ....', [A1, G2]],
    },
  }),

  // laid-back bounce: 16th hats with accents, snap on the backbeat, melodic 808
  preset({
    id: 'westCoast', name: 'West coast', genre: 'hiphop',
    about: 'Smooth G-funk bounce with handclaps and a rolling bassline',
    bpm: 92, swing: 0.2,
    mix: { kick: 0.85, snare: 0.6, clap: 0.75, hat: 0.55, openhat: 0.45, shaker: 0.4, bass: 0.8 },
    fx: { reverb: 0.25 },
    A: {
      kick:    'X... ..x. X.x. ....',
      snare:   '.... X... .... X...',
      clap:    '.... X... .... X...',
      hat:     'Xoxo Xoxo Xoxo Xo.o',
      openhat: '.... .... .... ..o.',
      shaker:  '..o. ..o. ..o. ..o.',
      bass:    ['X.x. ..x. X..x .x..', [A1, A2, G2, E2, D2, E2]],
    },
  }),

  // slow and murky: 32nd hat rolls, sparse cowbell, long 808
  preset({
    id: 'memphis', name: 'Memphis', genre: 'hiphop',
    about: 'Slow, dark drums with rattling hats and a lone cowbell',
    bpm: 70, swing: 0.2,
    mix: { kick: 0.85, clap: 0.78, hat: 0.5, openhat: 0.42, cowbell: 0.45, bass: 0.8 },
    fx: { reverb: 0.3, filter: -0.15, drive: 0.25 },
    sends: { cowbell: [0.3, 0.3], clap: [0.3, 0.2] },
    A: {
      kick:    'X... ...x ..x. ....',
      clap:    '.... X... .... X...',
      hat:     'x.2. x.x2 x.2. x2x.',
      openhat: '.... .... .... ...o',
      cowbell: '.... .... ..o. ....',
      bass:    ['X... .... ..x. ....', [A1, F2]],
    },
  }),

  // ---- afro ----

  // 3+3+2 rim and conga against a straight clap
  preset({
    id: 'afrobeats', name: 'Afrobeats', genre: 'afro',
    about: 'Bright afrobeats groove with a 3-3-2 rim pattern and congas',
    bpm: 108, swing: 0.15,
    mix: { kick: 0.82, clap: 0.6, rim: 0.6, shaker: 0.45, openhat: 0.45, conga: 0.6, bass: 0.78 },
    fx: { reverb: 0.25 },
    A: {
      kick:    'X... ..x. X... ..x.',
      clap:    '.... o... .... o...',
      rim:     'x..x ..x. x..x ..x.',
      openhat: '.... .... .... ..o.',
      shaker:  'Xoxo Xoxo Xoxo Xoxo',
      conga:   ['..x. x.x. ..x. x.xx', [0, 5, 0, 0, 5, 0, 7]],
      bass:    ['X... ..x. X... ..x.', [A1, C2, D2, E2]],
    },
  }),

  // tresillo kick push, ghost snare into 3, rim clave figure, soft 16th shaker
  preset({
    id: 'afroBass', name: 'Afro bass', genre: 'afro',
    about: 'Bouncy afrobeats groove with a pushing kick and a walking 808',
    bpm: 104, swing: 0.12,
    mix: { kick: 0.8, snare: 0.72, clap: 0.5, hat: 0.7, openhat: 0.55, rim: 0.58, shaker: 0.42, bass: 0.8 },
    fx: { reverb: 0.3, echoTime: '3/16' },
    A: {
      kick:    'X..x .... X..x ....',
      snare:   '.... x..g .... x...',
      clap:    '.... o... .... o...',
      rim:     '...x ..x. ..x. .x..',
      hat:     'X.xo x.o. X.xo x..o',
      openhat: '.... .... .... ..o.',
      shaker:  'xooo xooo xooo xooo',
      bass:    ['X..x ..x. .x.x ..x.', [A1, A1, C2, E2, D2, C2]],
    },
  }),

  // two bars; the log drum is the bassline and does all the talking
  preset({
    id: 'amapiano', name: 'Amapiano', genre: 'afro',
    about: 'Laid-back amapiano groove led by a bouncing log drum',
    bpm: 113, swing: 0.2,
    mix: { kick: 0.72, clap: 0.55, rim: 0.5, shaker: 0.5, openhat: 0.4, conga: 0.45, logdrum: 0.85 },
    fx: { reverb: 0.25, echo: 0.15, echoTime: '3/16' },
    sends: { clap: [0.35, 0.2], rim: [0.25, 0.3] },
    A: {
      kick:    'x... x... x... x... | x... x... x... x...',
      clap:    '.... X... .... X... | .... X... .... X...',
      rim:     '..o. ...o ..o. .o.. | ..o. ...o ..o. ..o?',
      openhat: '..o. ..o. ..o. ..o. | ..o. ..o. ..o. ..o.',
      shaker:  'xooo xooo xooo xooo | xooo xooo xooo xooo',
      conga:   ['.... ..x. .... x... | .... ..x. ..x. ....', [0, 5, 0, 7]],
      logdrum: ['...X ..x. ..x. x... | ...X ..x. .x.. x.x.', [A1, A1, C2, E2, A1, A2, G2, E2, D2]],
    },
  }),

  // four on the floor with toms and congas weaving around it
  preset({
    id: 'afroHouse', name: 'Afro house', genre: 'afro',
    about: 'Driving four-on-the-floor kick wrapped in toms and congas',
    bpm: 122,
    mix: { kick: 0.85, clap: 0.55, rim: 0.5, openhat: 0.5, shaker: 0.45, conga: 0.6, tomhi: 0.5, tomlo: 0.55 },
    fx: { reverb: 0.3 },
    A: {
      kick:    'X... X... X... X...',
      clap:    '.... o... .... o...',
      rim:     'x..x ..x. ..x. .x..',
      openhat: '..x. ..x. ..x. ..x.',
      shaker:  'xoxo xoxo xoxo xoxo',
      conga:   ['.x.x ...x .x.. x.x.', [0, 7, 0, 5, 0, 7]],
      tomhi:   '.... .... ...o ....',
      tomlo:   '...o .... .... ..o.',
    },
  }),

  // heavy swing, snaps instead of claps, sliding 808 underneath
  preset({
    id: 'afroSwing', name: 'Afro swing', genre: 'afro',
    about: 'Swung afro groove with snaps and a smooth sliding 808',
    bpm: 100, swing: 0.35,
    mix: { kick: 0.8, snap: 0.65, rim: 0.55, hat: 0.55, shaker: 0.4, conga: 0.5, bass: 0.82 },
    fx: { reverb: 0.25, echo: 0.15, echoTime: '3/16' },
    A: {
      kick:   'X... ..x. X... ....',
      snap:   '.... X... .... X...',
      rim:    '...x ..x. ...x .o..',
      hat:    'x.x. x.x. x.x. x.xo',
      shaker: '.o.o .o.o .o.o .o.o',
      conga:  ['.... .... ..x. ..x.', [0, 5]],
      bass:   ['X... ..x. X... ..xx', [A1, C2, E2, D2, C2]],
    },
  }),

  // ---- latin / caribbean ----

  // dembow: kick on every beat, snare on the 'a' of 1 and the 'and' of 2, twice per bar
  preset({
    id: 'reggaeton', name: 'Reggaeton', genre: 'latin',
    about: 'The classic dembow rhythm with a kick on every beat',
    bpm: 95,
    mix: { kick: 0.85, snare: 0.78, rim: 0.45, hat: 0.55, openhat: 0.45, tomhi: 0.45, bass: 0.78 },
    fx: { reverb: 0.2 },
    A: {
      kick:    'X... x... X... x...',
      snare:   '...x ..x. ...x ..x.',
      rim:     '...o ..o. ...o ..o.',
      hat:     'x.x. x.x. x.x. x.xo',
      openhat: '.... .... .... ..o.',
      tomhi:   '.... .... .... .?..',
      bass:    ['X... x... X... x...', [A1, A1, F2, G2]],
    },
  }),

  // kick on 1 with a pickup into 3, rim 3+3+2, offbeat hats
  preset({
    id: 'dancehall', name: 'Dancehall', genre: 'latin',
    about: 'Island dancehall groove with a 3-3-2 rim and offbeat hats',
    bpm: 100, swing: 0.1,
    mix: { kick: 0.85, clap: 0.7, rim: 0.6, hat: 0.5, openhat: 0.5, tomhi: 0.5, bass: 0.8 },
    fx: { reverb: 0.2, echo: 0.15 },
    A: {
      kick:    'X... ...x X... ....',
      clap:    '.... X... .... X...',
      rim:     'x..x ..x. x..x ..x.',
      hat:     'x.o. x.o. x.o. x.o.',
      openhat: '..x. ..x. ..x. ..x.',
      tomhi:   ['.... .... .... .o.o', [0, 3]],
      bass:    ['X... ...x X... ..x.', [A1, E2, A1, G2]],
    },
  }),

  // tamborzao-style kick and conga figure, clap on the backbeat
  preset({
    id: 'baileFunk', name: 'Baile funk', genre: 'latin',
    about: 'Punchy Brazilian funk with a syncopated kick and conga figure',
    bpm: 130,
    mix: { kick: 0.85, clap: 0.72, hat: 0.45, conga: 0.62, tomlo: 0.55, bass: 0.82 },
    fx: { drive: 0.2 },
    A: {
      kick:  'X..x ..x. ..x. x...',
      clap:  '.... X... .... X...',
      hat:   'x.x. x.x. x.x. x.x.',
      conga: ['..x. x..x .x.. ..xx', [5, 0, 5, 0, 7, 5]],
      tomlo: '.... .... ...o ....',
      bass:  ['X..x ..x. .... x...', [A1, A1, C2, E2]],
    },
  }),

  // dembow snares at house tempo, offbeat open hats
  preset({
    id: 'moombahton', name: 'Moombahton', genre: 'latin',
    about: 'Dembow snares on a house kick, slow and heavy',
    bpm: 108,
    mix: { kick: 0.85, snare: 0.72, clap: 0.55, openhat: 0.5, shaker: 0.45, tomhi: 0.45, bass: 0.8 },
    fx: { reverb: 0.2, drive: 0.15 },
    A: {
      kick:    'X... X... X... X...',
      snare:   '...x ..x. ...x ..x.',
      clap:    '.... o... .... o...',
      openhat: '..x. ..x. ..x. ..x.',
      shaker:  'xoxo xoxo xoxo xoxo',
      tomhi:   ['.... .... .... ..o.', [-2]],
      bass:    ['X... X... X... X...', [A1, A1, C2, G2]],
    },
  }),

  // ---- electronic ----

  // four on the floor, clap on 2 and 4, open hat on every offbeat
  preset({
    id: 'house', name: 'House', genre: 'electronic',
    about: 'Classic four-on-the-floor house beat with offbeat open hats',
    bpm: 124, swing: 0.1,
    mix: { kick: 0.88, clap: 0.72, hat: 0.45, openhat: 0.55, shaker: 0.4, bass: 0.72 },
    fx: { reverb: 0.2 },
    A: {
      kick:    'X... X... X... X...',
      clap:    '.... X... .... X...',
      hat:     'xo.o xo.o xo.o xo.o',
      openhat: '..x. ..x. ..x. ..x.',
      shaker:  '.o.o .o.o .o.o .o.o',
      bass:    ['..x. ..x. ..x. ..xx', [A1, A1, C2, E2, A2]],
    },
  }),

  // softer kick, rim instead of clap, swung shaker and a warm filtered tone
  preset({
    id: 'deepHouse', name: 'Deep house', genre: 'electronic',
    about: 'Warm, swung house groove with a soft rim and shaker',
    bpm: 120, swing: 0.25,
    mix: { kick: 0.82, rim: 0.55, clap: 0.5, hat: 0.42, openhat: 0.5, shaker: 0.45, bass: 0.75 },
    fx: { reverb: 0.3, echo: 0.15, echoTime: '3/16', filter: -0.15 },
    A: {
      kick:    'X... x... X... x...',
      clap:    '.... o... .... o...',
      rim:     '.... x... ..g. x..g',
      hat:     'x.ox x.ox x.ox x.ox',
      openhat: '..o. ..o. ..o. ..o.',
      shaker:  'oxox oxox oxox oxox',
      bass:    ['..x. ..x. ...x ..x.', [A1, C2, E2, D2]],
    },
  }),

  // pounding kick, 16th hats shaped by velocity, a little drive
  preset({
    id: 'techno', name: 'Techno', genre: 'electronic',
    about: 'Pounding straight techno with driving 16th hats',
    bpm: 130,
    mix: { kick: 0.9, clap: 0.55, rim: 0.5, hat: 0.5, openhat: 0.5, ride: 0.4, tomlo: 0.45, bass: 0.7 },
    fx: { reverb: 0.2, echo: 0.15, echoTime: '3/16', drive: 0.25 },
    sends: { rim: [0.2, 0.4] },
    A: {
      kick:    'X... X... X... X...',
      clap:    '.... o... .... o...',
      rim:     '...x .... ..x. ...?',
      hat:     'gogx gogx gogx gogx',
      openhat: '..x. ..x. ..x. ..x.',
      ride:    'x.x. x.x. x.x. x.x.',
      tomlo:   '.... .... .... .o..',
      bass:    ['..xo ..xo ..xo ..xo', [A1]],
    },
  }),

  // 2-step: the kick skips beat 3, shuffled hats, two-bar kick variation
  preset({
    id: 'ukGarage', name: 'UK garage', genre: 'electronic',
    about: 'Shuffling 2-step garage beat with a skipping kick',
    bpm: 132, swing: 0.35,
    mix: { kick: 0.85, snare: 0.75, rim: 0.5, hat: 0.5, openhat: 0.45, shaker: 0.42, bass: 0.78 },
    fx: { reverb: 0.2, echo: 0.15, echoTime: '3/16' },
    A: {
      kick:    'X... .... ..x. .... | X... .... .... ..x.',
      snare:   '.... X... .... X... | .... X... .... X..g',
      rim:     '..g. ...o .... .o.. | ..g. ...o ..o. ....',
      hat:     'x.ox x.ox x.ox x.ox | x.ox x.ox x.ox x.ox',
      openhat: '..o. .... ..o. .... | ..o. .... ..o. ....',
      shaker:  '.o.o .o.o .o.o .o.o | .o.o .o.o .o.o .o.o',
      bass:    ['X... .... ..x. .... | X... .... .... ..x.', [A1, C2, A1, E2]],
    },
  }),

  // 2-step D&B: kick on 1 and the 'and' of 3, snare on 2 and 4, ghost notes between
  preset({
    id: 'dnb', name: 'Drum & bass', genre: 'electronic',
    about: 'Fast two-step drum and bass with ghost snares and a ride',
    bpm: 174,
    mix: { kick: 0.85, snare: 0.82, hat: 0.5, ride: 0.42, shaker: 0.4, bass: 0.8 },
    fx: { reverb: 0.2 },
    A: {
      kick:   'X... .... ..x. .... | X... .... ..xx ....',
      snare:  '.... X... .g.. X..g | .... X... .... X.g.',
      hat:    'x.x. x.x. x.x. x.x. | x.x. x.x. x.x. x.xx',
      ride:   'o... o... o... o... | o... o... o... o...',
      shaker: '.o.o .o.o .o.o .o.o | .o.o .o.o .o.o .o.o',
      bass:   ['X... .... ..x. .... | X... .... ..x. ....', [A1, C2, A1, G2]],
    },
  }),

  // one big snare on 3, wide space around it
  preset({
    id: 'halftime', name: 'Halftime', genre: 'electronic',
    about: 'Heavy half-time drums with a huge snare, great for dubstep',
    bpm: 140,
    mix: { kick: 0.88, snare: 0.85, clap: 0.6, hat: 0.5, openhat: 0.45, crash: 0.35, bass: 0.82 },
    fx: { reverb: 0.3, echo: 0.2, echoTime: '3/16', drive: 0.2 },
    sends: { snare: [0.4, 0.2], clap: [0.4, 0.2] },
    A: {
      kick:    'X... .... .... ..x. | X... ..x. .... ....',
      snare:   '.... .... X... .... | .... .... X... ..o3',
      clap:    '.... .... X... .... | .... .... X... ....',
      hat:     'x... x.x. x... x.x. | x... x.x. x... x2x.',
      openhat: '.... .... .... .... | .... ..o. .... ....',
      crash:   'o... .... .... .... | .... .... .... ....',
      bass:    ['X... .... .... ..x. | X... ..x. .... ....', [A1, E2, A1, C2]],
    },
  }),

  // funky break: kick pushes beat 3, ghosted snares around the backbeat
  preset({
    id: 'breakbeat', name: 'Breakbeat', genre: 'electronic',
    about: 'Funky broken beat with ghost snares, made for big beat and breaks',
    bpm: 128, swing: 0.1,
    mix: { kick: 0.85, snare: 0.82, hat: 0.5, openhat: 0.48, ride: 0.35, bass: 0.75 },
    fx: { reverb: 0.15, drive: 0.25 },
    A: {
      kick:    'X... ..x. ..x. ....',
      snare:   '.... X..g .g.. X.g.',
      hat:     'x.x. x.x. x.x. x...',
      openhat: '.... .... .... ..o.',
      ride:    '.... .... .... ...o',
      bass:    ['X... ..x. ..x. ....', [A1, A1, C2]],
    },
  }),

  // ---- other ----

  // slow swung pocket, snaps a touch late
  preset({
    id: 'rnb', name: 'R&B', genre: 'other',
    about: 'Smooth, swung R&B pocket with finger snaps',
    bpm: 88, swing: 0.35,
    mix: { kick: 0.82, snap: 0.7, rim: 0.5, hat: 0.5, openhat: 0.4, shaker: 0.4, bass: 0.78 },
    feel: { snap: { nudge: 0.08 } },
    fx: { reverb: 0.3, echo: 0.15, echoTime: '3/16' },
    A: {
      kick:    'X... ...x ..x. ...o',
      snap:    '.... X... .... X...',
      rim:     '.... ..g. .g.. ..g.',
      hat:     'xoxo xoxo xoxo xoo.',
      openhat: '.... .... .... ...o',
      shaker:  '..o. ..o. ..o. ..o.',
      bass:    ['X... ...x ..x. ....', [A1, G2, F2]],
    },
  }),

  // three bars of groove then a tom fill
  preset({
    id: 'pop', name: 'Pop', genre: 'other',
    about: 'Clean, punchy pop beat with a tom fill every fourth bar',
    bpm: 118,
    mix: { kick: 0.85, snare: 0.7, clap: 0.65, hat: 0.5, openhat: 0.45, tomhi: 0.55, tomlo: 0.6, bass: 0.75 },
    fx: { reverb: 0.25 },
    A: {
      kick:    'X... ..x. X... ....',
      snare:   '.... X... .... X...',
      clap:    '.... X... .... X...',
      hat:     'x.o. x.o. x.o. x.o.',
      openhat: '.... .... .... ..o.',
      bass:    ['X... ..x. X... ....', [A1, C2, F2]],
    },
    B: {
      kick:    'X... ..x. X... ....',
      snare:   '.... X... .... x.xx',
      clap:    '.... X... .... ....',
      hat:     'x.o. x.o. x.o. ....',
      tomhi:   '.... .... .... .x..',
      tomlo:   '.... .... .... ...x',
      bass:    ['X... ..x. X... ....', [A1, C2, G2]],
    },
    chain: ['A', 'A', 'A', 'B'],
  }),

  // ghost-note snare, accented 16th hats, octave-jumping bass
  preset({
    id: 'funk', name: 'Funk', genre: 'other',
    about: 'Tight funk groove full of ghost notes and an octave-jumping bass',
    bpm: 100, swing: 0.15,
    mix: { kick: 0.85, snare: 0.8, hat: 0.55, openhat: 0.45, cowbell: 0.4, bass: 0.78 },
    fx: { reverb: 0.15 },
    A: {
      kick:    'X.x. .... ..x. .x..',
      snare:   '.... X..g .g.. X..g',
      hat:     'Xoxo Xoxo Xo.o Xoxo',
      openhat: '.... .... ..o. ....',
      cowbell: '.... .... .... ...?',
      bass:    ['X.x. ...x ..x. .xx.', [A1, A2, G2, C2, E2, G2]],
    },
  }),

  // four on the floor, open hat on every offbeat, octave bass
  preset({
    id: 'disco', name: 'Disco', genre: 'other',
    about: 'Four-on-the-floor disco with offbeat open hats and an octave bass',
    bpm: 120,
    mix: { kick: 0.85, snare: 0.65, clap: 0.6, hat: 0.45, openhat: 0.55, shaker: 0.4, bass: 0.75 },
    fx: { reverb: 0.25 },
    A: {
      kick:    'X... X... X... X...',
      snare:   '.... x... .... x...',
      clap:    '.... o... .... o...',
      hat:     'x.ox x.ox x.ox x.ox',
      openhat: '..x. ..x. ..x. ..x.',
      shaker:  'oxox oxox oxox oxox',
      bass:    ['x.x. x.x. x.x. x.x.', [A1, A2, A1, A2, F2, C3, G2, B2]],
    },
  }),

  // crash on the first bar, tom fill at the end of the second
  preset({
    id: 'rock', name: 'Rock', genre: 'other',
    about: 'Straight rock beat with a crash and a tom fill every two bars',
    bpm: 112,
    mix: { kick: 0.88, snare: 0.82, hat: 0.5, crash: 0.38, tomhi: 0.6, tomlo: 0.65, bass: 0.7 },
    fx: { reverb: 0.2, drive: 0.15 },
    A: {
      kick:  'X... ..x. X.x. ....',
      snare: '.... X... .... X...',
      hat:   'x.x. x.x. x.x. x.x.',
      crash: 'x... .... .... ....',
      bass:  ['X... ..x. X.x. ....', [A1, A1, C2, D2]],
    },
    B: {
      kick:  'X... ..x. X... ....',
      snare: '.... X... .... f.x.',
      hat:   'x.x. x.x. x.x. ....',
      tomhi: '.... .... .... .xx.',
      tomlo: '.... .... .... ...X',
      bass:  ['X... ..x. X... ....', [A1, A1, G2]],
    },
  }),

  // Rythmik originals

  // the kick counts in threes against the 4/4 hats: 3+3+3+3+4
  preset({
    id: 'clockwork', name: 'Clockwork', genre: 'other', original: true,
    about: 'Ticking groove where the kick counts in threes against the hats',
    bpm: 118, swing: 0.05,
    mix: { kick: 0.82, clap: 0.65, rim: 0.55, hat: 0.5, cowbell: 0.4, tomlo: 0.5, bass: 0.75 },
    fx: { reverb: 0.2, echo: 0.2, echoTime: '3/16' },
    sends: { rim: [0.2, 0.4], cowbell: [0.2, 0.35] },
    A: {
      kick:    'X..x ..x. .x.. x...',
      clap:    '.... X... .... X...',
      rim:     '.x.. .x.. .x.. .x..',
      hat:     'xgog xgog xgog xgog',
      cowbell: ['..o. .... .... .o..', [7, 0]],
      tomlo:   '.... .... .... ..o.',
      bass:    ['X..x ..x. .x.. x...', [A1, A1, C2, D2, E2]],
    },
  }),

  // rain on metal: rattling chance-y shaker and hats around a sparse beat
  preset({
    id: 'tinRoof', name: 'Tin roof', genre: 'other', original: true,
    about: 'Loose, rattling percussion that changes a little every time it loops',
    bpm: 96, swing: 0.25,
    mix: { kick: 0.82, snap: 0.62, hat: 0.45, shaker: 0.45, cowbell: 0.42, conga: 0.55, bass: 0.75 },
    fx: { reverb: 0.3, echo: 0.2, echoTime: '3/16' },
    A: {
      kick:    'X... ...x .... x...',
      snap:    '.... X... .... X...',
      hat:     'x?o? x?o? x?o? x?o?',
      shaker:  '?o?o ?o?o ?o?o ?o?o',
      cowbell: ['..o. .... .?.. ....', [0, 3]],
      conga:   ['x..x .x.. ..x. .xx.', [0, 5, 7, 0, 5, 0]],
      bass:    ['X... ...x .... x...', [A1, E2, D2]],
    },
  }),

  // ghost notes everywhere, a snare flam on 4, slightly late hats
  preset({
    id: 'ghostSteps', name: 'Ghost steps', genre: 'other', original: true,
    about: 'Quiet, shuffling drums built from ghost notes and flams',
    bpm: 84, swing: 0.3,
    mix: { kick: 0.85, snare: 0.78, rim: 0.5, hat: 0.5, openhat: 0.4, bass: 0.78 },
    feel: { hat: { nudge: 0.06 } },
    fx: { reverb: 0.25, filter: -0.1 },
    A: {
      kick:    'X... ..g. ..x. .g..',
      snare:   '.g.. X.gg .g.g f.g.',
      rim:     '...g .... ...g ....',
      hat:     'xgxg xgxg xgxg xg2g',
      openhat: '.... .... .... ...o',
      bass:    ['X... .... ..x. ....', [A1, D2]],
    },
  }),

  // slow and huge: rolled snare, long echoes, low tom pulses
  preset({
    id: 'lowGear', name: 'Low gear', genre: 'other', original: true,
    about: 'Slow, wide drums with rolled snares and long echoes',
    bpm: 66,
    mix: { kick: 0.88, snare: 0.75, hat: 0.45, ride: 0.35, tomlo: 0.55, bass: 0.82 },
    fx: { reverb: 0.35, echo: 0.3, echoTime: '1/4' },
    sends: { snare: [0.35, 0.3], ride: [0.25, 0.2] },
    A: {
      kick:  'X... .... ..x. .... | X... ...x .... ....',
      snare: '.... .... X... .... | .... .... X... ..2.',
      hat:   'x.o. x.o. x.o. x.o. | x.o. x.o. x.o. x3o.',
      ride:  'o... .... .... .... | .... .... .... ....',
      tomlo: '.... ..o. .... .... | .... .... .... o...',
      bass:  ['X... .... ..x. .... | X... ...x .... ....', [A1, C2, F2, E2]],
    },
  }),
];

const empty = {
  id: 'empty',
  name: 'Empty',
  genre: 'other',
  description: 'No sounds at all, so you can start from scratch.',
  pattern: emptyPattern(),
};

// keyed by id, in display order: genre by genre, Empty last
const ordered = GENRES.flatMap((g) => LIST.filter((p) => p.genre === g.id));
export const PRESETS = Object.fromEntries([...ordered, empty].map((p) => [p.id, p]));
export const PRESET_IDS = Object.keys(PRESETS);
