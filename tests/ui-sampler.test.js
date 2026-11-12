// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { polyfillDom, tick } from './helpers/fakes.js';

const shared = vi.hoisted(() => ({ booth: null }));
vi.mock('../src/audio/booth.js', async () => {
  const { fakeBooth } = await import('./helpers/fakes.js');
  return { createBooth: () => (shared.booth = fakeBooth()) };
});

import { mountSampler, samplerErrorText, revealSampler, PANEL_ID } from '../src/ui/sampler.js';
import { mountBooth } from '../src/ui/booth.js';
import { SAMPLER_HELP, SAMPLER_GUIDE } from '../src/ui/help-sampler.js';
import { HELP } from '../src/ui/help.js';
import { isTyping } from '../src/ui/dom.js';

// A sampler that keeps state like the real one, without audio.
function makeSampler() {
  const listeners = new Set();
  let n = 0;
  const sources = [];
  const samples = [];
  const emit = () => [...listeners].forEach((cb) => cb());
  const addSource = (name, duration) => {
    if (sources.length >= 8) throw new Error('too-many');
    const s = { id: `src-${++n}`, name, duration, channels: 1, sampleRate: 48000 };
    sources.push(s);
    emit();
    return { ...s };
  };
  const sampler = {
    recording: false,
    previewSourceId: null,
    get sources() { return sources.map((s) => ({ ...s })); },
    get samples() { return samples.map((s) => ({ ...s })); },
    getSample: (id) => ({ ...samples.find((s) => s.id === id) }),
    fromFile: vi.fn(async (file) => addSource(file.name.replace(/\.[^.]*$/, ''), 12)),
    record: vi.fn(async () => addSource('Mic 1', 1.5)),
    cancelRecord: vi.fn(),
    fromTake: vi.fn((takeId) => addSource(`Take ${takeId}`, 3)),
    removeSource: vi.fn((id) => {
      sources.splice(sources.findIndex((s) => s.id === id), 1);
      emit();
    }),
    getPeaks: (id, cols) => ({ min: new Float32Array(cols), max: new Float32Array(cols) }),
    chop: vi.fn(() => [{ start: 0, end: 0.4 }, { start: 0.5, end: 0.9 }, { start: 1, end: 1.4 }]),
    createSample: vi.fn((sourceId, { start, end, name }) => {
      if (samples.length >= 16) throw new Error('too-many');
      const id = `smp-${samples.length + 1}`;
      samples.push({
        id, sourceId, name: name || `Sound ${samples.length + 1}`, start, end, duration: end - start,
        gain: 0.8, pitch: 0, reverse: false, fadeIn: 0, fadeOut: 0.01,
      });
      emit();
      return id;
    }),
    update: vi.fn((id, partial) => {
      Object.assign(samples.find((s) => s.id === id), partial);
      emit();
    }),
    remove: vi.fn((id) => {
      samples.splice(samples.findIndex((s) => s.id === id), 1);
      emit();
    }),
    audition: vi.fn(),
    playRegion: vi.fn(async (id) => {
      sampler.previewSourceId = id;
      emit();
    }),
    stopRegion: vi.fn(() => {
      if (!sampler.previewSourceId) return;
      sampler.previewSourceId = null;
      emit();
    }),
    storage: 'saved',
    setStorage(next) {
      sampler.storage = next;
      emit();
    },
    save: vi.fn(async () => true),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    listenerCount: () => listeners.size,
  };
  return sampler;
}

function makeEngine(tracks = ['kick', 'snare']) {
  const cbs = new Set();
  const pattern = { tracks: [...tracks] };
  return {
    getPattern: () => structuredClone(pattern),
    addTrack: vi.fn((id) => {
      if (pattern.tracks.includes(id) || pattern.tracks.length >= 16) return false;
      pattern.tracks.push(id);
      cbs.forEach((cb) => cb(structuredClone(pattern)));
      return true;
    }),
    onPatternChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
}

function makeBooth(takes = []) {
  const cbs = new Set();
  return {
    state: 'idle',
    takes,
    previewTakeId: null,
    micOpen: true,
    getClipProgress: () => null,
    onChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    emit: () => cbs.forEach((cb) => cb()),
  };
}

function makeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    data,
  };
}

