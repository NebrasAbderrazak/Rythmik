export const STEPS = 16;

export const TRACKS = [
  { id: 'kick', name: 'Kick' },
  { id: 'snare', name: 'Snare' },
  { id: 'clap', name: 'Clap' },
  { id: 'hat', name: 'Closed hat' },
  { id: 'openhat', name: 'Open hat' },
  { id: 'rim', name: 'Rim' },
  { id: 'shaker', name: 'Shaker' },
  { id: 'bass', name: '808 bass' },
];
export const TRACK_IDS = TRACKS.map((t) => t.id);

export const VOICES = [
  { id: 'kick', name: 'Kick', group: 'drums', pitched: false },
  { id: 'snare', name: 'Snare', group: 'drums', pitched: false },
  { id: 'clap', name: 'Clap', group: 'drums', pitched: false },
  { id: 'hat', name: 'Closed hat', group: 'drums', pitched: false },
  { id: 'openhat', name: 'Open hat', group: 'drums', pitched: false },
  { id: 'rim', name: 'Rim', group: 'perc', pitched: false },
  { id: 'shaker', name: 'Shaker', group: 'perc', pitched: false },
  { id: 'bass', name: '808 bass', group: 'bass', pitched: true },
  { id: 'tomlo', name: 'Low tom', group: 'drums', pitched: false },
  { id: 'tomhi', name: 'High tom', group: 'drums', pitched: false },
  { id: 'crash', name: 'Crash', group: 'drums', pitched: false },
  { id: 'ride', name: 'Ride', group: 'drums', pitched: false },
  { id: 'cowbell', name: 'Cowbell', group: 'perc', pitched: false },
  { id: 'conga', name: 'Conga', group: 'perc', pitched: false },
  { id: 'snap', name: 'Snap', group: 'perc', pitched: false },
  { id: 'logdrum', name: 'Log drum', group: 'bass', pitched: true },
];
export const VOICE_IDS = VOICES.map((v) => v.id);

// pitched voices take a MIDI note from BASS_NOTES, the rest semitones
export const isPitched = (id) => id === 'bass' || id === 'logdrum';
export const isSampleId = (id) => typeof id === 'string' && /^smp-[A-Za-z0-9_-]{1,40}$/.test(id);
export const isTrackId = (id) => VOICE_IDS.includes(id) || isSampleId(id);

export const MAX_TRACKS = 16;
export const SECTION_LENGTHS = [16, 32];
export const MAX_CHAIN = 8;
export const MAX_ROLL = 4;
export const MAX_PITCH = 12;
export const MAX_NUDGE = 0.5;
export const DEFAULT_VELOCITY = 0.8;
export const FLAM_SECONDS = 0.02;

// hats and shakers used to play this accent shape; new steps keep it
export function grooveVelocity(step) {
  if (step % 4 === 0) return 0.85;
  if (step % 2 === 0) return 0.7;
  return 0.5;
}

// v is stored 0..1 with 0.8 as a normal hit, so 0.8 plays a voice at full level
export const velocityGain = (v) => v / DEFAULT_VELOCITY;

export const MIN_BPM = 60;
export const MAX_BPM = 180;
export const DEFAULT_BPM = 104;

export const MAX_SWING = 0.6;
export const DEFAULT_VOLUME = 0.8;
export const DEFAULT_MASTER = 0.8;

// A natural minor, A1 to E3
export const BASS_NOTES = [
  { midi: 33, name: 'A1' },
  { midi: 35, name: 'B1' },
  { midi: 36, name: 'C2' },
  { midi: 38, name: 'D2' },
  { midi: 40, name: 'E2' },
  { midi: 41, name: 'F2' },
  { midi: 43, name: 'G2' },
  { midi: 45, name: 'A2' },
  { midi: 47, name: 'B2' },
  { midi: 48, name: 'C3' },
  { midi: 50, name: 'D3' },
  { midi: 52, name: 'E3' },
];
export const BASS_MIDI = BASS_NOTES.map((n) => n.midi);
export const DEFAULT_BASS_NOTE = 33; // A1

export const isBassNote = (m) => BASS_MIDI.includes(m);

// ties go down
export function snapBassNote(m) {
  let best = BASS_MIDI[0];
  for (const n of BASS_MIDI) if (Math.abs(n - m) < Math.abs(best - m)) best = n;
  return best;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function clampBpm(n, fallback = DEFAULT_BPM) {
  const v = Number(n);
  if (n === null || n === '' || !Number.isFinite(v)) return fallback;
  return Math.round(clamp(v, MIN_BPM, MAX_BPM));
}

export function clampUnit(n, fallback, lo = 0, hi = 1) {
  const v = Number(n);
  if (n === null || n === '' || typeof n === 'boolean' || !Number.isFinite(v)) return fallback;
  return clamp(v, lo, hi);
}

export const clampSwing = (x, fallback = 0) => clampUnit(x, fallback, 0, MAX_SWING);

export const secondsPerStep = (bpm) => 60 / bpm / 4; // 16th notes

// odd 16ths are delayed by swing * secondsPerStep * 5/6, so 0.4 is an exact
// triplet shuffle (MPC ~67%) and 0.6 is half a step late (MPC 75%).
export const SWING_FACTOR = 5 / 6;
export function swingOffset(step, swing, spb) {
  return step % 2 === 1 ? swing * spb * SWING_FACTOR : 0;
}

// square-law fader, 0.8 is unity gain (1.0 = +3.9 dB, 0.5 = -8.2 dB)
export function volumeToGain(v) {
  const x = clampUnit(v, DEFAULT_VOLUME);
  return (x / DEFAULT_VOLUME) ** 2;
}
