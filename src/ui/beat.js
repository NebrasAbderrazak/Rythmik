import { TRACKS, STEPS, BASS_NOTES } from '../audio/engine.js';
import { PRESETS } from '../audio/presets.js';
import { renderBeat, EXPORT_BARS } from '../audio/export.js';
import { encodeWav } from '../audio/wav.js';
import { createKnob } from './knob.js';
import { downloadPattern, readPatternFile } from './persistence.js';
import { PRESET_INFO } from './help.js';
import { helpLabel } from './helptip.js';
import { el, silk, led, downloadBlob } from './dom.js';

const SWING_MAX = 0.6; // knob shows 0..100%
const PRESET_ORDER = ['afroBass', 'trap', 'boomBap', 'empty'];
const DEFAULT_EXPORT_BARS = 4;
const LOW_MASTER = 0.1;

export function hiddenSettingsNote({ mixed = false, lowMaster = false } = {}) {
  const parts = [];
  if (lowMaster) parts.push('master volume is low');
  if (mixed) parts.push('some sounds are muted or soloed');
  if (!parts.length) return '';
  return `Some Advanced settings are active: ${parts.join(' and ')}. Turn on Advanced to change ${parts.length > 1 ? 'them' : 'it'}.`;
}

export function presetLine(key) {
  const p = PRESETS[key];
  if (!p) return '';
  const info = PRESET_INFO[key] || '';
  return key === 'empty' ? info : `${info}, ${p.pattern.bpm} BPM`;
}

/**
 * The BEAT view: presets, pad grid, export. Advanced-only parts carry .rk-adv.
 * loadWithUndo(pattern, message, trigger) is owned by the app so Undo survives view switches.
 */
