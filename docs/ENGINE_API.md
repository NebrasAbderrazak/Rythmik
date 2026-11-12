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

## Rap booth

```js
import { createBooth } from './audio/booth.js';
import { encodeWav } from './audio/wav.js';

const booth = createBooth(engine);       // uses engine.context, engine.output and the clock

// mic
await booth.openMic()                    // getUserMedia from a user gesture; echoCancellation, noiseSuppression,
                                         // autoGainControl all off. Rejects with Error('mic-denied' | 'mic-busy' | 'mic-unavailable')
booth.closeMic()
booth.micOpen                            // boolean
booth.getInputLevel()                    // 0..1 peak since last call, for a meter (UI polls in rAF)
booth.setMonitoring(bool)                // hear the mic through the speakers/headphones; default false
booth.monitoring

// recording
booth.setBars(n)                         // take length: 2 | 4 | 8 | 16 bars (default 4)
booth.setCountIn(bool)                   // 1-bar count-in click before recording, default true
await booth.record()                     // starts the beat if needed, counts in, records exactly `bars` bars
                                         // aligned to bar 1 of the pattern; resolves with the new take
booth.cancel()                           // stop recording without keeping a take
booth.state                              // 'idle' | 'count-in' | 'recording'
booth.getRecordProgress()                // { bar, totalBars, countIn: bool } while recording

// takes (kept in memory)
booth.takes                              // [{ id, name: 'Take 1', bars, bpm, duration, peak, createdAt }]
booth.selectedTakeId                     // take used in the mix (newest take by default)
booth.selectTake(id)
booth.deleteTake(id)
booth.playTake(id, { withBeat: true })   // preview; withBeat plays the pattern in sync
booth.stopPreview()

// latency
booth.latencyMs                          // total compensation applied to new and existing takes
booth.autoLatencyMs                      // estimate from baseLatency + outputLatency + input track latency
booth.setLatencyOffset(ms)               // manual trim, -200..200, added on top of the estimate

// export
await booth.renderMix(takeId?)           // AudioBuffer: beat (current pattern) + take, through the master chain,
                                         // rendered offline for the take's length plus a short tail
await booth.renderVocal(takeId?)         // AudioBuffer: dry take only, latency-compensated
encodeWav(audioBuffer, { bitDepth: 16 }) // ArrayBuffer of a PCM WAV file
await renderBeat(pattern, { bars: 4, tail: 1.5 }) // AudioBuffer: beat only (src/audio/export.js), bars 1|2|4|8|16, master chain + tail

booth.onChange(cb)                       // cb() after any state/take/mic change; returns unsubscribe
```

Input devices and diagnostics:

```js
await booth.listInputs()                 // [{ deviceId, label, isDefault }]; Chrome's 'default' first as
                                         // "Default (<device>)", 'communications' dropped; 'Microphone N' before permission
await booth.openMic({ deviceId })        // exact device; omitted = last chosen; '' / 'default' / null = system default
await booth.setInputDevice(deviceId)     // remember + reopen if open (monitoring kept); rejects Error('busy') while recording
booth.inputDeviceId                      // open (or next) device; null = system default. UI persists this
booth.inputLabel                         // track label of the open mic
booth.lastFallback                       // true if the chosen device was gone and the default was opened instead
booth.onDevicesChange(cb)                // cb({ reason: 'devicechange' | 'device-lost' | 'fallback', deviceId?, label? })
                                         // 'device-lost': open mic unplugged, mic already closed. Returns unsubscribe
booth.getMicStatus()                     // { open, deviceId, label, muted, enabled, readyState, contextState,
                                         //   sampleRate, silentForMs, fallback }; silentForMs = time below -70 dBFS
```

`openMic()` errors: `mic-denied` (NotAllowed/Security), `mic-busy` (NotReadable: in use by another app or
blocked by Windows privacy settings), `mic-unavailable` (no device / insecure context). Suggested UI rule: open
and `silentForMs > 3000` → "No signal from <label>"; `muted` true → the OS is withholding audio.

Also available:

```js
booth.bars, booth.countIn, booth.latencyOffsetMs, booth.previewTakeId   // current values
booth.getRecordProgress()                // null when idle; also has beat (1-4) and startTime (bar 1 context time)
booth.importTake(samples, { bpm, bars, sampleRate })   // sample 0 = bar 1 downbeat, before latency compensation
booth.dispose()

engine.start({ at })                     // start step 0 at a given context time
engine.getNextBarTime(minTime)           // context time of the next downbeat, null when stopped
engine.setEndTime(t | null)              // stop scheduling steps at or after t (start() resets it)
engine.setTempoOverride(bpm | null)      // play at another tempo without changing the pattern
```

`record()` resolves with `null` when cancelled (including when the beat is stopped mid-take) and rejects with
`Error('mic-closed')` or `Error('busy')`. Each take keeps 250 ms of audio before bar 1 and 600 ms after the
last bar, so latency changes can re-align existing takes.

Each take stores the latency estimate from when it was recorded (`take.autoLatencyMs`); only the manual
offset applies live. `take.latencyMs` is the total currently applied to that take.
