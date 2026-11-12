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

## Pattern shape (version 3)
```js
{
  version: 3,
  bpm: 104,
  swing: 0,                       // 0..0.6
  master: 0.8,                    // 0..1
  steps:     { [trackId]: bool[16] },     // all 8 tracks
  bassNotes: number[16],                  // MIDI per step, each from BASS_NOTES
  mixer:     { [trackId]: { volume: 0..1, mute: bool, solo: bool } },
  fx: {                                   // beat effects, see "Effects" below
    reverb: 0, echo: 0,                   // 0..1
    echoTime: '1/8',                      // '1/8' | '3/16' | '1/4'
    filter: 0,                            // -1..1 (< 0 low-pass, > 0 high-pass)
    drive: 0,                             // 0..1
    sends: { [trackId]: { reverb: 0..1, echo: 0..1 } }
  }
}
```
`normalizePattern(any)` fills missing tracks/fields with defaults, clamps values, also accepts older patterns: version 1 (4 tracks, no version field) and version 2 (no `fx`, loads with effects off).
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
                                         // rejects Error('too-many-takes') when MAX_TAKES (12) are kept
booth.cancel()                           // stop recording without keeping a take
booth.state                              // 'idle' | 'count-in' | 'recording'
booth.getRecordProgress()                // { bar, totalBars, countIn: bool } while recording

// takes (kept in memory)
booth.takes                              // [{ id, name: 'Take 1', bars, bpm, duration, peak, createdAt }]
booth.takesFull                          // true when MAX_TAKES (12, exported from booth.js) are kept
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
engine.setTempoOverride(bpm | null)      // play at another tempo without changing the pattern (60..180, fractions kept)
engine.tempoOverride                     // current override or null
engine.setBarAnchors([{ at, period? }] | null)  // step 0 lands exactly on these context times (period: repeats);
                                         // a step closer than half a step before one is dropped. start()/stop() clear them
```

`record()` resolves with `null` when cancelled (including when the beat is stopped mid-take) and rejects with
`Error('mic-closed')`, `Error('busy')` or `Error('too-many-takes')` (12 takes kept: the user deletes one first;
`importTake` throws the same). Each take keeps 250 ms of audio before bar 1 and 600 ms after the
last bar, so latency changes can re-align existing takes.

Each take stores the latency estimate from when it was recorded (`take.autoLatencyMs`); only the manual
offset applies live. `take.latencyMs` is the total currently applied to that take.

## Effects

### Beat effects (engine)
```js
engine.setFx(name, value)                // returns the applied value, emits onPatternChange
//   'reverb'   0..1   room on the whole beat ("Space")
//   'echo'     0..1   tempo-synced delay amount
//   'echoTime' '1/8' | '3/16' | '1/4'
//   'filter'   -1..1  < 0 low-pass sweep, > 0 high-pass sweep, 0 = off
//   'drive'    0..1   saturation
engine.setTrackSend(trackId, 'reverb' | 'echo', 0..1)
engine.getPattern().fx                   // { reverb, echo, echoTime, filter, drive, sends: { [trackId]: { reverb, echo } } }
```
Patterns are version 3. Version 1 and 2 patterns load with effects off. `renderBeat` and the booth mix include the beat effects.
Unknown effect names, send kinds or tracks throw. Also exported from engine.js: `FX_NAMES`, `ECHO_TIMES`.
Default sends (used until changed): kick and 808 none; snare, clap, rim, open hat some reverb and echo; hats/shaker a little.
`renderBeat`'s default tail grows to cover echo/reverb ring-out (`beatTail(pattern)` in export.js gives the length used).

### Voice effects (booth)
```js
import { VOICE_PRESETS, KEYS, SCALES, TONES } from './audio/voice.js';
VOICE_PRESETS   // { clean, robot, tuned, radio, hall, lofi }: each { name, description, settings }
KEYS            // ['C', 'C#', ... 'B'];  SCALES  // ['minor', 'major']

booth.voice                              // current settings (copy) + preset: id, or null once a setting differs from it
booth.setVoicePreset(id)                 // returns booth.voice; presets keep key and scale; throws on unknown id
booth.setVoiceSettings(partial)          // returns booth.voice; { tune: 0..1, retune: 0..1 (0 = instant, robotic), key, scale,
                                         //   tone: 'clean' | 'full' | 'radio' | 'lofi', reverb: 0..1, echo: 0..1 }
                                         // 'clean' = 80 Hz highpass + level only (Clean preset, default); 'full' adds EQ + compressor
