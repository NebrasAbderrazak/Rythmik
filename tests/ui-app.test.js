// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fakeEngine, polyfillDom, tick, goTo, pressSpace } from './helpers/fakes.js';

const shared = vi.hoisted(() => ({ booth: null }));
vi.mock('../src/audio/booth.js', async () => {
  const { fakeBooth } = await import('./helpers/fakes.js');
  return { createBooth: () => (shared.booth = fakeBooth()) };
});

import { mountApp } from '../src/ui/app.js';
import { HELP } from '../src/ui/help.js';

let engine;
const q = (sel) => document.querySelector(sel);
const view = (name) => q(`[data-view=${name}]`);
const tourOpen = () => !q('.rk-tour').hidden;
const playBtn = () => q('.rk-play');
const escape = (target = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

beforeAll(async () => {
  polyfillDom();
  localStorage.clear();
  history.replaceState(null, '', '/');
  document.body.innerHTML = '<div id="app"></div>';
  engine = fakeEngine();
  mountApp(document.getElementById('app'), engine);
  await tick();
});

describe('first visit tour', () => {
  it('shows on BEAT and Esc ends it on a connected control', () => {
    expect(tourOpen()).toBe(true);
    expect(document.activeElement.closest('.rk-tour')).toBeTruthy();
    expect(localStorage.getItem('rythmik:toured')).toBe('1');
    escape();
    expect(tourOpen()).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement.isConnected).toBe(true);
    expect(document.activeElement.closest('[hidden]')).toBeNull();
  });

  it('replays from the Guide; Skip returns focus to Play', () => {
    goTo('#guide');
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Replay the tour').click();
    expect(tourOpen()).toBe(true);
    expect(view('beat').hidden).toBe(false);
    [...q('.rk-tour').querySelectorAll('button')].find((b) => b.textContent === 'Skip tour').click();
    expect(tourOpen()).toBe(false);
    expect(document.activeElement).toBe(playBtn());
  });
});

describe('advanced switch', () => {
  it('toggles aria-checked, data-advanced and storage', () => {
    const sw = q('[role=switch]');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(q('.rk-machine').dataset.advanced).toBe('false');
    sw.click();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(q('.rk-machine').dataset.advanced).toBe('true');
    expect(localStorage.getItem('rythmik:advanced')).toBe('1');
    sw.click();
    expect(localStorage.getItem('rythmik:advanced')).toBe('0');
  });
});

describe('help tips', () => {
  it('only one is open; Esc closes it and refocuses its button', () => {
    const [a, b] = document.querySelectorAll('.rk-help__btn');
    a.focus();
    a.click();
    expect(a.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(a.getAttribute('aria-controls')).hidden).toBe(false);
    b.focus();
    b.click();
    expect(a.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    escape(document.activeElement);
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(b);
  });

  it('headings do not contain a ? button', () => {
    for (const h of document.querySelectorAll('h1, h2, h3')) expect(h.querySelector('.rk-help')).toBeNull();
  });
});

describe('Space shortcut', () => {
  it('leaves focused buttons and links alone', () => {
    engine.start.mockClear();
    const sw = q('[role=switch]');
    sw.focus();
    expect(pressSpace(sw).defaultPrevented).toBe(false);
    expect(pressSpace(q('.rk-mode')).defaultPrevented).toBe(false);
    expect(engine.start).not.toHaveBeenCalled();
  });

  it('toggles play from the page background', () => {
    engine.start.mockClear();
    document.activeElement.blur();
    expect(pressSpace(document.body).defaultPrevented).toBe(true);
    expect(engine.start).toHaveBeenCalledTimes(1);
    pressSpace(document.body);
    expect(engine.stop).toHaveBeenCalled();
  });
});

describe('routes', () => {
  it('switching views keeps a running take and shows the REC link', () => {
    goTo('#booth');
    expect(view('booth').hidden).toBe(false);
    expect(q('.rk-rec').hidden).toBe(true);
    shared.booth.state = 'recording';
    shared.booth.emit();
    expect(playBtn().disabled).toBe(true);
    goTo('#beat');
    expect(view('booth').hidden).toBe(true);
    expect(view('booth').isConnected).toBe(true);
    expect(shared.booth.cancel).not.toHaveBeenCalled();
    expect(q('.rk-rec').hidden).toBe(false);
    expect(q('.rk-rec').getAttribute('href')).toBe('#booth');
    expect(q('[data-preset]').disabled).toBe(true);
    goTo('#booth');
    expect(q('.rk-rec').hidden).toBe(true);
    shared.booth.state = 'idle';
    shared.booth.emit();
    expect(playBtn().disabled).toBe(false);
  });

  it('mode links carry aria-current', () => {
    goTo('#beat');
    const [beat, booth] = document.querySelectorAll('.rk-mode');
    expect(beat.getAttribute('aria-current')).toBe('page');
    expect(booth.hasAttribute('aria-current')).toBe(false);
  });

  it('rewrites an unknown hash to the route shown', () => {
    goTo('#nope');
    expect(location.hash).toBe('#beat');
    expect(view('beat').hidden).toBe(false);
  });
});

describe('beginner notes', () => {
  it('say when a hidden setting is in effect', async () => {
    const note = q('.rk-seq .rk-note-line');
    engine.setMasterVolume(0.05);
    await tick();
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/master volume is low/);
    engine.setMasterVolume(0.8);
    await tick();
    expect(note.hidden).toBe(true);
  });
});

