import { HELP, GUIDE_SECTIONS, GUIDE_RECIPES } from './help.js';
import { el } from './dom.js';

export function mountGuide({ onReplayTour }) {
  const replay = el('button', { type: 'button', class: 'rk-key', text: 'Replay the tour' });
  replay.addEventListener('click', onReplayTour);

  const recipes = el('section', { class: 'rk-guide__block', 'aria-labelledby': 'rk-guide-how' }, [
    el('h3', { id: 'rk-guide-how', class: 'rk-guide__h', text: 'How to' }),
    el(
      'div',
      { class: 'rk-guide__recipes' },
      GUIDE_RECIPES.map((r) =>
        el('article', { class: 'rk-guide__recipe' }, [
          el('h4', { class: 'rk-guide__title', text: r.title }),
          el('ol', { class: 'rk-guide__steps' }, r.steps.map((s) => el('li', { text: s }))),
        ]),
      ),
    ),
  ]);

  const sections = GUIDE_SECTIONS.map((s) =>
    el('section', { class: 'rk-guide__block', 'aria-labelledby': `rk-guide-${s.id}` }, [
      el('h3', { id: `rk-guide-${s.id}`, class: 'rk-guide__h', text: s.title }),
      el(
        'dl',
        { class: 'rk-guide__list' },
        s.keys.flatMap((k) => [
          el('dt', {}, [
            el('span', { text: HELP[k].term }),
            HELP[k].sub ? el('span', { class: 'rk-label__sub', text: HELP[k].sub }) : null,
          ]),
          el('dd', { text: HELP[k].text }),
        ]),
      ),
    ]),
  );

  return el('div', { class: 'rk-guide' }, [
    el('div', { class: 'rk-btnrow rk-guide__top' }, [
      el('a', { class: 'rk-key rk-key--link', href: '#beat', text: 'Back to Beat' }),
      replay,
    ]),
    el('p', { class: 'rk-hint', text: 'Every control also has a small ? button next to it with the same short explanation. Advanced controls appear when the Advanced switch is on.' }),
    recipes,
    ...sections,
  ]);
}