await booth.prepareVoice(takeId?)        // runs pitch correction for the take (cached per take + tune settings)
booth.voiceBusy                          // true while tuning
// playTake, renderMix use the processed voice; renderVocal(takeId, { processed: true }) for the tuned vocal
```
- `onChange` fires on voice changes and when tuning starts/finishes (`voiceBusy` flips).
- Tuning starts 150 ms (engine debounce) after the last tune/retune/key/scale change, so knob drags do not
  restart it on every step; the UI adds its own debounce on top. `voiceBusy` is already true during that wait. The pitch track is kept per take, so these changes only
  redo the correction. `booth.voiceCacheSize` = takes with a tuned result in memory.
- Tone, reverb and echo follow live during a preview; tune/retune/key/scale apply from the next `playTake`
  (which waits for tuning, so the first play after a change can take about a second).
- `renderVocal(id, { processed: true })` is stereo and includes the reverb/echo tail; the default stays the dry mono take.
- Echo on the voice is a dotted 1/8 at the take's tempo.
Default key follows the 808 scale (A minor).

## Remix deck

Load your own audio file (it never leaves the browser), loop a part of it, change its speed and add space.
The deck plays into `engine.master`, so it shares the master chain with the beat.

```js
import { createRemix, SPEED_PRESETS, REMIX_PRESETS, MIN_SPEED, MAX_SPEED } from './audio/remix.js';
import { detectBpm, createTapTempo } from './audio/tempo.js';

const remix = createRemix(engine);       // optional: createRemix(engine, { OfflineAudioContext, stretchCache })

// file
await remix.load(fileOrArrayBuffer, { name })  // decodes; resolves with remix.info. Rejects Error('decode-failed' |
                                              // 'too-long' (> 10 min, MAX_SONG_SECONDS) | 'too-large' (file > 200 MB,
                                              // MAX_FILE_BYTES, checked before
                                              // reading) | 'busy' (already loading, or locked) | 'cancelled' (disposed)).
                                              // Replaces the current song.
remix.loaded                                  // boolean
remix.info                                    // { name, duration, sampleRate, channels } or null
remix.unload()                                // throws Error('busy') while locked
remix.getPeaks(columns)                       // { min: Float32Array, max: Float32Array } per column, source time, for a
                                              // waveform; columns is made a whole number in 1..8192. Built from
                                              // 8192 min/max columns scanned once per song (on first use),
                                              // so any width is cheap

// transport (source time = seconds in the original file)
remix.play({ from, at })                      // from defaults to the loop start (or 0 when the loop is off);
                                              // at: context time to start (default ~0.1 s from now). Returns a promise.
                                              // With keep pitch on it waits for the stretch first (never plays the
                                              // plain sound at another speed)
remix.stop()
remix.isPlaying                               // also true while waiting for the stretch
remix.pending                                 // true while play() waits for the stretch
remix.getPosition()                           // current source time, for the playhead; null when stopped
remix.setLoop(start, end)                     // source seconds, clamped, at least 0.5 s long; returns remix.loop
remix.setLoopEnabled(bool)                    // default true, loop = whole song after load
remix.loop                                    // { start, end, enabled }

// sound
SPEED_PRESETS                                 // [{ id: 'superSlowed', name: 'Super slowed', speed: 0.75 },
                                              //  { id: 'slowed', name: 'Slowed', speed: 0.85 },
                                              //  { id: 'normal', name: 'Normal', speed: 1 },
                                              //  { id: 'spedUp', name: 'Sped up', speed: 1.25 }]
remix.setSpeed(x)                             // MIN_SPEED 0.5 .. MAX_SPEED 1.5; pitch follows speed (classic "slowed")
remix.setKeepPitch(bool)                      // Advanced: time-stretch offline so pitch stays; default false
remix.stretchBusy                             // true while any stretch is waiting or running (also when a take needs
                                              // an evicted speed again). A stretched copy at the old speed keeps
                                              // playing until the new one is ready; the plain sound pauses instead
remix.setFx(name, value)                      // returns the applied value
//   'reverb'  0..1  "Space"
//   'muffle'  0..1  low-pass, 0 = off (bypassed), 1 = about 500 Hz ("underwater / next room")
//   'bass'    0..1  low shelf (100 Hz) up to +9 dB, with the deck level 3 dB lower at full: lows +6 dB net, rest -3 dB
//   'volume'  0..1  deck level (0.8 = unity, same curve as track faders, after a fixed -3 dB trim for headroom)
REMIX_PRESETS                                 // { original, slowedReverb, nightcore }: each { name, settings }
remix.applyPreset(id)                         // "Slowed + reverb" = speed 0.85, reverb ~0.5, muffle a little;
                                              // "Nightcore" = speed 1.25 (pitch up), a touch of reverb
remix.settings                                // { speed, keepPitch, reverb, muffle, bass, volume, beatSync } (copy)
remix.setSettings(partial)                    // for restoring saved settings

