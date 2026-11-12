// Plain-language help for the SAMPLES panel. Merged into HELP by the app; pure data.

export const SAMPLER_HELP = Object.freeze({
  smpPanel: {
    term: 'Samples',
    sub: 'your own sounds',
    text: 'Turns your voice or any short audio file into drum sounds you can put in the beat, up to 16 sounds of 10 seconds each.',
  },
  smpRecord: {
    term: 'Record',
    sub: 'up to 10 s',
    text: 'Records a short sound from your mic, such as a word, a clap or a beatbox hit; silence at the start and end is cut off.',
  },
  smpLength: {
    term: 'Length',
    sub: 'record time',
    text: 'How many seconds Record listens for; short is easier, because you then pick the part you want anyway.',
  },
  smpLoad: {
    term: 'Load a sound',
    sub: 'audio file',
    text: 'Opens a WAV, MP3, OGG or M4A file of up to 30 seconds; the file stays on this computer and is never uploaded.',
  },
  smpFromTake: {
    term: 'From a Booth take',
    sub: 'reuse your voice',
    text: 'Takes the audio of a take you recorded in BOOTH, so you can cut a word or an ad-lib out of it.',
  },
  smpSources: {
    term: 'Sounds to cut',
    sub: 'what you brought in',
    text: 'Everything you recorded or loaded waits here until you cut sounds from it; pick one to show its waveform.',
  },
  smpRemoveSource: {
    term: 'Remove',
    sub: 'the long recording',
    text: 'Takes this recording off the list; sounds you already made from it keep working.',
  },
  smpWave: {
    term: 'Waveform',
    sub: 'drag to choose',
    text: 'Shows your sound as a picture: tall parts are loud, so drag across the part you want or move the two handles.',
  },
  smpRegion: {
    term: 'Region',
    sub: 'the part you keep',
    text: 'The marked part of the waveform that becomes your sound; arrow keys on a handle move it in small steps, Shift in bigger ones.',
  },
  smpPlayRegion: {
    term: 'Play region',
    sub: 'hear the part',
    text: 'Plays only the marked part, so you can check it starts right on the hit and stops before the next one.',
  },
  smpChop: {
    term: 'Chop',
    sub: 'find the hits',
    text: 'Finds the separate hits or words in the recording and cuts it into numbered slices for you.',
  },
  smpSlices: {
    term: 'Slices',
    sub: 'tap to pick',
    text: 'The pieces Chop found: tap a number to hear it and pick it, tap again to unpick it, then add the picked ones.',
  },
  smpName: {
    term: 'Name',
    sub: 'for the new sound',
    text: 'What the new sound is called in the list and in the beat; slices get a number after it.',
  },
  smpAdd: {
    term: 'Add as sound',
    sub: 'make it a pad',
    text: 'Saves the region, or each picked slice, as a sound with its own pad in the list below.',
  },
  smpAddAll: {
    term: 'Add all slices',
    sub: 'one click',
    text: 'Makes a sound from every slice at once, as many as still fit in the 16 sounds.',
  },
  smpPad: {
    term: 'Pad',
    sub: 'tap to hear',
    text: 'Plays the sound with its current settings, the same way it will sound in the beat.',
  },
  smpVolume: {
    term: 'Volume',
    sub: 'how loud',
    text: 'How loud this sound plays in the beat; double-click or Delete resets it.',
  },
  smpPitch: {
    term: 'Pitch',
    sub: 'higher or lower',
    text: 'Plays the sound up to 12 semitones higher or lower; higher is also shorter, lower is longer and deeper.',
  },
  smpReverse: {
    term: 'Reverse',
    sub: 'play backwards',
    text: 'Plays the sound backwards, which turns a hit into a swell that leads into the next beat.',
  },
  smpAddToBeat: {
    term: 'Add to beat',
    sub: 'new row',
    text: 'Puts the sound in the beat as a new row of pads in the grid above, where you tap the steps it plays on.',
  },
  smpFadeIn: {
    term: 'Fade in',
    sub: 'soft start',
    text: 'Raises the volume gently at the start, which removes clicks and softens a sharp attack.',
  },
  smpFadeOut: {
    term: 'Fade out',
    sub: 'soft end',
    text: 'Lowers the volume at the end so the sound stops without a click.',
  },
  smpStartEnd: {
    term: 'Start / End',
    sub: 'fine trim, seconds',
    text: 'The exact start and end of the sound in its recording, in seconds, for trimming in tiny steps.',
  },
  smpRename: {
    term: 'Rename',
    sub: 'change the name',
    text: 'Changes the name shown on the pad and on its row in the beat.',
  },
  smpDelete: {
    term: 'Delete',
    sub: 'press twice',
    text: 'Removes the sound and its row in the beat; press it a second time to confirm.',
  },
  smpStorage: {
    term: 'Storage',
    sub: 'where sounds live',
    text: 'Your sounds are kept in this browser on this computer, so they are still here after a reload unless the browser blocks storage.',
  },
  smpUseTake: {
    term: 'Use as sample',
    sub: 'cut a sound from it',
    text: 'Sends this take to SAMPLES in BEAT, where you can cut a word or ad-lib out of it and play it as a drum.',
  },
});

export const SAMPLER_GUIDE = Object.freeze({
  section: {
    id: 'samples',
    title: 'Your own sounds',
    keys: [
      'smpPanel', 'smpRecord', 'smpLength', 'smpLoad', 'smpFromTake', 'smpUseTake', 'smpSources', 'smpRemoveSource',
      'smpWave', 'smpRegion', 'smpPlayRegion', 'smpChop', 'smpSlices', 'smpName', 'smpAdd', 'smpAddAll',
      'smpPad', 'smpVolume', 'smpPitch', 'smpReverse', 'smpAddToBeat', 'smpStorage',
      'smpFadeIn', 'smpFadeOut', 'smpStartEnd', 'smpRename', 'smpDelete',
    ],
  },
  recipe: {
    title: 'Turn a word from your take into a drum',
    steps: [
      'Record a take in BOOTH, then press Use as sample next to it.',
      'In SAMPLES, drag across the word you want, or press Chop and tap the slice with your word.',
      'Press Play region (or tap the slice) until it starts right on the word.',
      'Press Add as sound, then tap its pad to hear it.',
      'Turn Pitch down for a deeper hit, or switch on Reverse for a swell.',
      'Press Add to beat and tap the steps on its new row in the grid.',
    ],
  },
});
