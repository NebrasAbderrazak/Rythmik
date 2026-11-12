import {
  MAX_SAMPLES,
  MAX_SAMPLE_SECONDS,
  MAX_SOURCE_SECONDS,
  MAX_SOURCES,
  MAX_RECORD_SECONDS,
} from '../audio/sampler.js';
import { createKnob } from './knob.js';
import { helpLabel, helpTip } from './helptip.js';
import { parseRoute } from './router.js';
import { el, led, setUnavailable, isUnavailable } from './dom.js';
import './sampler.css';

export const PANEL_ID = 'rk-sampler';

const MAX_TRACKS = 16;
const RECORD_CHOICES = [2, 4, MAX_RECORD_SECONDS];
const DEFAULT_RECORD = 4;
const MIN_REGION = 0.02;
const HANDLE_STEP = 0.01;
const HANDLE_BIG_STEP = 0.1;
const HANDLE_PAGE_STEP = 0.5;
const DRAG_PX = 4;
const CHOP_MAX = 8;
const FADE_MAX_MS = 500;
const HIT_MS = 140;
const CONFIRM_MS = 4000;
const WAVE_IN = '#cfc5b4';
const WAVE_OUT = '#6a6157';
const SLICE_LINE = 'rgba(240, 233, 221, 0.35)';
const OPEN_KEY = 'rythmik:samplesOpen';
const COUNT_FROM = 3;
const COUNT_STEP_MS = 700;

const MESSAGES = {
  'decode-failed': 'Could not read that file as audio. Try a WAV, MP3, OGG or M4A file.',
  'too-long': `That sound is longer than ${MAX_SOURCE_SECONDS} seconds. Pick a shorter file or trim it first.`,
  'not-audio': 'That is not an audio file.',
  'mic-denied': 'Microphone access is blocked. Open the site settings (the icon left of the address bar), set Microphone to Allow, then try again.',
  'mic-unavailable': 'No microphone found. Plug one in or close other apps using it, then try again.',
  'mic-busy': 'The mic is in use by another app or blocked by Windows privacy settings.',
  'mic-closed': 'The mic closed before recording started. Try again.',
  'no-mic': 'Recording is not available here. Load a sound instead.',
  busy: 'The mic is busy with a take in BOOTH. Try again when it is done.',
  silent: 'Nothing was heard. Move closer to the mic or speak louder, then try again.',
  'no-take': 'That take is gone. Pick another one.',
  'no-source': 'That recording is gone. Bring in a new one.',
};
const TOO_MANY_SOURCES = `You already have ${MAX_SOURCES} recordings to cut from. Remove one to bring in another.`;
const TOO_MANY_SAMPLES = `You have ${MAX_SAMPLES} sounds, the most there can be. Delete one to make room.`;

/** Plain words for a sampler error. kind: 'source' (bringing a sound in) or 'sample' (making a sound). */
export function samplerErrorText(err, kind = 'source') {
  const code = err?.message;
  if (code === 'too-many') return kind === 'sample' ? TOO_MANY_SAMPLES : TOO_MANY_SOURCES;
  return MESSAGES[code] || (kind === 'sample' ? 'Could not make that sound.' : 'Could not bring that sound in.');
}

let mounted = null; // the panel on the page, so revealSampler can open it

function readOpen(store) {
  try {
    const v = store?.getItem(OPEN_KEY);
    return v === 'true' ? true : v === 'false' ? false : null;
  } catch {
    return null;
  }
}

function writeOpen(store, on) {
  try {
    store?.setItem(OPEN_KEY, String(on));
  } catch {
    // storage blocked: the choice lasts for this visit
  }
}

function defaultStore() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Shows the SAMPLES panel in BEAT, opened, and moves focus to it. */
export function revealSampler() {
  mounted?.setOpen(true);
  const focusPanel = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || panel.closest('[hidden]')) return;
    panel.focus({ preventScroll: true });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    panel.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  };
  if (parseRoute(location.hash) === 'beat' && location.hash) {
    focusPanel();
    return;
  }
  window.addEventListener('hashchange', focusPanel, { once: true });
  location.hash = '#beat';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const secs = (t) => `${(Number(t) || 0).toFixed(2)} s`;
const semis = (v) => `${v > 0 ? '+' : ''}${v} st`;

/**
 * The SAMPLES panel. `sampler` comes from createSampler(engine, { booth }); `booth` is the
 * booth engine (takes, clip progress). Call setActive(true) while the panel is on screen.
 */
