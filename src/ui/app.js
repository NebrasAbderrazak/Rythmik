import { MIN_BPM, MAX_BPM } from '../audio/engine.js';
import { PRESETS } from '../audio/presets.js';
import { mountBeat } from './beat.js';
import { mountBooth } from './booth.js';
import { mountGuide } from './guide.js';
import { createTour } from './tour.js';
import { createStatus } from './status.js';
import { helpLabel, helpTip, closeHelp } from './helptip.js';
import { parseRoute, routeHash, MODES } from './router.js';
import { loadAdvanced, saveAdvanced, hasToured, markToured } from './settings.js';
import { getDefaultStorage, loadSavedPattern, createAutosave } from './persistence.js';
import { el, led, text, isTyping } from './dom.js';

const MODE_HELP = { beat: 'modeBeat', booth: 'modeBooth' };
// Space only toggles playback when focus is not on something Space already operates.
const SPACE_OWNERS = 'button, a[href], select, input[type=radio], input[type=checkbox], [role=switch], [role=button], [role=slider], .rk-tour';

const VIEW_INFO = {
  beat: { title: 'Beat', intro: 'Build a one-bar loop: tap pads, press Play, change the tempo.' },
  booth: { title: 'Booth', intro: 'Record yourself over the beat in four steps.' },
  guide: { title: 'Guide', intro: 'Short, plain explanations of every control, plus a few how-tos.' },
};

