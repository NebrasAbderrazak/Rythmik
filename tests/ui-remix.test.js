// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fakeEngine, polyfillDom, tick, goTo, pressSpace } from './helpers/fakes.js';

const shared = vi.hoisted(() => ({ booth: null, remix: null }));
vi.mock('../src/audio/booth.js', async () => {
  const { fakeBooth } = await import('./helpers/fakes.js');
  return { createBooth: () => (shared.booth = fakeBooth()) };
});
vi.mock('../src/audio/remix.js', async (importOriginal) => {
  const { fakeRemix } = await import('./helpers/fakes.js');
  return { ...(await importOriginal()), createRemix: () => (shared.remix = fakeRemix()) };
});

import { mountApp } from '../src/ui/app.js';
import { formatTime, remixFileName, loadRemixSettings } from '../src/ui/remix.js';
import { formatBpm } from '../src/ui/format.js';
import { backingText } from '../src/ui/booth.js';

let engine;
let restoredWith = [];
const q = (sel) => document.querySelector(sel);
const view = () => q('[data-view=remix]');
const button = (text, root = document) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const fileInput = () => view().querySelector('input[type=file]');
const key = (target, k, opts = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

function chooseFile(file) {
  const input = fileInput();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

beforeAll(async () => {
  polyfillDom();
  HTMLCanvasElement.prototype.getContext = () => null;
  localStorage.clear();
  localStorage.setItem('rythmik:toured', '1');
  localStorage.setItem('rythmik:remix', JSON.stringify({ reverb: 0.3, volume: 0.6, junk: 1 }));
  history.replaceState(null, '', '/');
  document.body.innerHTML = '<div id="app"></div>';
  engine = fakeEngine();
  mountApp(document.getElementById('app'), engine);
  // mock calls are cleared between tests, so keep the mount-time ones
  restoredWith = shared.remix.setSettings.mock.calls.map((c) => c[0]);
  await tick();
});

describe('remix route', () => {
  it('has a third mode button that opens the view', () => {
    const modes = [...document.querySelectorAll('.rk-mode')];
    expect(modes.map((m) => m.getAttribute('href'))).toEqual(['#beat', '#booth', '#remix']);
    goTo('#remix');
    expect(view().hidden).toBe(false);
    expect(modes[2].getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('Rythmik | Remix');
    expect(modes[2].parentElement.querySelector('[data-help=modeRemix]')).toBeTruthy();
  });

  it('restores saved settings without unknown keys', () => {
    expect(restoredWith).toEqual([{ reverb: 0.3, volume: 0.6 }]);
  });
});

describe('empty state', () => {
  it('offers Load a song and says the file stays local', () => {
    const load = button('Load a song', view());
    expect(load).toBeTruthy();
    expect(load.closest('[hidden]')).toBeNull();
    expect(view().textContent).toMatch(/stays on this computer/);
    expect(fileInput().getAttribute('accept')).toBe('audio/*');
    expect(view().querySelector('[aria-labelledby=rk-remix-sound-h]').hidden).toBe(true);
  });

  it('shows a plain message when the file cannot be decoded', async () => {
    shared.remix.load.mockRejectedValueOnce(new Error('decode-failed'));
    chooseFile(new File(['x'], 'broken.mp3', { type: 'audio/mpeg' }));
    await tick();
    const msg = view().querySelector('.rk-msg.is-error');
    expect(msg.textContent).toMatch(/Could not read that file as audio/);
    expect(button('Load a song', view()).closest('[hidden]')).toBeNull();
  });

  it('names the length limit when a song is too long', async () => {
    shared.remix.load.mockRejectedValueOnce(new Error('too-long'));
    chooseFile(new File(['x'], 'long.mp3', { type: 'audio/mpeg' }));
    await tick();
    expect(view().querySelector('.rk-msg.is-error').textContent).toMatch(/longer than 10 minutes/);
    expect(view().textContent).toMatch(/up to 10 minutes/);
  });

  it('rejects files that are not audio before decoding', async () => {
    shared.remix.load.mockClear();
    chooseFile(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    await tick();
    expect(shared.remix.load).not.toHaveBeenCalled();
    expect(view().querySelector('.rk-msg.is-error').textContent).toBe('That is not an audio file.');
  });

  it('loads a song and shows its strip', async () => {
    chooseFile(new File(['x'], 'My Song.mp3', { type: 'audio/mpeg' }));
    await tick();
    expect(shared.remix.load).toHaveBeenCalled();
    expect(q('.rk-remix__name').textContent).toBe('My Song.mp3');
    expect(q('.rk-remix__time').textContent).toBe('2:00');
    expect(button('Play song', view())).toBeTruthy();
    expect(view().querySelector('[aria-labelledby=rk-remix-sound-h]').hidden).toBe(false);
  });
});

describe('deck', () => {
  it('Play song toggles the deck', () => {
    button('Play song', view()).click();
    expect(shared.remix.play).toHaveBeenCalled();
    expect(button('Stop song', view())).toBeTruthy();
    button('Stop song', view()).click();
    expect(shared.remix.stop).toHaveBeenCalled();
  });
});

describe('presets and speed keys', () => {
  it('lights the active preset and speed', () => {
    const slowed = view().querySelector('[data-remix-preset=slowedReverb]');
    slowed.click();
    expect(shared.remix.applyPreset).toHaveBeenCalledWith('slowedReverb');
    expect(slowed.getAttribute('aria-pressed')).toBe('true');
    const pressed = () => [...view().querySelectorAll('[data-speed]')].filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed().map((b) => b.dataset.speed)).toEqual(['slowed']);
    view().querySelector('[data-speed=spedUp]').click();
    expect(shared.remix.setSpeed).toHaveBeenLastCalledWith(1.25);
    expect(pressed().map((b) => b.dataset.speed)).toEqual(['spedUp']);
    expect(slowed.getAttribute('aria-pressed')).toBe('false');
    expect(q('.rk-remix__speed').textContent).toContain('1.25x');
    view().querySelector('[data-remix-preset=original]').click();
    expect(pressed().map((b) => b.dataset.speed)).toEqual(['normal']);
  });

  it('Nightcore is a one-click key next to Slowed + reverb and Original', () => {
    const keys = [...view().querySelectorAll('[data-remix-preset]')].map((b) => b.dataset.remixPreset);
    expect(keys).toEqual(['slowedReverb', 'nightcore', 'original']);
    const nightcore = view().querySelector('[data-remix-preset=nightcore]');
    expect(nightcore.textContent).toBe('Nightcore');
    expect(nightcore.parentElement.querySelector('[data-help=remixNightcore]')).toBeTruthy();
    nightcore.click();
    expect(shared.remix.applyPreset).toHaveBeenLastCalledWith('nightcore');
    expect(nightcore.getAttribute('aria-pressed')).toBe('true');
    expect(view().querySelector('[data-remix-preset=slowedReverb]').getAttribute('aria-pressed')).toBe('false');
    view().querySelector('[data-remix-preset=original]').click();
    expect(nightcore.getAttribute('aria-pressed')).toBe('false');
  });

  it('saves settings when they change', () => {
    view().querySelector('[data-speed=slowed]').click();
    expect(loadRemixSettings()).toMatchObject({ speed: 0.85, reverb: 0 });
  });
});

describe('loop handles', () => {
  it('move with arrow keys, further with Shift', () => {
    const end = view().querySelector('[role=slider][aria-label="Loop end"]');
    const start = view().querySelector('[role=slider][aria-label="Loop start"]');
    expect(end.getAttribute('aria-valuenow')).toBe('120');
    expect(end.getAttribute('aria-valuetext')).toBe('2:00.0');
    end.focus();
    key(end, 'ArrowLeft');
    expect(shared.remix.setLoop).toHaveBeenLastCalledWith(0, 119.9);
    key(end, 'ArrowLeft', { shiftKey: true });
    expect(shared.remix.setLoop.mock.lastCall[1]).toBeCloseTo(118.9, 5);
    key(start, 'ArrowRight', { shiftKey: true });
    expect(shared.remix.setLoop.mock.lastCall[0]).toBe(1);
    expect(start.getAttribute('aria-valuetext')).toBe('0:01.0');
  });

  it('Loop switch turns looping off', () => {
    const sw = button('Loop', view());
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click();
    expect(shared.remix.setLoopEnabled).toHaveBeenLastCalledWith(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
  });

  it('a handle key turns looping back on', () => {
    const sw = button('Loop', view());
    sw.click();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    key(view().querySelector('[role=slider][aria-label="Loop start"]'), 'ArrowRight');
    expect(shared.remix.setLoopEnabled).toHaveBeenLastCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('Start here and End here mark the loop without a pointer', () => {
    const r = shared.remix;
    r.setLoop(0, 120);
    const at = vi.spyOn(r, 'getPosition');
    at.mockReturnValue(30);
    button('Start here', view()).click();
    expect(r.setLoop).toHaveBeenLastCalledWith(30, 120);
    at.mockReturnValue(90);
    button('End here', view()).click();
    expect(r.setLoop).toHaveBeenLastCalledWith(30, 90);
    // an end before the start moves the start out of the way
    at.mockReturnValue(10);
    button('End here', view()).click();
    expect(r.setLoop).toHaveBeenLastCalledWith(0, 10);
    // with Loop off, marking turns it on
    button('Loop', view()).click();
    at.mockReturnValue(50);
    button('Start here', view()).click();
    expect(r.setLoop).toHaveBeenLastCalledWith(50, 120);
    expect(r.loop.enabled).toBe(true);
    expect(view().querySelector('[data-help=remixMarkStart]')).toBeTruthy();
    expect(view().querySelector('[data-help=remixMarkEnd]')).toBeTruthy();
    at.mockRestore();
    r.setLoop(0, 120);
  });

  it('after Stop, Start here marks where the song stopped', () => {
    const r = shared.remix;
    button('Play song', view()).click();
    const at = vi.spyOn(r, 'getPosition').mockReturnValue(45);
    button('Stop song', view()).click();
    at.mockRestore();
    expect(r.getPosition()).toBeNull();
    button('Start here', view()).click();
    expect(r.setLoop).toHaveBeenLastCalledWith(45, 120);
    r.setLoop(0, 120);
  });
});

describe('tempo and beat sync', () => {
  it('beat sync is disabled with a reason until the song has a tempo', () => {
    const sync = button('Beat plays along', view());
    expect(sync.disabled).toBe(true);
    expect(q('#rk-remix-syncwhy').textContent).toMatch(/Needs the song tempo/);
    expect(sync.getAttribute('aria-describedby')).toBe('rk-remix-syncwhy');
  });

  it('tap tempo sets the song tempo from what you hear', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    button('Tap', view()).click();
    now.mockReturnValue(1500);
    button('Tap', view()).click();
    now.mockRestore();
    // two taps 500 ms apart = 120 BPM heard at 0.85x
    expect(shared.remix.setSourceBpm.mock.lastCall[0]).toBeCloseTo(120 / 0.85, 5);
  });

  it('x2 and /2 fix the tempo, and sync turns on', () => {
    shared.remix.setSourceBpm(90);
    button('x2', view()).click();
    expect(shared.remix.setSourceBpm).toHaveBeenLastCalledWith(180);
    button('/2', view()).click();
    expect(shared.remix.setSourceBpm).toHaveBeenLastCalledWith(90);
    expect(q('.rk-lcd--readout .rk-lcd__text').textContent).toBe('90');
    const sync = button('Beat plays along', view());
    expect(sync.disabled).toBe(false);
    sync.click();
    expect(shared.remix.setBeatSync).toHaveBeenLastCalledWith(true);
    expect(sync.getAttribute('aria-checked')).toBe('true');
    expect(loadRemixSettings().beatSync).toBe(true);
  });
});

describe('booth backing', () => {
  it('offers Record over: Remix once the song has a tempo', () => {
    goTo('#booth');
    const overRemix = q('#rk-over-remix');
    expect(overRemix.disabled).toBe(false);
    overRemix.click();
    expect(shared.booth.setBacking).toHaveBeenLastCalledWith('remix');
    expect(q('#rk-over-why').textContent).toMatch(/loop start of My Song\.mp3/);
  });

  it('explains why Remix is unavailable without a tempo', () => {
    shared.booth.setBacking('beat');
    shared.remix.setSourceBpm(null);
    expect(q('#rk-over-remix').disabled).toBe(true);
    expect(q('#rk-over-why').textContent).toMatch(/needs a tempo/);
    shared.remix.setSourceBpm(90);
    q('#rk-over-remix').click();
  });

  it('labels takes with their backing and a tidy tempo', () => {
    const b = shared.booth;
    b.takes = [
      { id: 1, name: 'Take 1', bars: 4, bpm: 93.3333, duration: 10.3, peak: 0.5, backing: { type: 'remix', name: 'My Song.mp3' } },
      { id: 2, name: 'Take 2', bars: 4, bpm: 100, duration: 9.6, peak: 0.5, backing: { type: 'beat' } },
    ];
    b.selectedTakeId = 1;
    b.emit();
    const infos = [...document.querySelectorAll('.rk-take__info')].map((n) => n.textContent);
    expect(infos[0]).toMatch(/^4 bars at 93\.3 BPM over My Song\.mp3,/);
    expect(infos[1]).toMatch(/^4 bars at 100 BPM over the beat,/);
    expect(q('[aria-label="Play Take 1 with song"]')).toBeTruthy();
    expect(q('[aria-label="Play Take 2 with beat"]')).toBeTruthy();
  });
});

describe('while a take records over the remix', () => {
  it('locks the deck and its effect knobs', () => {
    const b = shared.booth;
    expect(b.backing).toBe('remix');
    b.state = 'recording';
    shared.remix.locked = true;
    b.emit();
    goTo('#remix');
    expect(view().querySelector('[data-speed=slowed]').disabled).toBe(true);
    expect(view().querySelector('[data-remix-preset=slowedReverb]').disabled).toBe(true);
    expect(button('Play song', view()).disabled).toBe(true);
    expect(button('Load another', view()).disabled).toBe(true);
    expect(button('Remove', view()).disabled).toBe(true);
    expect(button('Loop', view()).disabled).toBe(true);
    expect(button('Keep pitch', view()).disabled).toBe(true);
    const end = view().querySelector('[aria-label="Loop end"]');
    expect(end.getAttribute('aria-disabled')).toBe('true');
    key(end, 'ArrowLeft');
    expect(shared.remix.setLoop).not.toHaveBeenCalled();
    expect(view().querySelector('.rk-note-line:not([hidden])').textContent).toMatch(/locked while a take records/);
    const space = view().querySelector('[aria-labelledby=rk-remix-space-label]');
    const before = space.getAttribute('aria-valuenow');
    expect(space.getAttribute('aria-disabled')).toBe('true');
    key(space, 'ArrowUp');
    expect(shared.remix.setFx).not.toHaveBeenCalled();
    expect(space.getAttribute('aria-valuenow')).toBe(before);
  });

  it('Space is swallowed; the transport key reads Cancel take and cancels', () => {
    const b = shared.booth;
    document.activeElement.blur();
    expect(pressSpace(document.body).defaultPrevented).toBe(true);
    expect(b.cancel).not.toHaveBeenCalled();
    expect(engine.start).not.toHaveBeenCalled();
    const play = q('.rk-play');
    expect(play.disabled).toBe(false);
    expect(play.textContent).toContain('Cancel take');
    play.click();
    expect(b.cancel).toHaveBeenCalled();

    b.state = 'idle';
    shared.remix.locked = false;
    b.emit();
    expect(view().querySelector('[data-speed=slowed]').disabled).toBe(false);
    expect(q('.rk-play').textContent).toContain('Play');
  });

  it('a take over the beat keeps the transport locked', () => {
    const b = shared.booth;
    b.setBacking('beat');
    b.state = 'recording';
    b.emit();
    expect(q('.rk-play').disabled).toBe(true);
    b.state = 'idle';
    b.emit();
  });
});

describe('deck states from the engine', () => {
  it('respects remix.locked on its own', () => {
    goTo('#remix');
    const r = shared.remix;
    r.locked = true;
    r.emit();
    expect(view().querySelector('[data-speed=slowed]').disabled).toBe(true);
    expect(button('Remove', view()).disabled).toBe(true);
    expect(view().querySelector('.rk-note-line:not([hidden])')).toBeTruthy();
    r.locked = false;
    r.emit();
    expect(view().querySelector('[data-speed=slowed]').disabled).toBe(false);
  });

  it('shows Stretching on Play while keep pitch prepares', async () => {
    const r = shared.remix;
    let started;
    r.play.mockImplementationOnce(() => new Promise((res) => (started = res)));
    r.stretchBusy = true;
    button('Play song', view()).click();
    await tick();
    const deck = view().querySelector('.rk-deck');
    expect(deck.textContent).toBe('Stretching…');
    expect(deck.getAttribute('aria-busy')).toBe('true');
    r.stretchBusy = false;
    r.isPlaying = true;
    started();
    await tick();
    expect(deck.textContent).toBe('Stop song');
    deck.click();
    expect(r.stop).toHaveBeenCalled();
  });

  it('a Stop while play is pending wins', async () => {
    const r = shared.remix;
    let started;
    r.play.mockImplementationOnce(() => new Promise((res) => (started = res)));
    const deck = view().querySelector('.rk-deck');
    deck.click();
    await tick();
    expect(deck.textContent).toBe('Starting…');
    deck.click();
    expect(deck.textContent).toBe('Play song');
    started();
    await tick();
    expect(deck.textContent).toBe('Play song');
    expect(deck.hasAttribute('aria-busy')).toBe(false);
  });

  it('says when a file is too large', async () => {
    shared.remix.load.mockRejectedValueOnce(new Error('too-large'));
    chooseFile(new File(['x'], 'huge.wav', { type: 'audio/wav' }));
    await tick();
    expect(view().querySelector('.rk-msg.is-error').textContent).toMatch(/too large/);
  });
});

describe('dropping files', () => {
  const drop = (target, files) => {
    const e = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { files } });
    target.dispatchEvent(e);
    return e;
  };
  const dragover = (target) => {
    const e = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { dropEffect: 'none' } });
    target.dispatchEvent(e);
    return e;
  };

  it('never lets the browser open a dropped file', () => {
    goTo('#beat');
    expect(dragover(document.body).defaultPrevented).toBe(true);
    expect(drop(document.body, [new File(['x'], 'a.mp3', { type: 'audio/mpeg' })]).defaultPrevented).toBe(true);
    expect(shared.remix.load).not.toHaveBeenCalled();
  });

  it('loads an audio file dropped anywhere in REMIX', async () => {
    goTo('#remix');
    drop(q('.rk-transport'), [new File(['x'], 'Dropped.mp3', { type: 'audio/mpeg' })]);
    await tick();
    expect(shared.remix.load).toHaveBeenCalled();
    expect(q('.rk-remix__name').textContent).toBe('Dropped.mp3');
  });

  it('cancels dragover on the song panel and refuses the drop while locked', () => {
    shared.remix.locked = true;
    shared.remix.emit();
    const panel = view().querySelector('[aria-labelledby=rk-remix-song-h]');
    expect(dragover(panel).defaultPrevented).toBe(true);
    expect(drop(panel, [new File(['x'], 'b.mp3', { type: 'audio/mpeg' })]).defaultPrevented).toBe(true);
    expect(shared.remix.load).not.toHaveBeenCalled();
    expect(view().querySelector('.rk-msg.is-error').textContent).toMatch(/take is recording/);
    shared.remix.locked = false;
    shared.remix.emit();
  });
});

describe('loop handle drag', () => {
  it('keeps the grab offset so the edge does not jump', () => {
    const r = shared.remix;
    r.setLoop(10, 100);
    const wave = view().querySelector('.rk-wave');
    wave.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 100, right: 1200, bottom: 100 });
    const end = view().querySelector('[aria-label="Loop end"]');
    const pointer = (type, target, clientX) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: 7 });
      target.dispatchEvent(e);
    };
    // 10 px per second: grabbed 3 px right of the 100 s edge
    pointer('pointerdown', end, 1003);
    pointer('pointermove', wave, 803);
    expect(end.getAttribute('aria-valuenow')).toBe('80');
    pointer('pointerup', wave, 803);
    expect(r.setLoop.mock.lastCall[0]).toBe(10);
    expect(r.setLoop.mock.lastCall[1]).toBeCloseTo(80, 5);
  });
});

