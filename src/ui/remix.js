import { SPEED_PRESETS, REMIX_PRESETS, MIN_SPEED, MAX_SPEED } from '../audio/remix.js';
import { createTapTempo } from '../audio/tempo.js';
import { encodeWav } from '../audio/wav.js';
import { createKnob } from './knob.js';
import { helpLabel, helpTip } from './helptip.js';
import { getDefaultStorage } from './persistence.js';
import { el, led, downloadBlob, setUnavailable, isUnavailable } from './dom.js';

export const REMIX_KEY = 'rythmik:remix';

// Limits documented by the remix engine.
const MIN_LOOP = 0.5;
const MIN_SONG_BPM = 40;
const MAX_SONG_BPM = 220;
// Same limit as the deck; checked here too so a huge file is refused before it is read.
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const HANDLE_STEP = 0.1; // seconds per arrow press
const HANDLE_BIG_STEP = 1; // with Shift
const HANDLE_PAGE_STEP = 5;
const DRAG_PX = 4; // movement before a press on the waveform counts as a drag
const WAVE_IN = '#cfc5b4';
const WAVE_OUT = '#6a6157';

const NUMBER_SETTINGS = ['speed', 'reverb', 'muffle', 'bass', 'volume'];
const BOOLEAN_SETTINGS = ['keepPitch', 'beatSync'];

const LOAD_ERRORS = {
  'decode-failed': 'Could not read that file as audio. Try an MP3, WAV, OGG or M4A file.',
  'too-long': 'That song is longer than 15 minutes. Pick a shorter file or trim it first.',
  busy: 'Still loading the last file. Try again in a moment.',
  'too-large': 'That file is over 200 MB, too large to load in the browser.',
  'not-audio': 'That is not an audio file.',
};

