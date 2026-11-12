import { createBooth } from '../audio/booth.js';
import { encodeWav } from '../audio/wav.js';
import { helpLabel, helpTip } from './helptip.js';
import { el, silk, led, isTyping, downloadBlob } from './dom.js';

const BAR_OPTIONS = [2, 4, 8, 16];
const OFFSET_MIN = -200;
const OFFSET_MAX = 200;
const METER_DECAY = 0.88; // per frame, so short peaks stay visible
const METER_SEGMENTS = 12;
const METER_FLOOR_DB = -48;

const MIC_MESSAGES = {
  'mic-denied':
    'Microphone access is blocked. Open the site settings (the icon left of the address bar), set Microphone to Allow, then press Enable mic again.',
  'mic-unavailable':
    'No microphone available. Plug one in or close other apps using it, then try again. The page must be served over HTTPS or localhost.',
  'mic-busy': 'Mic in use by another app or blocked by Windows privacy settings.',
};
const INPUT_KEY = 'rythmik:input';
const SILENT_MS = 3000;

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

/**
 * The BOOTH view. onLockChange(locked) fires when a take starts or ends.
 * isActive() tells whether the view is on screen (the R shortcut only works there).
 */
export function mountBooth(engine, { onLockChange = () => {}, isActive = () => true } = {}) {
  const booth = createBooth(engine);
  let locked = false;

  let bars = BAR_OPTIONS.includes(booth.bars) ? booth.bars : 4;
  let countIn = typeof booth.countIn === 'boolean' ? booth.countIn : true;
  let offsetMs = Number.isFinite(booth.latencyOffsetMs) ? booth.latencyOffsetMs : 0;
  let busy = false;
  let cancelRequested = false;
  let meterLevel = 0;
  let litSegments = -1;
  let rafId = 0;
  let switching = false;
  let diagText = '';
  let progressText = '';

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

  const recStep = step(2, 'Record', 'rk-step-rec');
  const offsetNote = el('p', { class: 'rk-note-line rk-beginner', hidden: true });
  const recPanel = el('section', { class: 'rk-step', 'aria-labelledby': 'rk-step-rec' }, [
    recStep.head,
    recordEmpty,
    el('div', { class: 'rk-field' }, [helpLabel('takeBars', { forId: 'rk-booth-bars' }), barsSelect]),
    el('div', { class: 'rk-btnrow' }, [countInBtn, helpTip('countIn')]),
    el('div', { class: 'rk-btnrow' }, [recordBtn, helpTip('record'), progress]),
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

  // 4 export
  const mixBtn = el('button', { type: 'button', class: 'rk-key', text: 'Export mix (WAV)' });
  const vocalBtn = el('button', { type: 'button', class: 'rk-key', text: 'Export vocal (WAV)' });
  const exportEmpty = el('p', { class: 'rk-empty', text: 'Record a take, pick it in step 3, then export it here.' });
  const exportMsg = el('p', { class: 'rk-msg', role: 'status' });
  const exportStep = step(4, 'Export', 'rk-step-export');
  const exportPanel = el('section', { class: 'rk-step', 'aria-labelledby': 'rk-step-export' }, [
    exportStep.head,
    exportEmpty,
    el('div', { class: 'rk-btnrow' }, [mixBtn, helpTip('exportMix')]),
    el('div', { class: 'rk-btnrow' }, [vocalBtn, helpTip('exportVocal')]),
    exportMsg,
  ]);

  const view = el('div', { class: 'rk-booth' }, [
    el('p', { class: 'rk-hint rk-booth__intro' }, [
      silk('Tip', { 'aria-hidden': 'true' }),
      el('span', { text: ' Wear headphones so the beat does not leak into the mic.' }),
    ]),
    el('div', { class: 'rk-steps' }, [micPanel, recPanel, takesPanel, exportPanel]),
  ]);

  // Take rows are keyed by id so focus survives re-renders.
  const takeRows = new Map();

  function makeTakeRow(take) {
    const radioId = `rk-take-${take.id}`;
    const radio = el('input', { type: 'radio', id: radioId, name: 'rk-booth-take', value: take.id, class: 'rk-radio' });
    radio.addEventListener('change', () => {
      if (radio.checked) booth.selectTake(take.id);
    });
    const name = el('span', { class: 'rk-take__name', text: take.name });
    const info = el('span', { class: 'rk-take__info' });
    const tag = el('span', { class: 'rk-take__tag', text: 'In mix' });
    const label = el('label', { class: 'rk-take__label', for: radioId }, [radio, name, info, tag]);
    const playBtn = el('button', { type: 'button', class: 'rk-key rk-key--led', 'aria-label': `Play ${take.name} with beat` }, [
      led(),
      el('span', { text: 'Play' }),
    ]);
    playBtn.addEventListener('click', () => startPreview(take));
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
      row.info.textContent = `${take.bars} bars, ${(take.duration || 0).toFixed(1)} s, peak ${formatPeak(take.peak)}`;
      const selected = take.id === booth.selectedTakeId;
      row.radio.checked = selected;
      row.li.classList.toggle('is-selected', selected);
      row.playBtn.firstElementChild.classList.toggle('is-on', booth.previewTakeId === take.id);
      row.playBtn.disabled = recording || busy;
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
    countInBtn.setAttribute('aria-pressed', String(countIn));

    recordBtn.disabled = !micOpen && idle;
    recordLabel.textContent = idle ? `Record ${bars} bars` : 'Cancel recording';
    recordLed.classList.toggle('is-on', !idle);
    recordEmpty.hidden = micOpen || !idle;
    recStep.led.classList.toggle('is-on', !idle);
    recStep.led.classList.toggle('is-blink', state === 'count-in');
    if (idle) setProgress('');

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
    mixBtn.disabled = vocalBtn.disabled = busy || !idle || !hasTake;
    exportEmpty.hidden = hasTake;

    updateLoop();
  }

  function setProgress(t) {
    if (t === progressText) return;
    progressText = t;
    progress.textContent = t;
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
    setMicMsg(countIn ? 'Count-in, then recording.' : 'Recording.');
    let take;
    try {
      const pending = booth.record();
      render();
      take = await pending;
    } catch (err) {
      if (!cancelRequested) {
        setMicMsg('Recording failed.', true);
        console.error('Rythmik: record', err);
      }
    }
    if (take) setMicMsg(`${take.name} recorded. Play it in step 3.`);
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
    if (!take || busy) return;
    const returnFocus = document.activeElement;
    busy = true;
    setExportMsg('Rendering…');
    render();
    try {
      const buffer = kind === 'mix' ? await booth.renderMix(take.id) : await booth.renderVocal(take.id);
      const filename = `rythmik-${kind}-take-${takeNumber(take)}.wav`;
      downloadBlob(encodeWav(buffer, { bitDepth: 16 }), filename, 'audio/wav');
      setExportMsg(`Saved ${filename}.`);
    } catch (err) {
      console.error('Rythmik: export', err);
      setExportMsg('Export failed.', true);
    }
    busy = false;
    render();
    if (returnFocus instanceof HTMLElement && !returnFocus.disabled) returnFocus.focus();
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
      setProgress(
        p.countIn || booth.state === 'count-in'
          ? `Count-in${p.beat ? ` ${p.beat}` : ''}`
          : `Recording bar ${Math.max(1, p.bar || 1)} of ${p.totalBars || bars}`,
      );
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
  mixBtn.addEventListener('click', () => exportTake('mix'));
  vocalBtn.addEventListener('click', () => exportTake('vocal'));

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
  const saved = loadInput();
  if (saved) booth.setInputDevice(saved).catch(() => {}); // mic is closed: only remembered
  const unsubscribe = booth.onChange(render);
  const unsubDevices = booth.onDevicesChange(onDevices);
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
    destroy() {
      document.removeEventListener('keydown', onKey);
      unsubscribe?.();
      unsubDevices?.();
      if (rafId) cancelAnimationFrame(rafId);
      booth.cancel();
      booth.dispose();
    },
  };
}
