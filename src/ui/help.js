// Plain-language help for every control. Pure data: also read by the Guide view and tests.
import { SAMPLER_HELP, SAMPLER_GUIDE } from './help-sampler.js';

export const HELP = {
  modeBeat: {
    term: 'Beat',
    sub: 'make the beat',
    text: 'Opens the beat maker, where you pick a preset, tap pads and set the tempo.',
  },
  modeBooth: {
    term: 'Booth',
    sub: 'record your voice',
    text: 'Opens the recording booth, where you rap over your beat and export the song; the beat keeps playing while you switch.',
  },
  modeRemix: {
    term: 'Remix',
    sub: 'rework a song',
    text: 'Opens the remix deck, where you load your own song, slow it down or speed it up, add space and rap over it.',
  },
  undo: {
    term: 'Undo',
    sub: 'bring back your beat',
    text: 'Brings back the pattern you had before loading a preset or file; it disappears after a few seconds or once you edit.',
  },
  play: {
    term: 'Play / Stop',
    text: 'Starts or stops the beat loop; the Space bar does the same.',
  },
  tempo: {
    term: 'Tempo',
    sub: 'speed, in BPM',
    text: 'How fast the beat runs in beats per minute: around 90 feels laid back, around 140 feels fast.',
  },
  advanced: {
    term: 'Advanced',
    sub: 'all controls',
    text: 'Shows the extra controls: swing, volumes, mute, solo, notes, chance, pitch and flam modes, the chain, track feel, effect details, voice tuning and remix speed.',
  },
  presets: {
    term: 'Presets',
    sub: 'ready-made beats',
    text: 'Loads a finished groove from the chosen genre to play with or change; it replaces your beat, and Undo brings yours back for a few seconds.',
  },
  pads: {
    term: 'Pads',
    sub: '16 steps per bar',
    text: 'Each row is one sound and each pad is one step of the bar; lit pads play when the moving light passes them, and brighter pads hit harder.',
  },
  sounds: {
    term: 'Sound names',
    sub: 'tap to hear',
    text: 'Press a sound name on the left to hear that sound once.',
  },
  swing: {
    term: 'Swing',
    sub: 'groove feel',
    text: 'Plays every second step a little late so the beat bounces instead of marching; 0% is straight, and double-click or Delete resets it.',
  },
  master: {
    term: 'Master',
    sub: 'overall volume',
    text: 'Sets the loudness of the whole beat for your speakers and exported files; double-click or Delete resets it to 80%.',
  },
  volume: {
    term: 'Volume',
    sub: 'per sound',
    text: 'Sets how loud one sound is compared to the others; double-click or Delete resets it.',
  },
  mute: {
    term: 'Mute',
    sub: 'M',
    text: 'Silences one sound without erasing its pads.',
  },
  solo: {
    term: 'Solo',
    sub: 'S',
    text: 'Plays only the soloed sounds so you can hear them on their own; solo several to hear a few together.',
  },
  bassNotes: {
    term: '808 notes',
    sub: 'bass pitch',
    text: 'Picks the note of the 808 bass or log drum on each step; without Advanced every step keeps the note the preset gave it.',
  },
  exportBeat: {
    term: 'Export beat',
    sub: 'WAV file',
    text: 'Saves the beat on its own as a WAV audio file that plays anywhere and loads into other music apps.',
  },
  beatBars: {
    term: 'Bars',
    sub: 'file length',
    text: 'How long the exported file is, in bars of four beats; the loop with its sections repeats to fill it.',
  },
  patternFile: {
    term: 'Pattern file',
    sub: 'JSON',
    text: 'Export saves your pads and settings as a small file, and Import loads one back, so you can keep or share beats.',
  },
  presetGenre: {
    term: 'Genre',
    sub: 'filter presets',
    text: 'Shows only the presets of one style, so you can find a groove for the kind of song you want.',
  },
  presetOriginal: {
    term: 'Original',
    sub: 'made for Rythmik',
    text: 'Marks grooves made just for Rythmik rather than typical patterns of a genre.',
  },
  editMode: {
    term: 'Edit mode',
    sub: 'what a tap does',
    text: 'Chooses what tapping a pad changes: on or off, how hard it hits, rolls, and in Advanced chance, pitch and flams.',
  },
  modeOnOff: {
    term: 'On/off',
    sub: 'tap to switch',
    text: 'Tapping a pad switches that sound on or off at that step.',
  },
  modeVelocity: {
    term: 'Velocity',
    sub: 'how hard',
    text: 'Tapping a lit pad cycles it between soft, normal and accent; brighter pads hit harder.',
  },
  modeRoll: {
    term: 'Roll',
    sub: 'fast repeats',
    text: 'Tapping a lit pad cycles 1 to 4 quick hits inside that step, like the rolling hi-hats in trap.',
  },
  modeChance: {
    term: 'Chance',
    sub: 'maybe it plays',
    text: 'Tapping a lit pad cycles how often it plays on each loop (100, 75, 50 or 25%), so the beat changes a little every time.',
  },
  modePitch: {
    term: 'Pitch',
    sub: 'tune a step',
    text: 'Tap a pad, then use the minus and plus keys to tune that one hit up or down.',
  },
  modeFlam: {
    term: 'Flam',
    sub: 'double hit',
    text: 'Tapping a lit pad adds or removes a flam: a softer extra hit just before the main one.',
  },
  pitchEdit: {
    term: 'Step pitch',
    sub: 'selected pad',
    text: 'Tunes the selected pad in semitones, or picks its note for the 808 and log drum; Reset puts it back to normal.',
  },
  sections: {
    term: 'Sections',
    sub: 'A and B',
    text: 'A beat can have two parts, A and B; these keys choose which one the pads show and edit.',
  },
  addB: {
    term: 'Add B',
    sub: 'second part',
    text: 'Makes section B as a copy of A, so you can change it into a variation or a fill.',
  },
  removeB: {
    term: 'Remove B',
    sub: 'one part only',
    text: 'Deletes section B and plays A only; Undo brings it back for a few seconds.',
  },
  stepLength: {
    term: 'Steps',
    sub: '16 or 32',
    text: 'Sets the length of the section you edit: 16 steps is one bar, 32 is two bars, and going to 32 copies the first bar.',
  },
  barPage: {
    term: 'Bar',
    sub: 'which half',
    text: 'With 32 steps the pads show one bar at a time; these keys switch between bar 1 and bar 2.',
  },
  chainSimple: {
    term: 'Play A then B',
    sub: 'loop order',
    text: 'When on, the loop plays section A and then section B; when off, it repeats A only.',
  },
  chain: {
    term: 'Chain',
    sub: 'loop order',
    text: 'The order the sections play in, up to 8 slots: tap a slot to switch it between A and B.',
  },
  humanize: {
    term: 'Humanize',
    sub: 'less robotic',
    text: 'Changes every hit very slightly in loudness and timing so the beat feels played by a person.',
  },
  randomize: {
    term: 'Randomize',
    sub: 'new ideas',
    text: 'Writes a fresh random pattern for the chosen track in the section you edit; press again for another idea.',
  },
  autoFill: {
    term: 'Auto fill',
    sub: 'every 4 bars',
    text: 'Makes section B a copy of A with a drum fill at the end and plays A three times, then B.',
  },
  clearTrack: {
    term: 'Clear track',
    sub: 'empty one row',
    text: 'Switches off every pad of the chosen track in the section you edit.',
  },
  toolTrack: {
    term: 'Track',
    sub: 'for the tools',
    text: 'The track that Randomize and Clear track change; it follows the last row you tapped.',
  },
  addTrack: {
    term: 'Add track',
    sub: 'more sounds',
    text: 'Adds a new row with another drum, percussion or bass sound, or one of your samples, up to 16 rows.',
  },
  editTracks: {
    term: 'Edit tracks',
    sub: 'remove rows',
    text: 'Shows a remove key on every row, and in Advanced keys to move rows up and down.',
  },
  removeTrack: {
    term: 'Remove',
    sub: 'delete a row',
    text: 'Takes the sound and its pads out of the beat; Undo brings it back for a few seconds.',
  },
  moveTrack: {
    term: 'Move',
    sub: 'row order',
    text: 'Moves a row up or down in the list; it does not change how the beat sounds.',
  },
  missingSample: {
    term: 'Missing sample',
    sub: 'silent row',
    text: 'This row uses a sample that is not in this browser, so it stays silent until you import its project file or remove it.',
  },
  trackFeel: {
    term: 'Track feel',
    sub: 'per sound',
    text: 'Gives single sounds their own swing or pushes them a little early or late against the grid.',
  },
  trackSwing: {
    term: 'Track swing',
    sub: 'own swing',
    text: 'Swing for this sound only; at the far left it follows the main Swing knob.',
  },
  trackNudge: {
    term: 'Nudge',
    sub: 'early or late',
    text: 'Moves every hit of this sound slightly early (left) or late (right), up to half a step.',
  },
  projectFile: {
    term: 'Project file',
    sub: 'beat + samples',
    text: 'Export project saves the pattern together with the samples it uses in one file, and Import project loads it back.',
  },
  input: {
    term: 'Input',
    sub: 'which mic',
    text: 'Chooses which microphone to record from, for example a headset or a USB mic.',
  },
  mic: {
    term: 'Enable mic',
    sub: 'turn the mic on',
    text: 'Asks the browser for microphone access and turns it on; your voice never leaves this device.',
  },
  level: {
    term: 'Level',
    sub: 'mic meter',
    text: 'Shows how loud your mic is: aim for the middle while you rap and move back if the top light flashes.',
  },
  monitoring: {
    term: 'Monitor',
    sub: 'hear yourself',
    text: 'Plays your own voice into your headphones while you record; use headphones, or speakers will howl.',
  },
  takeBars: {
    term: 'Bars',
    sub: 'take length',
    text: 'How long one recording lasts, counted in bars of the beat (one bar is four beats).',
  },
  countIn: {
    term: 'Count-in',
    sub: '4 clicks first',
    text: 'Plays four clicks before recording starts so you know exactly when to come in.',
  },
  record: {
    term: 'Record',
    sub: 'shortcut R',
    text: 'Starts the beat from the top and records your voice for the chosen bars; press Cancel or Esc to stop without keeping it.',
  },
  takes: {
    term: 'Takes',
    sub: 'your recordings',
    text: 'Every recording is kept as a take: play them back, delete the weak ones and pick the one that goes in the mix.',
  },
  latencyOffset: {
    term: 'Offset',
    sub: 'manual timing',
    text: 'Shifts your recorded voice later (right) or earlier (left) in milliseconds when it does not sit on the beat.',
  },
  latency: {
    term: 'Latency',
    sub: 'voice timing fix',
    text: 'Your device adds a small delay between beat and voice; Rythmik estimates it, and the offset slider fixes the rest if your voice sounds early or late.',
  },
  takePlay: {
    term: 'Play take',
    sub: 'listen back',
    text: 'Plays that take together with the beat so you can hear how it sounds.',
  },
  takeDelete: {
    term: 'Delete take',
    sub: 'throw it away',
    text: 'Removes that take for good; it cannot be undone.',
  },
  previewStop: {
    term: 'Stop',
    sub: 'stop listening',
    text: 'Stops the take that is playing back; Esc does the same.',
  },
  exportMix: {
    term: 'Export mix',
    sub: 'beat + voice',
    text: 'Saves the beat plus the picked take, with its voice effects, as one WAV file: your finished song.',
  },
  exportVocal: {
    term: 'Export vocal',
    sub: 'voice only',
    text: 'Saves only your voice from the picked take as a WAV file, for mixing in another app.',
  },
  vocalFx: {
    term: 'Vocal file',
    sub: 'dry or with effects',
    text: 'Choose whether Export vocal saves your voice with the Voice effects from step 4 or untouched (dry).',
  },
  effects: {
    term: 'Effects',
    sub: 'sound of the beat',
    text: 'Adds room, echo and color to the whole beat; the effects are saved with the pattern and are in your exports.',
  },
  fxSpace: {
    term: 'Space',
    sub: 'reverb',
    text: 'Puts the beat in a room: turn it up for a bigger, wetter sound, or down for dry and close.',
  },
  fxEcho: {
    term: 'Echo',
    sub: 'delay',
    text: 'Repeats the sounds in time with the beat, fading out each time.',
  },
  fxEchoTime: {
    term: 'Echo time',
    sub: 'gap between repeats',
    text: 'Sets how far apart the echoes are: short is an eighth note, dotted is the bouncy three-sixteenths, long is a full beat.',
  },
  fxFilter: {
    term: 'Filter',
    sub: 'darker or thinner',
    text: 'Turn left to cut the highs for a dark, muffled sound, right to cut the lows for a thin one; the middle is off.',
  },
  fxDrive: {
    term: 'Drive',
    sub: 'grit',
    text: 'Pushes the beat into gentle distortion so it sounds warmer and dirtier as you turn it up.',
  },
  fxSends: {
    term: 'Sends',
    sub: 'per sound',
    text: 'Sets how much of each sound goes into Space and Echo, for example echo on the snare only.',
  },
  voice: {
    term: 'Voice',
    sub: 'vocal effects',
    text: 'Pick a sound for your recorded voice; it is used when you play takes back and in the mix export.',
  },
  voiceClean: {
    term: 'Clean',
    sub: 'no effect',
    text: 'Your voice as recorded, just cleaned of low rumble and level-matched.',
  },
  voiceRobot: {
    term: 'Robot',
    sub: 'hard autotune',
    text: 'Snaps your voice to the nearest note instantly for the classic robotic autotune sound.',
  },
  voiceTuned: {
    term: 'Tuned',
    sub: 'soft autotune',
    text: 'Gently pulls your voice toward the right notes so it sounds in tune but still natural.',
  },
  voiceRadio: {
    term: 'Radio',
    sub: 'phone voice',
    text: 'Makes your voice thin and narrow, like it comes out of an old radio or a phone.',
  },
  voiceHall: {
    term: 'Hall',
    sub: 'big room',
    text: 'Places your voice in a large room with a long reverb tail.',
  },
  voiceLofi: {
    term: 'Lo-fi',
    sub: 'dusty tape',
    text: 'Makes your voice darker and a little gritty, like an old tape.',
  },
  voiceKey: {
    term: 'Key',
    sub: 'home note',
    text: 'The note the tuning is built on; leave it on A if you use the 808 notes as they come.',
  },
  voiceScale: {
    term: 'Scale',
    sub: 'minor or major',
    text: 'Chooses which notes the tuning snaps to: minor sounds darker, major sounds brighter.',
  },
  voiceTune: {
    term: 'Tune',
    sub: 'amount',
    text: 'How strongly your voice is pulled to the notes of the key: 0% is off, 100% is fully tuned.',
  },
  voiceRetune: {
    term: 'Retune speed',
    sub: 'robotic to natural',
    text: 'How fast the tuning grabs each note: low values jump instantly like a robot, high values glide naturally.',
  },
  voiceReverb: {
    term: 'Voice reverb',
    sub: 'room',
    text: 'Adds room sound to your voice only.',
  },
  voiceEcho: {
    term: 'Voice echo',
    sub: 'delay',
    text: 'Adds a soft echo to your whole voice that repeats in time with the beat.',
  },
  recordOver: {
    term: 'Record over',
    sub: 'beat or song',
    text: 'Chooses what you rap over: your beat, or the song loaded in REMIX starting at its loop start.',
  },
  remixLoad: {
    term: 'Load a song',
    sub: 'your audio file',
    text: 'Opens an audio file from this computer, such as an MP3 or WAV; it is never uploaded anywhere.',
  },
  remixRemove: {
    term: 'Remove',
    sub: 'unload the song',
    text: 'Takes the song out of the deck; your remix settings stay for the next song.',
  },
  remixDeck: {
    term: 'Play song',
    sub: 'the deck',
    text: 'Plays or stops your song; it is separate from the beat, so both can play at once.',
  },
  remixWave: {
    term: 'Waveform',
    sub: 'click or drag',
    text: 'Click to play from that point, drag across it to mark a loop, or drag the two handles to move the loop edges.',
  },
  remixLoop: {
    term: 'Loop',
    sub: 'repeat a part',
    text: 'When on, the song repeats the marked part over and over; when off, it plays to the end.',
  },
  remixMarkStart: {
    term: 'Start here',
    sub: 'loop start',
    text: 'Sets the loop start to where the song is playing now, or where it last stopped, and turns Loop on.',
  },
  remixMarkEnd: {
    term: 'End here',
    sub: 'loop end',
    text: 'Sets the loop end to where the song is playing now, or where it last stopped, and turns Loop on.',
  },
  remixSlowedReverb: {
    term: 'Slowed + reverb',
    sub: 'one click',
    text: 'Slows the song down, adds a big room and softens the highs for the classic dreamy sound.',
  },
  remixNightcore: {
    term: 'Nightcore',
    sub: 'one click',
    text: 'Speeds the song up so it plays faster and higher, with a touch of room.',
  },
  remixOriginal: {
    term: 'Original',
    sub: 'reset',
    text: 'Puts speed and effects back to how the song sounds as loaded.',
  },
  remixSpeed: {
    term: 'Speed',
    sub: 'slower or faster',
    text: 'Plays the song slower or faster, and like a record the pitch goes down or up with it.',
  },
  remixSpeedFine: {
    term: 'Fine speed',
    sub: '0.50x to 1.50x',
    text: 'Sets any speed between half and one and a half times the original.',
  },
  remixKeepPitch: {
    term: 'Keep pitch',
    sub: 'tempo only',
    text: 'Changes only the tempo and keeps the original pitch, which takes a few seconds to prepare after each speed change.',
  },
  remixSpace: {
    term: 'Space',
    sub: 'reverb',
    text: 'Puts the song in a big room: more Space sounds wider and more distant.',
  },
  remixMuffle: {
    term: 'Muffle',
    sub: 'next room',
    text: 'Cuts the highs so the song sounds like it plays underwater or through a wall.',
  },
  remixBass: {
    term: 'Bass',
    sub: 'low boost',
    text: 'Turns up the low end of the song.',
  },
  remixVolume: {
    term: 'Volume',
    sub: 'song level',
    text: 'Sets how loud the song is compared to the beat and your voice.',
  },
  remixSongBpm: {
    term: 'Song tempo',
    sub: 'BPM',
    text: 'The tempo found in your song at normal speed, and next to it the tempo at the speed you picked.',
  },
  remixTap: {
    term: 'Tap',
    sub: 'tap tempo',
    text: 'Tap this key along with the song while it plays to set its tempo when it was not found or is wrong.',
  },
  remixManualBpm: {
    term: 'Song BPM',
    sub: 'type it',
    text: 'Type the tempo of the song at normal speed if you know it.',
  },
  remixHalfDouble: {
    term: 'x2 and /2',
    sub: 'fix the tempo',
    text: 'Doubles or halves the song tempo when it was found at twice or half the real speed.',
  },
  remixBeatSync: {
    term: 'Beat plays along',
    sub: 'beat sync',
    text: 'Plays your beat in time with the song at the song tempo, starting on the loop start, whenever the song plays.',
  },
  remixExport: {
    term: 'Export remix',
    sub: 'WAV file',
    text: 'Saves the song as you hear it, with speed and effects, as a WAV file; the beat is included when Beat plays along is on.',
  },
  remixExportRange: {
    term: 'Length',
    sub: 'loop or whole song',
    text: 'Choose whether the export holds only the marked loop or the whole song.',
  },
};