let sampler;
let engine;
let view;
const button = (text, root = view.el) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const key = (target, k, opts = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
const msg = () => view.el.querySelector('.rk-msg');

let booth;
let store;

function mount({ tracks, takes, open = 'true' } = {}) {
  sampler = makeSampler();
  engine = makeEngine(tracks);
  booth = makeBooth(takes);
  store = makeStore(open == null ? {} : { 'rythmik:samplesOpen': open });
  view = mountSampler(sampler, engine, { booth, store, countdownStep: 0 });
  document.body.innerHTML = '';
  const machine = document.createElement('div');
  machine.className = 'rk-machine';
  machine.dataset.advanced = 'false';
  machine.append(view.el);
  document.body.append(machine);
  view.setActive(true);
}

function chooseFile(file) {
  const input = view.el.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

async function loadSound(name = 'drums.wav') {
  chooseFile(new File(['x'], name, { type: 'audio/wav' }));
  await tick();
}

beforeAll(() => {
  polyfillDom();
  HTMLCanvasElement.prototype.getContext = () => null;
});

describe('help', () => {
  it('has one short sentence per entry, all in the guide section', () => {
    for (const [k, h] of Object.entries(SAMPLER_HELP)) {
      expect(h.term, k).toBeTruthy();
      expect(h.text.length, k).toBeLessThan(200);
      expect(h.text.endsWith('.'), k).toBe(true);
      expect(h.text.slice(0, -1).includes('. '), k).toBe(false);
      expect(SAMPLER_GUIDE.section.keys, k).toContain(k);
      expect(HELP[k]).toBeTruthy();
    }
    expect(SAMPLER_GUIDE.recipe.title).toBe('Turn a word from your take into a drum');
  });
});

describe('empty state', () => {
  beforeEach(() => mount());

  it('offers record, load and booth take keys, and says sounds stay local', () => {
    expect(button('Record (up to 10 s)')).toBeTruthy();
    expect(button('Load a sound')).toBeTruthy();
    const take = button('From a Booth take');
    expect(take.disabled).toBe(true);
    const why = document.getElementById(take.getAttribute('aria-describedby'));
    expect(why.textContent).toMatch(/record one in BOOTH first/);
    expect(view.el.textContent).toMatch(/stay on this computer/);
    expect(view.el.querySelector('input[type=file]').getAttribute('accept')).toBe('audio/*');
    expect(view.el.querySelector('.rk-smp__editor').hidden).toBe(true);
    expect(view.el.id).toBe(PANEL_ID);
  });

  it('lists booth takes and turns one into a source', async () => {
    mount({ takes: [{ id: 7, name: 'Take 1', duration: 3 }] });
    const take = button('From a Booth take');
    expect(take.disabled).toBe(false);
    take.click();
    expect(take.getAttribute('aria-expanded')).toBe('true');
    view.el.querySelector('[data-take="7"]').click();
    expect(sampler.fromTake).toHaveBeenCalledWith(7);
    expect(view.el.querySelector('.rk-smp__editor').hidden).toBe(false);
    expect(msg().textContent).toMatch(/Take 1 is ready to cut/);
  });
});

describe('load errors', () => {
  beforeEach(() => mount());

  it.each([
    ['decode-failed', /Could not read that file as audio/],
    ['too-long', /longer than 30 seconds/],
    ['too-many', /8 recordings/],
  ])('%s gets plain words', async (code, text) => {
    sampler.fromFile.mockRejectedValueOnce(new Error(code));
    await loadSound();
    expect(msg().classList.contains('is-error')).toBe(true);
    expect(msg().textContent).toMatch(text);
  });

  it('refuses files that are not audio without reading them', async () => {
    chooseFile(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    await tick();
    expect(sampler.fromFile).not.toHaveBeenCalled();
    expect(msg().textContent).toBe('That is not an audio file.');
  });

  it('explains mic problems', async () => {
    sampler.record.mockRejectedValueOnce(new Error('mic-denied'));
    button('Record (up to 10 s)').click();
    await vi.waitFor(() => expect(msg().textContent).not.toBe(''));
    expect(sampler.record).toHaveBeenCalledWith({ seconds: 4 });
    expect(msg().textContent).toMatch(/Microphone access is blocked/);
  });

  it('maps errors by what was being made', () => {
    expect(samplerErrorText(new Error('too-many'), 'sample')).toMatch(/16 sounds/);
    expect(samplerErrorText(new Error('silent'))).toMatch(/Nothing was heard/);
  });
});

describe('region', () => {
  beforeEach(async () => {
    mount();
    await loadSound();
  });

  it('starts on the first 10 s and moves with the keyboard', () => {
    const start = view.el.querySelector('[data-handle=start]');
    const end = view.el.querySelector('[data-handle=end]');
    expect(end.getAttribute('aria-valuenow')).toBe('10.00');
    key(start, 'ArrowRight');
    expect(start.getAttribute('aria-valuenow')).toBe('0.01');
    key(start, 'ArrowRight', { shiftKey: true });
    expect(start.getAttribute('aria-valuenow')).toBe('0.11');
    // end cannot go past start + 10 s
    key(end, 'End');
    expect(end.getAttribute('aria-valuenow')).toBe('10.11');
    key(start, 'Home');
    expect(start.getAttribute('aria-valuenow')).toBe('0.11');
    key(end, 'ArrowLeft', { shiftKey: true });
    expect(end.getAttribute('aria-valuenow')).toBe('10.01');
    expect(view.el.querySelector('.rk-smp__regioninfo').textContent).toMatch(/0.11 s to 10.01 s/);
  });

  it('plays the region and adds it as a sound with its name', () => {
    button('Play region').click();
    expect(sampler.playRegion).toHaveBeenCalledWith('src-1', { start: 0, end: 10 });
    expect(button('Stop')).toBeTruthy();
    view.el.querySelector('#rk-smp-name').value = 'Boom';
    button('Add as sound').click();
    expect(sampler.createSample).toHaveBeenCalledWith('src-1', { start: 0, end: 10, name: 'Boom' });
    const card = view.el.querySelector('.rk-smp-card');
    expect(card.querySelector('.rk-smp-card__name').textContent).toBe('Boom');
    card.querySelector('.rk-smp-card__pad').click();
    expect(sampler.audition).toHaveBeenCalledWith('smp-1');
  });
});

describe('chop', () => {
  beforeEach(async () => {
    mount();
    await loadSound('kit.wav');
    button('Chop').click();
  });

  it('shows numbered slices you pick by tapping', () => {
    const slices = [...view.el.querySelectorAll('[data-slice]')];
    expect(slices.map((s) => s.textContent)).toEqual(['1', '2', '3']);
    slices[1].click();
    expect(slices[1].getAttribute('aria-pressed')).toBe('true');
    expect(sampler.playRegion).toHaveBeenLastCalledWith('src-1', { start: 0.5, end: 0.9 });
    slices[2].click();
    expect(button('Add 2 slices')).toBeTruthy();
    button('Add 2 slices').click();
    expect(sampler.createSample.mock.calls.map((c) => c[1].name)).toEqual(['kit 2', 'kit 3']);
  });

  it('adds every slice in one click', () => {
    button('Add all slices').click();
    expect(sampler.createSample).toHaveBeenCalledTimes(3);
    expect(view.el.querySelectorAll('.rk-smp-card').length).toBe(3);
    expect(msg().textContent).toMatch(/Added 3 sounds/);
  });

  it('a manual region edit unpicks the slices', () => {
    view.el.querySelector('[data-slice="0"]').click();
    key(view.el.querySelector('[data-handle=end]'), 'ArrowRight');
    expect(view.el.querySelector('[data-slice="0"]').getAttribute('aria-pressed')).toBe('false');
    expect(button('Add as sound')).toBeTruthy();
  });
});

describe('add to beat', () => {
  it('adds the row, then says it is already there', async () => {
    mount();
    await loadSound();
    button('Add as sound').click();
    const add = view.el.querySelector('[data-add]');
    add.click();
    expect(engine.addTrack).toHaveBeenCalledWith('smp-1');
    expect(add.disabled).toBe(true);
    expect(add.textContent).toBe('In the beat');
    expect(view.el.querySelector('.rk-smp-card__tag').hidden).toBe(false);
  });

  it('is disabled with a reason when the beat has 16 rows', async () => {
    mount({ tracks: Array.from({ length: 16 }, (_, i) => `t${i}`) });
    await loadSound();
    button('Add as sound').click();
    const add = view.el.querySelector('[data-add]');
    expect(add.disabled).toBe(true);
    expect(document.getElementById(add.getAttribute('aria-describedby')).textContent).toMatch(/16 rows/);
  });

  it('stops new sounds at 16 with a kind message', async () => {
    mount();
    await loadSound();
    for (let i = 0; i < 16; i++) sampler.createSample('src-1', { start: 0, end: 1 });
    const add = button('Add as sound');
    expect(add.disabled).toBe(true);
    expect(view.el.querySelector('#rk-smp-add-why').textContent).toMatch(/16 sounds/);
    expect(view.el.querySelector('.rk-smp__count').textContent).toBe('16 of 16 sounds');
  });

  it('shows the storage state of the sampler', async () => {
    mount();
    await loadSound();
    button('Add as sound').click();
    const line = () => view.el.querySelector('.rk-smp__storage').textContent;
    expect(line()).toBe('Saved in this browser.');
    sampler.setStorage('unsaved');
    expect(line()).toBe('Saving…');
    sampler.setStorage('unavailable');
    expect(line()).toMatch(/^Not saved: this browser blocks storage/);
    expect(sampler.save).not.toHaveBeenCalled();
  });

  it('deletes after a second press', async () => {
    mount();
    await loadSound();
    button('Add as sound').click();
    const del = view.el.querySelector('.rk-smp-card__del');
    del.click();
    expect(sampler.remove).not.toHaveBeenCalled();
    expect(del.textContent).toBe('Press again to delete');
    del.click();
    expect(sampler.remove).toHaveBeenCalledWith('smp-1');
    expect(view.el.querySelector('.rk-smp-card')).toBeNull();
  });
});

describe('setActive', () => {
  it('drops its listeners when hidden', () => {
    mount();
    expect(sampler.listenerCount()).toBe(1);
    view.setActive(false);
    expect(sampler.listenerCount()).toBe(0);
    view.setActive(true);
    expect(sampler.listenerCount()).toBe(1);
  });

  it('opens a source added while hidden', () => {
    mount();
    view.setActive(false);
    sampler.fromTake(3);
    view.setActive(true);
    expect(view.el.querySelector('.rk-smp__editor').hidden).toBe(false);
    expect(view.el.querySelector('[data-source="src-1"]').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('booth: Use as sample', () => {
  it('sends the take to the sampler and goes to the panel', async () => {
    mount();
    view.setActive(false);
    history.replaceState(null, '', '#booth');
    const boothView = mountBooth({ onStateChange: () => () => {}, onPatternChange: () => () => {} }, { getSampler: () => sampler });
    document.body.append(boothView.el);
    shared.booth.takes = [{ id: 5, name: 'Take 1', bars: 4, bpm: 100, duration: 9.6, peak: 0.5, backing: { type: 'beat' } }];
    shared.booth.emit();
    const use = button('Use as sample', boothView.el);
    expect(use.getAttribute('aria-label')).toBe('Use Take 1 as sample');
    use.click();
    expect(sampler.fromTake).toHaveBeenCalledWith(5);
    await tick();
    expect(location.hash).toBe('#beat');
    expect(document.activeElement).toBe(view.el);
  });

  it('explains when the take cannot be used', () => {
    mount();
    sampler.fromTake.mockImplementationOnce(() => { throw new Error('silent'); });
    const boothView = mountBooth({ onStateChange: () => () => {}, onPatternChange: () => () => {} }, { getSampler: () => sampler });
    document.body.append(boothView.el);
    shared.booth.takes = [{ id: 5, name: 'Take 1', bars: 4, bpm: 100, duration: 9.6, peak: 0.5, backing: { type: 'beat' } }];
    shared.booth.emit();
    button('Use as sample', boothView.el).click();
    expect(boothView.el.textContent).toMatch(/Nothing was heard/);
  });

  it('hides the key without a sampler', () => {
    const boothView = mountBooth({ onStateChange: () => () => {}, onPatternChange: () => () => {} });
    shared.booth.takes = [{ id: 5, name: 'Take 1', bars: 4, bpm: 100, duration: 9.6, peak: 0.5, backing: { type: 'beat' } }];
    shared.booth.emit();
    expect(button('Use as sample', boothView.el).hidden).toBe(true);
  });
});

describe('collapsed panel', () => {
  const body = () => view.el.querySelector('#rk-smp-body');
  const openKey = () => button('Your own sounds');

  it('starts closed for beginners with one row and a ?', () => {
    mount({ open: null });
    expect(body().hidden).toBe(true);
    expect(openKey().getAttribute('aria-expanded')).toBe('false');
    expect(openKey().parentElement.querySelector('[data-help=smpPanel]')).toBeTruthy();
    expect(view.el.querySelector('.rk-smp__openline').textContent).toMatch(/play it as a drum/);
    expect(view.isOpen).toBe(false);
  });

  it('remembers the choice', () => {
    mount({ open: null });
    openKey().click();
    expect(body().hidden).toBe(false);
    expect(store.data.get('rythmik:samplesOpen')).toBe('true');
    view.setOpen(false);
    expect(body().hidden).toBe(true);
    expect(store.data.get('rythmik:samplesOpen')).toBe('false');
  });

  it('opens by itself when sounds arrive', () => {
    mount({ open: null });
    sampler.fromTake(2);
    expect(view.isOpen).toBe(true);
  });

  it('stays closed when closed on purpose, until revealed', () => {
    mount({ open: 'false' });
    sampler.fromTake(2);
    expect(view.isOpen).toBe(false);
    history.replaceState(null, '', '#beat');
    revealSampler();
    expect(view.isOpen).toBe(true);
    expect(document.activeElement).toBe(view.el);
  });

  it('survives storage that throws', () => {
    const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const v = mountSampler(makeSampler(), makeEngine(), { booth: makeBooth(), store: bad });
    expect(v.isOpen).toBe(false);
    v.setOpen(true);
    expect(v.isOpen).toBe(true);
  });
});

describe('recording', () => {
  beforeEach(() => mount());

  it('counts down before the mic records', async () => {
    button('Record (up to 10 s)').click();
    await Promise.resolve();
    expect(view.el.querySelector('.rk-smp__busy').textContent).toMatch(/Recording in 3/);
    expect(sampler.record).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sampler.record).toHaveBeenCalledWith({ seconds: 4 }));
  });

  it('Esc anywhere cancels the countdown', async () => {
    button('Record (up to 10 s)').click();
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await tick();
    expect(sampler.record).not.toHaveBeenCalled();
    expect(msg().textContent).toBe('Recording cancelled.');
    // the document listener is gone again
    const later = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it('Esc anywhere cancels a running recording', async () => {
    let finish;
    sampler.record.mockImplementationOnce(() => {
      sampler.recording = true;
      return new Promise((r) => { finish = r; });
    });
    sampler.cancelRecord.mockImplementation(() => {
      sampler.recording = false;
      finish(null);
    });
    button('Record (up to 10 s)').click();
    await vi.waitFor(() => expect(sampler.record).toHaveBeenCalled());
    expect(button('Cancel recording')).toBeTruthy();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(sampler.cancelRecord).toHaveBeenCalled();
    await tick();
    expect(msg().textContent).toBe('Recording cancelled.');
  });

  it('says why Record is off while the Booth records, and warns about a playing take', () => {
    const rec = button('Record (up to 10 s)');
    const why = () => document.getElementById(rec.getAttribute('aria-describedby'));
    booth.state = 'recording';
    booth.emit();
    expect(rec.disabled).toBe(true);
    expect(why().textContent).toMatch(/The Booth is recording/);
    booth.state = 'idle';
    booth.previewTakeId = 1;
    booth.emit();
    expect(rec.disabled).toBe(false);
    expect(why().textContent).toMatch(/A take is playing/);
  });
});

describe('picked slices on the waveform', () => {
  it('lights every picked slice, not just the last', async () => {
    mount();
    const lit = [];
    const ctx = {
      fillStyle: '',
      setTransform() {},
      clearRect() {},
      fillRect(x, y, w) {
        if (w === 1 && this.fillStyle === '#cfc5b4') lit.push(x);
      },
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ctx;
    try {
      await loadSound('kit.wav');
      const wave = view.el.querySelector('.rk-smp__wave');
      Object.defineProperty(wave, 'clientWidth', { value: 120, configurable: true });
      Object.defineProperty(wave, 'clientHeight', { value: 60, configurable: true });
      button('Chop').click();
      view.el.querySelector('[data-slice="0"]').click();
      view.el.querySelector('[data-slice="2"]').click();
      await tick();
      lit.length = 0;
      view.setOpen(false);
      view.setOpen(true);
      await tick();
      // 12 s over 120 px: slice 1 is 0..0.4 s (x 0..3), slice 3 is 1..1.4 s (x 10..13)
      expect(lit).toEqual([0, 1, 2, 3, 10, 11, 12, 13]);
      expect(view.el.querySelectorAll('.rk-smp__slicemark.is-picked').length).toBe(2);
      expect(button('Add 2 slices')).toBeTruthy();
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });
});

describe('Space in text fields', () => {
  it('the app Space rule treats every panel input as typing', async () => {
    mount();
    await loadSound();
    button('Add as sound').click();
    const inputs = [...view.el.querySelectorAll('input:not([type=file])')];
    expect(inputs.length).toBeGreaterThan(2);
    for (const input of inputs) expect(isTyping(input), input.className).toBe(true);
  });
});
