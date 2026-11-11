# Engine API

The audio engine (`src/audio/`) never touches the DOM. The UI (`src/ui/`) only uses the exports below.

```js
import { createEngine, TRACKS, STEPS, BASS_NOTES, MIN_BPM, MAX_BPM } from './audio/engine.js';
import { PRESETS } from './audio/presets.js';
import { serializePattern, parsePattern, normalizePattern, emptyPattern } from './audio/pattern.js';

STEPS        // 16
MIN_BPM, MAX_BPM   // 60, 180
TRACKS       // in display order:
             // kick 'Kick', snare 'Snare', clap 'Clap', hat 'Closed hat', openhat 'Open hat',
             // rim 'Rim', shaker 'Shaker', bass '808 bass'
BASS_NOTES   // choices for the 808 note picker, A natural minor from A1 up ~1.5 octaves:
             // [{ midi: 33, name: 'A1' }, { midi: 35, name: 'B1' }, { midi: 36, name: 'C2' }, ...]
PRESETS      // { afroBass, trap, boomBap, empty }; each { name: 'Afro bass' | 'Trap' | 'Boom bap' | 'Empty', pattern }

const engine = createEngine();          // optional: createEngine({ context }) for tests
await engine.resume();                  // from a user gesture; creates/resumes the AudioContext
engine.context, engine.master, engine.output, engine.clock   // AudioContext, master input, final output, tempo clock

// transport
engine.start(); engine.stop(); engine.isPlaying
engine.getCurrentStep()                 // -1 when stopped; UI polls in requestAnimationFrame

// pattern
engine.getPattern()                     // deep copy (shape below)
engine.setPattern(pattern)              // normalizes; applies bpm, swing, mixer, master
engine.toggleStep(trackId, step)        // returns new boolean
engine.setBassNote(step, midi)          // midi must be in BASS_NOTES
engine.trigger(trackId, { midi }?)      // audition (808 uses midi if given)

// controls (all clamp their input, return the applied value, and update the pattern)
engine.setBpm(n)                        // 60..180, integer
engine.setSwing(x)                      // 0..0.6 ; 0 = straight; delays every odd 16th by x * secondsPerStep * 5/6 (0.4 = triplet shuffle); UI shows 0..100%
// trigger() ignores mute/solo (auditions always sound). setBassNote/trigger throw on notes not in BASS_NOTES.
// Also exported: MAX_SWING, engine.clock.swing
engine.setTrackVolume(trackId, v)       // 0..1 (perceptual curve inside engine)
engine.setMute(trackId, bool)
engine.setSolo(trackId, bool)           // any solo active -> only soloed tracks sound
engine.setMasterVolume(v)               // 0..1

// events (each returns an unsubscribe fn)
engine.onStateChange(cb)                // cb({ isPlaying, bpm })
engine.onPatternChange(cb)              // cb(patternCopy) after ANY pattern/control change (used for autosave)
```

## Pattern shape (version 2)
```js
{
  version: 2,
  bpm: 104,
  swing: 0,                       // 0..0.6
  master: 0.8,                    // 0..1
  steps:     { [trackId]: bool[16] },     // all 8 tracks
  bassNotes: number[16],                  // MIDI per step, each from BASS_NOTES
  mixer:     { [trackId]: { volume: 0..1, mute: bool, solo: bool } }
}
```
`normalizePattern(any)` fills missing tracks/fields with defaults, clamps values, also accepts older version 1 patterns (4 tracks, no version field).
`serializePattern(p)` returns pretty JSON text. `parsePattern(text)` returns a normalized pattern or throws `Error` with a short human-readable message ("Not a Rythmik pattern file.").
