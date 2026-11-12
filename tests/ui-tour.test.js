// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fakeEngine, polyfillDom, tick, goTo } from './helpers/fakes.js';

vi.mock('../src/audio/booth.js', async () => {
  const { fakeBooth } = await import('./helpers/fakes.js');
  return { createBooth: () => fakeBooth() };
});

import { mountApp } from '../src/ui/app.js';

describe('tour on a first visit that starts in BOOTH', () => {
  it('waits until BEAT is opened, then never again', async () => {
    polyfillDom();
    localStorage.clear();
    history.replaceState(null, '', '/#booth');
    document.body.innerHTML = '<div id="app"></div>';
    mountApp(document.getElementById('app'), fakeEngine());
    await tick();
    const card = document.querySelector('.rk-tour');
    expect(card.hidden).toBe(true);
    goTo('#beat');
    await tick();
    expect(card.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    goTo('#booth');
    goTo('#beat');
    await tick();
    expect(card.hidden).toBe(true);
    expect(localStorage.getItem('rythmik:toured')).toBe('1');
  });
});
