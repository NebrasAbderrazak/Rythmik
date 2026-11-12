import { TRACKS, STEPS, BASS_NOTES, MIN_BPM, MAX_BPM } from '../audio/engine.js';
import { PRESETS } from '../audio/presets.js';
import { createKnob } from './knob.js';
import { mountBooth } from './booth.js';
import {
  getDefaultStorage,
  loadSavedPattern,
  createAutosave,
  downloadPattern,
  readPatternFile,
} from './persistence.js';

const SWING_MAX = 0.6; // knob shows 0..100%
const STATUS_MS = 5000;
const PRESET_ORDER = ['afroBass', 'trap', 'boomBap', 'empty'];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function silk(text, attrs = {}) {
  return el('span', { class: 'rk-silk', ...attrs, text });
}

function led(extra = '') {
  return el('span', { class: `rk-led ${extra}`.trim(), 'aria-hidden': 'true' });
}

export function mountApp(root, engine) {
  const storage = getDefaultStorage();
  const tracks = TRACKS.map((t) => ({ ...t }));
  const bassNoteName = new Map(BASS_NOTES.map((n) => [n.midi, n.name]));

  const header = el('header', { class: 'rk-header' }, [
    el('div', { class: 'rk-brand' }, [
      el('h1', { class: 'rk-logo' }, [led('rk-led--logo'), el('span', { text: 'Rythmik' })]),
    ]),
    el('p', { class: 'rk-tagline', text: 'Make beats in your browser.' }),
  ]);

  const playLed = led('rk-led--play');
  const playLabel = el('span', { class: 'rk-play__label', text: 'Play' });
  const playBtn = el(
    'button',
    { type: 'button', class: 'rk-key rk-play', 'data-playing': 'false', 'aria-keyshortcuts': 'Space' },
    [playLed, el('span', { class: 'rk-play__glyph', 'aria-hidden': 'true' }), playLabel],
  );

  const bpmNumber = el('input', {
    id: 'rk-bpm',
    type: 'number',
    class: 'rk-lcd__input',
    min: MIN_BPM,
    max: MAX_BPM,
    step: 1,
    inputmode: 'numeric',
    'aria-describedby': 'rk-bpm-unit',
  });
  const bpmRange = el('input', {
    type: 'range',
    class: 'rk-fader',
    min: MIN_BPM,
    max: MAX_BPM,
    step: 1,
    'aria-label': 'Tempo',
  });
  const tempoModule = el('div', { class: 'rk-module rk-module--tempo' }, [
    el('label', { class: 'rk-silk', for: 'rk-bpm', text: 'Tempo' }),
    el('div', { class: 'rk-lcd' }, [
      bpmNumber,
      el('span', { id: 'rk-bpm-unit', class: 'rk-lcd__unit', text: 'BPM' }),
    ]),
    bpmRange,
  ]);

  const swingKnob = createKnob({
    label: 'Swing',
    caption: 'Swing',
    value: 0,
    defaultValue: 0,
    onInput: (v) => engine.setSwing((v / 100) * SWING_MAX),
  });
  const masterKnob = createKnob({
    label: 'Master volume',
    caption: 'Master',
    value: 80,
    defaultValue: 80,
    onInput: (v) => engine.setMasterVolume(v / 100),
  });

  const presetButtons = PRESET_ORDER.filter((key) => PRESETS[key]).map((key) =>
    el('button', { type: 'button', class: 'rk-key rk-key--flat', 'data-preset': key, text: PRESETS[key].name }),
  );

  const exportBtn = el('button', { type: 'button', class: 'rk-key rk-key--flat', 'aria-label': 'Export pattern as JSON', text: 'Export' });
  const importBtn = el('button', { type: 'button', class: 'rk-key rk-key--flat', 'aria-label': 'Import pattern from JSON', text: 'Import' });
  const fileInput = el('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    tabindex: -1,
    'aria-hidden': 'true',
  });

  const presetModule = el('div', { class: 'rk-module rk-module--presets' }, [
    silk('Patterns', { 'aria-hidden': 'true' }),
    el('div', { class: 'rk-keyrow', role: 'group', 'aria-label': 'Load pattern' }, presetButtons),
    el('span', { class: 'rk-divider', 'aria-hidden': 'true' }),
    el('div', { class: 'rk-keyrow', role: 'group', 'aria-label': 'Pattern file' }, [exportBtn, importBtn, fileInput]),
  ]);

  const transport = el('section', { class: 'rk-transport', 'aria-label': 'Transport' }, [
    el('div', { class: 'rk-module rk-module--play' }, [silk('Run', { 'aria-hidden': 'true' }), playBtn]),
    tempoModule,
    el('div', { class: 'rk-module rk-module--knobs' }, [swingKnob.el, masterKnob.el]),
    presetModule,
  ]);

  const audioNote = el('p', { class: 'rk-statusline__audio' }, [led(), el('span')]);
  const message = el('p', { class: 'rk-statusline__msg', role: 'status', 'aria-live': 'polite' });
  const statusLine = el('div', { class: 'rk-statusline' }, [audioNote, message]);

  const stepLeds = [];
  const ruler = el('div', { class: 'rk-row rk-row--ruler', 'aria-hidden': 'true' }, [
    el('div', { class: 'rk-row__name' }, [silk('Step')]),
    el('div', { class: 'rk-row__mix' }, [silk('M'), silk('S'), silk('Vol')]),
    el(
      'div',
      { class: 'rk-cells' },
      Array.from({ length: STEPS }, (_, i) => {
        const l = led('rk-led--step');
        stepLeds.push(l);
        return el('span', { class: 'rk-ruler__cell' }, [l, el('span', { class: 'rk-ruler__num', text: String(i + 1) })]);
      }),
    ),
  ]);

  const rows = [];
  const columns = Array.from({ length: STEPS }, () => []);
  const noteSelects = [];
  const grid = el('div', { class: 'rk-grid', role: 'group', 'aria-label': 'Step sequencer' });
  let focusPos = { row: 0, step: 0 };

  tracks.forEach((track, r) => {
    const nameLed = led('rk-led--hit');
    const nameBtn = el('button', { type: 'button', class: 'rk-name', 'aria-label': `Play ${track.name}` }, [
      nameLed,
      el('span', { class: 'rk-name__text', text: track.name }),
    ]);
    nameBtn.addEventListener('click', () => audition(track.id));

    const mute = el('button', { type: 'button', class: 'rk-toggle', 'aria-pressed': 'false', 'aria-label': `Mute ${track.name}` }, [
      led(),
      el('span', { 'aria-hidden': 'true', text: 'M' }),
    ]);
    const solo = el('button', { type: 'button', class: 'rk-toggle', 'aria-pressed': 'false', 'aria-label': `Solo ${track.name}` }, [
      led(),
      el('span', { 'aria-hidden': 'true', text: 'S' }),
    ]);
    mute.addEventListener('click', () => {
      engine.setMute(track.id, mute.getAttribute('aria-pressed') !== 'true');
      requestRender();
    });
    solo.addEventListener('click', () => {
      engine.setSolo(track.id, solo.getAttribute('aria-pressed') !== 'true');
      requestRender();
    });

    const knob = createKnob({
      label: `${track.name} volume`,
      size: 'sm',
      value: 80,
      defaultValue: 80,
      onInput: (v) => engine.setTrackVolume(track.id, v / 100),
    });

    const pads = [];
    for (let i = 0; i < STEPS; i++) {
      const pad = el('button', {
        type: 'button',
        class: 'rk-pad',
        tabindex: r === 0 && i === 0 ? 0 : -1,
        'aria-pressed': 'false',
        'aria-label': `${track.name}, step ${i + 1}`,
        'data-row': r,
        'data-step': i,
        'data-group': Math.floor(i / 4) % 2 ? 'b' : 'a',
      });
      pad.addEventListener('click', () => {
        const on = engine.toggleStep(track.id, i);
        pad.setAttribute('aria-pressed', on ? 'true' : 'false');
        setRoving(r, i);
        if (on && !engine.isPlaying) {
          const midi = track.id === 'bass' ? Number(noteSelects[i]?.value) : undefined;
          audition(track.id, midi);
        }
        requestRender();
      });
      pads.push(pad);
      columns[i].push(pad);
    }

    const row = el('div', { class: 'rk-row rk-row--track', role: 'group', 'aria-label': track.name, 'data-track': track.id }, [
      el('div', { class: 'rk-row__name' }, [nameBtn]),
      el('div', { class: 'rk-row__mix' }, [mute, solo, knob.el]),
      el('div', { class: 'rk-cells' }, pads),
    ]);
    grid.append(row);
    rows.push({ id: track.id, row, nameBtn, nameLed, mute, solo, knob, pads });

    if (track.id === 'bass') {
      const selects = [];
      for (let i = 0; i < STEPS; i++) {
        const sel = el(
          'select',
          { class: 'rk-note', 'aria-label': `808 note, step ${i + 1}`, 'data-step': i },
          BASS_NOTES.map((n) => el('option', { value: n.midi, text: n.name })),
        );
        sel.addEventListener('change', () => {
          const midi = Number(sel.value);
          engine.setBassNote(i, midi);
          audition('bass', midi);
          requestRender();
        });
        selects.push(sel);
        noteSelects.push(sel);
      }
      grid.append(
        el('div', { class: 'rk-row rk-row--notes', role: 'group', 'aria-label': '808 notes' }, [
          el('div', { class: 'rk-row__name' }, [silk('808 note', { 'aria-hidden': 'true' })]),
          el('div', { class: 'rk-row__mix', 'aria-hidden': 'true' }),
          el('div', { class: 'rk-cells' }, selects),
        ]),
      );
    }
  });

  const seqScroll = el('div', { class: 'rk-seq__scroll' }, [el('div', { class: 'rk-seq__inner' }, [ruler, grid])]);
  const sequencer = el('section', { class: 'rk-seq', 'aria-label': 'Pattern' }, [seqScroll]);

  const footer = el('footer', { class: 'rk-foot' }, [
    el('p', { class: 'rk-keys' }, [
      kbd('Space'), text(' play / stop  '),
      kbd('Arrows'), text(' move between pads  '),
      kbd('Enter'), text(' toggle pad  '),
      text('Knobs: drag or arrow keys, double-click to reset.'),
    ]),
    el('p', { class: 'rk-touch-hint', text: 'Knobs: drag up or down, double-tap to reset.' }),
  ]);

  function kbd(t) {
    return el('kbd', { text: t });
  }
  function text(t) {
    return document.createTextNode(t);
  }

  // During a take: tempo, pattern loads and Play/Stop are locked (the take's BPM is
  // fixed and stopping drops it). Pads, notes, swing and mixer stay live.
  let boothLocked = false;
  function setBoothLock(on) {
    boothLocked = on;
    for (const c of [playBtn, bpmNumber, bpmRange, importBtn, ...presetButtons]) c.disabled = on;
  }

  const machine = el('div', { class: 'rk-machine' }, [
    header,
    el('main', { class: 'rk-body' }, [transport, statusLine, sequencer, mountBooth(engine, { onLockChange: setBoothLock })]),
    footer,
  ]);
  root.replaceChildren(machine);

  let lastPattern = null;
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
    const mixer = p.mixer || {};
    const anySolo = tracks.some((t) => mixer[t.id]?.solo);
    for (const r of rows) {
      const steps = p.steps?.[r.id] || [];
      r.pads.forEach((pad, i) => pad.setAttribute('aria-pressed', steps[i] ? 'true' : 'false'));
      const m = mixer[r.id] || {};
      r.mute.setAttribute('aria-pressed', m.mute ? 'true' : 'false');
      r.solo.setAttribute('aria-pressed', m.solo ? 'true' : 'false');
      if (typeof m.volume === 'number') r.knob.setValue(Math.round(m.volume * 100));
      const silent = !!m.mute || (anySolo && !m.solo);
      r.row.classList.toggle('is-silent', silent);
    }
    const bassSteps = p.steps?.bass || [];
    noteSelects.forEach((sel, i) => {
      const midi = p.bassNotes?.[i];
      if (bassNoteName.has(midi)) sel.value = String(midi);
      sel.classList.toggle('is-active', !!bassSteps[i]);
    });
    renderBpm(p.bpm);
    if (typeof p.swing === 'number') swingKnob.setValue(Math.round((p.swing / SWING_MAX) * 100));
    if (typeof p.master === 'number') masterKnob.setValue(Math.round(p.master * 100));
  }

  function renderBpm(bpm) {
    if (typeof bpm !== 'number') return;
    const v = String(Math.round(bpm));
    if (document.activeElement !== bpmNumber) bpmNumber.value = v;
    bpmRange.value = v;
    bpmRange.setAttribute('aria-valuetext', `${v} BPM`);
  }

  function renderPlaying(isPlaying) {
    playLabel.textContent = isPlaying ? 'Stop' : 'Play';
    playBtn.dataset.playing = isPlaying ? 'true' : 'false';
    if (isPlaying) startPlayhead();
    else stopPlayhead();
  }

  let contextListened = false;
  function renderAudioNote() {
    const ctx = engine.context;
    const label = audioNote.lastElementChild;
    let t = '';
    if (!ctx) t = 'Audio starts on your first click or key press.';
    else if (ctx.state !== 'running') t = 'Audio is paused by the browser. Press Play or tap anywhere to resume.';
    label.textContent = t;
    audioNote.hidden = !t;
    if (ctx && !contextListened && typeof ctx.addEventListener === 'function') {
      contextListened = true;
      ctx.addEventListener('statechange', renderAudioNote);
    }
  }

  async function ensureAudio() {
    try {
      await engine.resume();
    } catch (err) {
      console.error('Rythmik: could not start audio', err);
    }
    renderAudioNote();
  }

  // trigger() resumes the context itself; call it synchronously inside the gesture.
  function audition(trackId, midi) {
    flashTrack(trackId);
    try {
      engine.trigger(trackId, Number.isFinite(midi) ? { midi } : {});
    } catch (err) {
      console.error('Rythmik: audition failed', err);
    }
    Promise.resolve().then(renderAudioNote);
  }

  // Browsers may suspend the context at any time; any gesture resumes it.
  document.addEventListener('pointerdown', ensureAudio);
  document.addEventListener('keydown', (e) => {
    if (!e.repeat) ensureAudio();
  });

  let statusTimer = 0;
  let undoReturnFocus = null;
  let undoActive = false;
  let applyingLoad = false; // setPattern from a load is not a user edit

  function clearStatus() {
    clearTimeout(statusTimer);
    statusTimer = 0;
    undoActive = false;
    const hadFocus = message.contains(document.activeElement);
    message.replaceChildren();
    message.classList.remove('is-error');
    if (hadFocus && undoReturnFocus) undoReturnFocus.focus();
    undoReturnFocus = null;
  }

  function showStatus(msg, { error = false, undo = null, returnFocus = null } = {}) {
    clearStatus();
    message.classList.toggle('is-error', error);
    message.append(el('span', { text: msg }));
    if (undo) {
      undoReturnFocus = returnFocus;
      const undoBtn = el('button', { type: 'button', class: 'rk-undo', text: 'Undo' });
      undoBtn.addEventListener('click', () => {
        undo();
        const back = undoReturnFocus;
        clearStatus();
        back?.focus();
        showStatus('Restored your previous pattern.');
      });
      message.append(undoBtn);
      undoActive = true;
    }
    statusTimer = setTimeout(clearStatus, error ? STATUS_MS + 3000 : STATUS_MS);
  }

  function applyPattern(p) {
    applyingLoad = true;
    try {
      engine.setPattern(p);
    } finally {
      applyingLoad = false;
    }
    requestRender();
  }

  function loadWithUndo(pattern, msg, trigger) {
    const previous = engine.getPattern();
    applyPattern(pattern);
    showStatus(msg, {
      undo: () => applyPattern(previous),
      returnFocus: trigger,
    });
  }

  function togglePlay() {
    if (engine.isPlaying) {
      engine.stop();
    } else {
      let started;
      try {
        started = engine.start();
      } catch (err) {
        started = Promise.reject(err);
      }
      Promise.resolve(started).then(renderAudioNote, (err) => {
        console.error('Rythmik: could not start playback', err);
        engine.stop();
        renderPlaying(false);
        renderAudioNote();
      });
    }
    renderPlaying(engine.isPlaying);
  }

  playBtn.addEventListener('click', togglePlay);

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      const msg = btn.dataset.preset === 'empty' ? 'Cleared the pattern.' : `Loaded ${preset.name}.`;
      loadWithUndo(preset.pattern, msg, btn);
    });
  });

  exportBtn.addEventListener('click', () => {
    try {
      downloadPattern(engine.getPattern());
      showStatus('Saved rythmik-pattern.json.');
    } catch (err) {
      console.error(err);
      showStatus('Could not export the pattern.', { error: true });
    }
  });

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const pattern = await readPatternFile(file);
      loadWithUndo(pattern, `Imported ${file.name}.`, importBtn);
    } catch (err) {
      showStatus(err?.message || 'Not a Rythmik pattern file.', { error: true });
    }
  });

  bpmRange.addEventListener('input', () => {
    engine.setBpm(Number(bpmRange.value));
    requestRender();
  });
  bpmNumber.addEventListener('input', () => {
    const v = Number(bpmNumber.value);
    if (bpmNumber.value !== '' && v >= MIN_BPM && v <= MAX_BPM) {
      engine.setBpm(v);
      bpmRange.value = String(Math.round(v));
    }
  });
  bpmNumber.addEventListener('change', commitBpm);
  bpmNumber.addEventListener('blur', commitBpm);
  bpmNumber.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commitBpm();
      bpmNumber.select();
    }
  });
  function commitBpm() {
    const raw = Number(bpmNumber.value);
    if (bpmNumber.value !== '' && Number.isFinite(raw)) engine.setBpm(raw); // engine clamps
    const bpm = engine.getPattern().bpm;
    bpmNumber.value = String(Math.round(bpm));
    renderBpm(bpm);
  }

  engine.onStateChange(({ isPlaying, bpm }) => {
    renderPlaying(isPlaying);
    if (typeof bpm === 'number') renderBpm(bpm);
  });

  function blocksSpace(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
    if (target.tagName === 'INPUT') {
      const t = target.type;
      return t !== 'range' && t !== 'checkbox' && t !== 'radio' && t !== 'button';
    }
    return false;
  }

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (blocksSpace(e.target)) return;
    e.preventDefault();
    if (boothLocked) return; // stopping the beat would kill the take
    if (!e.repeat) togglePlay();
  });
  // Keep buttons from also "clicking" on Space keyup (Firefox).
  document.addEventListener('keyup', (e) => {
    if ((e.code === 'Space' || e.key === ' ') && !blocksSpace(e.target)) e.preventDefault();
  });

  // Roving tabindex: the grid is a single tab stop, arrows move between pads.
  function setRoving(row, step) {
    const prev = rows[focusPos.row]?.pads[focusPos.step];
    if (prev) prev.tabIndex = -1;
    focusPos = { row, step };
    rows[row].pads[step].tabIndex = 0;
  }

  grid.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains('rk-pad')) return;
    let row = Number(t.dataset.row);
    let step = Number(t.dataset.step);
    switch (e.key) {
      case 'ArrowRight': step = (step + 1) % STEPS; break;
      case 'ArrowLeft': step = (step - 1 + STEPS) % STEPS; break;
      case 'ArrowDown': row = (row + 1) % rows.length; break;
      case 'ArrowUp': row = (row - 1 + rows.length) % rows.length; break;
      case 'Home': step = 0; if (e.ctrlKey) row = 0; break;
      case 'End': step = STEPS - 1; if (e.ctrlKey) row = rows.length - 1; break;
      default: return;
    }
    e.preventDefault();
    setRoving(row, step);
    rows[row].pads[step].focus();
  });
  grid.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.classList.contains('rk-pad')) {
      setRoving(Number(t.dataset.row), Number(t.dataset.step));
    }
  });

  let rafId = 0;
  let shownStep = -1;
  const hitTimers = new Map();

  function flashTrack(trackId) {
    const r = rows.find((x) => x.id === trackId);
    if (!r) return;
    r.nameLed.classList.add('is-on');
    clearTimeout(hitTimers.get(trackId));
    hitTimers.set(trackId, setTimeout(() => r.nameLed.classList.remove('is-on'), 110));
  }

  function showStep(step) {
    if (step === shownStep) return;
    if (shownStep >= 0) {
      columns[shownStep].forEach((b) => b.classList.remove('is-current'));
      stepLeds[shownStep].classList.remove('is-on');
    }
    if (step >= 0 && step < STEPS) {
      columns[step].forEach((b) => b.classList.add('is-current'));
      stepLeds[step].classList.add('is-on');
      if (lastPattern) {
        for (const r of rows) {
          if (lastPattern.steps?.[r.id]?.[step] && !r.row.classList.contains('is-silent')) flashTrack(r.id);
        }
      }
    }
    shownStep = step;
  }

  function tick() {
    showStep(engine.getCurrentStep());
    rafId = engine.isPlaying ? requestAnimationFrame(tick) : 0;
    if (!rafId) showStep(-1);
  }
  function startPlayhead() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }
  function stopPlayhead() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    showStep(-1);
  }

  const saved = loadSavedPattern(storage);
  engine.setPattern(saved ?? PRESETS.afroBass.pattern);

  const autosave = createAutosave(storage, { delay: 300 });
  engine.onPatternChange((p) => {
    // Undo would wipe edits made after a load, so drop it on the first edit.
    if (undoActive && !applyingLoad) clearStatus();
    autosave.schedule(p);
    lastPattern = p;
    requestRender();
  });
  const flushSave = () => autosave.flush();
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  render(engine.getPattern());
  renderPlaying(engine.isPlaying);
  renderAudioNote();
}
