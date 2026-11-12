import { createBooth } from '../audio/booth.js';
import { encodeWav } from '../audio/wav.js';
import { VOICE_PRESETS, KEYS, SCALES } from '../audio/voice.js';
import { createKnob } from './knob.js';
import { helpLabel, helpTip } from './helptip.js';
import { formatBpm } from './format.js';
import { el, silk, led, isTyping, downloadBlob, setUnavailable, isUnavailable } from './dom.js';

const BAR_OPTIONS = [2, 4, 8, 16];
const OFFSET_MIN = -200;
const OFFSET_MAX = 200;
const METER_DECAY = 0.88; // per frame, so short peaks stay visible
const METER_SEGMENTS = 12;
const METER_FLOOR_DB = -48;
const MAX_TAKES = 12; // same limit as the booth engine
const TAKES_FULL = `You have ${MAX_TAKES} takes. Delete one to record another.`;

const MIC_MESSAGES = {
  'mic-denied':
    'Microphone access is blocked. Open the site settings (the icon left of the address bar), set Microphone to Allow, then press Enable mic again.',
  'mic-unavailable':
    'No microphone available. Plug one in or close other apps using it, then try again. The page must be served over HTTPS or localhost.',
  'mic-busy': 'Mic in use by another app or blocked by Windows privacy settings.',
};
const INPUT_KEY = 'rythmik:input';
const VOICE_KEY = 'rythmik:voice';
const VOICE_ORDER = ['clean', 'robot', 'tuned', 'radio', 'hall', 'lofi'];
const VOICE_HELP = { clean: 'voiceClean', robot: 'voiceRobot', tuned: 'voiceTuned', radio: 'voiceRadio', hall: 'voiceHall', lofi: 'voiceLofi' };
const PREPARE_DELAY = 250; // ms after the last voice change before tuning starts
const SILENT_MS = 3000;
const BACKING_ERRORS = {
  busy: 'Wait until the take is finished.',
  'no-remix': 'Load a song in REMIX first.',
  'no-bpm': 'The song needs a tempo first. Tap it or type it in REMIX.',
};

function loadInput() {
  try {
    return localStorage.getItem(INPUT_KEY);
  } catch {
    return null;
  }
}

function saveInput(id) {
  try {
    if (id) localStorage.setItem(INPUT_KEY, id);
    else localStorage.removeItem(INPUT_KEY);
  } catch {
    // storage blocked: the choice just isn't remembered
  }
}

function loadVoice() {
  try {
    const v = JSON.parse(localStorage.getItem(VOICE_KEY) || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function saveVoice(v) {
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(v));
  } catch {
    // storage blocked: settings last for this visit only
  }
}

/** Preset id whose settings all match `voice`, or null for a custom mix. */
export function matchVoicePreset(voice, presets = VOICE_PRESETS) {
  if (!voice) return null;
  for (const id of VOICE_ORDER) {
    const s = presets[id]?.settings;
    if (!s) continue;
    const same = Object.entries(s).every(([k, want]) =>
      typeof want === 'number' ? Math.abs((Number(voice[k]) || 0) - want) < 0.005 : voice[k] === want,
    );
    if (same) return id;
  }
  return null;
}

export function retuneText(v) {
  const word = v < 34 ? 'Robotic' : v < 67 ? 'Smooth' : 'Natural';
  return `${word} ${v}%`;
}

function formatMs(ms) {
  const v = Math.round(ms || 0);
  return `${v > 0 ? '+' : ''}${v} ms`;
}

function formatPeak(peak) {
  if (!(peak > 0)) return 'silent';
  const db = 20 * Math.log10(peak);
  return `${db >= -0.05 ? '0.0' : db.toFixed(1)} dB`;
}

function takeNumber(take) {
  const m = /(\d+)\s*$/.exec(take?.name || '');
  return m ? m[1] : String(take?.id ?? '');
}

/** Number of lit meter segments for a 0..1 peak level. */
export function meterSegments(level, segments = METER_SEGMENTS, floorDb = METER_FLOOR_DB) {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, level));
  const n = Math.ceil(((db - floorDb) / -floorDb) * segments);
  return Math.max(0, Math.min(segments, n));
}

function step(n, title, id, tip = null) {
  const stateLed = led('rk-step__led');
  const h = el('h3', { class: 'rk-step__h', id }, [
    el('span', { class: 'rk-step__num', 'aria-hidden': 'true', text: String(n) }),
    el('span', { class: 'rk-step__title' }, [el('span', { class: 'rk-visually-hidden', text: `Step ${n}: ` }), title]),
    stateLed,
  ]);
  // The "?" stays outside the heading so it is not part of the heading's name.
  const head = el('div', { class: 'rk-step__head' }, [h, tip]);
  return { head, led: stateLed };
}

/** What a take was recorded over, for the takes list. */
export function backingText(take) {
  const b = take?.backing;
  return b?.type === 'remix' ? `over ${b.name || 'the song'}` : 'over the beat';
}

