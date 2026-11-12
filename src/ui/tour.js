// First-visit coach marks. Non-modal: the page stays usable; Esc or Skip ends it.
import { el, placeNear } from './dom.js';

export const TOUR_STEPS = [
  { anchor: 'pads', title: 'Tap the pads', text: 'Each row is a sound. Tap a pad to switch that sound on at that step; lit pads play.' },
  { anchor: 'play', title: 'Press Play', text: 'Play starts the loop and Stop ends it. The Space bar works too.' },
  { anchor: 'presets', title: 'Try a preset', text: 'Not sure where to start? Load a ready-made groove and change it to make it yours.' },
  { anchor: 'booth', title: 'Rap over it', text: 'When the beat feels right, open BOOTH to record yourself over it.' },
  { anchor: 'remix', title: 'Remix a song', text: 'Open REMIX to load your own song, make a slowed + reverb version and rap over that instead.' },
];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]';

// Focus the first candidate that is still in the page and not inside a hidden view.
function focusFirst(candidates) {
  for (const c of candidates) {
    if (!(c instanceof HTMLElement) || c === document.body || !c.isConnected || c.closest('[hidden]')) continue;
    const f = c.matches(FOCUSABLE) ? c : c.querySelector(FOCUSABLE);
    if (f && !f.closest('[hidden]')) {
      f.focus({ preventScroll: true });
      return f;
    }
  }
  return null;
}

/** anchors: { [name]: HTMLElement }. onEnd runs when the tour finishes or is skipped. */
export function createTour({ anchors, onEnd = () => {} }) {
  let index = -1;
  let card = null;
  let target = null;
  let returnFocus = null;

  const title = el('h2', { id: 'rk-tour-title', class: 'rk-tour__title' });
  const count = el('p', { class: 'rk-tour__count' });
  const body = el('p', { id: 'rk-tour-body', class: 'rk-tour__body' });
  const skipBtn = el('button', { type: 'button', class: 'rk-key', text: 'Skip tour' });
  const backBtn = el('button', { type: 'button', class: 'rk-key', text: 'Back' });
  const nextBtn = el('button', { type: 'button', class: 'rk-key rk-key--lit', text: 'Next' });
  card = el(
    'div',
    { class: 'rk-tour', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'rk-tour-title', 'aria-describedby': 'rk-tour-body', hidden: true },
    [count, title, body, el('div', { class: 'rk-btnrow rk-tour__btns' }, [skipBtn, backBtn, nextBtn])],
  );
  document.body.append(card);

  function onKey(e) {
    if (e.key === 'Escape' && index >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      end();
    }
  }
  function reposition() {
    if (target && index >= 0) placeNear(target, card, 12);
  }

  function show(i) {
    target?.classList.remove('rk-tour-target');
    index = i;
    const s = TOUR_STEPS[i];
    target = anchors[s.anchor] || null;
    count.textContent = `Step ${i + 1} of ${TOUR_STEPS.length}`;
    title.textContent = s.title;
    body.textContent = s.text;
    backBtn.hidden = i === 0;
    nextBtn.textContent = i === TOUR_STEPS.length - 1 ? 'Done' : 'Next';
    card.hidden = false;
    if (target) {
      target.classList.add('rk-tour-target');
      target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' });
    }
    reposition();
    nextBtn.focus();
  }

  function end() {
    if (index < 0) return;
    const last = target;
    const back = returnFocus;
    target?.classList.remove('rk-tour-target');
    target = null;
    index = -1;
    card.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    returnFocus = null;
    focusFirst([back, last, anchors.play]);
    onEnd();
  }

  skipBtn.addEventListener('click', end);
  backBtn.addEventListener('click', () => index > 0 && show(index - 1));
  nextBtn.addEventListener('click', () => (index < TOUR_STEPS.length - 1 ? show(index + 1) : end()));

  return {
    /** returnTo: where focus goes when the tour ends (default: what had focus before). */
    start({ returnTo } = {}) {
      if (index >= 0) return;
      returnFocus = returnTo || document.activeElement;
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, { passive: true, capture: true });
      show(0);
    },
    end,
    get active() {
      return index >= 0;
    },
  };
}