// tempo
remix.sourceBpm                               // detected (or set) tempo of the original file; null if unknown
remix.bpmConfidence                           // 0..1 from detection
remix.setSourceBpm(n | null)                  // manual / tap; 40..220, kept unrounded
remix.effectiveBpm                            // sourceBpm * speed (rounded to 0.1, for display), null if unknown
remix.setBeatSync(bool)                       // the beat plays along at effectiveBpm, bar 1 on the loop start; needs a BPM
                                              // (returns false without one). Stays on across songs; the beat only plays
                                              // while a BPM is known
remix.bpmBusy                                 // true while detecting after load

await detectBpm(audioBuffer)                  // { bpm, confidence } (onset envelope + autocorrelation, 70..180 folded,
                                              // rounded to 0.01); async, yields while working; bpm null on silence /
                                              // clips under 4 s. Long songs: the middle 2 minutes
const tap = createTapTempo(); tap.tap(timeMs) // returns bpm (40..220) after 2+ taps, null before; resets after a 2 s
tap.reset(); tap.count                        // gap; a time that is not a number is ignored

// export
await remix.render({ loopOnly = true, withBeat = settings.beatSync })   // AudioBuffer, processed as you hear it
                                              // (speed, keep pitch, fx), through the master chain + reverb tail

remix.onChange(cb)                            // cb() after any change (load, settings, play state, bpm, stretch)
remix.dispose()
```
- The beat (beat sync) and takes over the remix use `sourceBpm * speed` unrounded, doubled or halved into 60..180.
  The beat is re-aligned to bar 1 on every loop wrap, so loops that are not a whole number of bars stay in step.
  If the beat was already playing, beat sync restarts it in step. Stopping the deck stops the beat it started; the
  user stopping the beat leaves the deck playing.
- Song detection runs once after `load` resolves; a song only gets `sourceBpm` when confidence is at least 0.1.
  `setSourceBpm` wins over a detection still running.
- Keep pitch: phase vocoder with phase locking, both channels in sync. Starts 200 ms after the last speed change,
  about 7 s for a 4-minute song at 0.85x on a mid-range laptop. Up to 2 speeds kept per song (each copy is as
  big as the song), 1 on devices with `navigator.deviceMemory <= 4` or touch-only devices (coarse pointer, no
  hover); `stretchCacheLimit()` gives the default, `createRemix(engine, { stretchCache })` overrides it. Files with more than 2 channels are folded to stereo for the stretch.
- `render` also takes `sampleRate` and `OfflineAudioContext`. Rejects `Error('no-song')` without a song.
- Used by the booth: `remix.snapshot()` (throws `no-remix` / `no-bpm`), `prepareSnapshot(snap)`,
  `playSnapshot(snap, { at, duration })` (resolves `{ startTime, stop(ringOut) }`), `renderSnapshot(snap, opts)`,
  `remix.setLocked(bool)`.
- `remix.locked`: true while the booth records over the deck (set from `record()` until the take ends or is
  cancelled; `onChange` fires on both flips). While locked, `setSpeed`, `setKeepPitch`, `setFx`, `applyPreset`,
  `setSettings`, `setBeatSync`, `setSourceBpm`, `setLoop` and `setLoopEnabled` change nothing and return the
  current value; `load` rejects and `unload` throws `Error('busy')`. Play/stop still work (stop drops the take).
- `dispose()` also stops take previews and makes a load in flight reject `Error('cancelled')`.

### Recording over the remix
```js
booth.setBacking('beat' | 'remix')            // needs createBooth(engine, { remix }); 'remix' requires a loaded song
                                              // with a BPM. Rejects/throws Error('busy') while recording
booth.backing                                 // 'beat' (default) | 'remix'
                                              // setBacking('remix') throws Error('no-remix' | 'no-bpm'); unloading the
                                              // song or clearing its BPM switches back to 'beat' (onChange fires)
```
With the remix as backing, a take starts on the loop start (bar 1) and is `bars` bars at `remix.effectiveBpm`.
The count-in clicks at that tempo. The beat only plays along if beat sync is on. Each take keeps a snapshot of
the remix settings it was recorded over (`take.backing`), and `playTake`/`renderMix` use that snapshot, so a
take still lines up after you change speed. Changing the loop start or speed afterwards does not move old takes.

- `take.backing`: `{ type: 'beat' }` or `{ type: 'remix', name, speed, keepPitch, reverb, muffle, bass, volume,
  beatSync, sourceBpm, bpm, loop: { start, end, enabled } }`; `take.bpm` is the remix tempo (may have decimals).
- Recording over the remix restarts the deck from the loop start after the count-in and stops it after the take;
  a beat that is playing without sync is stopped. Stopping the deck mid-take drops the take (`record()` resolves
  `null`); stopping the beat does not. Recording or previewing over the beat stops a playing deck.
- `playTake(id, { withBeat: true })` on a remix take plays its snapshot (song + synced beat), not the live deck.
- Loop off: the take stops at the last whole bar before the song ends (`take.bars` can be less than `booth.bars`);
  with less than one bar of song left after the loop start, `record()` resolves `null`.