describe('accessibility', () => {
  it('each ? button is described by its explanation', () => {
    const btn = q('[data-help=play]');
    const desc = document.getElementById(btn.getAttribute('aria-describedby'));
    expect(desc.textContent).toBe(HELP.play.text);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('the skip link comes first and jumps to the section heading', () => {
    goTo('#beat');
    const skip = q('a[href], button');
    expect(skip.textContent).toBe('Skip to section');
    skip.click();
    expect(location.hash).toBe('#beat');
    expect(document.activeElement).toBe(view('beat').querySelector('.rk-view__title'));
  });

  it('the REC link name starts with REC', () => {
    const rec = q('.rk-rec');
    expect(rec.querySelector('[aria-hidden=true]:not(.rk-led)')).toBeNull();
    expect(rec.textContent.trim()).toMatch(/^REC: recording a take/);
  });
});

describe('booth recording', () => {
  const live = () => view('booth').querySelector('.rk-visually-hidden[role=status]');

  it('announces the count-in and each bar once', async () => {
    goTo('#booth');
    const b = shared.booth;
    b.micOpen = true;
    b.emit();
    let finish;
    let progress = { countIn: true, beat: 1 };
    b.getRecordProgress = () => progress;
    b.record.mockImplementationOnce(() => {
      b.state = 'count-in';
      b.emit();
      return new Promise((r) => (finish = r));
    });
    const said = [];
    const watch = new MutationObserver(() => said.push(live().textContent));
    watch.observe(live(), { childList: true, characterData: true, subtree: true });
    q('.rk-record').click();
    await tick();
    progress = { countIn: true, beat: 2 };
    await tick();
    b.state = 'recording';
    progress = { bar: 1, totalBars: 4, beat: 1 };
    await tick();
    progress = { bar: 1, totalBars: 4, beat: 3 };
    await tick();
    progress = { bar: 2, totalBars: 4, beat: 1 };
    await tick();
    b.state = 'idle';
    b.emit();
    finish(null);
    await tick();
    watch.disconnect();
    expect(said.filter(Boolean)).toEqual(['Count-in', 'Recording bar 1 of 4', 'Recording bar 2 of 4']);
    expect(live().textContent).toBe('');
  });

  it('says how to go on when the take limit is reached', async () => {
    const b = shared.booth;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    b.record.mockRejectedValueOnce(new Error('too-many-takes'));
    q('.rk-record').click();
    await tick();
    const msg = view('booth').querySelector('.rk-msg.is-error');
    expect(msg.textContent).toBe('You have 12 takes. Delete one to record another.');
    expect(logged).not.toHaveBeenCalled();
    expect(playBtn().disabled).toBe(false);
    logged.mockRestore();
    b.takesFull = true;
    b.record.mockClear();
    q('.rk-record').click();
    expect(b.record).not.toHaveBeenCalled();
    expect(msg.textContent).toBe('You have 12 takes. Delete one to record another.');
    b.takesFull = false;
  });
});
