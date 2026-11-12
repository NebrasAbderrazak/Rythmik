import { VOICES, BASS_NOTES, MAX_SWING } from '../audio/engine.js';
import { PRESETS, GENRES } from '../audio/presets.js';
import { emptyPattern, normalizePattern } from '../audio/pattern.js';
import { humanize, randomizeTrack, makeFill, clearTrack } from '../audio/groove.js';
import { renderBeat, EXPORT_BARS } from '../audio/export.js';
import { encodeWav } from '../audio/wav.js';
import { createKnob } from './knob.js';
import { downloadPattern, readPatternFile, EXPORT_FILENAME, PROJECT_FILENAME, MAX_PROJECT_BYTES } from './persistence.js';
import { helpLabel, helpTip } from './helptip.js';
import { el, silk, led, downloadBlob, setUnavailable } from './dom.js';

const SWING_MAX = MAX_SWING || 0.6; // knob shows 0..100%
const BAR = 16;
const MAX_TRACKS = 16;
const MAX_CHAIN = 8;
const DEFAULT_EXPORT_BARS = 4;
const LOW_MASTER = 0.1;
const HUMANIZE_AMOUNT = 0.5;

const ECHO_TIMES = [
  { value: '1/8', text: 'Short (1/8)' },
  { value: '3/16', text: 'Dotted (3/16)' },
  { value: '1/4', text: 'Long (1/4)' },
];

const VOICE_GROUPS = [
  { id: 'drums', name: 'Drums' },
  { id: 'perc', name: 'Percussion' },
  { id: 'bass', name: 'Bass' },
];

export const EDIT_MODES = [
  { id: 'toggle', name: 'On/off', adv: false },
  { id: 'velocity', name: 'Velocity', adv: false },
  { id: 'roll', name: 'Roll', adv: false },
  { id: 'chance', name: 'Chance', adv: true },
  { id: 'pitch', name: 'Pitch', adv: true },
  { id: 'flam', name: 'Flam', adv: true },
];
const EDIT_HELP = { toggle: 'modeOnOff', velocity: 'modeVelocity', roll: 'modeRoll', chance: 'modeChance', pitch: 'modePitch', flam: 'modeFlam' };
const TOOL_HELP = { humanize: 'humanize', randomize: 'randomize', fill: 'autoFill', clear: 'clearTrack' };

const MODE_LEGEND = {
  toggle: 'Tap a pad to switch it on or off.',
  velocity: 'Tap a lit pad: soft, normal, accent. Brighter pads hit harder.',
  roll: 'Tap a lit pad: 1, 2, 3 or 4 hits inside the step. Ticks show the hits.',
  chance: 'Tap a lit pad: plays 100, 75, 50 or 25% of the time. Striped pads are maybe.',
  pitch: 'Tap a pad to select it, then tune it with - and +.',
  flam: 'Tap a lit pad to add or remove a flam. A notch marks it.',
};
const FIRST_TAP = ' An empty pad switches on first.';

const VELOCITY_LEVELS = [0.5, 0.8, 1];
const CHANCE_LEVELS = [1, 0.75, 0.5, 0.25];

/** soft, normal, accent, back to soft; values in between move up to the next level. */
export function nextVelocity(v) {
  return VELOCITY_LEVELS.find((l) => l > v + 0.001) ?? VELOCITY_LEVELS[0];
}
/** 100, 75, 50, 25%, back to 100. */
export function nextChance(c) {
  return CHANCE_LEVELS.find((l) => l < c - 0.001) ?? CHANCE_LEVELS[0];
}
export const nextRoll = (r) => (Math.max(1, Math.min(4, r || 1)) % 4) + 1;

export function velocityName(v) {
  if (v >= 0.95) return 'accent';
  if (v >= 0.65) return 'normal';
  if (v >= 0.4) return 'soft';
  return 'ghost';
}

const noteName = new Map(BASS_NOTES.map((n) => [n.midi, n.name]));
const voiceById = new Map(VOICES.map((v) => [v.id, v]));
const isSample = (id) => typeof id === 'string' && id.startsWith('smp-');
const isPitched = (id) => !!voiceById.get(id)?.pitched;

export function pitchText(id, p) {
  if (isPitched(id)) return noteName.get(p) ?? String(p);
  const n = Math.round(Number(p) || 0);
  return n > 0 ? `+${n}` : String(n);
}

/** Spoken details of an on step, for the pad's name. */
export function stepDetails(id, s) {
  if (!s) return '';
  const parts = [velocityName(s.v)];
  if (s.r > 1) parts.push(`roll ${s.r}`);
  if (s.c < 1) parts.push(`${Math.round(s.c * 100)}% chance`);
  if (isPitched(id)) parts.push(`note ${pitchText(id, s.p)}`);
  else if (s.p) parts.push(`pitch ${pitchText(id, s.p)}`);
  if (s.f) parts.push('flam');
  return parts.join(', ');
}

/** Filter knob runs -100..100: left darker, right thinner, center off. */
export function filterText(v) {
  const n = Math.round(v);
  if (n === 0) return 'Off';
  return n < 0 ? `Dark ${-n}%` : `Thin ${n}%`;
}

/** Per-track swing knob: -1 follows the main swing. */
export const trackSwingText = (v) => (v < 0 ? 'Main' : `${Math.round(v)}%`);
/** Nudge knob in percent of a step. */
export function nudgeText(v) {
  const n = Math.round(v);
  if (n === 0) return 'On grid';
  return n < 0 ? `Early ${-n}%` : `Late ${n}%`;
}

// Effect settings a beginner can get without Advanced: a fresh pattern and every preset.
function baselineFx() {
  try {
    return [emptyPattern(), ...Object.values(PRESETS).map((p) => p.pattern)].map((p) => normalizePattern(p).fx || {});
  } catch {
    return [{}];
  }
}

const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
const sameSends = (a = {}, b = {}) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
    (id) => near(a[id]?.reverb, b[id]?.reverb) && near(a[id]?.echo, b[id]?.echo),
  );

/** Advanced-only effects that match no baseline: subset of ['filter', 'drive', 'sends']. */
export function changedHiddenFx(fx, baselines = baselineFx()) {
  if (!fx) return [];
  const out = [];
  if (!baselines.some((b) => near(fx.filter, b.filter))) out.push('filter');
  if (!baselines.some((b) => near(fx.drive, b.drive))) out.push('drive');
  if (!baselines.some((b) => sameSends(fx.sends, b.sends))) out.push('sends');
  return out;
}

const FX_PARTS = { filter: 'Filter is on', drive: 'Drive is on', sends: 'effect sends are changed' };

export function hiddenSettingsNote({ mixed = false, lowMaster = false, fx = [], feel = false } = {}) {
  const parts = [];
  if (lowMaster) parts.push('master volume is low');
  if (mixed) parts.push('some sounds are muted or soloed');
  if (feel) parts.push('some sounds have their own swing or nudge');
  for (const k of fx) if (FX_PARTS[k]) parts.push(FX_PARTS[k]);
  if (!parts.length) return '';
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `Some Advanced settings are active: ${list}. Turn on Advanced to change ${parts.length > 1 ? 'them' : 'it'}.`;
}

const presetJson = new Map();
function presetText(id) {
  if (!presetJson.has(id)) presetJson.set(id, JSON.stringify(normalizePattern(PRESETS[id].pattern)));
  return presetJson.get(id);
}

/** Preset that matches the pattern exactly, or null. */
export function matchPreset(pattern) {
  const key = JSON.stringify(normalizePattern(pattern));
  return Object.keys(PRESETS).find((id) => presetText(id) === key) ?? null;
}

/** True while the pattern is still exactly that preset. */
export const isPreset = (pattern, id) => !!PRESETS[id] && JSON.stringify(normalizePattern(pattern)) === presetText(id);

/**
 * Two-press confirm: the first press arms the button and shows `question`, a second press
 * within `ms` returns true. Returns false on the first press.
 */
export function confirmPress(btn, question, ms = 4000) {
  if (btn.dataset.armed === 'true') {
    disarm(btn);
    return true;
  }
  btn.dataset.armed = 'true';
  btn.dataset.label = btn.textContent;
  btn.textContent = question;
  btn.classList.add('rk-key--lit');
  clearTimeout(Number(btn.dataset.timer));
  btn.dataset.timer = String(setTimeout(() => disarm(btn), ms));
  return false;
}
function disarm(btn) {
  clearTimeout(Number(btn.dataset.timer));
  if (btn.dataset.armed !== 'true') return;
  btn.textContent = btn.dataset.label;
  btn.classList.remove('rk-key--lit');
  delete btn.dataset.armed;
  delete btn.dataset.timer;
}

