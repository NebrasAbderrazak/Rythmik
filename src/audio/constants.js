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
