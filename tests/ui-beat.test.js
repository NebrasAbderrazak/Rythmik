// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fakeEngine, polyfillDom, tick, goTo } from './helpers/fakes.js';

const shared = vi.hoisted(() => ({ booth: null, sampler: null }));
vi.mock('../src/audio/booth.js', async () => {
  const { fakeBooth } = await import('./helpers/fakes.js');
  return { createBooth: () => (shared.booth = fakeBooth()) };
});
vi.mock('../src/audio/sampler.js', async (importOriginal) => {
  const real = await importOriginal();
  const { fakeSampler } = await import('./helpers/fakes.js');
  return { ...real, createSampler: (engine) => (shared.sampler = fakeSampler(engine)) };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mountApp } from '../src/ui/app.js';
import { PRESETS } from '../src/audio/presets.js';
import { normalizePattern, serializePattern } from '../src/audio/pattern.js';
import { savePattern, loadSavedPattern, readPatternFile, STORAGE_KEY } from '../src/ui/persistence.js';
import { nextVelocity, nextChance, nextRoll, stepDetails, matchPreset } from '../src/ui/beat.js';

let engine;
const q = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
const beat = () => q('[data-view=beat]');
const key = (text) => qa('button', beat()).find((b) => b.textContent.trim() === text);
const shown = (node) => {
  for (let n = node; n; n = n.parentElement) if (getComputedStyle(n).display === 'none' || n.hidden) return false;
  return true;
};
const setAdvanced = (on) => {
  const sw = q('[role=switch]');
  if ((sw.getAttribute('aria-checked') === 'true') !== on) sw.click();
};
const row = (id) => q(`.rk-row--track[data-track="${id}"]`);
const pad = (id, step) => q(`.rk-pad[data-step="${step}"]`, row(id));
const undo = () => q('.rk-undo').click();
const steps = (id, section = engine.editSection) => engine.getPattern().sections[section].steps[id];

beforeAll(async () => {
  polyfillDom();
  localStorage.clear();
  localStorage.setItem('rythmik:toured', '1');
  history.replaceState(null, '', '/#beat');
  document.head.append(
    Object.assign(document.createElement('style'), {
      textContent: ".rk-machine[data-advanced='false'] .rk-adv { display: none; } .rk-machine[data-advanced='true'] .rk-beginner { display: none; }",
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  engine = fakeEngine();
  mountApp(document.getElementById('app'), engine);
  await tick();
});

describe('step helpers', () => {
  it('cycle velocity, chance and roll', () => {
    expect([0.5, 0.8, 1].map(nextVelocity)).toEqual([0.8, 1, 0.5]);
    expect(nextVelocity(0.3)).toBe(0.5);
    expect([1, 0.75, 0.5, 0.25].map(nextChance)).toEqual([0.75, 0.5, 0.25, 1]);
    expect([1, 2, 3, 4].map(nextRoll)).toEqual([2, 3, 4, 1]);
    expect(stepDetails('kick', { v: 1, r: 3, c: 0.5, p: 2, f: true })).toBe('accent, roll 3, 50% chance, pitch +2, flam');
    expect(stepDetails('bass', { v: 0.8, r: 1, c: 1, p: 36, f: false })).toBe('normal, note C2');
  });
});

describe('your own sounds', () => {
  it('the slot under the pads holds the sampler panel with one fold key', () => {
    const slot = q('#rk-sampler-slot');
    const keys = qa('button', slot).filter((x) => x.textContent.trim() === 'Your own sounds');
    expect(keys.length).toBe(1);
    expect(keys[0].hasAttribute('aria-expanded')).toBe(true);
  });
});

describe('preset browser', () => {
  it('starts on the genre of the loaded preset with its LED lit', () => {
    expect(matchPreset(engine.getPattern())).toBe('afroBass');
    const current = q('[data-preset][aria-current=true]', beat());
    expect(current.dataset.preset).toBe('afroBass');
    expect(q('.rk-led', current).classList.contains('is-on')).toBe(true);
    expect(q('[data-genre=afro][aria-pressed=true]', beat())).toBeTruthy();
    expect(q('[data-preset=trap]', beat()).hidden).toBe(true);
    expect(q('[data-preset=afroBass] .rk-preset__desc', beat()).textContent).toBe(PRESETS.afroBass.description);
  });

  it('genre keys filter the list; originals are marked', () => {
    q('button[data-genre=hiphop]', beat()).click();
    const visible = qa('.rk-presets [data-preset]', beat()).filter((b) => !b.hidden).map((b) => b.dataset.preset);
    expect(visible).toEqual(Object.values(PRESETS).filter((p) => p.genre === 'hiphop').map((p) => p.id));
    q('button[data-genre=other]', beat()).click();
    expect(q('[data-preset=clockwork] .rk-tag', beat()).textContent).toBe('Original');
    expect(q('[data-preset=rock] .rk-tag', beat())).toBeNull();
  });

  it('loads with Undo, which also puts the LED back', () => {
    q('button[data-genre=hiphop]', beat()).click();
    q('[data-preset=trap]', beat()).click();
    expect(engine.getPattern().bpm).toBe(PRESETS.trap.pattern.bpm);
    expect(q('[data-preset=trap]', beat()).getAttribute('aria-current')).toBe('true');
    undo();
    expect(matchPreset(engine.getPattern())).toBe('afroBass');
    expect(q('[data-preset=afroBass]', beat()).getAttribute('aria-current')).toBe('true');
  });
});

describe('edit modes', () => {
  it('beginners get On/off, Velocity and Roll; Advanced adds Chance, Pitch and Flam', () => {
    setAdvanced(false);
    const modes = qa('.rk-modekey', beat()).filter(shown).map((b) => b.dataset.mode);
    expect(modes).toEqual(['toggle', 'velocity', 'roll']);
    setAdvanced(true);
    expect(qa('.rk-modekey', beat()).filter(shown).length).toBe(6);
    setAdvanced(false);
  });

  it('On/off toggles, Velocity and Roll cycle a lit pad', async () => {
    q('[data-preset=empty]', beat()).click();
    await tick();
    pad('kick', 0).click();
    expect(steps('kick')[0]).toMatchObject({ v: 0.8, r: 1 });
    await tick();
    expect(pad('kick', 0).getAttribute('aria-pressed')).toBe('true');
    expect(pad('kick', 0).getAttribute('aria-label')).toBe('Kick, step 1, normal');

    q('.rk-modekey[data-mode=velocity]', beat()).click();
    expect(q('.rk-legend', beat()).textContent).toMatch(/soft, normal, accent/);
    pad('kick', 0).click();
    expect(steps('kick')[0].v).toBe(1);
    pad('kick', 0).click();
    expect(steps('kick')[0].v).toBe(0.5);
    await tick();
    expect(pad('kick', 0).dataset.level).toBe('soft');
    // an empty pad switches on first
    pad('kick', 4).click();
    expect(steps('kick')[4]).toMatchObject({ v: 0.8 });

    q('.rk-modekey[data-mode=roll]', beat()).click();
    pad('hat', 2).click();
    pad('hat', 2).click();
    pad('hat', 2).click();
    expect(steps('hat')[2].r).toBe(3);
    await tick();
    expect(pad('hat', 2).dataset.roll).toBe('3');
  });

  it('Chance and Flam cycle; Pitch tunes the selected pad; leaving Advanced resets the mode', async () => {
    setAdvanced(true);
    q('.rk-modekey[data-mode=chance]', beat()).click();
    pad('kick', 0).click();
    expect(steps('kick')[0].c).toBe(0.75);
    await tick();
    expect(pad('kick', 0).textContent).toBe('75');
    q('.rk-modekey[data-mode=flam]', beat()).click();
    pad('kick', 0).click();
    expect(steps('kick')[0].f).toBe(true);

    q('.rk-modekey[data-mode=pitch]', beat()).click();
    pad('kick', 0).click();
    await tick();
    expect(pad('kick', 0).classList.contains('is-selected')).toBe(true);
    q('[aria-label="Pitch up"]', beat()).click();
    q('[aria-label="Pitch up"]', beat()).click();
    expect(steps('kick')[0].p).toBe(2);
    pad('bass', 0).click();
    q('[aria-label="Pitch up"]', beat()).click();
    expect(steps('bass')[0].p).toBe(35);
    await tick();
    expect(q('.rk-pitch .rk-lcd__text', beat()).textContent).toBe('B1');

    setAdvanced(false);
    expect(q('.rk-modekey[data-mode=toggle]', beat()).getAttribute('aria-pressed')).toBe('true');
    expect(q('.rk-pitch', beat()).hidden).toBe(true);
  });
});

describe('tracks', () => {
  it('Add track lists unused voices and samples, then adds a row', async () => {
    shared.sampler.addSample('smp-yeah', 'Yeah');
    const add = key('Add track');
    add.click();
    expect(add.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-add=kick]', beat())).toBeNull();
    expect(q('[data-add=conga]', beat())).toBeTruthy();
    q('[data-add=conga]', beat()).click();
    await tick();
    expect(engine.getPattern().tracks).toContain('conga');
    expect(row('conga')).toBeTruthy();
    expect(document.activeElement).toBe(q('.rk-name', row('conga')));
    add.click();
    q('[data-add="smp-yeah"]', beat()).click();
    await tick();
    expect(q('.rk-name__text', row('smp-yeah')).textContent).toBe('Yeah');
    expect(q('.rk-trackcount', beat()).textContent).toBe('10 of 16 tracks');
  });

  it('a pattern with an unknown sample shows a missing row', async () => {
    const p = engine.getPattern();
    p.tracks.push('smp-gone');
    engine.setPattern(p);
    await tick();
    expect(row('smp-gone').classList.contains('is-missing')).toBe(true);
    expect(q('.rk-name__text', row('smp-gone')).textContent).toBe('Missing sample');
    expect(q('[data-help=missingSample]', row('smp-gone'))).toBeTruthy();
  });

  it('Edit tracks removes with Undo; Advanced moves rows', async () => {
    key('Edit tracks').click();
    await tick();
    const remove = q('[aria-label="Remove Conga"]', beat());
    expect(shown(remove)).toBe(true);
    remove.click();
    await tick();
    expect(engine.getPattern().tracks).not.toContain('conga');
    expect(document.activeElement.isConnected).toBe(true);
    undo();
    await tick();
    expect(engine.getPattern().tracks).toContain('conga');

    setAdvanced(true);
    q('[aria-label="Move Snare up"]', beat()).click();
    expect(engine.getPattern().tracks.slice(0, 2)).toEqual(['snare', 'kick']);
    await tick();
    expect(qa('.rk-row--track', beat())[0].dataset.track).toBe('snare');
    setAdvanced(false);
    key('Edit tracks').click();
  });
});

describe('sections, chain and length', () => {
  it('Add B copies A; the beginner toggle chains A then B', async () => {
    expect(q('[data-section=B]', beat()).hidden).toBe(true);
    key('Add B').click();
    await tick();
    expect(engine.getPattern().sections.B).toBeTruthy();
    expect(engine.editSection).toBe('B');
    expect(q('[data-section=B]', beat()).getAttribute('aria-pressed')).toBe('true');
    expect(steps('kick', 'B')).toEqual(steps('kick', 'A'));
    pad('snare', 6).click();
    expect(steps('snare', 'B')[6]).toBeTruthy();
    expect(steps('snare', 'A')[6]).toBeNull();

    const chain = key('Play A then B');
    expect(shown(chain)).toBe(true);
    chain.click();
    expect(engine.getPattern().chain).toEqual(['A', 'B']);
    await tick();
    expect(q('.rk-chain__text', beat()).textContent).toBe('A B');
  });

  it('Advanced chain slots cycle and grow up to 8', async () => {
    setAdvanced(true);
    q('[aria-label="Add a chain slot"]', beat()).click();
    await tick();
    expect(engine.getPattern().chain).toEqual(['A', 'B', 'A']);
    q('.rk-slot[data-index="2"]', beat()).click();
    expect(engine.getPattern().chain).toEqual(['A', 'B', 'B']);
    for (let i = 0; i < 10; i++) q('[aria-label="Add a chain slot"]', beat()).click();
    await tick();
    expect(engine.getPattern().chain.length).toBe(8);
    expect(q('[aria-label="Add a chain slot"]', beat()).disabled).toBe(true);
  });

  it('Remove B is undoable', async () => {
    key('Remove B').click();
    await tick();
    expect(engine.getPattern().sections.B).toBeNull();
    expect(engine.editSection).toBe('A');
    undo();
    await tick();
    expect(engine.getPattern().sections.B).toBeTruthy();
    expect(document.activeElement).toBe(q('[data-section=B]', beat()));
    setAdvanced(false);
    q('[data-section=A]', beat()).click();
  });

  it('32 steps pages by bar and arrow keys cross bars', async () => {
    q('[data-length="32"]', beat()).click();
    await tick();
    expect(engine.getPattern().sections.A.length).toBe(32);
    const bar2 = key('Bar 2');
    expect(shown(bar2)).toBe(true);
    bar2.click();
    await tick();
    expect(pad('kick', 16)).toBeTruthy();
    expect(q('.rk-ruler__num', beat()).textContent).toBe('17');
    pad('kick', 17).click();
    expect(steps('kick')[17]).toBeTruthy();
    key('Bar 1').click();
    await tick();
    pad('kick', 15).focus();
    pad('kick', 15).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(pad('kick', 16));
    expect(key('Bar 2').getAttribute('aria-pressed')).toBe('true');
    q('[data-length="16"]', beat()).click();
    await tick();
    expect(engine.getPattern().sections.A.length).toBe(16);
    expect(shown(key('Bar 2'))).toBe(false);
    undo();
    expect(engine.getPattern().sections.A.length).toBe(32);
  });

  it('the playhead only lights the section being edited', async () => {
    key('Bar 2').click();
    engine.playPosition = { section: 'A', step: 18, chainIndex: 0 };
    engine.start();
    await tick(40);
    expect(pad('kick', 18).classList.contains('is-current')).toBe(true);
    expect(q('[data-section=A] .rk-led', beat()).classList.contains('is-on')).toBe(true);
    engine.playPosition = { section: 'B', step: 2, chainIndex: 1 };
    await tick(40);
    expect(qa('.rk-pad.is-current', beat()).length).toBe(0);
    expect(q('[data-section=B] .rk-led', beat()).classList.contains('is-on')).toBe(true);
    engine.stop();
    await tick();
  });
});

describe('groove tools', () => {
  it('Clear track, Randomize and Humanize are undoable', async () => {
    const before = engine.getPattern();
    const select = q('#rk-tool-track');
    select.value = 'kick';
    select.dispatchEvent(new Event('change'));
    key('Clear track').click();
    expect(steps('kick').every((s) => s === null)).toBe(true);
    undo();
    expect(engine.getPattern()).toEqual(before);
    key('Randomize').click();
    expect(engine.getPattern().sections.A.steps.kick).not.toEqual(before.sections.A.steps.kick);
    undo();
    key('Humanize').click();
    expect(engine.getPattern()).not.toEqual(before);
    undo();
    expect(engine.getPattern()).toEqual(before);
  });

  it('Auto fill makes B and plays A A A B', async () => {
    const p = engine.getPattern();
    p.sections.B = null;
    p.chain = ['A'];
    engine.setPattern(p);
    key('Auto fill').click();
    expect(engine.getPattern().chain).toEqual(['A', 'A', 'A', 'B']);
    await tick();
    expect(shown(q('[data-section=B]', beat()))).toBe(true);
    undo();
    expect(engine.getPattern().sections.B).toBeNull();
  });
});

describe('files', () => {
  it('v4 patterns survive autosave and pattern files', async () => {
    const p = engine.getPattern();
    p.sections.A.steps.kick[3] = { v: 1, r: 2, c: 0.5, p: 3, f: true };
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    expect(savePattern(p, storage)).toBe(true);
    expect([...store.keys()]).toEqual([STORAGE_KEY]);
    expect(loadSavedPattern(storage)).toEqual(normalizePattern(p));
    const file = new File([serializePattern(p)], 'beat.json', { type: 'application/json' });
    const back = await readPatternFile(file);
    expect(back.version).toBe(4);
    expect(back.sections.A.steps.kick[3]).toMatchObject({ v: 1, r: 2, c: 0.5, p: 3, f: true });
    expect(back.tracks).toEqual(p.tracks);
  });

  it('Export project and Import project go through the sampler (Advanced)', async () => {
    setAdvanced(true);
    URL.createObjectURL ??= () => 'blob:x';
    URL.revokeObjectURL ??= () => {};
    key('Export project').click();
    await tick();
    expect(shared.sampler.exportProject).toHaveBeenCalledWith(engine.getPattern());

    const pattern = normalizePattern(PRESETS.trap.pattern);
    const input = q('.rk-project-input', beat());
    const file = new File([JSON.stringify({ app: 'rythmik', version: 1, pattern, samples: [] })], 'song.json');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await tick();
    expect(shared.sampler.importProject).toHaveBeenCalledWith(file);
    expect(engine.getPattern().bpm).toBe(pattern.bpm);
    expect(q('.rk-statusline__text').textContent).toBe('Imported song.json with its samples.');

    Object.defineProperty(input, 'files', { value: [new File(['nope'], 'x.json')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await tick();
    expect(q('.rk-statusline__text').textContent).toBe('Not a Rythmik project file.');
    setAdvanced(false);
  });

  it('the sampler panel sits in its slot under the grid', () => {
    goTo('#beat');
    const slot = q('#rk-sampler-slot');
    expect(slot).toBeTruthy();
    expect(slot.previousElementSibling.classList.contains('rk-seq')).toBe(true);
  });
});

describe('review fixes', () => {
  const patternWithB = (chain, editB = false) => {
    const p = normalizePattern(PRESETS.boomBap.pattern);
    p.sections.B = structuredClone(p.sections.A);
    if (editB) p.sections.B.steps.kick[1] = { v: 1, r: 1, c: 1, p: 0, f: false };
    p.chain = chain;
    return p;
  };

  it('Import project asks before replacing sounds; the beat stays undoable', async () => {
    setAdvanced(true);
    const btn = key('Import project');
    const input = q('.rk-project-input', beat());
    const opened = vi.spyOn(input, 'click').mockImplementation(() => {});
    const n = shared.sampler.samples.length;
    expect(n).toBeGreaterThan(0);
    btn.click();
    expect(opened).not.toHaveBeenCalled();
    expect(btn.textContent).toBe(`Replace your ${n} ${n === 1 ? 'sound' : 'sounds'} and the beat?`);
    expect(q('.rk-statusline__text').textContent).toMatch(/cannot come back; Undo only brings back the beat/);
    btn.click();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe('Import project');

    const before = engine.getPattern();
    const pattern = normalizePattern(PRESETS.house.pattern);
    const file = new File([JSON.stringify({ app: 'rythmik', version: 1, pattern, samples: [] })], 'p.json');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await tick();
    expect(engine.getPattern().bpm).toBe(pattern.bpm);
    expect(q('.rk-statusline__actions').hidden).toBe(false);
    undo();
    expect(engine.getPattern()).toEqual(before);
    opened.mockRestore();
    setAdvanced(false);
  });

  it('the ruler LEDs go dark after a rebuild and on Stop', async () => {
    engine.setPattern(normalizePattern(PRESETS.trap.pattern));
    engine.playPosition = { section: 'A', step: 3, chainIndex: 0 };
    engine.start();
    await tick(40);
    expect(qa('.rk-led--step.is-on', beat()).length).toBe(1);
    key('Add track').click();
    q('[data-add=cowbell]', beat()).click();
    engine.playPosition = { section: 'A', step: 5, chainIndex: 0 };
    await tick(40);
    expect(qa('.rk-led--step.is-on', beat()).length).toBe(1);
    engine.stop();
    await tick();
    expect(qa('.rk-led--step.is-on', beat()).length).toBe(0);
    expect(qa('.rk-pad.is-current', beat()).length).toBe(0);
  });

  it('Play A then B shows B in the chain and turning it off is undoable', async () => {
    engine.setPattern(patternWithB(['A', 'A', 'A', 'B']));
    await tick();
    const toggle = key('Play A then B');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(engine.getPattern().chain).toEqual(['A']);
    undo();
    expect(engine.getPattern().chain).toEqual(['A', 'A', 'A', 'B']);
    engine.setChain(['A']);
    await tick();
    toggle.click();
    expect(engine.getPattern().chain).toEqual(['A', 'B']);
  });

  it('Auto fill asks before replacing a hand-edited B, not its own fill', async () => {
    engine.setPattern(patternWithB(['A', 'B'], true));
    const fill = key('Auto fill');
    fill.click();
    expect(engine.getPattern().chain).toEqual(['A', 'B']);
    expect(fill.textContent).toBe('Replace B?');
    fill.click();
    expect(engine.getPattern().chain).toEqual(['A', 'A', 'A', 'B']);
    expect(fill.textContent).toBe('Auto fill');
    fill.click();
    expect(fill.textContent).toBe('Auto fill');
    undo();
    expect(engine.getPattern().sections.B).toBeTruthy();
  });

  it('Undo is locked while a take records', async () => {
    q('button[data-genre=hiphop]', beat()).click();
    q('[data-preset=boomBap]', beat()).click();
    const btn = q('.rk-undo');
    shared.booth.state = 'recording';
    shared.booth.emit();
    expect(btn.disabled).toBe(true);
    const bpm = engine.getPattern().bpm;
    btn.click();
    expect(engine.getPattern().bpm).toBe(bpm);
    shared.booth.state = 'idle';
    shared.booth.emit();
    expect(btn.disabled).toBe(false);
  });

  it('the preset LED goes out after an edit', async () => {
    q('button[data-genre=hiphop]', beat()).click();
    q('[data-preset=lofi]', beat()).click();
    await tick();
    expect(q('[data-preset=lofi]', beat()).getAttribute('aria-current')).toBe('true');
    pad('kick', 1).click();
    await tick();
    expect(q('[data-preset][aria-current]', beat())).toBeNull();
  });

  it('pad values sit on a plate with readable contrast', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/ui/style.css'), 'utf8');
    const block = css.match(/\.rk-pad__val \{([^}]+)\}/)[1];
    expect(block).toMatch(/color: var\(--text\)/);
    const plate = block.match(/background: (#[0-9a-f]{6})/i)[1];
    const text = css.match(/--text: (#[0-9a-f]{6})/i)[1];
    expect(contrast(text, plate)).toBeGreaterThanOrEqual(4.5);
  });

  it('a note row is one tab stop with arrow keys', async () => {
    setAdvanced(true);
    await tick();
    const notes = qa('.rk-note', q('.rk-row--notes', beat()));
    expect(notes.map((n) => n.tabIndex)).toEqual([0, ...new Array(notes.length - 1).fill(-1)]);
    notes[0].focus();
    notes[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(notes[1]);
    expect(notes[1].tabIndex).toBe(0);
    expect(notes[0].tabIndex).toBe(-1);
    notes[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(notes[notes.length - 1]);
  });

  it('chain slots say why they cannot switch without B', async () => {
    const p = normalizePattern(PRESETS.trap.pattern);
    p.chain = ['A', 'A'];
    engine.setPattern(p);
    await tick();
    const slot = q('.rk-slot', beat());
    expect(slot.getAttribute('aria-disabled')).toBe('true');
    expect(slot.getAttribute('aria-label')).toMatch(/Add B to switch/);
    key('Add B').click();
    await tick();
    expect(q('.rk-slot', beat()).hasAttribute('aria-disabled')).toBe(false);
    expect(q('.rk-slot', beat()).getAttribute('aria-label')).toMatch(/press to switch to B/);
    setAdvanced(false);
  });

  it('the picker keeps focus on Close when it redraws', async () => {
    key('Add track').click();
    const close = qa('button', q('#rk-addtrack')).find((b) => b.textContent === 'Close');
    close.focus();
    engine.setPattern(engine.getPattern());
    await tick();
    expect(document.activeElement.textContent).toBe('Close');
    expect(document.activeElement.isConnected).toBe(true);
    document.activeElement.click();
    expect(q('#rk-addtrack').hidden).toBe(true);
    expect(q('[data-move]', beat())).toBeNull();
  });
});

function contrast(a, b) {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