describe('song outside REMIX', () => {
  it('lights the REMIX LED and offers Stop song in the transport', () => {
    const r = shared.remix;
    const remixLed = q('.rk-mode[href="#remix"] .rk-led');
    const stopSong = button('Stop song', q('.rk-transport'));
    r.isPlaying = true;
    r.emit();
    expect(remixLed.classList.contains('is-on')).toBe(true);
    expect(stopSong.closest('[hidden]')).toBeTruthy();
    goTo('#beat');
    expect(stopSong.closest('[hidden]')).toBeNull();
    expect(stopSong.parentElement.querySelector('[data-help=remixDeck]')).toBeTruthy();
    stopSong.click();
    expect(r.stop).toHaveBeenCalled();
    expect(remixLed.classList.contains('is-on')).toBe(false);
    expect(stopSong.closest('[hidden]')).toBeTruthy();
  });
});

describe('beat sync without a tempo', () => {
  it('shows Off while it cannot play, then follows the remembered choice', () => {
    goTo('#remix');
    const r = shared.remix;
    expect(loadRemixSettings().beatSync).toBe(true);
    r.sourceBpm = null;
    r.settings = { ...r.settings, beatSync: false };
    r.emit();
    const sync = button('Beat plays along', view());
    expect(sync.getAttribute('aria-checked')).toBe('false');
    expect(sync.disabled).toBe(true);
    expect(q('#rk-remix-syncwhy').textContent).toMatch(/Needs the song tempo/);
    r.setSourceBpm(100);
    expect(r.setBeatSync).toHaveBeenLastCalledWith(true);
    expect(sync.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the clamped tempo after typing one', () => {
    const input = q('#rk-remix-bpm');
    shared.remix.setSourceBpm.mockImplementationOnce((n) => {
      shared.remix.sourceBpm = Math.min(220, n);
      shared.remix.emit();
    });
    input.focus();
    input.value = '500';
    input.dispatchEvent(new Event('change'));
    expect(input.value).toBe('220');
    shared.remix.setSourceBpm(100);
  });
});

describe('export', () => {
  it('renders the chosen length with the beat when synced', async () => {
    URL.createObjectURL ??= () => 'blob:x';
    URL.revokeObjectURL ??= () => {};
    const data = new Float32Array(8);
    shared.remix.render.mockResolvedValueOnce({ numberOfChannels: 1, sampleRate: 48000, length: 8, getChannelData: () => data });
    const btn = button('Export remix (WAV)', view());
    q('#rk-remix-range-song').click();
    btn.click();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await tick();
    expect(shared.remix.render).toHaveBeenCalledWith({ loopOnly: false, withBeat: true });
    expect(view().querySelector('.rk-msg:not(.is-error)').textContent).toMatch(/Dropped-remix\.wav/);
  });

  it('with Loop off the whole song is exported and the choice is disabled', async () => {
    q('#rk-remix-range-loop').click();
    button('Loop', view()).click();
    expect(q('#rk-remix-range-loop').disabled).toBe(true);
    expect(q('#rk-remix-range-why').hidden).toBe(false);
    expect(q('#rk-remix-range-why').textContent).toBe('Loop is off: the whole song is exported.');
    button('Export remix (WAV)', view()).click();
    await tick();
    expect(shared.remix.render).toHaveBeenCalledWith({ loopOnly: false, withBeat: true });
    button('Loop', view()).click();
    expect(q('#rk-remix-range-loop').disabled).toBe(false);
  });
});

describe('saved settings', () => {
  const storage = (value) => ({ getItem: () => value, setItem() {} });

  it('ignores corrupt values', () => {
    for (const v of ['{', '[]', 'null', '"x"', '42']) expect(loadRemixSettings(storage(v)), v).toBeNull();
    expect(loadRemixSettings({ getItem: () => { throw new Error('blocked'); } })).toBeNull();
  });

  it('drops unknown keys and wrong types', () => {
    expect(loadRemixSettings(storage('{"speed":"fast","x":1,"keepPitch":"yes","reverb":0.4}'))).toEqual({ reverb: 0.4 });
  });
});

describe('formatting', () => {
  it('formats tempo, time and file names', () => {
    expect(formatBpm(92)).toBe('92');
    expect(formatBpm(78.24)).toBe('78.2');
    expect(formatBpm(null)).toBe('--');
    expect(formatTime(222)).toBe('3:42');
    expect(formatTime(61.25, true)).toBe('1:01.3');
    expect(remixFileName('My Song.mp3')).toBe('My-Song-remix.wav');
    expect(remixFileName('a/b:c?.wav')).toBe('abc-remix.wav');
    expect(remixFileName('')).toBe('song-remix.wav');
    expect(backingText({ backing: { type: 'remix', name: 'X' } })).toBe('over X');
    expect(backingText({})).toBe('over the beat');
  });
});
