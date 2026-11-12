// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fakeEngine, polyfillDom, tick } from './helpers/fakes.js';

vi.mock('../src/audio/booth.js', async () => {
  const { fakeBooth } = await import('./helpers/fakes.js');
  return { createBooth: () => fakeBooth() };
});

import { mountApp } from '../src/ui/app.js';
import { STORAGE_KEY, BROKEN_KEY } from '../src/ui/persistence.js';
import { PRESETS } from '../src/audio/presets.js';

describe('a saved beat that cannot be read', () => {
  it('loads a preset, keeps a copy and shows a notice', async () => {
    polyfillDom();
    localStorage.clear();
    localStorage.setItem('rythmik:toured', '1');
    localStorage.setItem(STORAGE_KEY, '{ broken');
    history.replaceState(null, '', '/#beat');
    document.body.innerHTML = '<div id="app"></div>';
    const engine = fakeEngine();
    mountApp(document.getElementById('app'), engine);
    await tick();
    expect(engine.getPattern().bpm).toBe(PRESETS.afroBass.pattern.bpm);
    expect(localStorage.getItem(BROKEN_KEY)).toBe('{ broken');
    expect(document.querySelector('.rk-statusline__text').textContent).toMatch(/saved beat could not be read/);
  });
});