export function mountApp(root, engine) {
  const storage = getDefaultStorage();
  let advanced = loadAdvanced(storage);
  let route = null;
  let boothLocked = false;

  // pattern lifecycle (before any view renders)
  engine.setPattern(loadSavedPattern(storage) ?? PRESETS.afroBass.pattern);
  const status = createStatus();
  let applyingLoad = false; // setPattern from a load is not a user edit

  function applyPattern(p) {
    applyingLoad = true;
    try {
      engine.setPattern(p);
    } finally {
      applyingLoad = false;
    }
  }

  function loadWithUndo(pattern, msg, trigger) {
    const previous = engine.getPattern();
    applyPattern(pattern);
    status.show(msg, { undo: () => applyPattern(previous), focusBack: trigger });
  }

  // header
  const modeLinks = Object.fromEntries(
    MODES.map((m) => [
      m,
      el('a', { class: 'rk-mode', href: routeHash(m) }, [led(), el('span', { text: VIEW_INFO[m].title })]),
    ]),
  );
  const guideLink = el('a', { class: 'rk-key rk-key--link rk-guidebtn', href: routeHash('guide'), text: 'Guide' });
  const advLabel = el('span', { text: 'Advanced' });
  const advSwitch = el('button', { type: 'button', class: 'rk-key rk-key--led rk-switch', role: 'switch', 'aria-checked': String(advanced) }, [
    led(),
    advLabel,
  ]);

  const header = el('header', { class: 'rk-header' }, [
    el('div', { class: 'rk-brand' }, [
      el('h1', { class: 'rk-logo' }, [led('rk-led--logo'), el('span', { text: 'Rythmik' })]),
      el('p', { class: 'rk-tagline', text: 'Make beats in your browser.' }),
    ]),
    el('div', { class: 'rk-header__controls' }, [
      el('nav', { class: 'rk-modes', 'aria-label': 'Sections' }, MODES.map((m) => el('span', { class: 'rk-modes__item' }, [modeLinks[m], helpTip(MODE_HELP[m])]))),
      el('div', { class: 'rk-util' }, [guideLink, el('span', { class: 'rk-util__adv' }, [advSwitch, helpTip('advanced')])]),
    ]),
  ]);

  // transport
  const playLabel = el('span', { class: 'rk-play__label', text: 'Play' });
  const playBtn = el(
    'button',
    { type: 'button', class: 'rk-key rk-play', 'data-playing': 'false', 'aria-keyshortcuts': 'Space' },
    [led('rk-led--play'), el('span', { class: 'rk-play__glyph', 'aria-hidden': 'true' }), playLabel],
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
  const bpmRange = el('input', { type: 'range', class: 'rk-fader rk-tempo__fader', min: MIN_BPM, max: MAX_BPM, step: 1, 'aria-label': 'Tempo' });
  const lockMark = el('span', { class: 'rk-lockmark', hidden: true, text: 'Locked while recording' });
  const recLink = el('a', { class: 'rk-rec', href: routeHash('booth'), hidden: true }, [
    led('is-on rk-led--blink'),
    el('span', { 'aria-hidden': 'true', text: 'REC' }),
    el('span', { class: 'rk-visually-hidden', text: 'Recording a take. Go to Booth.' }),
  ]);
  const transport = el('section', { class: 'rk-transport', 'aria-label': 'Transport' }, [
    el('div', { class: 'rk-transport__play' }, [playBtn, helpTip('play')]),
    el('div', { class: 'rk-tempo' }, [
      helpLabel('tempo', { forId: 'rk-bpm', sub: false }),
      el('div', { class: 'rk-tempo__row' }, [
        el('div', { class: 'rk-lcd' }, [bpmNumber, el('span', { id: 'rk-bpm-unit', class: 'rk-lcd__unit', text: 'BPM' })]),
        bpmRange,
      ]),
      lockMark,
    ]),
    recLink,
  ]);

  const audioNote = el('p', { class: 'rk-statusline__audio' }, [led(), el('span')]);
  const statusLine = el('div', { class: 'rk-statusline' }, [audioNote, status.el]);

  // views
  function viewShell(name, content) {
    const h = el('h2', { class: 'rk-view__title', id: `rk-view-${name}-h`, tabindex: -1 }, [
      el('span', { class: 'rk-silk', text: VIEW_INFO[name].title }),
    ]);
    return el('section', { class: `rk-view rk-view--${name}`, 'aria-labelledby': h.id, 'data-view': name, hidden: true }, [
      el('div', { class: 'rk-view__head' }, [h, el('p', { class: 'rk-view__intro', text: VIEW_INFO[name].intro })]),
      content,
    ]);
  }

  const beat = mountBeat(engine, { status, loadWithUndo, afterAudio: renderAudioNote });
  const boothView = mountBooth(engine, {
    onLockChange: setBoothLock,
    isActive: () => route === 'booth',
  });
  const tour = createTour({
    anchors: { pads: beat.anchors.pads, play: playBtn, presets: beat.anchors.presets, booth: modeLinks.booth },
  });
  const guide = mountGuide({
    onReplayTour: () => {
      navigate('beat');
      tour.start({ returnTo: playBtn });
    },
  });
  const views = {
    beat: viewShell('beat', beat.el),
    booth: viewShell('booth', boothView.el),
    guide: viewShell('guide', guide),
  };

  const footer = el('footer', { class: 'rk-foot' }, [
    el('p', { class: 'rk-keys' }, [
      kbd('Space'), text(' play / stop  '),
      kbd('Arrows'), text(' move between pads  '),
      kbd('Enter'), text(' toggle pad  '),
      kbd('R'), text(' record (Booth)  '),
      kbd('Esc'), text(' cancel / close  '),
      text('Knobs: arrow keys or drag, '), kbd('Delete'), text(' or double-click resets.'),
    ]),
    el('p', { class: 'rk-touch-hint', text: 'Knobs: drag up or down, double-tap to reset.' }),
  ]);
  function kbd(t) {
    return el('kbd', { text: t });
  }

  const machine = el('div', { class: 'rk-machine', 'data-advanced': String(advanced) }, [
    header,
    transport,
    statusLine,
    el('main', { class: 'rk-body' }, Object.values(views)),
    footer,
  ]);
  root.replaceChildren(machine);

  // routing
  function applyRoute(next, { focus = false } = {}) {
    // Unknown hashes are rewritten to the route actually shown.
    if (location.hash && location.hash !== routeHash(next)) history.replaceState(null, '', routeHash(next));
    if (next === route) return;
    route = next;
    closeHelp();
    if (tour.active && next !== 'beat') tour.end();
    for (const [name, view] of Object.entries(views)) view.hidden = name !== next;
    for (const [name, link] of Object.entries(modeLinks)) {
      if (name === next) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (next === 'guide') guideLink.setAttribute('aria-current', 'page');
    else guideLink.removeAttribute('aria-current');
    document.title = `Rythmik | ${VIEW_INFO[next].title}`;
    renderRec();
    beat.setActive(next === 'beat');
    boothView.setActive();
    if (focus) views[next].querySelector('.rk-view__title')?.focus();
    maybeStartTour();
  }

  // First visit: the tour runs the first time BEAT is on screen. Blocked storage means once per page load.
  let tourPending = !hasToured(storage);
  function maybeStartTour() {
    if (!tourPending || route !== 'beat') return;
    tourPending = false;
    markToured(storage);
    requestAnimationFrame(() => {
      if (route === 'beat') tour.start();
    });
  }

  // pushState skips hashchange, so the caller controls focus.
  function navigate(next) {
    if (location.hash !== routeHash(next)) history.pushState(null, '', routeHash(next));
    applyRoute(next);
  }

  const onLocation = () => applyRoute(parseRoute(location.hash), { focus: true });
  window.addEventListener('hashchange', onLocation);
  window.addEventListener('popstate', onLocation);

  // advanced
  function setAdvanced(on) {
    advanced = on;
    machine.dataset.advanced = String(on);
    advSwitch.setAttribute('aria-checked', String(on));
    saveAdvanced(storage, on);
  }
  advSwitch.addEventListener('click', () => setAdvanced(!advanced));

  // During a take: tempo, pattern loads and Play/Stop are locked (the take's BPM is
  // fixed and stopping drops it). Pads, notes, swing and mixer stay live.
  function setBoothLock(on) {
    boothLocked = on;
    for (const c of [playBtn, bpmNumber, bpmRange]) c.disabled = on;
    lockMark.hidden = !on;
    beat.setLocked(on);
    renderRec();
  }

  function renderRec() {
    recLink.hidden = !(boothLocked && route !== 'booth');
  }

  // transport rendering
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
    beat.setPlaying(isPlaying);
  }

  let contextListened = false;
  function renderAudioNote() {
    const ctx = engine.context;
    const label = audioNote.lastElementChild;
    let t = '';
    if (!ctx) t = 'Audio starts on your first click or key press.';
    else if (ctx.state !== 'running') t = 'Audio is paused by the browser. Press Play or tap anywhere to resume.';
    if (label.textContent !== t) label.textContent = t;
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

  // Browsers may suspend the context at any time; any gesture resumes it.
  document.addEventListener('pointerdown', ensureAudio);
  document.addEventListener('keydown', (e) => {
    if (!e.repeat) ensureAudio();
  });

  function togglePlay() {
    if (boothLocked) return;
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

  bpmRange.addEventListener('input', () => {
    engine.setBpm(Number(bpmRange.value));
    renderBpm(engine.getPattern().bpm);
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
    if (bpmNumber.value !== '' && Number.isFinite(raw) && !boothLocked) engine.setBpm(raw); // engine clamps
    const bpm = engine.getPattern().bpm;
    bpmNumber.value = String(Math.round(bpm));
    renderBpm(bpm);
  }

  engine.onStateChange(({ isPlaying, bpm }) => {
    renderPlaying(isPlaying);
    if (typeof bpm === 'number') renderBpm(bpm);
  });

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target)) return;
    if (e.target instanceof Element && e.target.closest(SPACE_OWNERS)) return;
    e.preventDefault();
    if (!e.repeat) togglePlay();
  });

  // autosave
  const autosave = createAutosave(storage, { delay: 300 });
  engine.onPatternChange((p) => {
    // Undo would wipe edits made after a load, so drop it on the first edit.
    if (status.undoActive && !applyingLoad) status.clear();
    autosave.schedule(p);
    renderBpm(p.bpm);
  });
  const flushSave = () => autosave.flush();
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  applyRoute(parseRoute(location.hash));
  renderBpm(engine.getPattern().bpm);
  renderPlaying(engine.isPlaying);
  renderAudioNote();

}
