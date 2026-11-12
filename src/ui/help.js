// Plain-language help for every control. Pure data: also read by the Guide view and tests.

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
    text: 'Shows the extra controls for fine-tuning: swing, master and per-sound volume, mute, solo, 808 notes and latency.',
  },
  presets: {
    term: 'Presets',
    sub: 'ready-made beats',
    text: 'Loads a finished groove to play with or change; it replaces your pads, and Undo brings yours back for a few seconds.',
  },
  pads: {
    term: 'Pads',
    sub: '16 steps per bar',
    text: 'Each row is one sound and each pad is one step of the bar; lit pads play when the moving light passes them.',
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
    text: 'Picks the pitch of the 808 bass on each step; without Advanced every step keeps the note the preset gave it.',
  },
  exportBeat: {
    term: 'Export beat',
    sub: 'WAV file',
    text: 'Saves the beat on its own as a WAV audio file that plays anywhere and loads into other music apps.',
  },
  beatBars: {
    term: 'Bars',
    sub: 'file length',
    text: 'How many times the one-bar pattern repeats in the exported file (one bar is four beats).',
  },
  patternFile: {
    term: 'Pattern file',
    sub: 'JSON',
    text: 'Export saves your pads and settings as a small file, and Import loads one back, so you can keep or share beats.',
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
    text: 'Saves the beat plus the picked take as one WAV file: your finished song.',
  },
  exportVocal: {
    term: 'Export vocal',
    sub: 'voice only',
    text: 'Saves only your voice from the picked take as a WAV file, for mixing in another app.',
  },
};

export const HELP_KEYS = Object.keys(HELP);

export const PRESET_INFO = {
  afroBass: 'bouncy afrobeats groove',
  trap: 'rolling hats and deep 808, made for fast flows',
  boomBap: 'dusty 90s head-nod groove',
  empty: 'clears every pad so you can start from scratch',
};

export const GUIDE_SECTIONS = [
  {
    id: 'beat',
    title: 'Making a beat',
    keys: ['modeBeat', 'play', 'tempo', 'presets', 'undo', 'pads', 'sounds', 'exportBeat', 'beatBars', 'patternFile'],
  },
  {
    id: 'booth',
    title: 'Recording in the booth',
    keys: ['modeBooth', 'input', 'mic', 'level', 'monitoring', 'takeBars', 'countIn', 'record', 'takes', 'takePlay', 'takeDelete', 'previewStop', 'exportMix', 'exportVocal'],
  },
  {
    id: 'advanced',
    title: 'Advanced controls',
    keys: ['advanced', 'swing', 'master', 'volume', 'mute', 'solo', 'bassNotes', 'latency', 'latencyOffset'],
  },
];

export const GUIDE_RECIPES = [
  {
    title: 'Make your first beat',
    steps: [
      'In BEAT, press a preset such as Afro bass, or Empty to start clean.',
      'Press Play (or Space).',
      'Tap pads to switch sounds on and off while it loops.',
      'Move Tempo until the speed feels right.',
      'Your beat is saved in this browser automatically.',
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
];

export function helpText(key) {
  return HELP[key]?.text ?? '';
}
