// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fakeEngine, polyfillDom, tick, goTo } from './helpers/fakes.js';

const shared = vi.hoisted(() => ({ booth: null }));
vi.mock('../src/audio/booth.js', async () => {
  const { fakeBooth } = await import('./helpers/fakes.js');
  return { createBooth: () => (shared.booth = fakeBooth()) };
});

import { mountApp } from '../src/ui/app.js';
import { VOICE_PRESETS } from '../src/audio/voice.js';
import { hiddenSettingsNote, filterText, changedHiddenFx } from '../src/ui/beat.js';
import { PRESETS } from '../src/audio/presets.js';
import { normalizePattern } from '../src/audio/pattern.js';
import { retuneText } from '../src/ui/booth.js';
import { isUnavailable } from '../src/ui/dom.js';

let engine;
let restoredWith = [];
const q = (sel) => document.querySelector(sel);
// jsdom has no stylesheet: mirror the one rule that hides Advanced controls.
const shown = (node) => {
  for (let n = node; n; n = n.parentElement) if (getComputedStyle(n).display === 'none' || n.hidden) return false;
  return true;
};
const setAdvanced = (on) => {
  const sw = q('[role=switch]');
  if ((sw.getAttribute('aria-checked') === 'true') !== on) sw.click();
};

beforeAll(async () => {
  polyfillDom();
  localStorage.clear();
  localStorage.setItem('rythmik:toured', '1');
  localStorage.setItem('rythmik:voice', JSON.stringify({ reverb: 0.25 }));
  history.replaceState(null, '', '/');
  document.head.append(
    Object.assign(document.createElement('style'), {
      textContent: ".rk-machine[data-advanced='false'] .rk-adv { display: none; }",
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  engine = fakeEngine();
  mountApp(document.getElementById('app'), engine);
  // mock calls are cleared between tests, so keep the mount-time ones
  restoredWith = shared.booth.setVoiceSettings.mock.calls.map((c) => c[0]);
  await tick();
});

describe('beat effects', () => {
  it('beginners see Space and Echo; Advanced reveals filter, drive, echo time and sends', () => {
    setAdvanced(false);
    const space = q('[aria-labelledby="rk-fx-space-label"]');
    const filter = q('[aria-labelledby="rk-fx-filter-label"]');
    expect(shown(space)).toBe(true);
    expect(shown(q('[aria-labelledby="rk-fx-echo-label"]'))).toBe(true);
    expect(shown(filter)).toBe(false);
    expect(shown(q('#rk-fx-echotime'))).toBe(false);
    setAdvanced(true);
    expect(shown(filter)).toBe(true);
    expect(shown(q('[aria-labelledby="rk-fx-drive-label"]'))).toBe(true);
    expect(shown(q('#rk-fx-echotime'))).toBe(true);
    expect(document.querySelectorAll('.rk-send').length).toBe(8);
    setAdvanced(false);
  });

  it('knobs drive the engine and follow pattern changes', async () => {
    const space = q('[aria-labelledby="rk-fx-space-label"]');
    const before = Number(space.getAttribute('aria-valuenow'));
    expect(before).toBe(Math.round(engine.getPattern().fx.reverb * 100));
    space.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(engine.setFx).toHaveBeenLastCalledWith('reverb', (before + 10) / 100);
    engine.setFx('filter', -0.4);
    await tick();
    expect(q('[aria-labelledby="rk-fx-filter-label"]').getAttribute('aria-valuetext')).toBe('Dark 40%');
    expect(q('.rk-seq .rk-note-line').textContent).toMatch(/Filter is on/);
    engine.setFx('filter', 0);
    await tick();
    expect(q('.rk-seq .rk-note-line').hidden).toBe(true);
  });

  it('formats the filter and note text', () => {
    expect(filterText(0)).toBe('Off');
    expect(filterText(30)).toBe('Thin 30%');
    expect(hiddenSettingsNote({ fx: ['filter', 'drive'] })).toBe(
      'Some Advanced settings are active: Filter is on and Drive is on. Turn on Advanced to change them.',
    );
    for (const p of Object.values(PRESETS)) expect(changedHiddenFx(normalizePattern(p.pattern).fx), p.name).toEqual([]);
    const fx = normalizePattern(PRESETS.afroBass.pattern).fx;
    fx.filter = 0.5;
    fx.sends.kick.echo = 0.77;
    expect(changedHiddenFx(fx)).toEqual(['filter', 'sends']);
    expect(retuneText(0)).toMatch(/^Robotic/);
    expect(retuneText(100)).toMatch(/^Natural/);
  });
});

describe('booth voice step', () => {
  it('restores saved voice settings on mount', () => {
    expect(restoredWith).toContainEqual({ reverb: 0.25 });
  });

  it('sits between Takes and Export and lights the picked preset', () => {
    goTo('#booth');
    const titles = [...document.querySelectorAll('.rk-step__title')].map((t) => t.textContent);
    expect(titles).toEqual(['Step 1: Mic', 'Step 2: Record', 'Step 3: Takes', 'Step 4: Voice', 'Step 5: Export']);
    const presets = [...document.querySelectorAll('[data-voice]')];
    expect(presets.length).toBe(6);
    const robot = q('[data-voice=robot]');
    expect(robot.textContent).toContain(VOICE_PRESETS.robot.description);
    robot.click();
    expect(shared.booth.setVoicePreset).toHaveBeenCalledWith('robot');
    expect(robot.getAttribute('aria-pressed')).toBe('true');
    expect(presets.filter((b) => b.getAttribute('aria-pressed') === 'true')).toEqual([robot]);
    expect(JSON.parse(localStorage.getItem('rythmik:voice'))).toMatchObject(VOICE_PRESETS.robot.settings);
  });

  it('Advanced reveals key, scale and voice knobs', () => {
    setAdvanced(false);
    expect(shown(q('#rk-voice-key'))).toBe(false);
    expect(shown(q('[aria-labelledby="rk-voice-retune-label"]'))).toBe(false);
    setAdvanced(true);
    expect(shown(q('#rk-voice-key'))).toBe(true);
    expect(shown(q('#rk-voice-scale'))).toBe(true);
    for (const k of ['tune', 'retune', 'reverb', 'echo']) expect(shown(q(`[aria-labelledby="rk-voice-${k}-label"]`)), k).toBe(true);
    const key = q('#rk-voice-key');
    key.value = 'C';
    key.dispatchEvent(new Event('change'));
    expect(shared.booth.setVoiceSettings).toHaveBeenLastCalledWith({ key: 'C' });
    setAdvanced(false);
  });

  it('tuning disables preview and export and shows a busy line', () => {
    const b = shared.booth;
    b.takes = [{ id: 1, name: 'Take 1', bars: 4, bpm: 100, duration: 9.6, peak: 0.5 }];
    b.selectedTakeId = 1;
    b.emit();
    const btn = (text) => [...document.querySelectorAll('button')].find((x) => x.textContent === text);
    expect(isUnavailable(btn('Export mix (WAV)'))).toBe(false);
    b.voiceBusy = true;
    b.emit();
    expect(q('.rk-busy').textContent).toBe('Tuning your take…');
    expect(isUnavailable(btn('Export mix (WAV)'))).toBe(true);
    expect(isUnavailable(btn('Export vocal (WAV)'))).toBe(true);
    expect(isUnavailable(q('[aria-label="Play Take 1 with beat"]'))).toBe(true);
    b.voiceBusy = false;
    b.emit();
    expect(q('.rk-busy').textContent).toBe('');
    expect(isUnavailable(btn('Export mix (WAV)'))).toBe(false);
  });

  it('vocal export defaults to effects and can be dry', async () => {
    const b = shared.booth;
    expect(q('#rk-vocal-wet').checked).toBe(true);
    q('#rk-vocal-dry').click();
    const vocal = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Export vocal (WAV)');
    URL.createObjectURL ??= () => 'blob:x';
    URL.revokeObjectURL ??= () => {};
    vocal.click();
    await tick();
    expect(b.renderVocal).toHaveBeenCalledWith(1, { processed: false });
  });

  it('a rendering export keeps focus, is busy and ignores another press', async () => {
    const b = shared.booth;
    let finish;
    b.renderMix.mockImplementation(() => new Promise((r) => (finish = r)));
    const mix = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Export mix (WAV)');
    mix.focus();
    mix.click();
    await tick();
    expect(document.activeElement).toBe(mix);
    expect(mix.getAttribute('aria-disabled')).toBe('true');
    expect(mix.getAttribute('aria-busy')).toBe('true');
    mix.click();
    await tick();
    expect(b.renderMix).toHaveBeenCalledTimes(1);
    finish(null);
    await tick();
    expect(mix.hasAttribute('aria-busy')).toBe(false);
    expect(isUnavailable(mix)).toBe(false);
    expect(document.activeElement).toBe(mix);
  });
});

describe('beat export focus', () => {
  it('keeps focus on the button while rendering', async () => {
    goTo('#beat');
    const wav = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Export beat (WAV)');
    wav.focus();
    wav.click();
    expect(document.activeElement).toBe(wav);
    expect(wav.getAttribute('aria-disabled')).toBe('true');
    expect(wav.getAttribute('aria-busy')).toBe('true');
  });
});