export function mountBeat(engine, { status, loadWithUndo, afterAudio = () => {} }) {
  const tracks = TRACKS.map((t) => ({ ...t }));
  const bassNoteName = new Map(BASS_NOTES.map((n) => [n.midi, n.name]));

  // presets
  const presetButtons = PRESET_ORDER.filter((key) => PRESETS[key]).map((key) =>
    el('button', { type: 'button', class: 'rk-key rk-preset', 'data-preset': key }, [
      el('span', { class: 'rk-preset__name', text: PRESETS[key].name }),
      el('span', { class: 'rk-preset__desc', text: presetLine(key) }),
    ]),
  );
  const lockNote = el('p', { class: 'rk-note-line', hidden: true, text: 'Presets, tempo and Import are locked while a take records.' });
  const presetModule = el('section', { class: 'rk-module rk-module--col rk-module--presets', 'aria-labelledby': 'rk-presets-h' }, [
    helpLabel('presets', { tag: 'h3', id: 'rk-presets-h', className: 'rk-module__head' }),
    el('div', { class: 'rk-presets' }, presetButtons),
    lockNote,
  ]);

  // groove (advanced)
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

  // sequencer
  const stepLeds = [];
  const ruler = el('div', { class: 'rk-row rk-row--ruler', 'aria-hidden': 'true' }, [
    el('div', { class: 'rk-row__name' }, [silk('Step')]),
    el('div', { class: 'rk-row__mix rk-adv' }, [silk('M'), silk('S'), silk('Vol')]),
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
  const grid = el('div', { class: 'rk-grid', role: 'group', 'aria-label': 'Pads' });
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
      el('div', { class: 'rk-row__mix rk-adv' }, [mute, solo, knob.el]),
      el('div', { class: 'rk-cells' }, pads),
    ]);
    grid.append(row);
    rows.push({ id: track.id, row, nameBtn, nameLed, mute, solo, knob, pads });

    if (track.id === 'bass') {
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
        noteSelects.push(sel);
      }
      grid.append(
        el('div', { class: 'rk-row rk-row--notes rk-adv', role: 'group', 'aria-label': '808 notes' }, [
          el('div', { class: 'rk-row__name' }, [helpLabel('bassNotes', { sub: false })]),
          el('div', { class: 'rk-row__mix', 'aria-hidden': 'true' }),
          el('div', { class: 'rk-cells' }, noteSelects),
        ]),
      );
    }
  });

  const hiddenNote = el('p', { class: 'rk-note-line rk-beginner', hidden: true });
  const seqHead = el('div', { class: 'rk-seq__head' }, [
    helpLabel('pads'),
    helpLabel('sounds'),
    el('span', { class: 'rk-seq__mixhelp rk-adv' }, [helpLabel('mute'), helpLabel('solo'), helpLabel('volume')]),
  ]);
  const seqScroll = el('div', { class: 'rk-seq__scroll' }, [el('div', { class: 'rk-seq__inner' }, [ruler, grid])]);
  const firstRow = rows[0].row;
  const sequencer = el('section', { class: 'rk-seq', 'aria-label': 'Pads' }, [
    silk('Sequencer', { class: 'rk-silk rk-seq__title', 'aria-hidden': 'true' }),
    seqHead,
    hiddenNote,
    seqScroll,
  ]);

  // export beat
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

  // pattern file
  const exportBtn = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'Export pattern as JSON file', text: 'Export' });
  const importBtn = el('button', { type: 'button', class: 'rk-key', 'aria-label': 'Import pattern from JSON file', text: 'Import' });
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true, tabindex: -1, 'aria-hidden': 'true' });
  const fileModule = el('section', { class: 'rk-module rk-module--col', 'aria-labelledby': 'rk-file-h' }, [
    helpLabel('patternFile', { tag: 'h3', id: 'rk-file-h', className: 'rk-module__head' }),
    el('div', { class: 'rk-btnrow' }, [exportBtn, importBtn, fileInput]),
    el('p', { class: 'rk-hint', text: 'Your beat also saves itself in this browser.' }),
  ]);

  const view = el('div', { class: 'rk-beat' }, [
    el('div', { class: 'rk-band' }, [presetModule, grooveModule]),
    sequencer,
    el('div', { class: 'rk-band' }, [exportModule, fileModule]),
  ]);

  let lastPattern = null;
  let renderQueued = false;
  let locked = false;

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
    let anyMixed = false;
    for (const r of rows) {
      const steps = p.steps?.[r.id] || [];
      r.pads.forEach((pad, i) => pad.setAttribute('aria-pressed', steps[i] ? 'true' : 'false'));
      const m = mixer[r.id] || {};
      r.mute.setAttribute('aria-pressed', m.mute ? 'true' : 'false');
      r.solo.setAttribute('aria-pressed', m.solo ? 'true' : 'false');
      if (typeof m.volume === 'number') r.knob.setValue(Math.round(m.volume * 100));
      const silent = !!m.mute || (anySolo && !m.solo);
      if (silent) anyMixed = true;
      r.row.classList.toggle('is-silent', silent);
    }
    const bassSteps = p.steps?.bass || [];
    noteSelects.forEach((sel, i) => {
      const midi = p.bassNotes?.[i];
      if (bassNoteName.has(midi)) sel.value = String(midi);
      sel.classList.toggle('is-active', !!bassSteps[i]);
    });
    if (typeof p.swing === 'number') swingKnob.setValue(Math.round((p.swing / SWING_MAX) * 100));
    if (typeof p.master === 'number') masterKnob.setValue(Math.round(p.master * 100));
    // Beginners can't see these controls; say what is in effect instead of resetting it.
    const t = hiddenSettingsNote({ mixed: anyMixed, lowMaster: typeof p.master === 'number' && p.master < LOW_MASTER });
    if (hiddenNote.textContent !== t) hiddenNote.textContent = t;
    hiddenNote.hidden = !t;
  }

  // trigger() resumes the context itself; call it synchronously inside the gesture.
  function audition(trackId, midi) {
    flashTrack(trackId);
    try {
      engine.trigger(trackId, Number.isFinite(midi) ? { midi } : {});
    } catch (err) {
      console.error('Rythmik: audition failed', err);
    }
    Promise.resolve().then(afterAudio);
  }

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset || locked) return;
      const msg = btn.dataset.preset === 'empty' ? 'Cleared the pattern.' : `Loaded ${preset.name}.`;
      loadWithUndo(preset.pattern, msg, btn);
    });
  });

  exportBtn.addEventListener('click', () => {
    try {
      downloadPattern(engine.getPattern());
      status.show('Saved rythmik-pattern.json.');
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
      loadWithUndo(pattern, `Imported ${file.name}.`, importBtn);
    } catch (err) {
      status.show(err?.message || 'Not a Rythmik pattern file.', { error: true });
    }
  });

  let rendering = false;
  function setWavMsg(t, error = false) {
    wavMsg.textContent = t;
    wavMsg.classList.toggle('is-error', error);
  }
  wavBtn.addEventListener('click', async () => {
    if (rendering) return;
    rendering = true;
    wavBtn.disabled = barsSelect.disabled = true;
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
    wavBtn.disabled = barsSelect.disabled = false;
    wavBtn.removeAttribute('aria-busy');
    wavLabel.textContent = 'Export beat (WAV)';
    if (document.activeElement === document.body) wavBtn.focus();
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
    if (t instanceof HTMLElement && t.classList.contains('rk-pad')) setRoving(Number(t.dataset.row), Number(t.dataset.step));
  });

  // playhead
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

  let active = true;

  function tick() {
    showStep(engine.getCurrentStep());
    rafId = engine.isPlaying && active ? requestAnimationFrame(tick) : 0;
    if (!rafId) showStep(-1);
  }

  function setPlaying(isPlaying) {
    if (isPlaying && active) {
      if (!rafId) rafId = requestAnimationFrame(tick);
    } else {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      showStep(-1);
    }
  }

  engine.onPatternChange((p) => {
    lastPattern = p;
    requestRender();
  });
  engine.onStateChange(({ isPlaying }) => setPlaying(isPlaying));

  render(engine.getPattern());
  setPlaying(engine.isPlaying);

  return {
    el: view,
    anchors: { pads: firstRow, presets: presetModule },
    setLocked(on) {
      locked = on;
      for (const c of [importBtn, ...presetButtons]) c.disabled = on;
      lockNote.hidden = !on;
    },
    // Re-sync after the transport starts/stops (state events may not fire for failed starts).
    setPlaying,
    /** The playhead only animates while the view is on screen. */
    setActive(on) {
      active = on;
      setPlaying(engine.isPlaying);
    },
  };
}