/**
 * The BOOTH view. onLockChange(locked) fires when a take starts or ends.
 * isActive() tells whether the view is on screen (the R shortcut only works there).
 * remix (optional): the shared deck, so takes can be recorded over the song.
 */
export function mountBooth(engine, { remix = null, onLockChange = () => {}, isActive = () => true } = {}) {
  const booth = createBooth(engine, { remix });
  let locked = false;

  let bars = BAR_OPTIONS.includes(booth.bars) ? booth.bars : 4;
  let countIn = typeof booth.countIn === 'boolean' ? booth.countIn : true;
  let offsetMs = Number.isFinite(booth.latencyOffsetMs) ? booth.latencyOffsetMs : 0;
  let busy = false;
  let tuning = false;
  let prepareTimer = 0;
  let busyText = '';
  let cancelRequested = false;
  let meterLevel = 0;
  let litSegments = -1;
  let rafId = 0;
  let switching = false;
  let diagText = '';
  let progressText = '';
  let announced = '';

  // 1 mic
  const inputSelect = el('select', { id: 'rk-booth-input', class: 'rk-select rk-booth__input' }, [
    el('option', { value: '', text: 'System default' }),
  ]);
  const micLabel = el('span', { text: 'Enable mic' });
  const micLed = led();
  const micBtn = el('button', { type: 'button', class: 'rk-key rk-key--led' }, [micLed, micLabel]);
  const monitorBtn = el('button', { type: 'button', class: 'rk-key rk-key--led', 'aria-pressed': 'false' }, [
    led(),
    el('span', { text: 'Monitor' }),
  ]);
  const meterSegs = Array.from({ length: METER_SEGMENTS }, (_, i) =>
    el('span', { class: `rk-ladder__seg${i === METER_SEGMENTS - 1 ? ' rk-ladder__seg--clip' : ''}` }),
  );
  const meter = el('span', { class: 'rk-ladder is-off', 'aria-hidden': 'true' }, meterSegs);
  const inputName = el('p', { class: 'rk-booth__active' });
  const micEmpty = el('p', {
    class: 'rk-empty',
    text: 'Plug in or pick a mic, put on headphones, then press Enable mic.',
  });
  const micMsg = el('p', { class: 'rk-msg', role: 'status' });
  const diagMsg = el('p', { class: 'rk-msg', role: 'status' });
  const micStep = step(1, 'Mic', 'rk-step-mic');
  const micPanel = el('section', { class: 'rk-step', 'aria-labelledby': 'rk-step-mic' }, [
    micStep.head,
    micEmpty,
    el('div', { class: 'rk-field' }, [helpLabel('input', { forId: 'rk-booth-input' }), inputSelect]),
    el('div', { class: 'rk-btnrow' }, [
      el('span', { class: 'rk-pair' }, [micBtn, helpTip('mic')]),
      el('span', { class: 'rk-pair' }, [monitorBtn, helpTip('monitoring')]),
    ]),
    el('div', { class: 'rk-field' }, [helpLabel('level'), meter]),
    inputName,
    micMsg,
    diagMsg,
  ]);

  // 2 record
  const barsSelect = el(
    'select',
    { id: 'rk-booth-bars', class: 'rk-select' },
    BAR_OPTIONS.map((n) => el('option', { value: n, text: `${n} bars` })),
  );
  barsSelect.value = String(bars);
  const countInBtn = el('button', { type: 'button', class: 'rk-key rk-key--led', 'aria-pressed': String(countIn) }, [
    led(),
    el('span', { text: 'Count-in' }),
  ]);
  const recordLabel = el('span', { text: 'Record' });
  const recordLed = led();
  const recordBtn = el(
    'button',
    { type: 'button', class: 'rk-key rk-key--led rk-key--big rk-record', 'aria-keyshortcuts': 'R', disabled: true },
    [recordLed, recordLabel],
  );
  const progress = el('p', { class: 'rk-booth__progress', 'aria-hidden': 'true' });
  // The visible counter changes every beat; this one speaks once per bar.
  const progressAnnounce = el('p', { class: 'rk-visually-hidden', role: 'status' });
  const recordEmpty = el('p', { class: 'rk-empty', text: 'Enable the mic in step 1 first.' });

  const offsetRange = el('input', {
    id: 'rk-booth-offset',
    type: 'range',
    class: 'rk-fader rk-booth__fader',
    min: OFFSET_MIN,
    max: OFFSET_MAX,
    step: 1,
  });
  offsetRange.value = String(offsetMs);
  const offsetOut = el('output', { class: 'rk-value', for: 'rk-booth-offset' });
  const autoOut = el('span', { class: 'rk-value' });
  const totalOut = el('span', { class: 'rk-value' });
  const latencyBlock = el('div', { class: 'rk-subpanel rk-adv' }, [
    el('div', { class: 'rk-field' }, [helpLabel('latency')]),
    el('p', { class: 'rk-field' }, [el('span', { class: 'rk-field__name', text: 'Estimate' }), autoOut]),
    el('div', { class: 'rk-field' }, [
      helpLabel('latencyOffset', { forId: 'rk-booth-offset', sub: false }),
      offsetRange,
      offsetOut,
    ]),
    el('p', { class: 'rk-field' }, [el('span', { class: 'rk-field__name', text: 'Total' }), totalOut]),
    el('p', { class: 'rk-hint', text: 'Voice late on playback? Move Offset right. Early? Move it left.' }),
  ]);

  const overBeat = el('input', { type: 'radio', id: 'rk-over-beat', name: 'rk-booth-backing', value: 'beat', class: 'rk-radio', checked: true });
  const overRemix = el('input', {
    type: 'radio',
    id: 'rk-over-remix',
    name: 'rk-booth-backing',
    value: 'remix',
    class: 'rk-radio',
    'aria-describedby': 'rk-over-why',
  });
  const backingWhy = el('p', { class: 'rk-hint', id: 'rk-over-why' });
  const backingChoice = remix
    ? el('fieldset', { class: 'rk-choice', 'aria-labelledby': 'rk-over-label' }, [
      helpLabel('recordOver', { id: 'rk-over-label' }),
      el('span', { class: 'rk-choice__opts' }, [
        el('label', { class: 'rk-choice__opt', for: 'rk-over-beat' }, [overBeat, el('span', { text: 'Beat' })]),
        el('label', { class: 'rk-choice__opt', for: 'rk-over-remix' }, [overRemix, el('span', { text: 'Remix' })]),
      ]),
      backingWhy,
    ])
    : null;

  const recStep = step(2, 'Record', 'rk-step-rec');
  const offsetNote = el('p', { class: 'rk-note-line rk-beginner', hidden: true });
  const recPanel = el('section', { class: 'rk-step', 'aria-labelledby': 'rk-step-rec' }, [
    recStep.head,
    recordEmpty,
    backingChoice,
    el('div', { class: 'rk-field' }, [helpLabel('takeBars', { forId: 'rk-booth-bars' }), barsSelect]),
    el('div', { class: 'rk-btnrow' }, [countInBtn, helpTip('countIn')]),
    el('div', { class: 'rk-btnrow' }, [recordBtn, helpTip('record'), progress]),
    progressAnnounce,
    offsetNote,
    latencyBlock,
  ]);

  // 3 takes
  const takeList = el('ul', { class: 'rk-takes', 'aria-label': 'Takes; the picked take is used in the mix' });
  const noTakes = el('p', { class: 'rk-empty', text: 'Your takes will show up here.' });
  const stopBtn = el('button', { type: 'button', class: 'rk-key', disabled: true, 'aria-label': 'Stop take playback', text: 'Stop' });
  const takesStep = step(3, 'Takes', 'rk-step-takes', helpTip('takes'));
  const takeLegend = el('p', { class: 'rk-btnrow rk-takes__legend' }, [
    helpLabel('takePlay', { sub: false }),
    helpLabel('takeDelete', { sub: false }),
    el('span', { class: 'rk-hint', text: 'The take marked In mix is the one you export.' }),
  ]);
  const takesPanel = el('section', { class: 'rk-step rk-step--wide', 'aria-labelledby': 'rk-step-takes' }, [
    takesStep.head,
    noTakes,
    takeLegend,
    takeList,
    el('div', { class: 'rk-btnrow' }, [stopBtn, helpTip('previewStop')]),
  ]);

  // 4 voice
  const voiceButtons = new Map();
  const voicePresetCells = VOICE_ORDER.filter((id) => VOICE_PRESETS[id]).map((id) => {
    const p = VOICE_PRESETS[id];
    const btn = el('button', { type: 'button', class: 'rk-key rk-preset rk-voice__preset', 'aria-pressed': 'false', 'data-voice': id }, [
      el('span', { class: 'rk-voice__top' }, [led(), el('span', { class: 'rk-preset__name', text: p.name })]),
      el('span', { class: 'rk-preset__desc', text: p.description }),
    ]);
    btn.addEventListener('click', () => {
      booth.setVoicePreset(id);
      voiceChanged();
    });
    voiceButtons.set(id, btn);
    return el('span', { class: 'rk-pair rk-voice__cell' }, [btn, helpTip(VOICE_HELP[id])]);
  });

  const keySelect = el('select', { id: 'rk-voice-key', class: 'rk-select' }, KEYS.map((k) => el('option', { value: k, text: k })));
  const scaleSelect = el(
    'select',
    { id: 'rk-voice-scale', class: 'rk-select' },
    SCALES.map((s) => el('option', { value: s, text: s.charAt(0).toUpperCase() + s.slice(1) })),
  );
  keySelect.addEventListener('change', () => setVoice({ key: keySelect.value }));
  scaleSelect.addEventListener('change', () => setVoice({ scale: scaleSelect.value }));

  const voiceKnob = (label, id, setting, opts = {}) => {
    const knob = createKnob({
      label: setting,
      labelledBy: id,
      showReadout: true,
      value: 0,
      defaultValue: 0,
      onInput: (v) => setVoice({ [setting]: v / 100 }),
      ...opts,
    });
    return { knob, cell: el('div', { class: 'rk-knobcell' }, [label, knob.el]) };
  };
  const tuneK = voiceKnob(helpLabel('voiceTune', { id: 'rk-voice-tune-label' }), 'rk-voice-tune-label', 'tune');
  const retuneK = voiceKnob(helpLabel('voiceRetune', { id: 'rk-voice-retune-label' }), 'rk-voice-retune-label', 'retune', { format: retuneText });
  const vReverbK = voiceKnob(helpLabel('voiceReverb', { id: 'rk-voice-reverb-label' }), 'rk-voice-reverb-label', 'reverb');
  const vEchoK = voiceKnob(helpLabel('voiceEcho', { id: 'rk-voice-echo-label' }), 'rk-voice-echo-label', 'echo');

  const voiceBusyLine = el('p', { class: 'rk-busy', role: 'status' });
  const voiceStep = step(4, 'Voice', 'rk-step-voice', helpTip('voice'));
  const voicePanel = el('section', { class: 'rk-step rk-step--wide', 'aria-labelledby': 'rk-step-voice' }, [
    voiceStep.head,
    el('div', { class: 'rk-voice__presets', role: 'group', 'aria-label': 'Voice presets' }, voicePresetCells),
    voiceBusyLine,
    el('div', { class: 'rk-subpanel rk-adv' }, [
      el('div', { class: 'rk-btnrow rk-voice__keyrow' }, [
        el('div', { class: 'rk-field' }, [helpLabel('voiceKey', { forId: 'rk-voice-key' }), keySelect]),
        el('div', { class: 'rk-field' }, [helpLabel('voiceScale', { forId: 'rk-voice-scale' }), scaleSelect]),
      ]),
      el('div', { class: 'rk-knobs' }, [tuneK.cell, retuneK.cell, vReverbK.cell, vEchoK.cell]),
    ]),
  ]);

  // 5 export
  const mixBtn = el('button', { type: 'button', class: 'rk-key', text: 'Export mix (WAV)' });
  const vocalBtn = el('button', { type: 'button', class: 'rk-key', text: 'Export vocal (WAV)' });
  const vocalWetRadio = el('input', { type: 'radio', id: 'rk-vocal-wet', name: 'rk-vocal-fx', value: 'wet', class: 'rk-radio', checked: true });
  const vocalDryRadio = el('input', { type: 'radio', id: 'rk-vocal-dry', name: 'rk-vocal-fx', value: 'dry', class: 'rk-radio' });
  const vocalChoice = el('fieldset', { class: 'rk-choice', 'aria-labelledby': 'rk-vocal-fx-label' }, [
    helpLabel('vocalFx', { id: 'rk-vocal-fx-label' }),
    el('span', { class: 'rk-choice__opts' }, [
      el('label', { class: 'rk-choice__opt', for: 'rk-vocal-wet' }, [vocalWetRadio, el('span', { text: 'With voice effects' })]),
      el('label', { class: 'rk-choice__opt', for: 'rk-vocal-dry' }, [vocalDryRadio, el('span', { text: 'Dry' })]),
    ]),
  ]);
  const exportEmpty = el('p', { class: 'rk-empty', text: 'Record a take, pick it in step 3, then export it here.' });
  const exportMsg = el('p', { class: 'rk-msg', role: 'status' });
  const exportStep = step(5, 'Export', 'rk-step-export');
  const exportPanel = el('section', { class: 'rk-step', 'aria-labelledby': 'rk-step-export' }, [
    exportStep.head,
    exportEmpty,
    el('div', { class: 'rk-btnrow' }, [mixBtn, helpTip('exportMix')]),
    vocalChoice,
    el('div', { class: 'rk-btnrow' }, [vocalBtn, helpTip('exportVocal')]),
    exportMsg,
  ]);

  const view = el('div', { class: 'rk-booth' }, [
    el('p', { class: 'rk-hint rk-booth__intro' }, [
      silk('Tip', { 'aria-hidden': 'true' }),
      el('span', { text: ' Wear headphones so the beat does not leak into the mic.' }),
    ]),
    el('div', { class: 'rk-steps' }, [micPanel, recPanel, takesPanel, voicePanel, exportPanel]),
  ]);

  // Take rows are keyed by id so focus survives re-renders.
  const takeRows = new Map();

  function makeTakeRow(take) {
    const radioId = `rk-take-${take.id}`;
    const radio = el('input', { type: 'radio', id: radioId, name: 'rk-booth-take', value: take.id, class: 'rk-radio' });
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      booth.selectTake(take.id);
      prepareSelected();
    });
    const name = el('span', { class: 'rk-take__name', text: take.name });
    const info = el('span', { class: 'rk-take__info' });
    const tag = el('span', { class: 'rk-take__tag', text: 'In mix' });
    const label = el('label', { class: 'rk-take__label', for: radioId }, [radio, name, info, tag]);
    const withWhat = take.backing?.type === 'remix' ? 'song' : 'beat';
    const playBtn = el('button', { type: 'button', class: 'rk-key rk-key--led', 'aria-label': `Play ${take.name} with ${withWhat}` }, [
      led(),
      el('span', { text: 'Play' }),
    ]);
    playBtn.addEventListener('click', () => {
      if (!isUnavailable(playBtn)) startPreview(take);
    });
    const delBtn = el('button', { type: 'button', class: 'rk-key', 'aria-label': `Delete ${take.name}`, text: 'Delete' });
    delBtn.addEventListener('click', () => deleteTake(take.id));
    const li = el('li', { class: 'rk-take' }, [label, el('div', { class: 'rk-btnrow' }, [playBtn, delBtn])]);
    return { li, radio, info, playBtn, delBtn };
  }

  function renderTakes(takes) {
    const ids = new Set(takes.map((t) => t.id));
    for (const [id, row] of takeRows) {
      if (!ids.has(id)) {
        row.li.remove();
        takeRows.delete(id);
      }
    }
    const recording = booth.state !== 'idle';
    takes.forEach((take, i) => {
      let row = takeRows.get(take.id);
      if (!row) {
        row = makeTakeRow(take);
        takeRows.set(take.id, row);
      }
      // Move only misplaced rows; moving a node blurs it.
      const at = takeList.children[i] || null;
      if (at !== row.li) takeList.insertBefore(row.li, at);
      row.info.textContent = `${take.bars} bars at ${formatBpm(take.bpm)} BPM ${backingText(take)}, ${(take.duration || 0).toFixed(1)} s, peak ${formatPeak(take.peak)}`;
      const selected = take.id === booth.selectedTakeId;
      row.radio.checked = selected;
      row.li.classList.toggle('is-selected', selected);
      row.playBtn.firstElementChild.classList.toggle('is-on', booth.previewTakeId === take.id);
      setUnavailable(row.playBtn, { hard: recording, soft: busy || tuning });
      row.delBtn.disabled = recording || busy;
    });
    noTakes.hidden = takes.length > 0;
    takeList.hidden = takes.length === 0;
    takeLegend.hidden = takes.length === 0;
  }

  // Disabling a focused control drops focus to the page; keep it nearby.
  function rescueFocus(prev) {
    if (!(prev instanceof HTMLElement) || !prev.disabled) return;
    const row = [...takeRows.values()].find((r) => r.li.contains(prev));
    const candidates = [row?.radio, recordBtn, ...[...takeRows.values()].map((r) => r.radio), micBtn];
    candidates.find((c) => c && !c.disabled && c.isConnected)?.focus();
  }

  function render() {
    const prevFocus = document.activeElement;
    renderControls();
    const nextLocked = booth.state !== 'idle';
    if (nextLocked !== locked) {
      locked = nextLocked;
      onLockChange(locked);
    }
    rescueFocus(prevFocus);
  }

  function renderControls() {
    tuning = !!booth.voiceBusy;
    const state = booth.state;
    const idle = state === 'idle';
    const micOpen = !!booth.micOpen;
    const takes = booth.takes || [];

    micLabel.textContent = micOpen ? 'Turn mic off' : 'Enable mic';
    micLed.classList.toggle('is-on', micOpen);
    micBtn.disabled = !idle;
    inputSelect.disabled = !idle || switching;
    selectCurrentInput();
    inputName.textContent = micOpen && booth.inputLabel ? `Active mic: ${booth.inputLabel}` : '';
    if (!micOpen) setDiag('');
    monitorBtn.setAttribute('aria-pressed', String(!!booth.monitoring));
    monitorBtn.disabled = !micOpen; // closeMic resets monitoring
    meter.classList.toggle('is-off', !micOpen);
    micEmpty.hidden = micOpen;
    micStep.led.classList.toggle('is-on', micOpen);

    barsSelect.disabled = !idle;
    countInBtn.disabled = !idle;
    renderBacking(idle);
    countInBtn.setAttribute('aria-pressed', String(countIn));

    recordBtn.disabled = !micOpen && idle;
    recordLabel.textContent = idle ? `Record ${bars} bars` : 'Cancel recording';
    recordLed.classList.toggle('is-on', !idle);
    recordEmpty.hidden = micOpen || !idle;
    recStep.led.classList.toggle('is-on', !idle);
    recStep.led.classList.toggle('is-blink', state === 'count-in');
    if (idle) {
      setProgress('');
      announce('');
    }

    autoOut.textContent = `${Math.round(booth.autoLatencyMs || 0)} ms`;
    totalOut.textContent = `${Math.round(booth.latencyMs || 0)} ms`;
    offsetOut.textContent = formatMs(offsetMs);
    offsetRange.setAttribute('aria-valuetext', formatMs(offsetMs));
    offsetRange.disabled = !idle;
    const note = offsetMs !== 0
      ? `Some Advanced settings are active: the latency offset is ${formatMs(offsetMs)}. Turn on Advanced to change it.`
      : '';
    if (offsetNote.textContent !== note) offsetNote.textContent = note;
    offsetNote.hidden = !note;

    renderTakes(takes);
    stopBtn.disabled = booth.previewTakeId == null;
    takesStep.led.classList.toggle('is-on', booth.previewTakeId != null);

    const hasTake = takes.some((t) => t.id === booth.selectedTakeId);
    for (const b of [mixBtn, vocalBtn]) setUnavailable(b, { hard: !idle || !hasTake, soft: busy || tuning });
    vocalWetRadio.disabled = vocalDryRadio.disabled = busy;
    exportEmpty.hidden = hasTake;

    renderVoice();

    updateLoop();
  }

  function renderBacking(idle) {
    if (!remix) return;
    const over = booth.backing === 'remix' ? 'remix' : 'beat';
    const ready = !!remix.loaded && remix.sourceBpm != null;
    overBeat.checked = over === 'beat';
    overRemix.checked = over === 'remix';
    overBeat.disabled = !idle;
    overRemix.disabled = !idle || (!ready && over !== 'remix');
    let why = '';
    if (!remix.loaded) why = 'To rap over your own song, load it in REMIX first.';
    else if (remix.sourceBpm == null) why = remix.bpmBusy ? 'Finding the song tempo…' : 'The song needs a tempo first. Tap it or type it in REMIX.';
    else if (over === 'remix') {
      const name = remix.info?.name || 'the song';
      why = `Takes start at the loop start of ${name}, at ${formatBpm(remix.effectiveBpm)} BPM.`;
    }
    if (backingWhy.textContent !== why) backingWhy.textContent = why;
    backingWhy.hidden = !why;
  }

  function changeBacking(kind) {
    try {
      booth.setBacking(kind);
    } catch (err) {
      setMicMsg(BACKING_ERRORS[err?.message] || 'Could not switch what you record over.', true);
    }
    render();
  }

  function renderVoice() {
    const v = booth.voice || {};
    const current = VOICE_PRESETS[v.preset] ? v.preset : matchVoicePreset(v);
    for (const [id, btn] of voiceButtons) btn.setAttribute('aria-pressed', String(id === current));
    if (KEYS.includes(v.key)) keySelect.value = v.key;
    if (SCALES.includes(v.scale)) scaleSelect.value = v.scale;
    const pct = (x) => Math.round((Number(x) || 0) * 100);
    tuneK.knob.setValue(pct(v.tune));
    retuneK.knob.setValue(pct(v.retune));
    vReverbK.knob.setValue(pct(v.reverb));
    vEchoK.knob.setValue(pct(v.echo));
    const t = tuning ? 'Tuning your take…' : '';
    if (t !== busyText) {
      busyText = t;
      voiceBusyLine.replaceChildren(...(t ? [led('is-on is-blink'), el('span', { text: t })] : []));
    }
    voiceStep.led.classList.toggle('is-on', tuning);
    voiceStep.led.classList.toggle('is-blink', tuning);
  }

  function setVoice(partial) {
    booth.setVoiceSettings(partial);
    voiceChanged();
  }

  // Save, then tune the picked take in the background so playback and export are ready.
  function voiceChanged() {
    saveVoice(booth.voice);
    render();
    clearTimeout(prepareTimer);
    prepareTimer = setTimeout(prepareSelected, PREPARE_DELAY);
  }

  async function prepareSelected() {
    prepareTimer = 0;
    const id = booth.selectedTakeId;
    if (id == null || !(booth.takes || []).some((t) => t.id === id)) return;
    await prepare(id);
  }

  async function prepare(id) {
    const pending = booth.prepareVoice(id);
    render();
    try {
      await pending;
    } catch (err) {
      console.error('Rythmik: voice', err);
    }
    render();
  }

  function setProgress(t) {
    if (t === progressText) return;
    progressText = t;
    progress.textContent = t;
  }

  function announce(t) {
    if (t === announced) return;
    announced = t;
    progressAnnounce.textContent = t;
  }

  function setMsg(node, t, error = false) {
    node.textContent = t;
    node.classList.toggle('is-error', error);
  }
  const setMicMsg = (t, error) => setMsg(micMsg, t, error);
  const setExportMsg = (t, error) => setMsg(exportMsg, t, error);

  // Labels stay generic until mic permission is granted.
  async function refreshInputs() {
    let list = [];
    try {
      list = (await booth.listInputs()) || [];
    } catch (err) {
      console.error('Rythmik: list inputs', err);
    }
    const opts = list.map((d) => el('option', { value: d.deviceId, text: d.label || 'Microphone' }));
    if (!list.some((d) => d.isDefault)) opts.unshift(el('option', { value: '', text: 'System default' }));
    inputSelect.replaceChildren(...opts);
    selectCurrentInput();
  }

  function selectCurrentInput() {
    const id = booth.inputDeviceId;
    const options = [...inputSelect.options];
    const match = id ? options.find((o) => o.value === id) : null;
    const fallback = options.find((o) => o.value === '' || o.value === 'default') || options[0];
    const want = (match || fallback)?.value;
    if (want !== undefined && inputSelect.value !== want) inputSelect.value = want;
  }

  async function changeInput() {
    const id = inputSelect.value || null;
    saveInput(id === 'default' ? null : id);
    switching = true;
    render();
    try {
      await booth.setInputDevice(id);
      if (booth.micOpen) setMicMsg(`Using ${booth.inputLabel || 'selected input'}.`);
    } catch (err) {
      setMicMsg(MIC_MESSAGES[err?.message] || 'Could not switch the input.', true);
      console.error('Rythmik: input', err);
    }
    switching = false;
    render();
    if (booth.micOpen) refreshInputs();
  }

  function setDiag(t) {
    // Only touch the live region when the message changes.
    if (t === diagText) return;
    diagText = t;
    setMsg(diagMsg, t, !!t);
  }

  function checkMic() {
    const st = booth.getMicStatus?.();
    if (!st?.open) return setDiag('');
    const name = st.label || booth.inputLabel || 'the mic';
    if (st.muted) setDiag(`${name} is muted by the system.`);
    else if (st.silentForMs > SILENT_MS)
      setDiag(
        `No sound from ${name}. Check Windows Settings > Privacy & security > Microphone, the browser's site permission, or pick another input.`,
      );
    else setDiag('');
  }

  function onDevices(ev) {
    if (ev?.reason === 'device-lost') {
      setMicMsg('Mic disconnected.', true);
      render();
      refreshInputs();
    } else if (ev?.reason === 'fallback') {
      setMicMsg('Saved mic not found, using default.', true);
      render();
    } else {
      refreshInputs();
    }
  }

  async function toggleMic() {
    if (booth.micOpen) {
      booth.closeMic();
      setMicMsg('Mic off.');
      render();
      return;
    }
    setMicMsg('Waiting for microphone permission…');
    try {
      await booth.openMic();
      if (!booth.lastFallback) setMicMsg('Mic on. Go to step 2 and press Record (or R).');
      refreshInputs();
    } catch (err) {
      setMicMsg(MIC_MESSAGES[err?.message] || 'Could not open the microphone.', true);
      console.error('Rythmik: mic', err);
    }
    render();
  }

  async function startRecording() {
    if (booth.state !== 'idle' || !booth.micOpen) return;
    cancelRequested = false;
    if (booth.takesFull) {
      setMicMsg(TAKES_FULL, true);
      return;
    }
    setMicMsg(countIn ? 'Count-in, then recording.' : 'Recording.');
    let take;
    try {
      const pending = booth.record();
      render();
      take = await pending;
    } catch (err) {
      if (err?.message === 'too-many-takes') {
        setMicMsg(TAKES_FULL, true);
        cancelRequested = false;
        render();
        return;
      }
      if (!cancelRequested) {
        setMicMsg('Recording failed.', true);
        console.error('Rythmik: record', err);
      }
    }
    if (take) {
      setMicMsg(`${take.name} recorded. Play it in step 3.`);
      prepareSelected();
    }
    else if (cancelRequested) setMicMsg('Recording cancelled.');
    else setMicMsg('Recording stopped, no take kept.');
    cancelRequested = false;
    render();
  }

  function cancelRecording() {
    if (booth.state === 'idle') return;
    cancelRequested = true;
    booth.cancel();
    render();
  }

  async function startPreview(take) {
    try {
      await prepare(take.id);
      await booth.playTake(take.id, { withBeat: true });
    } catch (err) {
      console.error('Rythmik: preview', err);
    }
    render();
  }

  function stopPreview() {
    booth.stopPreview();
    render();
  }

  function deleteTake(id) {
    const takes = booth.takes || [];
    const idx = takes.findIndex((t) => t.id === id);
    const next = takes[idx + 1] || takes[idx - 1];
    const hadFocus = takeRows.get(id)?.li.contains(document.activeElement);
    booth.deleteTake(id);
    render();
    if (!hadFocus) return;
    const target = next ? takeRows.get(next.id)?.delBtn : null;
    (target || recordBtn).focus();
  }

  async function exportTake(kind) {
    const take = (booth.takes || []).find((t) => t.id === booth.selectedTakeId);
    if (!take || busy || tuning) return;
    const btn = kind === 'mix' ? mixBtn : vocalBtn;
    busy = true;
    btn.setAttribute('aria-busy', 'true');
    setExportMsg('Rendering…');
    render();
    const dry = kind === 'vocal' && vocalDryRadio.checked;
    try {
      if (!dry) await booth.prepareVoice(take.id);
      const buffer = kind === 'mix'
        ? await booth.renderMix(take.id)
        : await booth.renderVocal(take.id, { processed: !dry });
      const filename = `rythmik-${kind}${dry ? '-dry' : ''}-take-${takeNumber(take)}.wav`;
      downloadBlob(encodeWav(buffer, { bitDepth: 16 }), filename, 'audio/wav');
      setExportMsg(`Saved ${filename}.`);
    } catch (err) {
      console.error('Rythmik: export', err);
      setExportMsg('Export failed.', true);
    }
    busy = false;
    btn.removeAttribute('aria-busy');
    render();
  }

  function paintMeter() {
    const n = meterSegments(meterLevel);
    if (n === litSegments) return;
    litSegments = n;
    meterSegs.forEach((s, i) => s.classList.toggle('is-on', i < n));
  }

  // Polls level and progress only while there is something to show.
  function frame() {
    rafId = 0;
    if (booth.micOpen) {
      meterLevel = Math.max(booth.getInputLevel() || 0, meterLevel * METER_DECAY);
      paintMeter();
      checkMic();
    }
    if (booth.state !== 'idle') {
      const p = booth.getRecordProgress() || {}; // null once the take ends
      const counting = p.countIn || booth.state === 'count-in';
      const bar = `Recording bar ${Math.max(1, p.bar || 1)} of ${p.totalBars || bars}`;
      setProgress(counting ? `Count-in${p.beat ? ` ${p.beat}` : ''}` : bar);
      announce(counting ? 'Count-in' : bar);
    }
    updateLoop();
  }

  // Only polls while the view is on screen; setActive() restarts it.
  function updateLoop() {
    const needed = isActive() && (booth.micOpen || booth.state !== 'idle');
    if (needed && !rafId) rafId = requestAnimationFrame(frame);
    if (!needed) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      meterLevel = 0;
      paintMeter();
    }
  }

  micBtn.addEventListener('click', toggleMic);
  monitorBtn.addEventListener('click', () => {
    booth.setMonitoring(!booth.monitoring);
    render();
  });
  barsSelect.addEventListener('change', () => {
    bars = Number(barsSelect.value);
    booth.setBars(bars);
    render();
  });
  countInBtn.addEventListener('click', () => {
    countIn = !countIn;
    booth.setCountIn(countIn);
    render();
  });
  recordBtn.addEventListener('click', () => {
    if (booth.state === 'idle') startRecording();
    else cancelRecording();
  });
  stopBtn.addEventListener('click', stopPreview);
  offsetRange.addEventListener('input', () => {
    offsetMs = Number(offsetRange.value);
    booth.setLatencyOffset(offsetMs);
    render();
  });
  inputSelect.addEventListener('change', changeInput);
  overBeat.addEventListener('change', () => overBeat.checked && changeBacking('beat'));
  overRemix.addEventListener('change', () => overRemix.checked && changeBacking('remix'));
  mixBtn.addEventListener('click', () => {
    if (!isUnavailable(mixBtn)) exportTake('mix');
  });
  vocalBtn.addEventListener('click', () => {
    if (!isUnavailable(vocalBtn)) exportTake('vocal');
  });

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (booth.state !== 'idle') {
        e.preventDefault();
        cancelRecording();
      } else if (booth.previewTakeId != null) {
        e.preventDefault();
        stopPreview();
      }
      return;
    }
    if ((e.key === 'r' || e.key === 'R') && !isTyping(e.target) && isActive()) {
      if (booth.state !== 'idle') return;
      e.preventDefault();
      if (booth.micOpen) startRecording();
      else setMicMsg('Enable the mic first.');
    }
  }
  document.addEventListener('keydown', onKey);

  booth.setBars(bars);
  booth.setCountIn(countIn);
  booth.setLatencyOffset(offsetMs);
  const savedVoice = loadVoice();
  if (savedVoice) {
    try {
      if (VOICE_PRESETS[savedVoice.preset]) booth.setVoicePreset(savedVoice.preset);
      const { preset, ...settings } = savedVoice;
      booth.setVoiceSettings(settings);
    } catch (err) {
      console.error('Rythmik: saved voice', err);
    }
  }
  const saved = loadInput();
  if (saved) booth.setInputDevice(saved).catch(() => {}); // mic is closed: only remembered
  booth.onChange(render);
  booth.onDevicesChange(onDevices);
  remix?.onChange(render);
  render();
  refreshInputs();

  return {
    el: view,
    setActive() {
      updateLoop();
    },
    get recording() {
      return booth.state !== 'idle';
    },
    /** 'beat' | 'remix': what takes are recorded over */
    get backing() {
      return booth.backing === 'remix' ? 'remix' : 'beat';
    },
    cancel: cancelRecording,
  };
}