const sameSection = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

export const chainText = (chain) => (chain || ['A']).join(' ');

const sampleError = (err) => {
  const m = err?.message;
  if (m === 'not-a-project') return 'Not a Rythmik project file.';
  return 'Could not import that project.';
};

/**
 * The BEAT view: preset browser, step grid with edit modes, sections, groove tools, effects, export.
 * Advanced-only parts carry .rk-adv. loadWithUndo / editWithUndo are owned by the app so Undo
 * survives view switches.
 */
export function mountBeat(engine, { status, loadWithUndo, editWithUndo, sampler = null, afterAudio = () => {} }) {
  const fxBaselines = baselineFx();
  const has = (name) => typeof engine[name] === 'function';

  let lastPattern = engine.getPattern();
  let mode = 'toggle';
  let page = 0;
  let editingTracks = false;
  let selected = null; // { id, step } for Pitch mode
  let toolTrack = null;
  let locked = false;
  let advanced = false;
  let lastFillB = null; // section B as Auto fill wrote it
  let currentPreset = matchPreset(lastPattern);
  let genre = PRESETS[currentPreset]?.genre || GENRES[0]?.id;

  const editSection = () => {
    const s = engine.editSection;
    return s === 'B' && lastPattern.sections?.B ? 'B' : 'A';
  };
  const sectionOf = (p) => p.sections?.[editSection()] || p.sections?.A || { length: BAR, steps: {} };

  function trackName(id) {
    const v = voiceById.get(id);
    if (v) return v.name;
    if (isSample(id)) return sampler?.getSample?.(id)?.name || 'Missing sample';
    return id;
  }
  const isMissing = (id) => isSample(id) && !sampler?.getSample?.(id);

  // ---------- preset browser ----------
  const genreKeys = GENRES.map((g) =>
    el('button', { type: 'button', class: 'rk-key rk-genre', 'aria-pressed': 'false', 'data-genre': g.id }, [led(), el('span', { text: g.name })]),
  );
  const presetButtons = [];
  const presetLeds = new Map();
  function presetKey(p) {
    const l = led();
    presetLeds.set(p.id, l);
    const btn = el('button', { type: 'button', class: 'rk-key rk-preset', 'data-preset': p.id, 'data-genre': p.genre }, [
      el('span', { class: 'rk-preset__top' }, [
        l,
        el('span', { class: 'rk-preset__name', text: p.name }),
        p.original ? el('span', { class: 'rk-tag', text: 'Original' }) : null,
      ]),
      el('span', { class: 'rk-preset__desc', text: p.description }),
    ]);
    presetButtons.push(btn);
    return btn;
  }
  const presetList = el(
    'div',
    { class: 'rk-presets', role: 'group', 'aria-label': 'Presets' },
    Object.values(PRESETS).filter((p) => p.id !== 'empty').map(presetKey),
  );
  const emptyBtn = PRESETS.empty ? presetKey(PRESETS.empty) : null;
  emptyBtn?.classList.add('rk-preset--empty');
  const lockNote = el('p', { class: 'rk-note-line', hidden: true, text: 'Presets, tempo and Import are locked while a take records.' });
  const presetModule = el('section', { class: 'rk-module rk-module--col rk-module--presets', 'aria-labelledby': 'rk-presets-h' }, [
    helpLabel('presets', { tag: 'h3', id: 'rk-presets-h', className: 'rk-module__head' }),
    el('div', { class: 'rk-browser__bar' }, [
      el('div', { class: 'rk-btnrow rk-genres', role: 'group', 'aria-labelledby': 'rk-genre-label' }, [
        helpLabel('presetGenre', { id: 'rk-genre-label', sub: false }),
        ...genreKeys,
      ]),
      el('p', { class: 'rk-hint rk-browser__legend' }, [el('span', { class: 'rk-tag', text: 'Original' }), el('span', { text: ' made for Rythmik' }), helpTip('presetOriginal')]),
    ]),
    presetList,
    el('div', { class: 'rk-btnrow' }, [emptyBtn]),
    lockNote,
  ]);

  function renderPresets() {
    for (const k of genreKeys) k.setAttribute('aria-pressed', String(k.dataset.genre === genre));
    for (const b of presetButtons) {
      if (b !== emptyBtn) b.hidden = b.dataset.genre !== genre;
      if (b.dataset.preset === currentPreset) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
    for (const [id, l] of presetLeds) l.classList.toggle('is-on', id === currentPreset);
  }
  genreKeys.forEach((k) =>
    k.addEventListener('click', () => {
      genre = k.dataset.genre;
      renderPresets();
    }),
  );
  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset || locked) return;
      const before = currentPreset;
      const msg = preset.id === 'empty' ? 'Cleared the pattern.' : `Loaded ${preset.name}.`;
      page = 0;
      engine.setEditSection?.('A');
      loadWithUndo(preset.pattern, msg, btn, {
        onUndo: () => {
          currentPreset = before;
          renderPresets();
        },
      });
      currentPreset = preset.id;
      renderPresets();
    });
  });

  // ---------- groove (advanced) ----------
  const swingLabel = helpLabel('swing', { id: 'rk-swing-label' });
  const swingKnob = createKnob({
    label: 'Swing',
    labelledBy: 'rk-swing-label',
    showReadout: true,
    value: 0,
    defaultValue: 0,
    onInput: (v) => engine.setSwing((v / 100) * SWING_MAX),
  });
  const masterLabel = helpLabel('master', { id: 'rk-master-label' });
  const masterKnob = createKnob({
    label: 'Master volume',
    labelledBy: 'rk-master-label',
    showReadout: true,
    value: 80,
    defaultValue: 80,
    onInput: (v) => engine.setMasterVolume(v / 100),
  });
  const grooveModule = el('section', { class: 'rk-module rk-module--col rk-module--groove rk-adv', 'aria-label': 'Groove and level' }, [
    silk('Groove', { 'aria-hidden': 'true' }),
    el('div', { class: 'rk-knobs' }, [
      el('div', { class: 'rk-knobcell' }, [swingLabel, swingKnob.el]),
      el('div', { class: 'rk-knobcell' }, [masterLabel, masterKnob.el]),
    ]),
  ]);

  // ---------- sections ----------
  const sectionKeys = ['A', 'B'].map((name) =>
    el('button', { type: 'button', class: 'rk-key rk-seckey', 'aria-pressed': 'false', 'data-section': name, 'aria-label': `Edit section ${name}` }, [
      led(),
      el('span', { text: name }),
    ]),
  );
  const addBBtn = el('button', { type: 'button', class: 'rk-key', text: 'Add B' });
  const addBCell = el('span', { class: 'rk-pair' }, [addBBtn, helpTip('addB')]);
  const removeBBtn = el('button', { type: 'button', class: 'rk-key', text: 'Remove B' });
  const removeBCell = el('span', { class: 'rk-pair rk-adv' }, [removeBBtn, helpTip('removeB')]);
  const lengthKeys = [16, 32].map((n) =>
    el('button', { type: 'button', class: 'rk-key rk-lenkey', 'aria-pressed': 'false', 'data-length': n, 'aria-label': `${n} steps` }, [
      led(),
      el('span', { text: String(n) }),
    ]),
  );
  const chainBtn = el('button', { type: 'button', class: 'rk-key rk-key--led', 'aria-pressed': 'false' }, [led(), el('span', { text: 'Play A then B' })]);
  const chainSimple = el('span', { class: 'rk-pair rk-beginner' }, [chainBtn, helpTip('chainSimple')]);
  const chainReadout = el('span', { class: 'rk-lcd rk-lcd--mini rk-chain__lcd' }, [
    el('span', { class: 'rk-lcd__unit', text: 'Loop' }),
    el('span', { class: 'rk-lcd__text rk-chain__text' }),
  ]);
  const chainSlots = el('div', { class: 'rk-chain__slots', role: 'group', 'aria-label': 'Chain slots' });
  const chainAdd = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'Add a chain slot', text: '+ Slot' });
  const chainDel = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'Remove the last chain slot', text: '- Slot' });
  const chainEditor = el('div', { class: 'rk-chain rk-adv' }, [
    helpLabel('chain', { id: 'rk-chain-label', sub: false }),
    chainSlots,
    el('span', { class: 'rk-btnrow' }, [chainAdd, chainDel]),
  ]);

  const sectionStrip = el('div', { class: 'rk-strip rk-strip--sections' }, [
    el('div', { class: 'rk-strip__group', role: 'group', 'aria-labelledby': 'rk-sections-label' }, [
      helpLabel('sections', { id: 'rk-sections-label', sub: false }),
      ...sectionKeys,
      addBCell,
      removeBCell,
    ]),
    el('div', { class: 'rk-strip__group', role: 'group', 'aria-labelledby': 'rk-length-label' }, [
      helpLabel('stepLength', { id: 'rk-length-label', sub: false }),
      ...lengthKeys,
    ]),
    el('div', { class: 'rk-strip__group' }, [chainSimple, chainReadout]),
    chainEditor,
  ]);

  // ---------- edit modes ----------
  const modeKeys = EDIT_MODES.map((m) => {
    const btn = el('button', { type: 'button', class: 'rk-key rk-modekey', 'aria-pressed': 'false', 'data-mode': m.id }, [
      led(),
      el('span', { text: m.name }),
    ]);
    btn.addEventListener('click', () => setMode(m.id));
    return { ...m, btn, cell: el('span', { class: `rk-pair${m.adv ? ' rk-adv' : ''}` }, [btn, helpTip(EDIT_HELP[m.id])]) };
  });
  const legend = el('p', { class: 'rk-hint rk-legend', id: 'rk-mode-legend' });

  // pitch editor for the selected pad
  const pitchDown = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'Pitch down', text: '-' });
  const pitchUp = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'Pitch up', text: '+' });
  const pitchReset = el('button', { type: 'button', class: 'rk-key', text: 'Reset' });
  const pitchValue = el('span', { class: 'rk-lcd__text', 'aria-live': 'polite' });
  const pitchWhat = el('span', { class: 'rk-pitch__what' });
  const pitchEditor = el('div', { class: 'rk-pitch', role: 'group', 'aria-labelledby': 'rk-pitch-label', hidden: true }, [
    helpLabel('pitchEdit', { id: 'rk-pitch-label', sub: false }),
    pitchWhat,
    el('span', { class: 'rk-btnrow' }, [pitchDown, el('span', { class: 'rk-lcd rk-lcd--mini' }, [pitchValue]), pitchUp, pitchReset]),
  ]);

  const modeStrip = el('div', { class: 'rk-strip rk-strip--modes' }, [
    el('div', { class: 'rk-strip__group', role: 'group', 'aria-labelledby': 'rk-mode-label' }, [
      helpLabel('editMode', { id: 'rk-mode-label', sub: false }),
      ...modeKeys.map((m) => m.cell),
    ]),
    legend,
    pitchEditor,
  ]);

  // ---------- grid ----------
  const barKeys = [0, 1].map((i) =>
    el('button', { type: 'button', class: 'rk-key rk-barkey', 'aria-pressed': 'false', 'data-bar': i }, [led(), el('span', { text: `Bar ${i + 1}` })]),
  );
  const barStrip = el('div', { class: 'rk-strip__group rk-bars', role: 'group', 'aria-labelledby': 'rk-bar-label', hidden: true }, [
    helpLabel('barPage', { id: 'rk-bar-label', sub: false }),
    ...barKeys,
  ]);

  const stepLeds = [];
  const rulerNums = [];
  const ruler = el('div', { class: 'rk-row rk-row--ruler', 'aria-hidden': 'true' }, [
    el('div', { class: 'rk-row__name' }, [silk('Step')]),
    el('div', { class: 'rk-row__edit' }, [silk('Edit')]),
    el('div', { class: 'rk-row__mix rk-adv' }, [silk('M'), silk('S'), silk('Vol')]),
    el(
      'div',
      { class: 'rk-cells' },
      Array.from({ length: BAR }, () => {
        const l = led('rk-led--step');
        const num = el('span', { class: 'rk-ruler__num' });
        stepLeds.push(l);
        rulerNums.push(num);
        return el('span', { class: 'rk-ruler__cell' }, [l, num]);
      }),
    ),
  ]);

  const grid = el('div', { class: 'rk-grid', role: 'group', 'aria-label': 'Pads', 'aria-describedby': 'rk-mode-legend' });
  let rows = [];
  let columns = [];
  let structureKey = '';
  let focusPos = { row: 0, step: 0 };

  const trackSelect = el('select', { id: 'rk-tool-track', class: 'rk-select' });
  const toolButtons = {
    humanize: el('button', { type: 'button', class: 'rk-key', text: 'Humanize' }),
    randomize: el('button', { type: 'button', class: 'rk-key', text: 'Randomize' }),
    fill: el('button', { type: 'button', class: 'rk-key', text: 'Auto fill' }),
    clear: el('button', { type: 'button', class: 'rk-key', text: 'Clear track' }),
  };
  const toolStrip = el('div', { class: 'rk-strip rk-strip--tools', role: 'group', 'aria-label': 'Groove tools' }, [
    silk('Tools', { 'aria-hidden': 'true', class: 'rk-silk rk-strip__silk' }),
    ...Object.entries(toolButtons).map(([k, b]) => el('span', { class: 'rk-pair' }, [b, helpTip(TOOL_HELP[k])])),
    el('span', { class: 'rk-field' }, [helpLabel('toolTrack', { forId: 'rk-tool-track', sub: false }), trackSelect]),
  ]);

  // track add / edit
  const addTrackBtn = el('button', { type: 'button', class: 'rk-key', 'aria-expanded': 'false', 'aria-controls': 'rk-addtrack' }, [
    el('span', { class: 'rk-plus', 'aria-hidden': 'true' }),
    el('span', { text: 'Add track' }),
  ]);
  const editTracksBtn = el('button', { type: 'button', class: 'rk-key rk-key--led', 'aria-pressed': 'false' }, [led(), el('span', { text: 'Edit tracks' })]);
  const trackCount = el('span', { class: 'rk-hint rk-trackcount' });
  const picker = el('div', { id: 'rk-addtrack', class: 'rk-picker', role: 'group', 'aria-label': 'Add a track', hidden: true });
  const trackStrip = el('div', { class: 'rk-strip rk-strip--tracks' }, [
    el('span', { class: 'rk-pair' }, [addTrackBtn, helpTip('addTrack')]),
    el('span', { class: 'rk-pair' }, [editTracksBtn, helpTip('editTracks')]),
    trackCount,
  ]);

  const hiddenNote = el('p', { class: 'rk-note-line rk-beginner', hidden: true });
  const seqHead = el('div', { class: 'rk-seq__head' }, [
    helpLabel('pads'),
    helpLabel('sounds'),
    el('span', { class: 'rk-seq__mixhelp rk-adv' }, [helpLabel('mute'), helpLabel('solo'), helpLabel('volume')]),
  ]);
  const editHelp = el('span', { class: 'rk-seq__edithelp', hidden: true }, [helpLabel('removeTrack'), el('span', { class: 'rk-adv' }, [helpLabel('moveTrack')])]);
  seqHead.append(editHelp);
  const seqScroll = el('div', { class: 'rk-seq__scroll' }, [el('div', { class: 'rk-seq__inner' }, [ruler, grid])]);
  const sequencer = el('section', { class: 'rk-seq', 'aria-label': 'Sequencer' }, [
    silk('Sequencer', { class: 'rk-silk rk-seq__title', 'aria-hidden': 'true' }),
    sectionStrip,
    modeStrip,
    seqHead,
    hiddenNote,
    el('div', { class: 'rk-strip' }, [barStrip]),
    seqScroll,
    trackStrip,
    picker,
    toolStrip,
  ]);

  const samplerSlot = el('section', { id: 'rk-sampler-slot', class: 'rk-sampler-slot', 'aria-label': 'Your own sounds', hidden: !sampler });

  // ---------- track feel (advanced) ----------
  const feelGrid = el('div', { class: 'rk-sends rk-feel' });
  const feelKnobs = new Map();
  const feelModule = el('section', { class: 'rk-module rk-module--col rk-module--wide rk-adv', 'aria-labelledby': 'rk-feel-h' }, [
    helpLabel('trackFeel', { tag: 'h3', id: 'rk-feel-h', className: 'rk-module__head' }),
    el('p', { class: 'rk-btnrow rk-hint' }, [helpLabel('trackSwing', { sub: false }), helpLabel('trackNudge', { sub: false })]),
    feelGrid,
  ]);

  // ---------- effects ----------
  // label must use id; the knob is named by it
  const fxKnob = (label, id, opts) => {
    const knob = createKnob({ labelledBy: id, showReadout: true, value: 0, defaultValue: 0, ...opts });
    return { label, knob, cell: el('div', { class: 'rk-knobcell' }, [label, knob.el]) };
  };
  const space = fxKnob(helpLabel('fxSpace', { id: 'rk-fx-space-label' }), 'rk-fx-space-label', { label: 'Space', onInput: (v) => engine.setFx('reverb', v / 100) });
  const echo = fxKnob(helpLabel('fxEcho', { id: 'rk-fx-echo-label' }), 'rk-fx-echo-label', { label: 'Echo', onInput: (v) => engine.setFx('echo', v / 100) });
  const filter = fxKnob(helpLabel('fxFilter', { id: 'rk-fx-filter-label' }), 'rk-fx-filter-label', {
    label: 'Filter',
    min: -100,
    max: 100,
    format: filterText,
    onInput: (v) => engine.setFx('filter', v / 100),
  });
  filter.knob.el.classList.add('rk-knob--bipolar');
  filter.cell.classList.add('rk-adv');
  const drive = fxKnob(helpLabel('fxDrive', { id: 'rk-fx-drive-label' }), 'rk-fx-drive-label', { label: 'Drive', onInput: (v) => engine.setFx('drive', v / 100) });
  drive.cell.classList.add('rk-adv');

  const echoTimeSelect = el(
    'select',
    { id: 'rk-fx-echotime', class: 'rk-select' },
    ECHO_TIMES.map((t) => el('option', { value: t.value, text: t.text })),
  );
  echoTimeSelect.addEventListener('change', () => engine.setFx('echoTime', echoTimeSelect.value));

  const sendGrid = el('div', { class: 'rk-sends' });
  const sendKnobs = new Map();
  const fxNote = el('p', { class: 'rk-hint', text: 'Space adds room, Echo repeats hits in time with the beat.' });
  const fxModule = el('section', { class: 'rk-module rk-module--col rk-module--fx', 'aria-labelledby': 'rk-fx-h' }, [
    helpLabel('effects', { tag: 'h3', id: 'rk-fx-h', className: 'rk-module__head' }),
    el('div', { class: 'rk-knobs rk-fx__knobs' }, [space.cell, echo.cell, filter.cell, drive.cell]),
    el('div', { class: 'rk-field rk-adv' }, [helpLabel('fxEchoTime', { forId: 'rk-fx-echotime' }), echoTimeSelect]),
    el('div', { class: 'rk-subpanel rk-adv' }, [helpLabel('fxSends'), sendGrid]),
    fxNote,
  ]);

  // Per-track knob cells (sends, feel) follow the track list.
  let perTrackKey = '';
  function buildPerTrack(p) {
    sendKnobs.clear();
    feelKnobs.clear();
    sendGrid.replaceChildren(
      ...p.tracks.map((id) => {
        const name = trackName(id);
        const mk = (kind, word) =>
          createKnob({
            label: `${name} ${word} send`,
            caption: word,
            size: 'sm',
            value: 0,
            defaultValue: 0,
            onInput: (v) => engine.setTrackSend(id, kind, v / 100),
          });
        const rev = mk('reverb', 'Space');
        const ech = mk('echo', 'Echo');
        sendKnobs.set(id, { reverb: rev, echo: ech });
        return el('div', { class: 'rk-send', role: 'group', 'aria-label': `${name} sends` }, [
          el('span', { class: 'rk-send__name', 'aria-hidden': 'true', text: name }),
          el('div', { class: 'rk-send__knobs' }, [rev.el, ech.el]),
        ]);
      }),
    );
    feelGrid.replaceChildren(
      ...p.tracks.map((id) => {
        const name = trackName(id);
        const swing = createKnob({
          label: `${name} swing`,
          caption: 'Swing',
          size: 'sm',
          min: -1,
          max: 100,
          value: -1,
          defaultValue: -1,
          format: trackSwingText,
          showReadout: true,
          onInput: (v) => has('setTrackSwing') && engine.setTrackSwing(id, v < 0 ? null : (v / 100) * SWING_MAX),
        });
        const nudge = createKnob({
          label: `${name} nudge`,
          caption: 'Nudge',
          size: 'sm',
          min: -50,
          max: 50,
          value: 0,
          defaultValue: 0,
          format: nudgeText,
          showReadout: true,
          onInput: (v) => has('setTrackNudge') && engine.setTrackNudge(id, v / 100),
        });
        nudge.el.classList.add('rk-knob--bipolar');
        feelKnobs.set(id, { swing, nudge });
        return el('div', { class: 'rk-send', role: 'group', 'aria-label': `${name} feel` }, [
          el('span', { class: 'rk-send__name', 'aria-hidden': 'true', text: name }),
          el('div', { class: 'rk-send__knobs' }, [swing.el, nudge.el]),
        ]);
      }),
    );
  }

  // ---------- export beat ----------
  const barsSelect = el(
    'select',
    { id: 'rk-beat-bars', class: 'rk-select' },
    EXPORT_BARS.map((n) => el('option', { value: n, text: `${n} ${n === 1 ? 'bar' : 'bars'}` })),
  );
  barsSelect.value = String(EXPORT_BARS.includes(DEFAULT_EXPORT_BARS) ? DEFAULT_EXPORT_BARS : EXPORT_BARS[0]);
  const wavLabel = el('span', { text: 'Export beat (WAV)' });
  const wavBtn = el('button', { type: 'button', class: 'rk-key' }, [wavLabel]);
  const wavMsg = el('p', { class: 'rk-msg', role: 'status' });
  const exportModule = el('section', { class: 'rk-module rk-module--col', 'aria-labelledby': 'rk-exportbeat-h' }, [
    helpLabel('exportBeat', { tag: 'h3', id: 'rk-exportbeat-h', className: 'rk-module__head' }),
    el('div', { class: 'rk-field' }, [helpLabel('beatBars', { forId: 'rk-beat-bars' }), barsSelect]),
    el('div', { class: 'rk-btnrow' }, [wavBtn]),
    wavMsg,
  ]);

  // ---------- files ----------
  const exportBtn = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'Export pattern as JSON file', text: 'Export' });
  const importBtn = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'Import pattern from JSON file', text: 'Import' });
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true, tabindex: -1, 'aria-hidden': 'true' });
  const projExportBtn = el('button', { type: 'button', class: 'rk-key', text: 'Export project' });
  const projImportBtn = el('button', { type: 'button', class: 'rk-key', text: 'Import project' });
  const projInput = el('input', { class: 'rk-project-input', type: 'file', accept: '.json,application/json', hidden: true, tabindex: -1, 'aria-hidden': 'true' });
  if (!sampler) {
    setUnavailable(projExportBtn, { hard: true });
    setUnavailable(projImportBtn, { hard: true });
  }
  const fileModule = el('section', { class: 'rk-module rk-module--col', 'aria-labelledby': 'rk-file-h' }, [
    helpLabel('patternFile', { tag: 'h3', id: 'rk-file-h', className: 'rk-module__head' }),
    el('div', { class: 'rk-btnrow' }, [exportBtn, importBtn, fileInput]),
    el('p', { class: 'rk-hint', text: 'Your beat also saves itself in this browser.' }),
    el('div', { class: 'rk-subpanel rk-adv' }, [
      helpLabel('projectFile', { id: 'rk-project-label' }),
      el('div', { class: 'rk-btnrow', role: 'group', 'aria-labelledby': 'rk-project-label' }, [projExportBtn, projImportBtn, projInput]),
    ]),
  ]);

  const view = el('div', { class: 'rk-beat' }, [
    el('div', { class: 'rk-band' }, [presetModule, grooveModule]),
    sequencer,
    samplerSlot,
    el('div', { class: 'rk-band' }, [feelModule]),
    el('div', { class: 'rk-band' }, [fxModule]),
    el('div', { class: 'rk-band' }, [exportModule, fileModule]),
  ]);

  // ---------- grid building ----------
  function buildGrid(p) {
    const sec = sectionOf(p);
    const start = page * BAR;
    rows = [];
    columns = Array.from({ length: BAR }, () => []);
    const nodes = [];
    p.tracks.forEach((id, r) => {
      const name = trackName(id);
      const missing = isMissing(id);
      const nameLed = led('rk-led--hit');
      const nameBtn = el(
        'button',
        { type: 'button', class: 'rk-name', 'aria-label': missing ? `${name}: this sample is not loaded` : `Play ${name}`, 'aria-disabled': missing ? 'true' : null },
        [nameLed, el('span', { class: 'rk-name__text', text: name })],
      );
      nameBtn.addEventListener('click', () => {
        toolTrack = id;
        renderTools(lastPattern);
        if (!missing) audition(id);
      });
      const nameCell = el('div', { class: 'rk-row__name' }, [nameBtn, missing ? helpTip('missingSample') : null]);

      const up = el('button', { type: 'button', class: 'rk-toggle rk-adv', 'aria-label': `Move ${name} up`, disabled: r === 0 }, [
        el('span', { class: 'rk-glyph rk-glyph--up', 'aria-hidden': 'true' }),
      ]);
      const down = el('button', { type: 'button', class: 'rk-toggle rk-adv', 'aria-label': `Move ${name} down`, disabled: r === p.tracks.length - 1 }, [
        el('span', { class: 'rk-glyph rk-glyph--down', 'aria-hidden': 'true' }),
      ]);
      const remove = el('button', { type: 'button', class: 'rk-toggle rk-remove', 'aria-label': `Remove ${name}`, disabled: p.tracks.length < 2 }, [
        el('span', { class: 'rk-glyph rk-glyph--x', 'aria-hidden': 'true' }),
      ]);
      up.addEventListener('click', () => moveTrack(id, r - 1, 'up'));
      down.addEventListener('click', () => moveTrack(id, r + 1, 'down'));
      remove.addEventListener('click', () => removeTrack(id, r));

      const mute = el('button', { type: 'button', class: 'rk-toggle', 'aria-pressed': 'false', 'aria-label': `Mute ${name}` }, [
        led(),
        el('span', { 'aria-hidden': 'true', text: 'M' }),
      ]);
      const solo = el('button', { type: 'button', class: 'rk-toggle', 'aria-pressed': 'false', 'aria-label': `Solo ${name}` }, [
        led(),
        el('span', { 'aria-hidden': 'true', text: 'S' }),
      ]);
      mute.addEventListener('click', () => {
        engine.setMute(id, mute.getAttribute('aria-pressed') !== 'true');
        requestRender();
      });
      solo.addEventListener('click', () => {
        engine.setSolo(id, solo.getAttribute('aria-pressed') !== 'true');
        requestRender();
      });
      const knob = createKnob({
        label: `${name} volume`,
        size: 'sm',
        value: 80,
        defaultValue: 80,
        onInput: (v) => engine.setTrackVolume(id, v / 100),
      });

      const pads = [];
      for (let i = 0; i < BAR; i++) {
        const step = start + i;
        const pad = el(
          'button',
          {
            type: 'button',
            class: 'rk-pad',
            tabindex: -1,
            'aria-pressed': 'false',
            'data-row': r,
            'data-step': step,
            'data-col': i,
            'data-group': Math.floor(i / 4) % 2 ? 'b' : 'a',
          },
          [el('span', { class: 'rk-pad__val', 'aria-hidden': 'true' })],
        );
        pad.addEventListener('click', () => padTap(id, r, step, pad));
        pads.push(pad);
        columns[i].push(pad);
      }

      const row = el('div', { class: 'rk-row rk-row--track', role: 'group', 'aria-label': name, 'data-track': id }, [
        nameCell,
        el('div', { class: 'rk-row__edit' }, [up, down, remove]),
        el('div', { class: 'rk-row__mix rk-adv' }, [mute, solo, knob.el]),
        el('div', { class: 'rk-cells' }, pads),
      ]);
      row.classList.toggle('is-missing', missing);
      nodes.push(row);
      const entry = { id, name, row, nameBtn, nameLed, mute, solo, knob, pads, notes: null, remove, up, down };

      if (isPitched(id)) {
        const notes = [];
        for (let i = 0; i < BAR; i++) {
          const step = start + i;
          const sel = el(
            'select',
            { class: 'rk-note', 'aria-label': `${name} note, step ${step + 1}`, 'data-step': step },
            BASS_NOTES.map((n) => el('option', { value: n.midi, text: n.name })),
          );
          sel.addEventListener('change', () => {
            const midi = Number(sel.value);
            engine.setStep(id, step, { p: midi });
            audition(id, { p: midi });
            requestRender();
          });
          notes.push(sel);
        }
        entry.notes = notes;
        rovingNotes(notes);
        nodes.push(
          el('div', { class: 'rk-row rk-row--notes rk-adv', role: 'group', 'aria-label': `${name} notes` }, [
            el('div', { class: 'rk-row__name' }, [helpLabel('bassNotes', { sub: false, term: id === 'bass' ? undefined : `${name} notes` })]),
            el('div', { class: 'rk-row__edit', 'aria-hidden': 'true' }),
            el('div', { class: 'rk-row__mix', 'aria-hidden': 'true' }),
            el('div', { class: 'rk-cells' }, notes),
          ]),
        );
      }
      rows.push(entry);
    });
    grid.replaceChildren(...nodes);
    rulerNums.forEach((n, i) => (n.textContent = String(start + i + 1)));
    const row = Math.min(focusPos.row, rows.length - 1);
    const col = Math.min(Math.max(focusPos.step - start, 0), BAR - 1);
    focusPos = { row: Math.max(row, 0), step: start + col };
    if (rows[focusPos.row]) rows[focusPos.row].pads[col].tabIndex = 0;
    resetPlayhead();
  }

  // A note row is one tab stop: Left/Right/Home/End move, Up/Down still pick the note.
  function rovingNotes(notes) {
    notes.forEach((n, i) => (n.tabIndex = i === 0 ? 0 : -1));
    const go = (i) => {
      notes.forEach((n, j) => (n.tabIndex = j === i ? 0 : -1));
      notes[i].focus();
    };
    notes.forEach((sel, i) => {
      sel.addEventListener('focus', () => notes.forEach((n, j) => (n.tabIndex = j === i ? 0 : -1)));
      sel.addEventListener('keydown', (e) => {
        let next;
        if (e.key === 'ArrowRight') next = (i + 1) % notes.length;
        else if (e.key === 'ArrowLeft') next = (i - 1 + notes.length) % notes.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = notes.length - 1;
        else return;
        e.preventDefault();
        go(next);
      });
    });
  }

  function structureOf(p) {
    const names = p.tracks.map((id) => `${id}:${trackName(id)}:${isMissing(id)}`).join('|');
    return `${names}#${editSection()}#${sectionOf(p).length}#${page}`;
  }

  // ---------- rendering ----------
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render(engine.getPattern());
    });
  }

  function render(p) {
    lastPattern = p;
    if (currentPreset && !isPreset(p, currentPreset)) {
      currentPreset = null;
      renderPresets();
    }
    const sec = sectionOf(p);
    if (page * BAR >= sec.length) page = 0;
    const key = structureOf(p);
    if (key !== structureKey) {
      const hadFocus = grid.contains(document.activeElement);
      structureKey = key;
      buildGrid(p);
      if (hadFocus) rows[focusPos.row]?.pads[focusPos.step - page * BAR]?.focus();
    }
    const tracksKey = p.tracks.map((id) => `${id}:${trackName(id)}`).join('|');
    if (tracksKey !== perTrackKey) {
      perTrackKey = tracksKey;
      buildPerTrack(p);
    }

    const mixer = p.mixer || {};
    const anySolo = p.tracks.some((id) => mixer[id]?.solo);
    let anyMixed = false;
    let anyFeel = false;
    for (const r of rows) {
      const steps = sec.steps?.[r.id] || [];
      r.pads.forEach((pad) => paintPad(pad, r, steps[Number(pad.dataset.step)]));
      const m = mixer[r.id] || {};
      r.mute.setAttribute('aria-pressed', m.mute ? 'true' : 'false');
      r.solo.setAttribute('aria-pressed', m.solo ? 'true' : 'false');
      if (typeof m.volume === 'number') r.knob.setValue(Math.round(m.volume * 100));
      const silent = !!m.mute || (anySolo && !m.solo);
      if (silent) anyMixed = true;
      if (m.swing != null || (m.nudge && Math.abs(m.nudge) > 0.001)) anyFeel = true;
      r.row.classList.toggle('is-silent', silent);
      if (r.notes) {
        r.notes.forEach((sel) => {
          const s = steps[Number(sel.dataset.step)];
          if (s && noteName.has(s.p)) sel.value = String(s.p);
          sel.classList.toggle('is-active', !!s);
        });
      }
    }
    if (typeof p.swing === 'number') swingKnob.setValue(Math.round((p.swing / SWING_MAX) * 100));
    if (typeof p.master === 'number') masterKnob.setValue(Math.round(p.master * 100));
    const fx = p.fx || {};
    const pct = (x) => Math.round((Number(x) || 0) * 100);
    space.knob.setValue(pct(fx.reverb));
    echo.knob.setValue(pct(fx.echo));
    filter.knob.setValue(pct(fx.filter));
    drive.knob.setValue(pct(fx.drive));
    if (ECHO_TIMES.some((t) => t.value === fx.echoTime)) echoTimeSelect.value = fx.echoTime;
    for (const [id, k] of sendKnobs) {
      k.reverb.setValue(pct(fx.sends?.[id]?.reverb));
      k.echo.setValue(pct(fx.sends?.[id]?.echo));
    }
    for (const [id, k] of feelKnobs) {
      const m = mixer[id] || {};
      k.swing.setValue(m.swing == null ? -1 : Math.round((m.swing / SWING_MAX) * 100));
      k.nudge.setValue(Math.round((m.nudge || 0) * 100));
    }
    // Beginners can't see these controls; say what is in effect instead of resetting it.
    const t = hiddenSettingsNote({
      mixed: anyMixed,
      lowMaster: typeof p.master === 'number' && p.master < LOW_MASTER,
      fx: changedHiddenFx(p.fx, fxBaselines),
      feel: anyFeel,
    });
    if (hiddenNote.textContent !== t) hiddenNote.textContent = t;
    hiddenNote.hidden = !t;

    renderSections(p);
    renderModes();
    renderTracks(p);
    renderTools(p);
    renderPitch(p);
  }

  function paintPad(pad, r, s) {
    const step = Number(pad.dataset.step);
    pad.setAttribute('aria-pressed', s ? 'true' : 'false');
    const val = pad.firstChild;
    let text = '';
    if (s) {
      pad.dataset.level = velocityName(s.v);
      pad.style.setProperty('--r', String(s.r));
      if (s.r > 1) pad.dataset.roll = String(s.r);
      else delete pad.dataset.roll;
      if (s.c < 1) pad.dataset.chance = '';
      else delete pad.dataset.chance;
      if (s.f) pad.dataset.flam = '';
      else delete pad.dataset.flam;
      if (mode === 'chance') text = `${Math.round(s.c * 100)}`;
      else if (mode === 'pitch' && (s.p || isPitched(r.id))) text = pitchText(r.id, s.p);
      pad.setAttribute('aria-label', `${r.name}, step ${step + 1}, ${stepDetails(r.id, s)}`);
    } else {
      delete pad.dataset.level;
      delete pad.dataset.roll;
      delete pad.dataset.chance;
      delete pad.dataset.flam;
      pad.setAttribute('aria-label', `${r.name}, step ${step + 1}`);
    }
    if (val.textContent !== text) val.textContent = text;
    pad.classList.toggle('is-selected', mode === 'pitch' && selected?.id === r.id && selected.step === step);
  }

  function renderSections(p) {
    const hasB = !!p.sections?.B;
    const cur = editSection();
    sectionKeys.forEach((k) => {
      k.setAttribute('aria-pressed', String(k.dataset.section === cur));
      if (k.dataset.section === 'B') k.hidden = !hasB;
    });
    addBCell.hidden = hasB;
    removeBCell.hidden = !hasB;
    const len = sectionOf(p).length;
    lengthKeys.forEach((k) => k.setAttribute('aria-pressed', String(Number(k.dataset.length) === len)));
    barStrip.hidden = len <= BAR;
    barKeys.forEach((k) => k.setAttribute('aria-pressed', String(Number(k.dataset.bar) === page)));
    const chain = p.chain || ['A'];
    chainSimple.hidden = !hasB;
    chainBtn.setAttribute('aria-pressed', String(chain.includes('B')));
    chainReadout.querySelector('.rk-chain__text').textContent = chainText(chain);
    chainReadout.hidden = !hasB && chain.length < 2;
    chainEditor.hidden = !hasB && chain.length < 2;
    const slotsKey = `${chain.join('')}:${hasB}`;
    if (chainSlots.dataset.key !== slotsKey) {
      const hadFocus = chainSlots.contains(document.activeElement) ? Number(document.activeElement.dataset.index) : -1;
      chainSlots.dataset.key = slotsKey;
      chainSlots.replaceChildren(
        ...chain.map((name, i) => {
          const b = el('button', {
            type: 'button',
            class: 'rk-toggle rk-slot',
            'data-name': name,
            'data-index': i,
            'aria-disabled': hasB ? null : 'true',
            'aria-label': `Slot ${i + 1}: section ${name}${hasB ? ', press to switch to ' + (name === 'A' ? 'B' : 'A') : '. Add B to switch slots'}`,
          }, [led(), el('span', { 'aria-hidden': 'true', text: name })]);
          b.addEventListener('click', () => cycleSlot(i));
          return b;
        }),
      );
      if (hadFocus >= 0) chainSlots.children[Math.min(hadFocus, chain.length - 1)]?.focus();
    }
    chainAdd.disabled = chain.length >= MAX_CHAIN;
    chainDel.disabled = chain.length <= 1;
  }

  function renderModes() {
    for (const m of modeKeys) m.btn.setAttribute('aria-pressed', String(m.id === mode));
    const t = MODE_LEGEND[mode] + (mode === 'toggle' ? '' : FIRST_TAP);
    if (legend.textContent !== t) legend.textContent = t;
    grid.dataset.mode = mode;
  }

  function renderTracks(p) {
    const n = p.tracks.length;
    trackCount.textContent = `${n} of ${MAX_TRACKS} tracks`;
    addTrackBtn.disabled = n >= MAX_TRACKS;
    if (addTrackBtn.disabled && !picker.hidden) closePicker(false);
    editTracksBtn.setAttribute('aria-pressed', String(editingTracks));
    grid.classList.toggle('is-editing', editingTracks);
    ruler.classList.toggle('is-editing', editingTracks);
    editHelp.hidden = !editingTracks;
    if (!picker.hidden) buildPicker(p);
  }

  function renderTools(p) {
    if (!p.tracks.includes(toolTrack)) toolTrack = p.tracks[0];
    const want = p.tracks.map((id) => `${id}:${trackName(id)}`).join('|');
    if (trackSelect.dataset.key !== want) {
      trackSelect.dataset.key = want;
      trackSelect.replaceChildren(...p.tracks.map((id) => el('option', { value: id, text: trackName(id) })));
    }
    trackSelect.value = toolTrack;
  }

  function renderPitch(p) {
    pitchEditor.hidden = mode !== 'pitch';
    if (mode !== 'pitch') return;
    const s = selected && p.tracks.includes(selected.id) ? sectionOf(p).steps?.[selected.id]?.[selected.step] : null;
    if (!s) selected = null;
    for (const b of [pitchDown, pitchUp, pitchReset]) b.disabled = !s;
    if (!s) {
      pitchWhat.textContent = 'Tap a pad to select it.';
      pitchValue.textContent = '--';
      return;
    }
    pitchWhat.textContent = `${trackName(selected.id)}, step ${selected.step + 1}`;
    pitchValue.textContent = pitchText(selected.id, s.p);
  }

  // ---------- actions ----------
  // trigger() resumes the context itself; call it synchronously inside the gesture.
  function audition(id, opts = {}) {
    flashTrack(id);
    try {
      engine.trigger(id, opts);
    } catch (err) {
      console.error('Rythmik: audition failed', err);
    }
    Promise.resolve().then(afterAudio);
  }

  function readStep(id, step) {
    if (has('getStep')) return engine.getStep(id, step);
    return sectionOf(engine.getPattern()).steps?.[id]?.[step] || null;
  }

  function padTap(id, r, step, pad) {
    toolTrack = id;
    setRoving(r, step);
    const s = readStep(id, step);
    let result = null;
    if (mode === 'toggle' || !s) {
      const on = engine.toggleStep(id, step);
      result = on ? readStep(id, step) : null;
    } else if (mode === 'velocity') {
      result = engine.setStep(id, step, { v: nextVelocity(s.v) });
    } else if (mode === 'roll') {
      result = engine.setStep(id, step, { r: nextRoll(s.r) });
    } else if (mode === 'chance') {
      result = engine.setStep(id, step, { c: nextChance(s.c) });
    } else if (mode === 'flam') {
      result = engine.setStep(id, step, { f: !s.f });
    } else {
      result = s;
    }
    if (mode === 'pitch') selected = result ? { id, step } : null;
    pad.setAttribute('aria-pressed', result ? 'true' : 'false');
    if (result && !engine.isPlaying && !isMissing(id)) audition(id, { p: result.p, v: result.v });
    requestRender();
  }

  function setMode(next) {
    mode = next;
    if (mode !== 'pitch') selected = null;
    render(engine.getPattern());
  }

  function shiftPitch(dir) {
    if (!selected) return;
    const s = readStep(selected.id, selected.step);
    if (!s) return;
    let p;
    if (isPitched(selected.id)) {
      const list = BASS_NOTES.map((n) => n.midi);
      const i = Math.max(0, list.indexOf(s.p));
      p = list[Math.max(0, Math.min(list.length - 1, i + dir))];
    } else {
      p = Math.max(-12, Math.min(12, (s.p || 0) + dir));
    }
    const out = engine.setStep(selected.id, selected.step, { p });
    if (out && !engine.isPlaying) audition(selected.id, { p: out.p, v: out.v });
    requestRender();
  }
  pitchDown.addEventListener('click', () => shiftPitch(-1));
  pitchUp.addEventListener('click', () => shiftPitch(1));
  pitchReset.addEventListener('click', () => {
    if (!selected) return;
    const p = isPitched(selected.id) ? BASS_NOTES[0].midi : 0;
    engine.setStep(selected.id, selected.step, { p });
    requestRender();
  });

  // sections
  sectionKeys.forEach((k) =>
    k.addEventListener('click', () => {
      engine.setEditSection(k.dataset.section);
      page = 0;
      selected = null;
      render(engine.getPattern());
    }),
  );
  addBBtn.addEventListener('click', () => {
    engine.setSectionB(true, { copyFrom: 'A' });
    engine.setEditSection('B');
    page = 0;
    status.show('Added section B as a copy of A. You are editing B.');
    render(engine.getPattern());
    sectionKeys[1].focus();
  });
  removeBBtn.addEventListener('click', () => {
    // Undo shows B again, so focus lands on its key
    editWithUndo(() => engine.setSectionB(false), 'Removed section B.', sectionKeys[1], {
      onUndo: () => render(engine.getPattern()),
    });
    render(engine.getPattern());
    sectionKeys[0].focus();
  });
  lengthKeys.forEach((k) =>
    k.addEventListener('click', () => {
      const len = Number(k.dataset.length);
      const name = editSection();
      const cur = sectionOf(engine.getPattern()).length;
      if (len === cur) return;
      if (len < cur) {
        page = 0;
        editWithUndo(() => engine.setSectionLength(name, len), `Section ${name} is 16 steps now.`, k);
      } else {
        engine.setSectionLength(name, len);
        status.show(`Section ${name} is 32 steps now: bar 2 starts as a copy of bar 1.`);
      }
      render(engine.getPattern());
    }),
  );
  barKeys.forEach((k) =>
    k.addEventListener('click', () => {
      page = Number(k.dataset.bar);
      focusPos = { row: focusPos.row, step: page * BAR + (focusPos.step % BAR) };
      render(engine.getPattern());
    }),
  );
  chainBtn.addEventListener('click', () => {
    const chain = engine.getPattern().chain || ['A'];
    if (chain.includes('B')) {
      editWithUndo(() => engine.setChain(['A']), 'The loop plays A only now.', chainBtn, {
        onUndo: () => render(engine.getPattern()),
      });
    } else {
      engine.setChain(['A', 'B']);
    }
    requestRender();
  });
  function cycleSlot(i) {
    const p = engine.getPattern();
    if (!p.sections?.B) return;
    const chain = [...p.chain];
    chain[i] = chain[i] === 'A' ? 'B' : 'A';
    engine.setChain(chain);
    render(engine.getPattern());
    chainSlots.children[i]?.focus();
  }
  chainAdd.addEventListener('click', () => {
    const chain = engine.getPattern().chain || ['A'];
    if (chain.length < MAX_CHAIN) engine.setChain([...chain, 'A']);
    requestRender();
  });
  chainDel.addEventListener('click', () => {
    const chain = engine.getPattern().chain || ['A'];
    if (chain.length > 1) engine.setChain(chain.slice(0, -1));
    requestRender();
  });

  // groove tools
  trackSelect.addEventListener('change', () => {
    toolTrack = trackSelect.value;
  });
  toolButtons.humanize.addEventListener('click', () => {
    loadWithUndo(humanize(engine.getPattern(), HUMANIZE_AMOUNT), 'Humanized the beat.', toolButtons.humanize);
  });
  toolButtons.randomize.addEventListener('click', () => {
    const id = trackSelect.value;
    const p = engine.getPattern();
    if (!p.tracks.includes(id)) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    loadWithUndo(randomizeTrack(p, id, { seed, section: editSection() }), `New random ${trackName(id)} in section ${editSection()}.`, toolButtons.randomize);
  });
  toolButtons.fill.addEventListener('click', () => {
    const p = engine.getPattern();
    // a B that was changed by hand is work worth a second press
    const handEdited = p.sections?.B && !sameSection(p.sections.A, p.sections.B) && JSON.stringify(p.sections.B) !== lastFillB;
    if (handEdited && !confirmPress(toolButtons.fill, 'Replace B?')) {
      status.show('Press Replace B? again to overwrite your section B with a fill.');
      return;
    }
    const filled = makeFill(p, { from: 'A' });
    lastFillB = JSON.stringify(normalizePattern(filled).sections.B);
    loadWithUndo(filled, 'Added a fill as section B. The loop plays A A A B.', toolButtons.fill);
  });
  toolButtons.clear.addEventListener('click', () => {
    const id = trackSelect.value;
    const p = engine.getPattern();
    if (!p.tracks.includes(id)) return;
    loadWithUndo(clearTrack(p, id, { section: editSection() }), `Cleared ${trackName(id)} in section ${editSection()}.`, toolButtons.clear);
  });

  // tracks
  function buildPicker(p) {
    const groups = VOICE_GROUPS.map((g) => {
      const voices = VOICES.filter((v) => v.group === g.id && !p.tracks.includes(v.id));
      return el('div', { class: 'rk-picker__group', role: 'group', 'aria-label': g.name }, [
        silk(g.name, { 'aria-hidden': 'true' }),
        voices.length
          ? el('div', { class: 'rk-picker__keys' }, voices.map((v) => pickKey(v.id, v.name)))
          : el('p', { class: 'rk-hint', text: 'All added.' }),
      ]);
    });
    const samples = (sampler?.samples || []).filter((s) => !p.tracks.includes(s.id));
    groups.push(
      el('div', { class: 'rk-picker__group', role: 'group', 'aria-label': 'Samples' }, [
        silk('Samples', { 'aria-hidden': 'true' }),
        samples.length
          ? el('div', { class: 'rk-picker__keys' }, samples.map((s) => pickKey(s.id, s.name)))
          : el('p', { class: 'rk-hint', text: sampler?.samples?.length ? 'All added.' : 'No samples yet. Make one in the Sampler below the pads.' }),
      ]),
    );
    const close = el('button', { type: 'button', class: 'rk-key', text: 'Close' });
    close.addEventListener('click', () => closePicker(true));
    const active = picker.contains(document.activeElement) ? document.activeElement : null;
    picker.replaceChildren(...groups, el('div', { class: 'rk-btnrow' }, [close]));
    if (active) (active.dataset.add && picker.querySelector(`[data-add="${active.dataset.add}"]`) || close).focus();
  }
  function pickKey(id, name) {
    const b = el('button', { type: 'button', class: 'rk-key rk-picker__key', 'data-add': id, text: name });
    b.addEventListener('click', () => addTrack(id));
    return b;
  }
  function openPicker() {
    buildPicker(engine.getPattern());
    picker.hidden = false;
    addTrackBtn.setAttribute('aria-expanded', 'true');
    picker.querySelector('button')?.focus();
  }
  function closePicker(refocus) {
    picker.hidden = true;
    addTrackBtn.setAttribute('aria-expanded', 'false');
    if (refocus) addTrackBtn.focus();
  }
  addTrackBtn.addEventListener('click', () => (picker.hidden ? openPicker() : closePicker(false)));
  picker.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePicker(true);
    }
  });
  function addTrack(id) {
    if (!engine.addTrack(id)) {
      status.show(`Could not add ${trackName(id)}: a beat has at most ${MAX_TRACKS} tracks.`, { error: true });
      return;
    }
    closePicker(false);
    status.show(`Added ${trackName(id)}.`);
    toolTrack = id;
    render(engine.getPattern());
    rows.find((r) => r.id === id)?.nameBtn.focus();
  }
  editTracksBtn.addEventListener('click', () => {
    editingTracks = !editingTracks;
    requestRender();
  });
  function removeTrack(id, index) {
    const name = trackName(id);
    editWithUndo(() => engine.removeTrack(id), `Removed ${name}.`, editTracksBtn);
    render(engine.getPattern());
    const next = rows[Math.min(index, rows.length - 1)];
    (next?.remove.disabled ? editTracksBtn : next?.remove || editTracksBtn).focus();
  }
  function moveTrack(id, to, dir) {
    if (to < 0 || to >= lastPattern.tracks.length) return;
    engine.moveTrack(id, to);
    render(engine.getPattern());
    const r = rows.find((x) => x.id === id);
    const key = dir === 'up' ? r?.up : r?.down;
    (key && !key.disabled ? key : r?.nameBtn)?.focus();
  }

  // files
  exportBtn.addEventListener('click', () => {
    try {
      downloadPattern(engine.getPattern());
      status.show(`Saved ${EXPORT_FILENAME}.`);
    } catch (err) {
      console.error(err);
      status.show('Could not export the pattern.', { error: true });
    }
  });
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || locked) return;
    try {
      const pattern = await readPatternFile(file);
      page = 0;
      loadWithUndo(pattern, `Imported ${file.name}.`, importBtn);
      currentPreset = null;
      renderPresets();
    } catch (err) {
      status.show(err?.message || 'Not a Rythmik pattern file.', { error: true });
    }
  });

  projExportBtn.addEventListener('click', async () => {
    if (!sampler || projExportBtn.getAttribute('aria-busy') === 'true') return;
    projExportBtn.setAttribute('aria-busy', 'true');
    try {
      const blob = await sampler.exportProject(engine.getPattern());
      downloadBlob(blob, PROJECT_FILENAME, 'application/json');
      status.show(`Saved ${PROJECT_FILENAME}.`);
    } catch (err) {
      console.error('Rythmik: project export', err);
      status.show('Could not export the project.', { error: true });
    }
    projExportBtn.removeAttribute('aria-busy');
  });
  projImportBtn.addEventListener('click', () => {
    if (locked || !sampler) return;
    const n = sampler.samples?.length || 0;
    if (n > 0 && !confirmPress(projImportBtn, `Replace your ${n} ${n === 1 ? 'sound' : 'sounds'} and the beat?`)) {
      status.show(`Press again to choose a project. Your ${n === 1 ? 'sound' : `${n} sounds`} cannot come back; Undo only brings back the beat.`);
      return;
    }
    projInput.click();
  });
  projInput.addEventListener('change', async () => {
    const file = projInput.files?.[0];
    projInput.value = '';
    if (!file || locked || !sampler) return;
    if (file.size > MAX_PROJECT_BYTES) {
      status.show('That file is too large to be a Rythmik project.', { error: true });
      return;
    }
    try {
      const pattern = await sampler.importProject(file);
      page = 0;
      // the old sounds are gone; Undo brings back only the beat
      loadWithUndo(pattern, `Imported ${file.name} with its samples.`, projImportBtn);
      currentPreset = matchPreset(engine.getPattern());
      renderPresets();
    } catch (err) {
      status.show(sampleError(err), { error: true });
    }
  });

  // export beat
  let rendering = false;
  function setWavMsg(t, error = false) {
    wavMsg.textContent = t;
    wavMsg.classList.toggle('is-error', error);
  }
  wavBtn.addEventListener('click', async () => {
    if (rendering) return;
    rendering = true;
    setUnavailable(wavBtn, { soft: true });
    barsSelect.disabled = true;
    wavBtn.setAttribute('aria-busy', 'true');
    wavLabel.textContent = 'Rendering…';
    setWavMsg('Rendering…');
    const pattern = engine.getPattern();
    try {
      const buffer = await renderBeat(pattern, { bars: Number(barsSelect.value) });
      const filename = `rythmik-beat-${Math.round(pattern.bpm)}bpm.wav`;
      downloadBlob(encodeWav(buffer, { bitDepth: 16 }), filename, 'audio/wav');
      setWavMsg(`Saved ${filename}.`);
    } catch (err) {
      console.error('Rythmik: beat export', err);
      setWavMsg('Export failed.', true);
    }
    rendering = false;
    setUnavailable(wavBtn);
    barsSelect.disabled = false;
    wavBtn.removeAttribute('aria-busy');
    wavLabel.textContent = 'Export beat (WAV)';
  });

  // ---------- keyboard: roving tabindex, the grid is one tab stop ----------
  function setRoving(row, step) {
    const prev = rows[focusPos.row]?.pads[focusPos.step - page * BAR];
    if (prev) prev.tabIndex = -1;
    focusPos = { row, step };
    const pad = rows[row]?.pads[step - page * BAR];
    if (pad) pad.tabIndex = 0;
  }

  grid.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains('rk-pad')) return;
    const len = sectionOf(lastPattern).length;
    let row = Number(t.dataset.row);
    let step = Number(t.dataset.step);
    switch (e.key) {
      case 'ArrowRight': step = (step + 1) % len; break;
      case 'ArrowLeft': step = (step - 1 + len) % len; break;
      case 'ArrowDown': row = (row + 1) % rows.length; break;
      case 'ArrowUp': row = (row - 1 + rows.length) % rows.length; break;
      case 'Home': step = page * BAR; if (e.ctrlKey) row = 0; break;
      case 'End': step = page * BAR + BAR - 1; if (e.ctrlKey) row = rows.length - 1; break;
      default: return;
    }
    e.preventDefault();
    const nextPage = Math.floor(step / BAR);
    if (nextPage !== page) {
      page = nextPage;
      focusPos = { row, step };
      render(engine.getPattern());
    }
    setRoving(row, step);
    rows[row].pads[step - page * BAR].focus();
  });
  grid.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.classList.contains('rk-pad')) setRoving(Number(t.dataset.row), Number(t.dataset.step));
  });

  // ---------- playhead ----------
  let rafId = 0;
  let shownCol = -1;

  // the grid was rebuilt or the transport stopped: nothing may stay lit
  function resetPlayhead() {
    shownCol = -1;
    shownKey = 'stale';
    stepLeds.forEach((l) => l.classList.remove('is-on'));
  }
  let shownKey = '';
  const hitTimers = new Map();

  function flashTrack(id) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    r.nameLed.classList.add('is-on');
    clearTimeout(hitTimers.get(id));
    hitTimers.set(id, setTimeout(() => r.nameLed.classList.remove('is-on'), 110));
  }

  function readPosition() {
    if (!engine.isPlaying) return null;
    if (has('getPlayPosition')) return engine.getPlayPosition();
    const step = engine.getCurrentStep();
    return step >= 0 ? { section: 'A', step, chainIndex: 0 } : null;
  }

  function showPosition(pos) {
    const key = pos ? `${pos.section}:${pos.step}:${pos.chainIndex}:${page}:${editSection()}` : '';
    if (key === shownKey) return;
    shownKey = key;
    if (!pos) stepLeds.forEach((l) => l.classList.remove('is-on'));
    const here = pos && pos.section === editSection();
    const col = here && Math.floor(pos.step / BAR) === page ? pos.step - page * BAR : -1;
    if (col !== shownCol) {
      if (shownCol >= 0) {
        columns[shownCol]?.forEach((b) => b.classList.remove('is-current'));
        stepLeds[shownCol].classList.remove('is-on');
      }
      if (col >= 0) {
        columns[col]?.forEach((b) => b.classList.add('is-current'));
        stepLeds[col].classList.add('is-on');
        const steps = sectionOf(lastPattern).steps || {};
        for (const r of rows) if (steps[r.id]?.[pos.step] && !r.row.classList.contains('is-silent')) flashTrack(r.id);
      }
      shownCol = col;
    }
    sectionKeys.forEach((k) => k.querySelector('.rk-led').classList.toggle('is-on', !!pos && pos.section === k.dataset.section));
    barKeys.forEach((k) => k.querySelector('.rk-led').classList.toggle('is-on', !!here && Math.floor(pos.step / BAR) === Number(k.dataset.bar)));
    [...chainSlots.children].forEach((b, i) => b.querySelector('.rk-led')?.classList.toggle('is-on', !!pos && pos.chainIndex === i));
  }

  let active = true;
  function tick() {
    showPosition(readPosition());
    rafId = engine.isPlaying && active ? requestAnimationFrame(tick) : 0;
    if (!rafId) showPosition(null);
  }
  function setPlaying(isPlaying) {
    if (isPlaying && active) {
      if (!rafId) rafId = requestAnimationFrame(tick);
    } else {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      showPosition(null);
    }
  }

  engine.onPatternChange((p) => {
    lastPattern = p;
    requestRender();
  });
  engine.onStateChange(({ isPlaying }) => setPlaying(isPlaying));
  sampler?.onChange?.(() => requestRender());

  render(engine.getPattern());
  renderPresets();
  setPlaying(engine.isPlaying);

  return {
    el: view,
    anchors: { pads: seqScroll, presets: presetModule, modes: modeStrip, samplerSlot },
    setLocked(on) {
      locked = on;
      for (const c of [importBtn, ...presetButtons]) c.disabled = on;
      if (sampler) projImportBtn.disabled = on;
      lockNote.hidden = !on;
    },
    // Re-sync after the transport starts/stops (state events may not fire for failed starts).
    setPlaying,
    /** The playhead only animates while the view is on screen. */
    setActive(on) {
      active = on;
      setPlaying(engine.isPlaying);
    },
    /** Advanced-only edit modes fall back to On/off when Advanced turns off. */
    setAdvanced(on) {
      advanced = on;
      if (!advanced && EDIT_MODES.find((m) => m.id === mode)?.adv) setMode('toggle');
    },
  };
}