export function mountSampler(sampler, engine, { booth = null, store = defaultStore(), countdownStep = COUNT_STEP_MS } = {}) {
  let active = false;
  let offs = [];
  let selected = null; // source id shown in the editor
  let known = new Set(); // source ids already seen, so new ones get selected
  const regions = new Map(); // source id -> { start, end }
  const chops = new Map(); // source id -> { slices: [{ start, end }], picked: Set<number> }
  let tracks = [];
  let recordSeconds = DEFAULT_RECORD;
  let loadingName = '';
  let takesOpen = false;
  const savedOpen = readOpen(store);
  let open = savedOpen === true;
  let hadSounds = false;
  let countdown = null; // { n, timer, resolve, cancelled } before a mic recording
  let escOn = false;
  let rafId = 0;
  let drawQueued = false;
  let drawnKey = '';
  let draft = null;
  let drag = null;
  let sourceKeysKey = '';
  let takeKeysKey = '';
  let resizeObs = null;
  let dprQuery = null;

  // ---- get a sound ----

  const fileInput = el('input', { type: 'file', accept: 'audio/*', hidden: true, tabindex: -1, 'aria-hidden': 'true' });
  const recordLed = led();
  const recordLabel = el('span', { text: `Record (up to ${MAX_RECORD_SECONDS} s)` });
  const recordBtn = el('button', { type: 'button', class: 'rk-key rk-key--led rk-key--big rk-smp__get-key', 'data-smp': 'record', 'aria-describedby': 'rk-smp-record-why' }, [
    recordLed,
    recordLabel,
  ]);
  const lengthKeys = RECORD_CHOICES.map((n) => {
    const btn = el('button', { type: 'button', class: 'rk-key rk-key--led', 'aria-pressed': 'false', 'aria-label': `${n} seconds` }, [
      led(),
      el('span', { text: `${n} s` }),
    ]);
    btn.addEventListener('click', () => {
      if (sampler.recording) return;
      recordSeconds = n;
      renderGet();
    });
    return { btn, n };
  });
  const loadBtn = el('button', { type: 'button', class: 'rk-key rk-key--big rk-smp__get-key', 'data-smp': 'load' }, [
    el('span', { text: 'Load a sound' }),
  ]);
  const takeBtn = el('button', {
    type: 'button',
    class: 'rk-key rk-key--big rk-smp__get-key',
    'aria-expanded': 'false',
    'aria-controls': 'rk-smp-takes',
    'aria-describedby': 'rk-smp-take-why',
    'data-smp': 'take',
  }, [el('span', { text: 'From a Booth take' })]);
  const takeWhy = el('p', { class: 'rk-hint', id: 'rk-smp-take-why' });
  const takeList = el('div', { class: 'rk-btnrow rk-smp__takes', id: 'rk-smp-takes', role: 'group', 'aria-label': 'Booth takes', hidden: true });
  const getWhy = el('p', { class: 'rk-note-line', hidden: true, text: TOO_MANY_SOURCES });
  const recordWhy = el('p', { class: 'rk-hint', id: 'rk-smp-record-why', hidden: true });
  const intro = el('p', { class: 'rk-smp__intro', text: 'Make drum sounds from your own voice or any short audio file. Start with one of these:' });
  const progress = el('p', { class: 'rk-smp__busy', role: 'status' });
  const getBlock = el('div', { class: 'rk-smp__get' }, [
    intro,
    el('div', { class: 'rk-smp__getkeys' }, [
      el('div', { class: 'rk-smp__getcell' }, [
        el('span', { class: 'rk-pair' }, [recordBtn, helpTip('smpRecord')]),
        el('div', { class: 'rk-btnrow rk-smp__lengths' }, [
          helpLabel('smpLength', { id: 'rk-smp-length' }),
          el('span', { class: 'rk-btnrow', role: 'group', 'aria-labelledby': 'rk-smp-length' }, lengthKeys.map((k) => k.btn)),
        ]),
        recordWhy,
      ]),
      el('div', { class: 'rk-smp__getcell' }, [
        el('span', { class: 'rk-pair' }, [loadBtn, helpTip('smpLoad')]),
        el('p', { class: 'rk-hint', text: 'or drop an audio file on this panel' }),
      ]),
      el('div', { class: 'rk-smp__getcell' }, [
        el('span', { class: 'rk-pair' }, [takeBtn, helpTip('smpFromTake')]),
        takeWhy,
      ]),
    ]),
    takeList,
    getWhy,
    progress,
    el('p', { class: 'rk-hint', text: `Sounds stay on this computer; nothing is uploaded. Up to ${MAX_SAMPLES} sounds, ${MAX_SAMPLE_SECONDS} s each.` }),
  ]);

  // ---- source editor ----

  const sourceKeys = el('span', { class: 'rk-btnrow', role: 'group', 'aria-labelledby': 'rk-smp-sources' });
  const removeSourceBtn = el('button', { type: 'button', class: 'rk-key', text: 'Remove' });
  const canvas = el('canvas', { class: 'rk-wave__canvas', 'aria-hidden': 'true' });
  const regionBox = el('div', { class: 'rk-wave__region', 'aria-hidden': 'true' });
  const sliceLayer = el('div', { class: 'rk-smp__slicemarks', 'aria-hidden': 'true' });
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
  const startHandle = handle('start', 'Region start');
  const endHandle = handle('end', 'Region end');
  const wave = el('div', { class: 'rk-wave rk-smp__wave' }, [canvas, sliceLayer, regionBox, startHandle, endHandle]);
  const regionInfo = el('p', { class: 'rk-smp__regioninfo' });
  const playLed = led();
  const playLabel = el('span', { text: 'Play region' });
  const playBtn = el('button', { type: 'button', class: 'rk-key rk-key--led' }, [playLed, playLabel]);
  const chopBtn = el('button', { type: 'button', class: 'rk-key', text: 'Chop' });
  const sliceKeys = el('span', { class: 'rk-smp__slicekeys', role: 'group', 'aria-labelledby': 'rk-smp-slices' });
  const addAllBtn = el('button', { type: 'button', class: 'rk-key', 'aria-describedby': 'rk-smp-add-why' }, [el('span', { text: 'Add all slices' })]);
  const sliceNote = el('p', { class: 'rk-hint' });
  const sliceBlock = el('div', { class: 'rk-smp__slices', hidden: true }, [
    helpLabel('smpSlices', { id: 'rk-smp-slices' }),
    sliceKeys,
    el('span', { class: 'rk-pair' }, [addAllBtn, helpTip('smpAddAll')]),
    sliceNote,
  ]);
  const nameInput = el('input', { type: 'text', id: 'rk-smp-name', class: 'rk-smp__text', maxlength: 40, autocomplete: 'off', spellcheck: 'false' });
  const addLabel = el('span', { text: 'Add as sound' });
  const addBtn = el('button', { type: 'button', class: 'rk-key rk-key--big', 'aria-describedby': 'rk-smp-add-why' }, [addLabel]);
  const addWhy = el('p', { class: 'rk-hint', id: 'rk-smp-add-why' });
  const editor = el('div', { class: 'rk-smp__editor', hidden: true }, [
    el('div', { class: 'rk-btnrow' }, [
      helpLabel('smpSources', { id: 'rk-smp-sources' }),
      sourceKeys,
      el('span', { class: 'rk-pair' }, [removeSourceBtn, helpTip('smpRemoveSource')]),
    ]),
    el('div', { class: 'rk-btnrow' }, [helpLabel('smpWave'), helpLabel('smpRegion')]),
    wave,
    regionInfo,
    el('div', { class: 'rk-btnrow' }, [
      el('span', { class: 'rk-pair' }, [playBtn, helpTip('smpPlayRegion')]),
      el('span', { class: 'rk-pair' }, [chopBtn, helpTip('smpChop')]),
    ]),
    sliceBlock,
    el('div', { class: 'rk-field' }, [helpLabel('smpName', { forId: 'rk-smp-name' }), nameInput]),
    el('div', { class: 'rk-btnrow' }, [el('span', { class: 'rk-pair' }, [addBtn, helpTip('smpAdd')]), addWhy]),
  ]);

  // ---- samples list ----

  const countOut = el('span', { class: 'rk-smp__count' });
  const storageLine = el('p', { class: 'rk-hint rk-smp__storage' });
  const noSamples = el('p', { class: 'rk-empty', text: 'Sounds you add show up here as pads you can play and put in the beat.' });
  const list = el('ul', { class: 'rk-smp__list', 'aria-label': 'Your sounds' });
  const legend = el('div', { class: 'rk-btnrow rk-smp__legend' }, [
    helpLabel('smpPad', { sub: false }),
    helpLabel('smpVolume', { sub: false }),
    helpLabel('smpPitch', { sub: false }),
    helpLabel('smpReverse', { sub: false }),
    helpLabel('smpAddToBeat', { sub: false }),
    el('span', { class: 'rk-btnrow rk-adv' }, [
      helpLabel('smpFadeIn', { sub: false }),
      helpLabel('smpFadeOut', { sub: false }),
      helpLabel('smpStartEnd', { sub: false }),
      helpLabel('smpRename', { sub: false }),
      helpLabel('smpDelete', { sub: false }),
    ]),
  ]);
  const samplesBlock = el('div', { class: 'rk-smp__samples', hidden: true }, [
    el('div', { class: 'rk-btnrow rk-smp__sampleshead' }, [
      el('h4', { class: 'rk-silk', text: 'Sounds' }),
      countOut,
      el('span', { class: 'rk-pair' }, [storageLine, helpTip('smpStorage')]),
    ]),
    noSamples,
    legend,
    list,
  ]);

  const msg = el('p', { class: 'rk-msg', role: 'status' });
  const openLed = led();
  const openBtn = el('button', {
    type: 'button',
    class: 'rk-key rk-key--led rk-smp__open',
    'aria-expanded': 'false',
    'aria-controls': 'rk-smp-body',
  }, [openLed, el('span', { text: 'Your own sounds' })]);
  const openLine = el('p', { class: 'rk-hint rk-smp__openline' });
  const body = el('div', { class: 'rk-smp__body', id: 'rk-smp-body', hidden: true }, [getBlock, editor, samplesBlock, msg, fileInput]);
  const panel = el('section', {
    class: 'rk-module rk-module--col rk-module--wide rk-smp',
    id: PANEL_ID,
    tabindex: -1,
    'aria-labelledby': 'rk-smp-h',
  }, [
    el('h3', { class: 'rk-silk', id: 'rk-smp-h', text: 'Samples' }),
    el('div', { class: 'rk-btnrow rk-smp__openrow' }, [el('span', { class: 'rk-pair' }, [openBtn, helpTip('smpPanel')]), openLine]),
    body,
  ]);

  // ---- helpers ----

  function setMsg(t, error = false) {
    msg.textContent = t;
    msg.classList.toggle('is-error', error);
  }

  function setBusy(t) {
    if (progress.dataset.text === t) return;
    progress.dataset.text = t;
    progress.replaceChildren(...(t ? [led('is-on is-blink'), el('span', { text: t })] : []));
  }

  const sourceInfo = () => sampler.sources.find((s) => s.id === selected) || null;
  const duration = () => sourceInfo()?.duration || 0;
  const sourcesFull = () => sampler.sources.length >= MAX_SOURCES;
  const samplesFull = () => sampler.samples.length >= MAX_SAMPLES;
  const takes = () => (booth && Array.isArray(booth.takes) ? booth.takes : []);
  const boothBusy = () => !!booth && booth.state != null && booth.state !== 'idle';
  const currentRegion = () => draft || regions.get(selected) || { start: 0, end: 0 };

  function defaultRegion(d) {
    return { start: 0, end: Math.min(d, MAX_SAMPLE_SECONDS) };
  }

  function selectSource(id) {
    const info = sampler.sources.find((s) => s.id === id);
    if (info && !regions.has(id)) regions.set(id, defaultRegion(info.duration));
    if (selected === id) return;
    selected = id;
    draft = null;
    drawnKey = '';
    nameInput.value = '';
    // last: stopping emits a change, which renders again
    if (sampler.previewSourceId && sampler.previewSourceId !== id) sampler.stopRegion?.();
  }

  // New sources (recorded, loaded, from a take, sent from BOOTH) open in the editor.
  function syncSources() {
    const ids = sampler.sources.map((s) => s.id);
    const fresh = ids.filter((id) => !known.has(id));
    known = new Set(ids);
    for (const id of [...regions.keys()]) if (!known.has(id)) regions.delete(id);
    for (const id of [...chops.keys()]) if (!known.has(id)) chops.delete(id);
    if (fresh.length) selectSource(fresh[fresh.length - 1]);
    else if (!known.has(selected)) selected = null;
    if (!selected && ids.length) selectSource(ids[ids.length - 1]);
  }

  function readTracks() {
    try {
      const p = engine.getPattern?.();
      tracks = Array.isArray(p?.tracks) ? p.tracks : [];
    } catch {
      tracks = [];
    }
  }

  // ---- bringing sounds in ----

  async function loadFile(file) {
    if (!file || loadingName || sampler.recording) return;
    if (file.type && !/^(audio|video)\//.test(file.type)) {
      setMsg(MESSAGES['not-audio'], true);
      return;
    }
    if (sourcesFull()) {
      setMsg(TOO_MANY_SOURCES, true);
      return;
    }
    loadingName = file.name || 'sound';
    setMsg('');
    render();
    try {
      const info = await sampler.fromFile(file);
      syncSources();
      if (info?.id) selectSource(info.id);
      setMsg(`Loaded ${info?.name || loadingName}. Drag across the part you want, or press Chop.`);
    } catch (err) {
      setMsg(samplerErrorText(err, 'source'), true);
      if (!MESSAGES[err?.message] && err?.message !== 'too-many') console.error('Rythmik: load sound', err);
    }
    loadingName = '';
    render();
  }

  function pickFile() {
    if (isUnavailable(loadBtn)) return;
    fileInput.click();
  }

  const isRecording = () => !!countdown || !!sampler.recording;

  function toggleRecord() {
    if (countdown) cancelCountdown();
    else if (sampler.recording) sampler.cancelRecord?.();
    else startRecord();
  }

  function cancelCountdown() {
    const cd = countdown;
    if (!cd) return;
    cd.cancelled = true;
    countdown = null;
    clearTimeout(cd.timer);
    cd.resolve?.();
    setMsg('Recording cancelled.');
    render();
  }

  const waitStep = (cd) => new Promise((resolve) => {
    cd.resolve = resolve;
    cd.timer = setTimeout(resolve, countdownStep);
  });

  // Opens the mic inside the click (the browser may ask), counts 3-2-1, then records.
  async function startRecord() {
    if (isUnavailable(recordBtn)) return;
    setMsg('');
    const cd = { n: COUNT_FROM, timer: 0, resolve: null, cancelled: false };
    countdown = cd;
    render();
    try {
      if (booth && !booth.micOpen && typeof booth.openMic === 'function') {
        setBusy('Opening the mic…');
        await booth.openMic();
      }
    } catch (err) {
      if (cd.cancelled) return;
      countdown = null;
      setMsg(samplerErrorText(err, 'source'), true);
      render();
      return;
    }
    for (let n = COUNT_FROM; n > 0; n--) {
      if (cd.cancelled) return;
      cd.n = n;
      setBusy(`Recording in ${n}…`);
      await waitStep(cd);
    }
    if (cd.cancelled) return;
    countdown = null;
    let job;
    try {
      job = sampler.record({ seconds: recordSeconds });
    } catch (err) {
      job = Promise.reject(err);
    }
    render();
    try {
      const info = await job;
      if (!info) {
        setMsg('Recording cancelled.');
      } else {
        syncSources();
        selectSource(info.id);
        setMsg(`Recorded ${info.name} (${secs(info.duration)}). Drag across the part you want, or press Chop.`);
      }
    } catch (err) {
      setMsg(samplerErrorText(err, 'source'), true);
      if (!MESSAGES[err?.message] && err?.message !== 'too-many') console.error('Rythmik: record sound', err);
    }
    render();
  }

  // Esc cancels a sampler recording from anywhere. Capture phase plus preventDefault,
  // so the booth and remix Esc handlers (which skip handled events) leave it alone.
  function onEsc(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || !isRecording()) return;
    e.preventDefault();
    toggleRecord();
  }

  function syncEsc() {
    const need = isRecording();
    if (need === escOn) return;
    escOn = need;
    if (need) document.addEventListener('keydown', onEsc, true);
    else document.removeEventListener('keydown', onEsc, true);
  }

  function useTake(take) {
    try {
      const info = sampler.fromTake(take.id);
      takesOpen = false;
      syncSources();
      if (info?.id) selectSource(info.id);
      setMsg(`${take.name} is ready to cut. Drag across the part you want, or press Chop.`);
      render();
      (sourceKeys.querySelector('[aria-pressed=true]') || panel).focus();
    } catch (err) {
      setMsg(samplerErrorText(err, 'source'), true);
      render();
    }
  }

  // ---- region ----

  function moveEdge(which, t, r) {
    const d = duration();
    if (which === 'start') return { ...r, start: clamp(t, Math.max(0, r.end - MAX_SAMPLE_SECONDS), r.end - MIN_REGION) };
    return { ...r, end: clamp(t, r.start + MIN_REGION, Math.min(d, r.start + MAX_SAMPLE_SECONDS)) };
  }

  function setRegion(r, { fromSlice = false } = {}) {
    if (!selected) return;
    regions.set(selected, { start: r.start, end: r.end });
    if (!fromSlice) chops.get(selected)?.picked.clear();
    if (sampler.previewSourceId === selected) sampler.stopRegion?.();
    renderEditor();
  }

  function timeAt(clientX) {
    const rect = wave.getBoundingClientRect();
    const f = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
    return f * duration();
  }

  wave.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !selected) return;
    const edge = e.target instanceof Element ? e.target.closest('[data-handle]') : null;
    const r = regions.get(selected);
    const t = timeAt(e.clientX);
    let mode = 'new';
    if (edge) mode = edge.dataset.handle;
    else if (t >= r.start && t <= r.end) mode = 'move';
    const grab = edge ? t - (mode === 'start' ? r.start : r.end) : 0;
    drag = { id: e.pointerId, mode, x: e.clientX, t0: t, grab, r, moved: false };
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
    const { r } = drag;
    const d = duration();
    if (drag.mode === 'start' || drag.mode === 'end') {
      draft = moveEdge(drag.mode, t - drag.grab, r);
    } else if (drag.mode === 'move') {
      const len = r.end - r.start;
      const start = clamp(r.start + (t - drag.t0), 0, d - len);
      draft = { start, end: start + len };
    } else {
      let start = Math.min(drag.t0, t);
      let end = Math.max(drag.t0, t);
      if (end - start > MAX_SAMPLE_SECONDS) {
        if (t > drag.t0) end = start + MAX_SAMPLE_SECONDS;
        else start = end - MAX_SAMPLE_SECONDS;
      }
      if (end - start < MIN_REGION) end = Math.min(d, start + MIN_REGION);
      draft = { start, end };
    }
    renderRegion();
  });

  function endDrag(e, commit) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    wave.classList.remove('is-dragging');
    const next = draft;
    draft = null;
    if (commit && d.moved && next) setRegion(next);
    else if (commit && !d.moved && d.mode === 'move') playRegion();
    else renderRegion();
  }
  wave.addEventListener('pointerup', (e) => endDrag(e, true));
  wave.addEventListener('pointercancel', (e) => endDrag(e, false));
  wave.addEventListener('lostpointercapture', (e) => endDrag(e, false));

  function onHandleKey(e) {
    const which = e.currentTarget.dataset.handle;
    const r = regions.get(selected);
    if (!r) return;
    let t = which === 'start' ? r.start : r.end;
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
    setRegion(moveEdge(which, Math.round(t * 1000) / 1000, r));
  }
  startHandle.addEventListener('keydown', onHandleKey);
  endHandle.addEventListener('keydown', onHandleKey);

  function playRegion(r = regions.get(selected)) {
    if (!selected || !r) return;
    Promise.resolve(sampler.playRegion(selected, { start: r.start, end: r.end })).catch((err) => {
      console.error('Rythmik: play region', err);
      setMsg('Could not play that part.', true);
    });
  }

  function togglePlay() {
    if (!selected) return;
    if (sampler.previewSourceId === selected) sampler.stopRegion();
    else playRegion();
  }

  // ---- chop ----

  function chop() {
    if (!selected) return;
    let slices = [];
    try {
      slices = sampler.chop(selected, { max: CHOP_MAX }) || [];
    } catch (err) {
      setMsg(samplerErrorText(err, 'source'), true);
      return;
    }
    chops.set(selected, { slices, picked: new Set() });
    setMsg(slices.length
      ? `Found ${slices.length} ${slices.length === 1 ? 'slice' : 'slices'}. Tap a number to hear it and pick it.`
      : 'No separate hits found. Mark the part you want on the waveform instead.');
    renderEditor();
    sliceKeys.querySelector('button')?.focus();
  }

  function toggleSlice(i) {
    const c = chops.get(selected);
    const s = c?.slices[i];
    if (!s) return;
    if (c.picked.has(i)) {
      c.picked.delete(i);
      if (sampler.previewSourceId === selected) sampler.stopRegion();
      renderEditor();
      return;
    }
    c.picked.add(i);
    const r = { start: s.start, end: Math.min(s.end, s.start + MAX_SAMPLE_SECONDS) };
    setRegion(r, { fromSlice: true });
    playRegion(r);
  }

  // ---- making sounds ----

  function baseName() {
    return nameInput.value.replace(/\s+/g, ' ').trim() || sourceInfo()?.name || 'Sound';
  }

  function addSounds(parts) {
    if (!selected || !parts.length) return;
    const made = [];
    let skipped = 0;
    let error = null;
    for (const p of parts) {
      if (samplesFull()) { skipped = parts.length - made.length; break; }
      try {
        const id = sampler.createSample(selected, { start: p.start, end: p.end, name: p.name });
        made.push(id);
      } catch (err) {
        if (err?.message === 'too-many') { skipped = parts.length - made.length; break; }
        error = err;
        break;
      }
    }
    if (error && !made.length) {
      setMsg(samplerErrorText(error, 'sample'), true);
    } else if (!made.length) {
      setMsg(TOO_MANY_SAMPLES, true);
    } else {
      const first = sampler.getSample?.(made[0]) || sampler.samples.find((s) => s.id === made[0]);
      let t = made.length === 1
        ? `Added ${first?.name || 'the sound'}. Tap its pad to hear it, then press Add to beat.`
        : `Added ${made.length} sounds. Tap their pads to hear them.`;
      if (skipped) t += ` ${skipped} did not fit: ${MAX_SAMPLES} sounds is the most.`;
      setMsg(t, !!skipped);
      chops.get(selected)?.picked.clear();
    }
    render();
  }

  function addCurrent() {
    if (isUnavailable(addBtn)) return;
    const c = chops.get(selected);
    const base = baseName();
    if (c && c.picked.size) {
      const picks = [...c.picked].sort((a, b) => a - b);
      addSounds(picks.map((i) => ({ ...c.slices[i], name: `${base} ${i + 1}` })));
    } else {
      const r = regions.get(selected);
      addSounds([{ ...r, name: nameInput.value.trim() ? base : '' }]);
    }
  }

  function addAll() {
    if (isUnavailable(addAllBtn)) return;
    const c = chops.get(selected);
    if (!c?.slices.length) return;
    const base = baseName();
    addSounds(c.slices.map((s, i) => ({ ...s, name: `${base} ${i + 1}` })));
  }

  function removeSource() {
    if (!selected) return;
    const name = sourceInfo()?.name || 'Recording';
    sampler.removeSource(selected);
    syncSources();
    setMsg(`${name} removed. Sounds made from it keep working.`);
    render();
    (sourceKeys.querySelector('[aria-pressed=true]') || recordBtn).focus();
  }

  // ---- sample cards ----

  const cards = new Map();

  function makeCard(s) {
    const id = s.id;
    const padLed = led();
    const pad = el('button', { type: 'button', class: 'rk-pad rk-smp-card__pad', 'data-sample': id }, [padLed]);
    const name = el('span', { class: 'rk-smp-card__name' });
    const info = el('span', { class: 'rk-smp-card__info' });
    const tag = el('span', { class: 'rk-smp-card__tag' }, [led('is-on'), el('span', { text: 'In the beat' })]);
    let hitTimer = 0;
    pad.addEventListener('click', () => {
      sampler.audition(id);
      pad.classList.add('is-hit');
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => pad.classList.remove('is-hit'), HIT_MS);
    });

    const update = (partial) => sampler.update(id, partial);
    const vol = createKnob({
      label: 'Volume',
      caption: 'Volume',
      size: 'sm',
      value: 80,
      defaultValue: 80,
      onInput: (v) => update({ gain: v / 100 }),
    });
    const pitch = createKnob({
      label: 'Pitch',
      caption: 'Pitch',
      size: 'sm',
      min: -12,
      max: 12,
      value: 0,
      defaultValue: 0,
      bigStep: 12,
      format: semis,
      onInput: (v) => update({ pitch: v }),
    });
    pitch.el.classList.add('rk-knob--bipolar');
    const fadeIn = createKnob({
      label: 'Fade in',
      caption: 'Fade in',
      size: 'sm',
      max: FADE_MAX_MS,
      step: 5,
      bigStep: 50,
      format: (v) => `${v} ms`,
      onInput: (v) => update({ fadeIn: v / 1000 }),
    });
    const fadeOut = createKnob({
      label: 'Fade out',
      caption: 'Fade out',
      size: 'sm',
      max: FADE_MAX_MS,
      step: 5,
      value: 10,
      defaultValue: 10,
      bigStep: 50,
      format: (v) => `${v} ms`,
      onInput: (v) => update({ fadeOut: v / 1000 }),
    });

    const reverse = el('button', { type: 'button', class: 'rk-key rk-key--led rk-switch', role: 'switch', 'aria-checked': 'false' }, [
      led(),
      el('span', { text: 'Reverse' }),
    ]);
    reverse.addEventListener('click', () => update({ reverse: reverse.getAttribute('aria-checked') !== 'true' }));

    const whyId = `rk-smp-${id}-why`;
    const addLed = led();
    const addText = el('span', { text: 'Add to beat' });
    const add = el('button', { type: 'button', class: 'rk-key rk-key--led', 'aria-describedby': whyId, 'data-add': id }, [addLed, addText]);
    const why = el('p', { class: 'rk-hint rk-smp-card__why', id: whyId });
    add.addEventListener('click', () => {
      if (isUnavailable(add)) return;
      const ok = engine.addTrack(id);
      readTracks();
      const nm = sampler.getSample?.(id)?.name || 'The sound';
      if (ok === false) setMsg(tracks.includes(id) ? `${nm} is already in the beat.` : 'The beat is full: 16 rows is the most.', true);
      else setMsg(`${nm} is a row in the beat now. Tap the steps on its row in the grid.`);
      renderSamples();
      // the key is disabled once the sound is in the beat; keep focus on this card
      if (add.disabled) pad.focus();
    });

    const numInput = (label) => el('input', {
      type: 'number',
      class: 'rk-lcd__input rk-lcd__input--wide rk-smp-card__num',
      min: 0,
      step: 0.001,
      inputmode: 'decimal',
      'aria-label': label,
    });
    const startIn = numInput('Start in seconds');
    const endIn = numInput('End in seconds');
    const commitNum = (input, key) => {
      const v = Number(input.value);
      if (input.value !== '' && Number.isFinite(v)) update({ [key]: v });
      renderSamples();
    };
    startIn.addEventListener('change', () => commitNum(startIn, 'start'));
    endIn.addEventListener('change', () => commitNum(endIn, 'end'));

    const rename = el('input', { type: 'text', class: 'rk-smp__text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Rename' });
    const commitName = () => {
      const v = rename.value.trim();
      if (v) update({ name: v });
      renderSamples();
    };
    rename.addEventListener('change', commitName);
    rename.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitName();
    });

    const delText = el('span', { text: 'Delete' });
    const del = el('button', { type: 'button', class: 'rk-key rk-smp-card__del' }, [delText]);
    let confirmTimer = 0;
    const resetDelete = () => {
      clearTimeout(confirmTimer);
      del.removeAttribute('data-confirm');
      delText.textContent = 'Delete';
    };
    del.addEventListener('click', () => {
      if (!del.hasAttribute('data-confirm')) {
        del.setAttribute('data-confirm', '');
        delText.textContent = 'Press again to delete';
        confirmTimer = setTimeout(resetDelete, CONFIRM_MS);
        return;
      }
      resetDelete();
      deleteSample(id);
    });
    del.addEventListener('blur', resetDelete);

    const li = el('li', { class: 'rk-smp-card', 'data-sample': id }, [
      el('div', { class: 'rk-smp-card__top' }, [pad, el('div', { class: 'rk-smp-card__title' }, [name, info, tag])]),
      el('div', { class: 'rk-smp-card__knobs' }, [vol.el, pitch.el]),
      el('div', { class: 'rk-btnrow' }, [reverse, add]),
      why,
      el('div', { class: 'rk-smp-card__adv rk-adv' }, [
        el('div', { class: 'rk-smp-card__knobs' }, [fadeIn.el, fadeOut.el]),
        el('div', { class: 'rk-btnrow' }, [
          el('span', { class: 'rk-lcd' }, [el('span', { class: 'rk-lcd__unit', text: 'Start' }), startIn, el('span', { class: 'rk-lcd__unit', text: 's' })]),
          el('span', { class: 'rk-lcd' }, [el('span', { class: 'rk-lcd__unit', text: 'End' }), endIn, el('span', { class: 'rk-lcd__unit', text: 's' })]),
        ]),
        el('div', { class: 'rk-btnrow' }, [rename, del]),
      ]),
    ]);

    return {
      li,
      add,
      pad,
      update(sm) {
        const nm = sm.name;
        if (name.textContent !== nm) {
          name.textContent = nm;
          pad.setAttribute('aria-label', `Play ${nm}`);
          vol.dial.setAttribute('aria-label', `Volume, ${nm}`);
          pitch.dial.setAttribute('aria-label', `Pitch, ${nm}`);
          fadeIn.dial.setAttribute('aria-label', `Fade in, ${nm}`);
          fadeOut.dial.setAttribute('aria-label', `Fade out, ${nm}`);
          reverse.setAttribute('aria-label', `Reverse ${nm}`);
          add.setAttribute('aria-label', `Add ${nm} to beat`);
          startIn.setAttribute('aria-label', `Start of ${nm}, seconds`);
          endIn.setAttribute('aria-label', `End of ${nm}, seconds`);
          rename.setAttribute('aria-label', `Rename ${nm}`);
          del.setAttribute('aria-label', `Delete ${nm}`);
        }
        const inBeat = tracks.includes(sm.id);
        info.textContent = `${secs(sm.duration)}${sm.reverse ? ', reversed' : ''}`;
        tag.hidden = !inBeat;
        vol.setValue(Math.round(sm.gain * 100));
        pitch.setValue(sm.pitch);
        fadeIn.setValue(Math.round(sm.fadeIn * 1000));
        fadeOut.setValue(Math.round(sm.fadeOut * 1000));
        reverse.setAttribute('aria-checked', String(!!sm.reverse));
        if (document.activeElement !== startIn) startIn.value = sm.start.toFixed(3);
        if (document.activeElement !== endIn) endIn.value = sm.end.toFixed(3);
        if (document.activeElement !== rename) rename.value = nm;

        let reason = '';
        if (typeof engine.addTrack !== 'function') reason = 'The beat cannot take new rows here.';
        else if (inBeat) reason = 'Already a row in the beat.';
        else if (tracks.length >= MAX_TRACKS) reason = `The beat has ${MAX_TRACKS} rows, the most it can have. Remove a row first.`;
        addText.textContent = inBeat ? 'In the beat' : 'Add to beat';
        addLed.classList.toggle('is-on', inBeat);
        add.disabled = !!reason;
        if (why.textContent !== reason) why.textContent = reason;
        why.hidden = !reason || inBeat;
      },
      dispose() {
        clearTimeout(hitTimer);
        clearTimeout(confirmTimer);
      },
    };
  }

  function deleteSample(id) {
    const all = sampler.samples;
    const idx = all.findIndex((s) => s.id === id);
    const next = all[idx + 1] || all[idx - 1];
    const nm = all[idx]?.name || 'The sound';
    sampler.remove(id);
    readTracks();
    setMsg(`${nm} deleted.`);
    render();
    const target = next ? cards.get(next.id)?.pad : null;
    (target || panel).focus();
  }

  // ---- waveform drawing ----

  function queueDraw() {
    if (drawQueued || !active) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      drawWave();
    });
  }

  function drawWave() {
    if (!active || !selected || editor.hidden) return;
    const w = Math.round(wave.clientWidth);
    const h = Math.round(wave.clientHeight);
    if (!(w > 0 && h > 0)) return;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const r = currentRegion();
    const c = chops.get(selected);
    const picks = c && c.picked.size ? [...c.picked].sort((x, y) => x - y).map((i) => c.slices[i]).filter(Boolean) : null;
    const key = `${selected}:${w}x${h}@${dpr}:${r.start.toFixed(3)}:${r.end.toFixed(3)}:${c ? c.slices.length : 0}:${picks ? [...c.picked].join(',') : ''}`;
    if (key === drawnKey) return;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    drawnKey = key;
    const peaks = sampler.getPeaks(selected, w);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const d = duration() || 1;
    const mid = h / 2;
    const amp = mid * 0.92;
    // picked slices are what gets added, so they are lit instead of the region
    const lit = (picks || [r]).map((p) => [(p.start / d) * w, (p.end / d) * w]);
    for (let x = 0; x < peaks.max.length; x++) {
      const top = mid - Math.min(1, peaks.max[x]) * amp;
      const bottom = mid - Math.max(-1, peaks.min[x]) * amp;
      ctx.fillStyle = lit.some(([a, b]) => x >= a && x < b) ? WAVE_IN : WAVE_OUT;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    if (c) {
      ctx.fillStyle = SLICE_LINE;
      for (const s of c.slices) ctx.fillRect(Math.round((s.start / d) * w), 0, 1, h);
    }
  }

  // ---- render ----

  function renderRegion() {
    const d = duration();
    const r = currentRegion();
    const pct = (t) => `${d > 0 ? (t / d) * 100 : 0}%`;
    regionBox.style.left = pct(r.start);
    regionBox.style.width = `${d > 0 ? ((r.end - r.start) / d) * 100 : 0}%`;
    startHandle.style.left = pct(r.start);
    endHandle.style.left = pct(r.end);
    const setSlider = (node, value, lo, hi) => {
      node.setAttribute('aria-valuemin', lo.toFixed(2));
      node.setAttribute('aria-valuemax', hi.toFixed(2));
      node.setAttribute('aria-valuenow', value.toFixed(2));
      node.setAttribute('aria-valuetext', secs(value));
    };
    setSlider(startHandle, r.start, Math.max(0, r.end - MAX_SAMPLE_SECONDS), Math.max(0, r.end - MIN_REGION));
    setSlider(endHandle, r.end, Math.min(d, r.start + MIN_REGION), Math.min(d, r.start + MAX_SAMPLE_SECONDS));
    regionInfo.textContent = `Region ${secs(r.start)} to ${secs(r.end)}: ${secs(r.end - r.start)} of up to ${MAX_SAMPLE_SECONDS} s`;
    queueDraw();
  }

  function renderSourceKeys() {
    const sources = sampler.sources;
    const key = sources.map((s) => `${s.id}:${s.name}`).join('|');
    if (key !== sourceKeysKey) {
      sourceKeysKey = key;
      const hadFocus = sourceKeys.contains(document.activeElement);
      sourceKeys.replaceChildren(...sources.map((s) => {
        const btn = el('button', { type: 'button', class: 'rk-key rk-key--led rk-smp__source', 'aria-pressed': 'false', 'data-source': s.id }, [
          led(),
          el('span', { class: 'rk-smp__sourcename', text: s.name }),
        ]);
        btn.addEventListener('click', () => {
          selectSource(s.id);
          render();
        });
        return btn;
      }));
      if (hadFocus) sourceKeys.querySelector('button')?.focus();
    }
    for (const btn of sourceKeys.children) btn.setAttribute('aria-pressed', String(btn.dataset.source === selected));
  }

  function renderSlices() {
    const c = chops.get(selected);
    sliceBlock.hidden = !c;
    sliceLayer.replaceChildren();
    if (!c) return;
    const d = duration() || 1;
    const count = c.slices.length;
    if (sliceKeys.childElementCount !== count || sliceKeys.dataset.source !== selected) {
      const hadFocus = sliceKeys.contains(document.activeElement);
      sliceKeys.dataset.source = selected;
      sliceKeys.replaceChildren(...c.slices.map((s, i) => {
        const btn = el('button', {
          type: 'button',
          class: 'rk-key rk-smp__slice',
          'aria-pressed': 'false',
          'aria-label': `Slice ${i + 1}, ${secs(s.start)} to ${secs(s.end)}`,
          'data-slice': i,
          text: String(i + 1),
        });
        btn.addEventListener('click', () => toggleSlice(i));
        return btn;
      }));
      if (hadFocus) sliceKeys.querySelector('button')?.focus();
    }
    [...sliceKeys.children].forEach((btn, i) => btn.setAttribute('aria-pressed', String(c.picked.has(i))));
    for (const [i, s] of c.slices.entries()) {
      const mark = el('span', { class: `rk-smp__slicemark${c.picked.has(i) ? ' is-picked' : ''}`, text: String(i + 1) });
      mark.style.left = `${(s.start / d) * 100}%`;
      mark.style.width = `${((s.end - s.start) / d) * 100}%`;
      sliceLayer.append(mark);
    }
    sliceNote.textContent = count ? '' : 'No separate hits found. Mark the part you want on the waveform instead.';
    sliceNote.hidden = !!count;
    addAllBtn.hidden = !count;
    addAllBtn.disabled = samplesFull();
  }

  function renderEditor() {
    const info = sourceInfo();
    editor.hidden = !info;
    if (!info) return;
    renderSourceKeys();
    renderRegion();
    renderSlices();
    const playing = sampler.previewSourceId === selected;
    playLed.classList.toggle('is-on', playing);
    playLabel.textContent = playing ? 'Stop' : 'Play region';
    playBtn.setAttribute('aria-label', playing ? 'Stop region' : 'Play region');
    nameInput.placeholder = info.name;
    const picked = chops.get(selected)?.picked.size || 0;
    addLabel.textContent = picked > 1 ? `Add ${picked} slices` : picked === 1 ? 'Add slice' : 'Add as sound';
    const full = samplesFull();
    addBtn.disabled = full;
    addWhy.textContent = full ? TOO_MANY_SAMPLES : '';
    addWhy.hidden = !full;
  }

  function renderStorage() {
    const n = sampler.samples.length;
    const state = sampler.storage;
    let t = '';
    if (n && state === 'saved') t = 'Saved in this browser.';
    else if (n && state === 'unsaved') t = 'Saving…';
    else if (n && state === 'unavailable') t = 'Not saved: this browser blocks storage. Sounds last until you close the tab.';
    storageLine.textContent = t;
    storageLine.parentElement.hidden = !t;
  }

  function renderSamples() {
    const all = sampler.samples;
    const ids = new Set(all.map((s) => s.id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        card.dispose();
        card.li.remove();
        cards.delete(id);
      }
    }
    all.forEach((s, i) => {
      let card = cards.get(s.id);
      if (!card) {
        card = makeCard(s);
        cards.set(s.id, card);
      }
      const at = list.children[i] || null;
      if (at !== card.li) list.insertBefore(card.li, at);
      card.update(s);
    });
    samplesBlock.hidden = !all.length && !sampler.sources.length;
    noSamples.hidden = all.length > 0;
    legend.hidden = list.hidden = all.length === 0;
    countOut.textContent = `${all.length} of ${MAX_SAMPLES} sounds`;
    renderStorage();
  }

  function renderTakeKeys() {
    const ts = takes();
    const key = ts.map((t) => `${t.id}:${t.name}`).join('|');
    if (key === takeKeysKey) return;
    takeKeysKey = key;
    takeList.replaceChildren(...ts.map((t) => {
      const btn = el('button', { type: 'button', class: 'rk-key', 'data-take': t.id }, [
        el('span', { text: t.name }),
        el('span', { class: 'rk-smp__takelen', text: secs(t.duration) }),
      ]);
      btn.addEventListener('click', () => useTake(t));
      return btn;
    }));
  }

  function renderGet() {
    const recording = isRecording();
    const full = sourcesFull();
    const empty = !sampler.sources.length && !sampler.samples.length;
    intro.hidden = !empty;
    recordLabel.textContent = recording ? 'Cancel recording' : `Record (up to ${MAX_RECORD_SECONDS} s)`;
    recordLed.classList.toggle('is-on', recording);
    recordLed.classList.toggle('is-blink', recording);
    setUnavailable(recordBtn, { hard: !recording && (full || boothBusy()), soft: !!loadingName });
    let recordReason = '';
    if (!recording && boothBusy()) recordReason = 'The Booth is recording. Record here when the take is done.';
    else if (!recording && booth?.previewTakeId != null) recordReason = 'A take is playing in BOOTH. Record stops it first.';
    if (recordWhy.textContent !== recordReason) recordWhy.textContent = recordReason;
    recordWhy.hidden = !recordReason;
    for (const k of lengthKeys) {
      k.btn.setAttribute('aria-pressed', String(k.n === recordSeconds));
      k.btn.disabled = recording;
    }
    setUnavailable(loadBtn, { hard: full || recording, soft: !!loadingName });
    const ts = takes();
    let takeReason = '';
    if (!booth) takeReason = 'Takes come from BOOTH, which is not available.';
    else if (!ts.length) takeReason = 'No takes yet: record one in BOOTH first.';
    takeBtn.disabled = !!takeReason || full || recording;
    takeWhy.textContent = takeReason;
    takeWhy.hidden = !takeReason;
    if (takeBtn.disabled) takesOpen = false;
    takeBtn.setAttribute('aria-expanded', String(takesOpen));
    takeList.hidden = !takesOpen;
    if (takesOpen) renderTakeKeys();
    getWhy.hidden = !full;
    if (loadingName) setBusy(`Loading ${loadingName}…`);
    else if (!recording) setBusy('');
    syncEsc();
  }

  function renderOpen() {
    const n = sampler.samples.length;
    const hasSounds = n > 0 || sampler.sources.length > 0;
    // sounds arriving (restored, from a take) open the panel unless it was closed on purpose
    if (hasSounds && !hadSounds && !open && savedOpen !== false) open = true;
    hadSounds = hasSounds;
    body.hidden = !open;
    openBtn.setAttribute('aria-expanded', String(open));
    openLed.classList.toggle('is-on', open);
    const line = n
      ? `${n} of ${MAX_SAMPLES} sounds.${open ? '' : ' Open to play and edit them.'}`
      : 'Record your voice or load a file and play it as a drum.';
    if (openLine.textContent !== line) openLine.textContent = line;
  }

  function setOpen(on, { remember = true } = {}) {
    const next = !!on;
    if (remember) writeOpen(store, next);
    if (next === open) return;
    open = next;
    renderOpen();
    if (open) {
      drawnKey = '';
      queueDraw();
    } else if (sampler.previewSourceId) {
      sampler.stopRegion();
    }
  }

  function render() {
    syncSources();
    renderOpen();
    renderGet();
    renderEditor();
    renderSamples();
    updateLoop();
  }

  function frame() {
    rafId = 0;
    const p = booth?.getClipProgress?.();
    if (p && p.elapsed > 0) setBusy(`Recording ${p.elapsed.toFixed(1)} of ${p.seconds} s… Esc cancels.`);
    else setBusy('Get ready…');
    updateLoop();
  }

  function updateLoop() {
    const needed = active && !!sampler.recording;
    if (needed && !rafId) rafId = requestAnimationFrame(frame);
    if (!needed && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  // ---- wiring ----

  recordBtn.addEventListener('click', toggleRecord);
  openBtn.addEventListener('click', () => setOpen(!open));
  loadBtn.addEventListener('click', pickFile);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    loadFile(file);
  });
  takeBtn.addEventListener('click', () => {
    if (takeBtn.disabled) return;
    takesOpen = !takesOpen;
    renderGet();
    if (takesOpen) takeList.querySelector('button')?.focus();
  });
  removeSourceBtn.addEventListener('click', removeSource);
  playBtn.addEventListener('click', togglePlay);
  chopBtn.addEventListener('click', chop);
  addBtn.addEventListener('click', addCurrent);
  addAllBtn.addEventListener('click', addAll);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCurrent();
  });

  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (sampler.previewSourceId) {
      e.preventDefault();
      sampler.stopRegion();
    } else if (takesOpen) {
      e.preventDefault();
      takesOpen = false;
      renderGet();
      takeBtn.focus();
    }
  });

  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = sourcesFull() ? 'none' : 'copy';
    panel.classList.add('is-dropping');
  });
  panel.addEventListener('dragleave', (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove('is-dropping');
  });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.classList.remove('is-dropping');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    setOpen(true);
    loadFile(file);
  });

  function onDprChange() {
    drawnKey = '';
    queueDraw();
    watchDpr();
  }
  function watchDpr() {
    dprQuery?.removeEventListener?.('change', onDprChange);
    dprQuery = active ? window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null : null;
    dprQuery?.addEventListener?.('change', onDprChange);
  }
  const onResize = () => queueDraw();

  render();

  const api = {
    el: panel,
    setActive(on) {
      const next = !!on;
      if (next === active) return;
      active = next;
      if (active) {
        readTracks();
        offs = [
          sampler.onChange(render),
          engine.onPatternChange?.((p) => {
            tracks = Array.isArray(p?.tracks) ? p.tracks : [];
            renderSamples();
          }),
          booth?.onChange?.(renderGet),
        ];
        if (typeof ResizeObserver === 'function') {
          resizeObs = new ResizeObserver(onResize);
          resizeObs.observe(wave);
        } else {
          window.addEventListener('resize', onResize);
        }
        watchDpr();
        drawnKey = '';
        render();
      } else {
        for (const off of offs) if (typeof off === 'function') off();
        offs = [];
        resizeObs?.disconnect();
        resizeObs = null;
        window.removeEventListener('resize', onResize);
        watchDpr();
        if (sampler.previewSourceId) sampler.stopRegion();
        if (countdown) cancelCountdown();
        drag = null;
        draft = null;
        updateLoop();
      }
    },
    /** A file dropped on the panel or handed over by the app. */
    dropFile(file) {
      setOpen(true);
      return loadFile(file);
    },
    setOpen,
    get isOpen() {
      return open;
    },
    focus() {
      panel.focus();
    },
  };
  mounted = api;
  return api;
}