for (const [key, entry] of Object.entries(SAMPLER_HELP)) {
  if (!(key in HELP)) HELP[key] = entry;
}

export const HELP_KEYS = Object.keys(HELP);

export const GUIDE_SECTIONS = [
  {
    id: 'beat',
    title: 'Making a beat',
    keys: ['modeBeat', 'play', 'tempo', 'presets', 'presetGenre', 'presetOriginal', 'undo', 'pads', 'sounds', 'exportBeat', 'beatBars', 'patternFile'],
  },
  {
    id: 'grooves',
    title: 'Shaping the groove',
    keys: [
      'editMode', 'modeOnOff', 'modeVelocity', 'modeRoll', 'sections', 'addB', 'stepLength', 'barPage', 'chainSimple',
      'humanize', 'randomize', 'autoFill', 'clearTrack', 'toolTrack', 'addTrack', 'editTracks', 'removeTrack', 'missingSample',
    ],
  },
  ...(SAMPLER_GUIDE?.section ? [SAMPLER_GUIDE.section] : []),
  {
    id: 'booth',
    title: 'Recording in the booth',
    keys: ['modeBooth', 'input', 'mic', 'level', 'monitoring', 'takeBars', 'countIn', 'record', 'takes', 'takePlay', 'takeDelete', 'previewStop', 'exportMix', 'exportVocal', 'vocalFx'],
  },
  {
    id: 'effects',
    title: 'Effects and voice',
    keys: ['effects', 'fxSpace', 'fxEcho', 'voice', 'voiceClean', 'voiceRobot', 'voiceTuned', 'voiceRadio', 'voiceHall', 'voiceLofi'],
  },
  {
    id: 'remix',
    title: 'Remixing a song',
    keys: [
      'modeRemix', 'remixLoad', 'remixRemove', 'remixDeck', 'remixWave', 'remixLoop', 'remixMarkStart', 'remixMarkEnd',
      'remixSlowedReverb', 'remixNightcore', 'remixOriginal',
      'remixSpeed', 'remixSpace', 'remixMuffle', 'remixBass', 'remixVolume', 'remixSongBpm', 'remixTap', 'remixHalfDouble',
      'remixBeatSync', 'remixExport', 'remixExportRange', 'recordOver',
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced controls',
    keys: [
      'advanced', 'swing', 'master', 'volume', 'mute', 'solo', 'bassNotes',
      'modeChance', 'modePitch', 'modeFlam', 'pitchEdit', 'removeB', 'chain', 'moveTrack', 'trackFeel', 'trackSwing', 'trackNudge', 'projectFile',
      'fxEchoTime', 'fxFilter', 'fxDrive', 'fxSends',
      'voiceKey', 'voiceScale', 'voiceTune', 'voiceRetune', 'voiceReverb', 'voiceEcho', 'latency', 'latencyOffset',
      'remixSpeedFine', 'remixKeepPitch', 'remixManualBpm',
    ],
  },
];

export const GUIDE_RECIPES = [
  {
    title: 'Make your first beat',
    steps: [
      'In BEAT, pick a genre and press a preset such as Afro bass, or Empty to start clean.',
      'Press Play (or Space).',
      'Tap pads to switch sounds on and off while it loops.',
      'Move Tempo until the speed feels right.',
      'Your beat is saved in this browser automatically.',
    ],
  },
  {
    title: 'Make a trap hi-hat roll',
    steps: [
      'In BEAT, pick Hip-hop and load Trap, or switch on a closed hat on every second step.',
      'Press Play, then press the Roll edit mode key above the pads.',
      'Tap a lit hi-hat pad near the end of the bar: each tap adds a hit, from 1 up to 4, then back to 1.',
      'Try 3 on one step and 2 on the next for the classic trap stutter.',
      'Press Velocity and tap some hats to make them softer, so the roll breathes.',
    ],
  },
  {
    title: 'Add a fill every 4 bars',
    steps: [
      'Make a beat you like in section A.',
      'Press Auto fill under the pads: section B becomes A with a drum fill at the end.',
      'The loop now plays A three times, then B, so the fill lands on every fourth bar.',
      'Press B to see and change the fill, or Undo if you do not like it.',
      'In Advanced, the Chain slots let you change the order, for example A B A B.',
    ],
  },
  {
    title: 'Record a verse',
    steps: [
      'Put on headphones so the beat does not leak into the mic.',
      'Go to BOOTH and pick your mic under Input, then press Enable mic.',
      'Rap a line and check the Level meter moves to about the middle.',
      'Choose how many bars to record and leave Count-in on.',
      'Press Record, wait for the four clicks, then rap. Record as many takes as you like.',
    ],
  },
  {
    title: 'Export a song',
    steps: [
      'In BOOTH, under Takes, pick the take you like best.',
      'Press Export mix to save beat and voice as one WAV file.',
      'Press Export vocal if you only want your voice.',
      'For the beat alone, use Export beat in BEAT.',
    ],
  },
  {
    title: 'Get the robot voice',
    steps: [
      'In BOOTH, record a take (steps 1 and 2).',
      'Open step 4, Voice, and press Robot.',
      'Wait until "Tuning your take" is gone, then press Play on your take.',
      'Happy with it? Export the mix in step 5.',
    ],
  },
  {
    title: 'Make a slowed + reverb version and rap over it',
    steps: [
      'Go to REMIX and press Load a song, or drop an audio file on the deck.',
      'Press Slowed + reverb, then Play song to hear it.',
      'Mark the part you want to rap over: drag across the waveform, or press Start here and End here while it plays.',
      'Check Song tempo shows a number; if not, press Tap along with the song.',
      'In BOOTH, set Record over to Remix and record your takes.',
      'Export the mix in step 5, or Export remix in REMIX for the song alone.',
    ],
  },
  ...(SAMPLER_GUIDE?.recipe ? [SAMPLER_GUIDE.recipe] : []),
];
