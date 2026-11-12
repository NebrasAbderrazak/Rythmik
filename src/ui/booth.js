import { createBooth } from '../audio/booth.js';
import { encodeWav } from '../audio/wav.js';

const BAR_OPTIONS = [2, 4, 8, 16];
const OFFSET_MIN = -200;
const OFFSET_MAX = 200;
const METER_DECAY = 0.88; // per frame, so short peaks stay visible

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

function led() {
  return el('span', { class: 'rk-led', 'aria-hidden': 'true' });
}

function silk(text) {
  return el('span', { class: 'rk-silk', 'aria-hidden': 'true', text });
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

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName === 'INPUT') {
    const t = target.type;
    return t !== 'range' && t !== 'checkbox' && t !== 'radio' && t !== 'button';
  }
  return false;
}

function download(arrayBuffer, filename) {
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: 'audio/wav' }));
  const a = el('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking synchronously can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// onLockChange(locked) fires when a take starts or ends. Focus on a control the
// callback disables moves to the Cancel button.
export function mountBooth(engine, { onLockChange = () => {} } = {}) {
  const booth = createBooth(engine);
  let locked = false;

  let bars = BAR_OPTIONS.includes(booth.bars) ? booth.bars : 4;
  let countIn = typeof booth.countIn === 'boolean' ? booth.countIn : true;
  let offsetMs = Number.isFinite(booth.latencyOffsetMs) ? booth.latencyOffsetMs : 0;
  let busy = false;
  let cancelRequested = false;
  let meterLevel = 0;
  let rafId = 0;
  let switching = false;
  let diagText = '';

  // mic
  const micBtn = el('button', { type: 'button', class: 'rk-key rk-booth__key', 'aria-pressed': 'false' }, [
    led(),
    el('span', { text: 'Enable mic' }),
  ]);
  const monitorBtn = el(
    'button',
    { type: 'button', class: 'rk-key rk-booth__key', 'aria-pressed': 'false', 'aria-label': 'Monitor mic input' },
    [led(), el('span', { text: 'Monitor' })],
  );
  const inputSelect = el('select', { id: 'rk-booth-input', class: 'rk-booth__select rk-booth__input' }, [
    el('option', { value: '', text: 'System default' }),
  ]);
  const inputName = el('span', { class: 'rk-booth__input-name' });
  const diagMsg = el('p', { class: 'rk-booth__msg', role: 'status', 'aria-live': 'polite' });
  const meterFill = el('span', { class: 'rk-booth__meter-fill' });
  const meter = el('span', { class: 'rk-booth__meter', 'aria-hidden': 'true' }, [meterFill]);
  const micMsg = el('p', { class: 'rk-booth__msg', role: 'status', 'aria-live': 'polite' });
  const micModule = el('div', { class: 'rk-module rk-booth__module' }, [
    silk('Mic'),
    el('div', { class: 'rk-booth__row' }, [micBtn, monitorBtn]),
    el('div', { class: 'rk-booth__row' }, [
      el('label', { class: 'rk-booth__label', for: 'rk-booth-input', text: 'Input' }),
      inputSelect,
    ]),
    el('div', { class: 'rk-booth__row' }, [el('span', { class: 'rk-booth__label', text: 'Level' }), meter]),
    inputName,
    el('p', { class: 'rk-booth__hint', text: 'Use headphones so the beat does not leak into the mic.' }),
    micMsg,
    diagMsg,
  ]);

  // record
  const barsSelect = el(
    'select',
    { id: 'rk-booth-bars', class: 'rk-booth__select' },
    BAR_OPTIONS.map((n) => el('option', { value: n, text: `${n} bars` })),
  );
  barsSelect.value = String(bars);
  const countInBtn = el(
    'button',
    { type: 'button', class: 'rk-key rk-booth__key', 'aria-pressed': String(countIn), 'aria-label': 'Count-in, one bar' },
    [led(), el('span', { text: 'Count-in' })],
  );
  const recordLabel = el('span', { text: 'Record' });
  const recordBtn = el(
    'button',
    { type: 'button', class: 'rk-key rk-booth__key rk-booth__record', 'aria-keyshortcuts': 'R', disabled: true },
    [led(), recordLabel],
  );
  const progress = el('p', { class: 'rk-booth__progress', 'aria-hidden': 'true' });
  const recordModule = el('div', { class: 'rk-module rk-booth__module' }, [
    silk('Record'),
    el('div', { class: 'rk-booth__row' }, [
      el('label', { class: 'rk-booth__label', for: 'rk-booth-bars', text: 'Length' }),
      barsSelect,
      countInBtn,
    ]),
    el('div', { class: 'rk-booth__row' }, [recordBtn, progress]),
  ]);

  // takes
  const takeList = el('ul', { class: 'rk-booth__takes', 'aria-label': 'Takes, selected take is used in the mix' });
  const noTakes = el('p', { class: 'rk-booth__hint', text: 'No takes yet.' });
  const stopBtn = el('button', { type: 'button', class: 'rk-key rk-booth__key', disabled: true, 'aria-label': 'Stop preview' }, [
    el('span', { text: 'Stop' }),
  ]);
  const takesModule = el('div', { class: 'rk-module rk-booth__module rk-booth__module--wide' }, [
    silk('Takes'),
    noTakes,
    takeList,
    el('div', { class: 'rk-booth__row' }, [stopBtn]),
  ]);

  // latency
  const offsetRange = el('input', {
    id: 'rk-booth-offset',
    type: 'range',
    class: 'rk-fader rk-booth__fader',
    min: OFFSET_MIN,
    max: OFFSET_MAX,
    step: 1,
  });
  offsetRange.value = String(offsetMs);
  const offsetOut = el('output', { class: 'rk-booth__value', for: 'rk-booth-offset' });
  const autoOut = el('span', { class: 'rk-booth__value' });
  const totalOut = el('span', { class: 'rk-booth__value' });
  const latencyModule = el('div', { class: 'rk-module rk-booth__module' }, [
    silk('Latency'),
    el('p', { class: 'rk-booth__row' }, [el('span', { class: 'rk-booth__label', text: 'Auto' }), autoOut]),
    el('div', { class: 'rk-booth__row' }, [
      el('label', { class: 'rk-booth__label', for: 'rk-booth-offset', text: 'Offset' }),
      offsetRange,
      offsetOut,
    ]),
    el('p', { class: 'rk-booth__row' }, [el('span', { class: 'rk-booth__label', text: 'Total' }), totalOut]),
  ]);

  // export
  const mixBtn = el('button', { type: 'button', class: 'rk-key rk-booth__key', text: 'Export mix (WAV)' });
  const vocalBtn = el('button', { type: 'button', class: 'rk-key rk-booth__key', text: 'Export vocal (WAV)' });
  const exportMsg = el('p', { class: 'rk-booth__msg', role: 'status', 'aria-live': 'polite' });
  const exportModule = el('div', { class: 'rk-module rk-booth__module' }, [
    silk('Export'),
    el('div', { class: 'rk-booth__row' }, [mixBtn, vocalBtn]),
    exportMsg,
  ]);

  const section = el('section', { class: 'rk-booth', 'aria-labelledby': 'rk-booth-title' }, [
    el('h2', { id: 'rk-booth-title', class: 'rk-booth__title rk-silk', text: 'Booth' }),
    el('div', { class: 'rk-booth__modules' }, [micModule, recordModule, latencyModule, takesModule, exportModule]),
  ]);

  // Take rows are keyed by id so focus survives re-renders.
  const takeRows = new Map();

  function makeTakeRow(take) {
    const radioId = `rk-take-${take.id}`;
    const radio = el('input', { type: 'radio', id: radioId, name: 'rk-booth-take', value: take.id, class: 'rk-booth__radio' });
    radio.addEventListener('change', () => {
      if (radio.checked) booth.selectTake(take.id);
    });
    const name = el('span', { class: 'rk-booth__take-name', text: take.name });
    const info = el('span', { class: 'rk-booth__take-info' });
    const label = el('label', { class: 'rk-booth__take-label', for: radioId }, [radio, name, info]);
    const playBtn = el('button', { type: 'button', class: 'rk-key rk-booth__key', 'aria-label': `Play ${take.name} with beat` }, [
      led(),
      el('span', { text: 'Play' }),
    ]);
    playBtn.addEventListener('click', () => startPreview(take));
    const delBtn = el('button', { type: 'button', class: 'rk-key rk-booth__key', 'aria-label': `Delete ${take.name}`, text: 'Delete' });
    delBtn.addEventListener('click', () => deleteTake(take.id));
    const li = el('li', { class: 'rk-booth__take' }, [label, el('div', { class: 'rk-booth__row' }, [playBtn, delBtn])]);
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
      row.radio.checked = take.id === booth.selectedTakeId;
      const playing = booth.previewTakeId === take.id;
      row.playBtn.setAttribute('aria-pressed', String(playing));
      row.playBtn.disabled = recording || busy;
      row.delBtn.disabled = recording || busy;
    });
    noTakes.hidden = takes.length > 0;
    takeList.hidden = takes.length === 0;
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

    micBtn.setAttribute('aria-pressed', String(micOpen));
    micBtn.lastElementChild.textContent = micOpen ? 'Mic on' : 'Enable mic';
    micBtn.setAttribute('aria-label', micOpen ? 'Microphone on, press to turn off' : 'Enable microphone');
    micBtn.disabled = !idle;
    inputSelect.disabled = !idle || switching;
    selectCurrentInput();
    inputName.textContent = micOpen && booth.inputLabel ? `Active: ${booth.inputLabel}` : '';
    if (!micOpen) setDiag('');
    monitorBtn.setAttribute('aria-pressed', String(!!booth.monitoring));
    monitorBtn.disabled = !micOpen; // closeMic resets monitoring
    meter.classList.toggle('is-off', !micOpen);

    barsSelect.disabled = !idle;
    countInBtn.disabled = !idle;
    countInBtn.setAttribute('aria-pressed', String(countIn));

    recordBtn.disabled = !micOpen && idle;
    recordBtn.setAttribute('aria-pressed', String(!idle));
    recordLabel.textContent = idle ? 'Record' : 'Cancel';
    recordBtn.setAttribute('aria-label', idle ? `Record ${bars} bars` : 'Cancel recording');
    if (idle) progress.textContent = micOpen ? '' : 'Enable the mic to record.';

    autoOut.textContent = `${Math.round(booth.autoLatencyMs || 0)} ms`;
    totalOut.textContent = `${Math.round(booth.latencyMs || 0)} ms`;
    offsetOut.textContent = formatMs(offsetMs);
    offsetRange.setAttribute('aria-valuetext', formatMs(offsetMs));
    offsetRange.disabled = !idle;

    renderTakes(takes);
    stopBtn.disabled = booth.previewTakeId == null;

    const hasTake = takes.some((t) => t.id === booth.selectedTakeId);
    mixBtn.disabled = vocalBtn.disabled = busy || !idle || !hasTake;

    updateLoop();
  }

  function setMicMsg(text, error = false) {
    micMsg.textContent = text;
    micMsg.classList.toggle('is-error', error);
  }

  function setExportMsg(text, error = false) {
    exportMsg.textContent = text;
    exportMsg.classList.toggle('is-error', error);
  }

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

  function setDiag(text) {
    // Only touch the live region when the message changes.
    if (text === diagText) return;
    diagText = text;
    diagMsg.textContent = text;
    diagMsg.classList.toggle('is-error', !!text);
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
      if (!booth.lastFallback) setMicMsg('Mic on. Press Record or R.');
      refreshInputs();
    } catch (err) {
      const msg = MIC_MESSAGES[err?.message] || 'Could not open the microphone.';
      setMicMsg(msg, true);
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
    if (take) setMicMsg(`${take.name} recorded.`);
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
      download(encodeWav(buffer, { bitDepth: 16 }), filename);
      setExportMsg(`Saved ${filename}.`);
    } catch (err) {
      console.error('Rythmik: export', err);
      setExportMsg('Export failed.', true);
    }
    busy = false;
    render();
    if (returnFocus instanceof HTMLElement && !returnFocus.disabled) returnFocus.focus();
  }

  // Polls level and progress only while there is something to show.
  function frame() {
    rafId = 0;
    if (booth.micOpen) {
      meterLevel = Math.max(booth.getInputLevel() || 0, meterLevel * METER_DECAY);
      meterFill.style.transform = `scaleX(${Math.min(1, meterLevel).toFixed(3)})`;
      meter.classList.toggle('is-hot', meterLevel >= 0.98);
      checkMic();
    }
    if (booth.state !== 'idle') {
      const p = booth.getRecordProgress() || {}; // null once the take ends
      progress.textContent =
        p.countIn || booth.state === 'count-in'
          ? `Count-in${p.beat ? ` ${p.beat}` : ''}`
          : `Recording bar ${Math.max(1, p.bar || 1)} of ${p.totalBars || bars}`;
    }
    updateLoop();
  }

  function updateLoop() {
    const needed = booth.micOpen || booth.state !== 'idle';
    if (needed && !rafId) rafId = requestAnimationFrame(frame);
    if (!needed) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      meterLevel = 0;
      meterFill.style.transform = 'scaleX(0)';
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
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
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
    if ((e.key === 'r' || e.key === 'R') && !isTyping(e.target)) {
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

  section.destroy = () => {
    document.removeEventListener('keydown', onKey);
    unsubscribe?.();
    unsubDevices?.();
    if (rafId) cancelAnimationFrame(rafId);
    booth.cancel();
    booth.dispose();
  };
  return section;
}