export function loadRemixSettings(storage = getDefaultStorage()) {
  try {
    const v = JSON.parse(storage?.getItem(REMIX_KEY) || 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const ok = (k) => (NUMBER_SETTINGS.includes(k) ? Number.isFinite(v[k]) : typeof v[k] === 'boolean');
    return Object.fromEntries([...NUMBER_SETTINGS, ...BOOLEAN_SETTINGS].filter(ok).map((k) => [k, v[k]]));
  } catch {
    return null;
  }
}

export function saveRemixSettings(settings, storage = getDefaultStorage()) {
  try {
    storage?.setItem(REMIX_KEY, JSON.stringify(settings));
    return !!storage;
  } catch {
    return false;
  }
}

/** 92 -> '92', 78.24 -> '78.2'; '--' when unknown. */
export function formatBpm(bpm) {
  if (!(bpm > 0)) return '--';
  const r = Math.round(bpm * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Seconds as m:ss, or m:ss.s with tenths. */
export function formatTime(seconds, tenths = false) {
  const t = Math.max(0, Number(seconds) || 0);
  const total = tenths ? Math.round(t * 10) / 10 : Math.round(t);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(s).padStart(2, '0');
  return `${m}:${ss}`;
}

export const formatSpeed = (speed) => `${Number(speed).toFixed(2)}x`;

export function remixFileName(name) {
  const base = String(name || '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${base || 'song'}-remix.wav`;
}

const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < eps;

export function matchesPreset(settings, preset) {
  if (!settings || !preset) return false;
  return Object.entries(preset).every(([k, want]) => (typeof want === 'number' ? near(settings[k], want) : settings[k] === want));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The REMIX view. `remix` comes from createRemix(engine) and is shared with the booth.
 * setLocked(true) while a take records: anything that would change the take's backing is locked.
 */
export function mountRemix(remix, { storage = getDefaultStorage() } = {}) {
  let active = false;
  let lockedByTake = false;
  let starting = false; // play() pending, e.g. waiting for a keep-pitch stretch
  let playGen = 0; // a Stop while play() is pending wins over its late result
  let loadingName = '';
  let exporting = false;
  let rafId = 0;
  let drawQueued = false;
  let drawnKey = '';
  let peaks = null; // { key, min, max }
  let draft = null; // loop shown while a handle or region is dragged
  let drag = null;
  let tapTimer = 0;
  let songMark = 0; // bumped on every load so cached peaks are dropped
  const tap = createTapTempo();

  const saved = loadRemixSettings(storage);
  // What the user chose for Beat plays along; the deck can only follow it once the song has a tempo.
  let wantSync = !!saved?.beatSync;

  // song: empty state
  const fileInput = el('input', { type: 'file', accept: 'audio/*', hidden: true, tabindex: -1, 'aria-hidden': 'true' });
  const loadBtn = el('button', { type: 'button', class: 'rk-key rk-key--big rk-remix__load' }, [el('span', { text: 'Load a song' })]);
  const emptyPanel = el('div', { class: 'rk-drop' }, [
    el('div', { class: 'rk-btnrow rk-drop__btns' }, [el('span', { class: 'rk-pair' }, [loadBtn, helpTip('remixLoad')])]),
    el('p', { class: 'rk-drop__or', text: 'or drop an audio file anywhere on this panel' }),
    el('p', { class: 'rk-hint', text: 'MP3, WAV, OGG or M4A, up to 15 minutes. The file stays on this computer; nothing is uploaded.' }),
  ]);
  const loadBusy = el('p', { class: 'rk-busy', role: 'status' });
  const loadMsg = el('p', { class: 'rk-msg', role: 'status' });

  // song: loaded
  const songName = el('p', { class: 'rk-remix__name' });
  const songTime = el('span', { class: 'rk-remix__time' });
  const deckLed = led();
  const deckLabel = el('span', { text: 'Play song' });
  const deckBtn = el('button', { type: 'button', class: 'rk-key rk-key--led rk-key--big rk-deck' }, [deckLed, deckLabel]);
  const replaceBtn = el('button', { type: 'button', class: 'rk-key', text: 'Load another' });
  const removeBtn = el('button', { type: 'button', class: 'rk-key', text: 'Remove' });

  const canvas = el('canvas', { class: 'rk-wave__canvas', 'aria-hidden': 'true' });
  const region = el('div', { class: 'rk-wave__region', 'aria-hidden': 'true' });
  const playhead = el('div', { class: 'rk-wave__head', 'aria-hidden': 'true', hidden: true });
  const handle = (which, name) =>
    el('div', {
      class: `rk-wave__handle rk-wave__handle--${which}`,
      role: 'slider',
      tabindex: 0,
      'aria-label': name,
      'aria-orientation': 'horizontal',
      'aria-description': 'Arrow keys move it, Shift moves it further.',
      'data-handle': which,
    }, [el('span', { class: 'rk-wave__grip', 'aria-hidden': 'true' })]);
  const startHandle = handle('start', 'Loop start');
  const endHandle = handle('end', 'Loop end');
  const wave = el('div', { class: 'rk-wave' }, [canvas, region, playhead, startHandle, endHandle]);

  const loopSwitch = el('button', { type: 'button', class: 'rk-key rk-key--led rk-switch', role: 'switch', 'aria-checked': 'true' }, [
    led(),
    el('span', { text: 'Loop' }),
  ]);
  const loopInfo = el('p', { class: 'rk-remix__loopinfo' });

  const songPanel = el('div', { class: 'rk-remix__song', hidden: true }, [
    el('div', { class: 'rk-remix__strip' }, [
      el('div', { class: 'rk-remix__title' }, [led('is-on'), songName, songTime]),
      el('div', { class: 'rk-btnrow' }, [
        el('span', { class: 'rk-pair' }, [deckBtn, helpTip('remixDeck')]),
        el('span', { class: 'rk-pair' }, [replaceBtn, helpTip('remixLoad')]),
        el('span', { class: 'rk-pair' }, [removeBtn, helpTip('remixRemove')]),
      ]),
    ]),
    el('div', { class: 'rk-field' }, [helpLabel('remixWave')]),
    wave,
    el('div', { class: 'rk-btnrow' }, [el('span', { class: 'rk-pair' }, [loopSwitch, helpTip('remixLoop')]), loopInfo]),
    el('p', {
      class: 'rk-hint',
      text: 'Play song only plays your song. The Play key in the top strip plays your beat; both can sound at once. Turn on Beat plays along to keep them in time.',
    }),
  ]);

  const lockNote = el('p', { class: 'rk-note-line', hidden: true, text: 'The song and all its settings are locked while a take records.' });
  const songModule = el('section', { class: 'rk-module rk-module--col rk-module--wide', 'aria-labelledby': 'rk-remix-song-h' }, [
    el('h3', { class: 'rk-silk', id: 'rk-remix-song-h', text: 'Song' }),
    emptyPanel,
    songPanel,
    loadBusy,
    loadMsg,
    lockNote,
    fileInput,
  ]);

  // sound
  const presetKey = (id, tip, big = false) => {
    const btn = el('button', {
      type: 'button',
      class: `rk-key rk-key--led${big ? ' rk-key--big' : ''}`,
      'aria-pressed': 'false',
      'data-remix-preset': id,
    }, [led(), el('span', { text: REMIX_PRESETS[id].name })]);
    btn.addEventListener('click', () => {
      if (isLocked()) return;
      remix.applyPreset(id);
      persist();
    });
    return { btn, cell: el('span', { class: 'rk-pair' }, [btn, tip]) };
  };
  const slowed = presetKey('slowedReverb', helpTip('remixSlowedReverb'), true);
  const original = presetKey('original', helpTip('remixOriginal'));

  const speedKeys = new Map();
  const speedCells = SPEED_PRESETS.map((p) => {
    const btn = el('button', { type: 'button', class: 'rk-key rk-key--led rk-speedkey', 'aria-pressed': 'false', 'data-speed': p.id }, [
      led(),
      el('span', { class: 'rk-speedkey__name', text: p.name }),
      el('span', { class: 'rk-speedkey__x', text: formatSpeed(p.speed) }),
    ]);
    btn.addEventListener('click', () => {
      if (isLocked()) return;
      remix.setSpeed(p.speed);
      persist();
    });
    speedKeys.set(p.id, { btn, speed: p.speed });
    return btn;
  });
  const speedOut = el('span', { class: 'rk-lcd rk-remix__speed' }, [el('span', { class: 'rk-lcd__text' }), el('span', { class: 'rk-lcd__unit', text: 'Speed' })]);

  // the label must carry `id`: the knob is named by it
  const knob = (label, id, opts) => {
    const k = createKnob({ labelledBy: id, showReadout: true, value: 0, defaultValue: 0, ...opts });
    return { knob: k, cell: el('div', { class: 'rk-knobcell' }, [label, k.el]) };
  };
  const fx = (setting) => (v) => {
    if (isLocked()) {
      renderSound(); // snaps the knob back
      return;
    }
    remix.setFx(setting, v / 100);
    persist();
  };
  const spaceK = knob(helpLabel('remixSpace', { id: 'rk-remix-space-label' }), 'rk-remix-space-label', { label: 'Space', onInput: fx('reverb') });
  const muffleK = knob(helpLabel('remixMuffle', { id: 'rk-remix-muffle-label' }), 'rk-remix-muffle-label', { label: 'Muffle', onInput: fx('muffle') });
  const bassK = knob(helpLabel('remixBass', { id: 'rk-remix-bass-label' }), 'rk-remix-bass-label', { label: 'Bass', onInput: fx('bass') });
  const volumeK = knob(helpLabel('remixVolume', { id: 'rk-remix-volume-label' }), 'rk-remix-volume-label', {
    label: 'Volume',
    value: 80,
    defaultValue: 80,
    onInput: fx('volume'),
  });
  const speedK = knob(helpLabel('remixSpeedFine', { id: 'rk-remix-speed-label' }), 'rk-remix-speed-label', {
    label: 'Fine speed',
    min: Math.round(MIN_SPEED * 100),
    max: Math.round(MAX_SPEED * 100),
    value: 100,
    defaultValue: 100,
    bigStep: 5,
    format: (v) => formatSpeed(v / 100),
    onInput: (v) => {
      if (isLocked()) {
        renderSound(); // snaps the knob back
        return;
      }
      remix.setSpeed(v / 100);
      persist();
    },
  });
  speedK.cell.classList.add('rk-adv');

  const keepPitchSwitch = el('button', { type: 'button', class: 'rk-key rk-key--led rk-switch', role: 'switch', 'aria-checked': 'false' }, [
    led(),
    el('span', { text: 'Keep pitch' }),
  ]);
  const stretchLine = el('p', { class: 'rk-busy', role: 'status' });
  const hiddenNote = el('p', { class: 'rk-note-line rk-beginner', hidden: true });

  const soundModule = el('section', { class: 'rk-module rk-module--col rk-module--wide', 'aria-labelledby': 'rk-remix-sound-h', hidden: true }, [
    el('h3', { class: 'rk-silk', id: 'rk-remix-sound-h', text: 'Sound' }),
    el('div', { class: 'rk-btnrow' }, [slowed.cell, original.cell]),
    el('div', { class: 'rk-remix__speedrow' }, [
      el('div', { class: 'rk-field' }, [helpLabel('remixSpeed', { id: 'rk-remix-speeds' }), speedOut]),
      el('div', { class: 'rk-speedkeys', role: 'group', 'aria-labelledby': 'rk-remix-speeds' }, speedCells),
    ]),
    el('div', { class: 'rk-knobs rk-remix__knobs' }, [spaceK.cell, muffleK.cell, bassK.cell, volumeK.cell, speedK.cell]),
    el('div', { class: 'rk-btnrow rk-adv' }, [el('span', { class: 'rk-pair' }, [keepPitchSwitch, helpTip('remixKeepPitch')]), stretchLine]),
    hiddenNote,
  ]);

  // tempo
  const songBpmOut = el('span', { class: 'rk-lcd__text' });
  const nowBpmOut = el('span', { class: 'rk-lcd__text' });
  const bpmBusyLine = el('p', { class: 'rk-busy', role: 'status' });
  const bpmMissing = el('p', { class: 'rk-empty', hidden: true });
  const tapLed = led();
  const tapBtn = el('button', { type: 'button', class: 'rk-key rk-key--led rk-key--big rk-tap', 'aria-describedby': 'rk-remix-tapinfo' }, [
    tapLed,
    el('span', { text: 'Tap' }),
  ]);
  const tapInfo = el('span', { class: 'rk-hint', id: 'rk-remix-tapinfo', text: 'Tap along while the song plays.' });
  const halfBtn = el('button', { type: 'button', class: 'rk-key', 'aria-label': '/2: halve the song tempo', text: '/2' });
  const doubleBtn = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'x2: double the song tempo', text: 'x2' });
  const bpmInput = el('input', {
    id: 'rk-remix-bpm',
    type: 'number',
    class: 'rk-lcd__input rk-lcd__input--wide',
    min: MIN_SONG_BPM,
    max: MAX_SONG_BPM,
    step: 0.1,
    inputmode: 'decimal',
  });
  const manualField = el('div', { class: 'rk-field rk-adv' }, [
    helpLabel('remixManualBpm', { forId: 'rk-remix-bpm' }),
    el('span', { class: 'rk-lcd' }, [bpmInput, el('span', { class: 'rk-lcd__unit', text: 'BPM' })]),
  ]);
  const syncSwitch = el('button', {
    type: 'button',
    class: 'rk-key rk-key--led rk-switch',
    role: 'switch',
    'aria-checked': 'false',
    'aria-describedby': 'rk-remix-syncwhy',
  }, [led(), el('span', { text: 'Beat plays along' })]);
  const syncWhy = el('p', { class: 'rk-hint', id: 'rk-remix-syncwhy' });

  const tempoModule = el('section', { class: 'rk-module rk-module--col', 'aria-labelledby': 'rk-remix-tempo-h', hidden: true }, [
    el('h3', { class: 'rk-silk', id: 'rk-remix-tempo-h', text: 'Tempo' }),
    el('div', { class: 'rk-field' }, [
      helpLabel('remixSongBpm'),
      el('span', { class: 'rk-lcd rk-lcd--readout' }, [songBpmOut, el('span', { class: 'rk-lcd__unit', text: 'BPM' })]),
      el('span', { class: 'rk-lcd rk-lcd--readout' }, [
        el('span', { class: 'rk-lcd__unit', text: 'Now' }),
        nowBpmOut,
        el('span', { class: 'rk-lcd__unit', text: 'BPM' }),
        el('span', { class: 'rk-visually-hidden', text: ' at the current speed' }),
      ]),
    ]),
    bpmBusyLine,
    bpmMissing,
    el('div', { class: 'rk-btnrow' }, [el('span', { class: 'rk-pair' }, [tapBtn, helpTip('remixTap')]), tapInfo]),
    el('div', { class: 'rk-btnrow' }, [halfBtn, doubleBtn, helpTip('remixHalfDouble')]),
    manualField,
    el('div', { class: 'rk-btnrow' }, [el('span', { class: 'rk-pair' }, [syncSwitch, helpTip('remixBeatSync')])]),
    syncWhy,
  ]);

  // export
  const loopRadio = el('input', {
    type: 'radio',
    id: 'rk-remix-range-loop',
    name: 'rk-remix-range',
    value: 'loop',
    class: 'rk-radio',
    checked: true,
    'aria-describedby': 'rk-remix-range-why',
  });
  const wholeRadio = el('input', { type: 'radio', id: 'rk-remix-range-song', name: 'rk-remix-range', value: 'song', class: 'rk-radio' });
  const exportLabel = el('span', { text: 'Export remix (WAV)' });
  const exportBtn = el('button', { type: 'button', class: 'rk-key' }, [exportLabel]);
  const exportMsg = el('p', { class: 'rk-msg', role: 'status' });
  const exportNote = el('p', { class: 'rk-hint' });
  const rangeWhy = el('p', { class: 'rk-hint', id: 'rk-remix-range-why', hidden: true, text: 'Loop is off: the whole song is exported.' });
  const exportModule = el('section', { class: 'rk-module rk-module--col', 'aria-labelledby': 'rk-remix-export-h', hidden: true }, [
    helpLabel('remixExport', { tag: 'h3', id: 'rk-remix-export-h', className: 'rk-module__head' }),
    el('fieldset', { class: 'rk-choice', 'aria-labelledby': 'rk-remix-range-label' }, [
      helpLabel('remixExportRange', { id: 'rk-remix-range-label' }),
      el('span', { class: 'rk-choice__opts' }, [
        el('label', { class: 'rk-choice__opt', for: 'rk-remix-range-loop' }, [loopRadio, el('span', { text: 'Loop only' })]),
        el('label', { class: 'rk-choice__opt', for: 'rk-remix-range-song' }, [wholeRadio, el('span', { text: 'Whole song' })]),
      ]),
      rangeWhy,
    ]),
    el('div', { class: 'rk-btnrow' }, [exportBtn]),
    exportNote,
    exportMsg,
  ]);

  const view = el('div', { class: 'rk-remix' }, [
    el('div', { class: 'rk-band rk-band--first' }, [songModule]),
    el('div', { class: 'rk-band' }, [soundModule]),
    el('div', { class: 'rk-band' }, [tempoModule, exportModule]),
  ]);

  // ---- helpers ----

  function persist() {
    saveRemixSettings({ ...remix.settings, beatSync: wantSync }, storage);
  }

  function setMsg(node, t, error = false) {
    node.textContent = t;
    node.classList.toggle('is-error', error);
  }

  function setBusy(node, t) {
    if (node.dataset.text === t) return;
    node.dataset.text = t;
    node.replaceChildren(...(t ? [led('is-on is-blink'), el('span', { text: t })] : []));
  }

  // The deck also locks itself while the booth records over it.
  const isLocked = () => lockedByTake || remix.locked === true;
  const duration = () => remix.info?.duration || 0;
  const exportWithBeat = () => !!remix.settings.beatSync && remix.sourceBpm != null;
  // With the loop off you hear the whole song, so that is what gets exported.
  const exportLoopOnly = () => remix.loop.enabled && loopRadio.checked;
  const currentLoop = () => draft || remix.loop;

  // ---- loading ----

  async function loadFile(file) {
    if (!file || isLocked() || loadingName) return;
    let problem = '';
    if (file.type && !/^(audio|video)\//.test(file.type)) problem = 'not-audio';
    else if (file.size > MAX_FILE_BYTES) problem = 'too-large';
    if (problem) {
      setMsg(loadMsg, LOAD_ERRORS[problem], true);
      return;
    }
    loadingName = file.name || 'song';
    setMsg(loadMsg, '');
    render();
    try {
      await remix.load(file, { name: file.name });
      songMark++;
      tap.reset();
      setMsg(loadMsg, `Loaded ${file.name}. Press Play song to hear it.`);
    } catch (err) {
      setMsg(loadMsg, LOAD_ERRORS[err?.message] || 'Could not load that file.', true);
      if (!LOAD_ERRORS[err?.message]) console.error('Rythmik: load song', err);
    }
    loadingName = '';
    render();
    // The key that opened the file may now be hidden; keep focus nearby.
    const f = document.activeElement;
    if (active && (!f || f === document.body || f.closest('[hidden]'))) (remix.loaded ? deckBtn : loadBtn).focus();
  }

  function pickFile() {
    if (isLocked() || loadingName) return;
    fileInput.click();
  }

  // ---- waveform ----

  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      drawWave();
    });
  }

  function drawWave() {
    if (!active || !remix.loaded) return;
    const w = Math.round(wave.clientWidth);
    const h = Math.round(wave.clientHeight);
    if (!(w > 0 && h > 0)) return;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const loop = currentLoop();
    const key = `${songMark}:${w}x${h}@${dpr}:${loop.enabled}:${loop.start.toFixed(3)}:${loop.end.toFixed(3)}`;
    if (key === drawnKey) return;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    drawnKey = key;
    const peakKey = `${songMark}:${w}`;
    if (peaks?.key !== peakKey) peaks = { key: peakKey, ...remix.getPeaks(w) };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const d = duration();
    const mid = h / 2;
    const amp = mid * 0.92;
    const a = loop.enabled ? (loop.start / d) * w : 0;
    const b = loop.enabled ? (loop.end / d) * w : w;
    for (let x = 0; x < peaks.max.length; x++) {
      const top = mid - Math.min(1, peaks.max[x]) * amp;
      const bottom = mid - Math.max(-1, peaks.min[x]) * amp;
      ctx.fillStyle = x >= a && x < b ? WAVE_IN : WAVE_OUT;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }

  function timeAt(clientX) {
    const r = wave.getBoundingClientRect();
    const f = r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
    return f * duration();
  }

  function renderLoop() {
    const d = duration();
    const loop = currentLoop();
    const pct = (t) => `${d > 0 ? (t / d) * 100 : 0}%`;
    region.style.left = pct(loop.start);
    region.style.width = `${d > 0 ? ((loop.end - loop.start) / d) * 100 : 0}%`;
    region.hidden = !loop.enabled;
    wave.classList.toggle('is-loop-off', !loop.enabled);
    startHandle.style.left = pct(loop.start);
    endHandle.style.left = pct(loop.end);
    const setSlider = (node, value, lo, hi) => {
      node.setAttribute('aria-valuemin', String(Math.round(lo * 10) / 10));
      node.setAttribute('aria-valuemax', String(Math.round(hi * 10) / 10));
      node.setAttribute('aria-valuenow', String(Math.round(value * 10) / 10));
      node.setAttribute('aria-valuetext', formatTime(value, true));
      if (isLocked()) node.setAttribute('aria-disabled', 'true');
      else node.removeAttribute('aria-disabled');
    };
    setSlider(startHandle, loop.start, 0, Math.max(0, loop.end - MIN_LOOP));
    setSlider(endHandle, loop.end, Math.min(d, loop.start + MIN_LOOP), d);
    loopSwitch.setAttribute('aria-checked', String(loop.enabled));
    loopInfo.textContent = loop.enabled
      ? `Loop ${formatTime(loop.start, true)} to ${formatTime(loop.end, true)} (${(loop.end - loop.start).toFixed(1)} s)`
      : 'Plays to the end of the song.';
    queueDraw();
  }

  // Loop length is kept when the region is moved; edges keep MIN_LOOP apart.
  function moveEdge(which, t, loop) {
    const d = duration();
    if (which === 'start') return { ...loop, start: clamp(t, 0, loop.end - MIN_LOOP) };
    return { ...loop, end: clamp(t, loop.start + MIN_LOOP, d) };
  }

  wave.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !remix.loaded || isLocked()) return;
    const edge = e.target instanceof Element ? e.target.closest('[data-handle]') : null;
    const loop = remix.loop;
    const t = timeAt(e.clientX);
    const d = duration();
    const coversSong = loop.start <= 0.01 && loop.end >= d - 0.01;
    let mode = 'new';
    if (edge) mode = edge.dataset.handle;
    else if (loop.enabled && !coversSong && t >= loop.start && t <= loop.end) mode = 'move';
    // where on the handle it was grabbed, so the edge does not jump to the pointer
    const grab = edge ? t - (mode === 'start' ? loop.start : loop.end) : 0;
    drag = { id: e.pointerId, mode, x: e.clientX, t0: t, grab, loop, moved: false };
    if (edge) {
      e.preventDefault();
      edge.focus({ preventScroll: true });
    }
    wave.setPointerCapture?.(e.pointerId);
  });

  wave.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) < DRAG_PX) return;
    drag.moved = true;
    wave.classList.add('is-dragging');
    const t = timeAt(e.clientX);
    const { loop } = drag;
    const d = duration();
    if (drag.mode === 'start' || drag.mode === 'end') {
      draft = moveEdge(drag.mode, t - drag.grab, loop);
    } else if (drag.mode === 'move') {
      const len = loop.end - loop.start;
      const start = clamp(loop.start + (t - drag.t0), 0, d - len);
      draft = { ...loop, start, end: start + len };
    } else {
      let start = Math.min(drag.t0, t);
      let end = Math.max(drag.t0, t);
      if (end - start < MIN_LOOP) end = Math.min(d, start + MIN_LOOP);
      if (end - start < MIN_LOOP) start = Math.max(0, end - MIN_LOOP);
      draft = { start, end, enabled: true };
    }
    renderLoop();
  });

  function endDrag(e, commit) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    wave.classList.remove('is-dragging');
    const next = draft;
    draft = null;
    if (commit && d.moved && next && !isLocked()) {
      remix.setLoop(next.start, next.end);
      if (d.mode === 'new' && !remix.loop.enabled) remix.setLoopEnabled(true);
    } else if (commit && !d.moved && d.mode !== 'start' && d.mode !== 'end' && !isLocked()) {
      playFrom(d.t0);
    }
    renderLoop();
  }
  wave.addEventListener('pointerup', (e) => endDrag(e, true));
  wave.addEventListener('pointercancel', (e) => endDrag(e, false));
  wave.addEventListener('lostpointercapture', (e) => endDrag(e, false));

  function onHandleKey(e) {
    const which = e.currentTarget.dataset.handle;
    const loop = remix.loop;
    let t = which === 'start' ? loop.start : loop.end;
    const step = e.shiftKey ? HANDLE_BIG_STEP : HANDLE_STEP;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp': t += step; break;
      case 'ArrowLeft':
      case 'ArrowDown': t -= step; break;
      case 'PageUp': t += HANDLE_PAGE_STEP; break;
      case 'PageDown': t -= HANDLE_PAGE_STEP; break;
      case 'Home': t = 0; break;
      case 'End': t = duration(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!remix.loaded || isLocked()) return;
    const next = moveEdge(which, t, loop);
    remix.setLoop(next.start, next.end);
    renderLoop();
  }
  startHandle.addEventListener('keydown', onHandleKey);
  endHandle.addEventListener('keydown', onHandleKey);

  // ---- transport ----

  async function playFrom(from) {
    if (!remix.loaded || isLocked()) return;
    const gen = ++playGen;
    starting = true;
    render();
    try {
      await remix.play(Number.isFinite(from) ? { from } : {});
    } catch (err) {
      if (gen === playGen) {
        console.error('Rythmik: play song', err);
        setMsg(loadMsg, 'Could not play the song.', true);
      }
    }
    if (gen !== playGen) return;
    starting = false;
    render();
  }

  function toggleDeck() {
    if (isUnavailable(deckBtn)) return;
    if (remix.isPlaying || starting) {
      playGen++;
      starting = false;
      remix.stop();
      render();
    } else {
      playFrom();
    }
  }

  function frame() {
    rafId = 0;
    const pos = remix.getPosition();
    const d = duration();
    if (pos != null && d > 0) {
      playhead.hidden = false;
      playhead.style.left = `${(clamp(pos, 0, d) / d) * 100}%`;
    } else {
      playhead.hidden = true;
    }
    updateLoop();
  }

  function updateLoop() {
    const needed = active && remix.isPlaying;
    if (needed && !rafId) rafId = requestAnimationFrame(frame);
    if (!needed) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      playhead.hidden = true;
    }
  }

  // ---- tempo ----

  function onTap() {
    if (isLocked() || !remix.loaded) return;
    tapLed.classList.add('is-on');
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => tapLed.classList.remove('is-on'), 90);
    const heard = tap.tap();
    if (heard == null) {
      tapInfo.textContent = 'Keep tapping…';
      return;
    }
    // Taps follow what you hear, which is the song at the current speed.
    const speed = remix.settings.speed || 1;
    remix.setSourceBpm(clamp(heard / speed, MIN_SONG_BPM, MAX_SONG_BPM));
    tapInfo.textContent = `${formatBpm(heard)} BPM from ${tap.count} taps`;
  }

  function scaleBpm(f) {
    const bpm = remix.sourceBpm;
    if (isLocked() || !(bpm > 0)) return;
    remix.setSourceBpm(clamp(bpm * f, MIN_SONG_BPM, MAX_SONG_BPM));
  }

  function commitBpm() {
    const raw = bpmInput.value;
    const v = Number(raw);
    if (!isLocked() && raw !== '' && Number.isFinite(v)) remix.setSourceBpm(v);
    bpmInput.value = remix.sourceBpm != null ? formatBpm(remix.sourceBpm) : '';
    render();
  }

  function followSync() {
    if (isLocked()) return;
    const canSync = remix.sourceBpm != null;
    if (canSync && remix.settings.beatSync !== wantSync) remix.setBeatSync(wantSync);
  }

  // ---- export ----

  async function exportRemix() {
    if (exporting || isUnavailable(exportBtn) || !remix.loaded) return;
    exporting = true;
    exportBtn.setAttribute('aria-busy', 'true');
    exportLabel.textContent = 'Rendering…';
    setMsg(exportMsg, 'Rendering…');
    render();
    const name = remix.info?.name;
    try {
      const buffer = await remix.render({ loopOnly: exportLoopOnly(), withBeat: exportWithBeat() });
      const filename = remixFileName(name);
      downloadBlob(encodeWav(buffer, { bitDepth: 16 }), filename, 'audio/wav');
      setMsg(exportMsg, `Saved ${filename}.`);
    } catch (err) {
      console.error('Rythmik: remix export', err);
      setMsg(exportMsg, 'Export failed.', true);
    }
    exporting = false;
    exportBtn.removeAttribute('aria-busy');
    exportLabel.textContent = 'Export remix (WAV)';
    render();
  }

  // ---- render ----

  function renderSound() {
    const s = remix.settings;
    slowed.btn.setAttribute('aria-pressed', String(matchesPreset(s, REMIX_PRESETS.slowedReverb.settings)));
    original.btn.setAttribute('aria-pressed', String(matchesPreset(s, REMIX_PRESETS.original.settings)));
    for (const { btn, speed } of speedKeys.values()) {
      btn.setAttribute('aria-pressed', String(near(s.speed, speed, 0.001)));
      btn.disabled = isLocked();
    }
    slowed.btn.disabled = original.btn.disabled = isLocked();
    speedOut.firstElementChild.textContent = formatSpeed(s.speed);
    const pct = (x) => Math.round((Number(x) || 0) * 100);
    spaceK.knob.setValue(pct(s.reverb));
    muffleK.knob.setValue(pct(s.muffle));
    bassK.knob.setValue(pct(s.bass));
    volumeK.knob.setValue(pct(s.volume));
    speedK.knob.setValue(pct(s.speed));
    for (const k of [spaceK, muffleK, bassK, volumeK, speedK]) {
      if (isLocked()) k.knob.dial.setAttribute('aria-disabled', 'true');
      else k.knob.dial.removeAttribute('aria-disabled');
    }
    keepPitchSwitch.setAttribute('aria-checked', String(!!s.keepPitch));
    keepPitchSwitch.disabled = isLocked();
    setBusy(stretchLine, remix.stretchBusy ? 'Stretching…' : '');
    const note = s.keepPitch ? 'Some Advanced settings are active: Keep pitch is on. Turn on Advanced to change it.' : '';
    if (hiddenNote.textContent !== note) hiddenNote.textContent = note;
    hiddenNote.hidden = !note;
  }

  function renderTempo() {
    const bpm = remix.sourceBpm;
    const known = bpm != null;
    const busy = !!remix.bpmBusy;
    songBpmOut.textContent = known ? formatBpm(bpm) : busy ? '...' : '--';
    nowBpmOut.textContent = known ? formatBpm(remix.effectiveBpm) : '--';
    setBusy(bpmBusyLine, busy && !known ? 'Finding the tempo…' : '');
    bpmMissing.hidden = known || busy || !remix.loaded;
    bpmMissing.textContent = 'No steady tempo found. Press Tap along with the song, or type the tempo.';
    // Typing the tempo is for everyone when detection found nothing.
    manualField.classList.toggle('rk-adv', known || busy);
    if (document.activeElement !== bpmInput) bpmInput.value = known ? formatBpm(bpm) : '';
    tapBtn.disabled = isLocked();
    bpmInput.disabled = isLocked();
    halfBtn.disabled = doubleBtn.disabled = isLocked() || !known;

    syncSwitch.setAttribute('aria-checked', String(known && !!remix.settings.beatSync));
    syncSwitch.disabled = isLocked() || !known;
    let why = '';
    if (!known) why = busy ? 'Waits for the song tempo.' : 'Needs the song tempo first: tap it or type it.';
    else if (remix.settings.beatSync) why = 'Your beat plays at the song tempo whenever the song plays.';
    else why = 'Off: the song plays without your beat.';
    if (syncWhy.textContent !== why) syncWhy.textContent = why;
  }

  function render() {
    const loaded = remix.loaded;
    const info = remix.info;
    emptyPanel.hidden = loaded || !!loadingName;
    songPanel.hidden = !loaded;
    soundModule.hidden = tempoModule.hidden = exportModule.hidden = !loaded;
    setBusy(loadBusy, loadingName ? `Loading ${loadingName}…` : '');
    setUnavailable(loadBtn, { hard: isLocked(), soft: !!loadingName });
    setUnavailable(replaceBtn, { hard: isLocked(), soft: !!loadingName });
    removeBtn.disabled = isLocked() || !!loadingName;
    lockNote.hidden = !isLocked();

    if (loaded && info) {
      if (songName.textContent !== info.name) songName.textContent = info.name;
      songTime.textContent = formatTime(info.duration);
      const playing = remix.isPlaying;
      const waiting = starting && !playing;
      deckLabel.textContent = waiting ? (remix.stretchBusy ? 'Stretching…' : 'Starting…') : playing ? 'Stop song' : 'Play song';
      deckLed.classList.toggle('is-on', playing || waiting);
      deckLed.classList.toggle('is-blink', waiting);
      if (waiting) deckBtn.setAttribute('aria-busy', 'true');
      else deckBtn.removeAttribute('aria-busy');
      deckBtn.disabled = isLocked();
      loopSwitch.disabled = isLocked();
      wave.classList.toggle('is-locked', isLocked());
      renderLoop();
      renderSound();
      renderTempo();
      exportNote.textContent = exportWithBeat()
        ? 'Includes your beat, because Beat plays along is on.'
        : 'Song only. Turn on Beat plays along to include your beat.';
      setUnavailable(exportBtn, { hard: isLocked(), soft: exporting });
      const loopOn = remix.loop.enabled;
      loopRadio.disabled = wholeRadio.disabled = exporting || !loopOn;
      rangeWhy.hidden = loopOn;
    }
    updateLoop();
  }

  // ---- wiring ----

  loadBtn.addEventListener('click', () => {
    if (!isUnavailable(loadBtn)) pickFile();
  });
  replaceBtn.addEventListener('click', () => {
    if (!isUnavailable(replaceBtn)) pickFile();
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    loadFile(file);
  });
  removeBtn.addEventListener('click', () => {
    if (isLocked()) return;
    remix.unload();
    setMsg(loadMsg, 'Song removed.');
    render();
    loadBtn.focus();
  });
  deckBtn.addEventListener('click', toggleDeck);
  loopSwitch.addEventListener('click', () => {
    if (isLocked()) return;
    remix.setLoopEnabled(!remix.loop.enabled);
    render();
  });
  keepPitchSwitch.addEventListener('click', () => {
    if (isLocked()) return;
    remix.setKeepPitch(!remix.settings.keepPitch);
    persist();
  });
  tapBtn.addEventListener('click', onTap);
  halfBtn.addEventListener('click', () => scaleBpm(0.5));
  doubleBtn.addEventListener('click', () => scaleBpm(2));
  bpmInput.addEventListener('change', commitBpm);
  bpmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitBpm();
  });
  syncSwitch.addEventListener('click', () => {
    if (isLocked() || remix.sourceBpm == null) return;
    wantSync = !remix.settings.beatSync;
    remix.setBeatSync(wantSync);
    persist();
  });
  exportBtn.addEventListener('click', exportRemix);

  // The drop itself is handled by the app (anywhere in REMIX); this only shows where it lands.
  songModule.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    e.dataTransfer.dropEffect = isLocked() ? 'none' : 'copy';
    songModule.classList.toggle('is-dropping', !isLocked());
  });
  songModule.addEventListener('dragleave', (e) => {
    if (!songModule.contains(e.relatedTarget)) songModule.classList.remove('is-dropping');
  });
  songModule.addEventListener('drop', () => songModule.classList.remove('is-dropping'));

  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(queueDraw);
    resizeObserver.observe(wave);
  } else {
    window.addEventListener('resize', queueDraw);
  }

  // Moving the window to a screen with another pixel ratio needs the canvas redrawn.
  let dprQuery = null;
  function onDprChange() {
    drawnKey = '';
    queueDraw();
    watchDpr();
  }
  function watchDpr() {
    dprQuery?.removeEventListener?.('change', onDprChange);
    dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null;
    dprQuery?.addEventListener?.('change', onDprChange);
  }
  watchDpr();

  if (saved) {
    try {
      remix.setSettings(saved);
    } catch (err) {
      console.error('Rythmik: saved remix', err);
    }
  }
  const unsubscribe = remix.onChange(() => {
    followSync();
    render();
  });
  render();

  return {
    el: view,
    setActive(on) {
      active = on;
      if (on) {
        drawnKey = '';
        queueDraw();
      }
      updateLoop();
    },
    setLocked(on) {
      lockedByTake = on;
      if (on) draft = null;
      render();
    },
    /** A file dropped anywhere while REMIX is on screen. */
    dropFile(file) {
      if (isLocked()) {
        setMsg(loadMsg, 'A take is recording. Load the song after it.', true);
        return;
      }
      loadFile(file);
    },
    destroy() {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', queueDraw);
      dprQuery?.removeEventListener?.('change', onDprChange);
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(tapTimer);
      unsubscribe();
    },
    /** Esc stops the song while REMIX is on screen. */
    stop() {
      if (!remix.isPlaying) return false;
      playGen++;
      starting = false;
      remix.stop();
      render();
      return true;
    },
  };
}
