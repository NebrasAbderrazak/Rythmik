// "?" toggletips. Only one is open at a time; Esc, outside press or moving focus away closes it.
import { HELP } from './help.js';
import { el, placeNear } from './dom.js';

let open = null; // { btn, pop }
let uid = 0;
let listening = false;

function close({ refocus = false } = {}) {
  if (!open) return false;
  const { btn, pop } = open;
  open = null;
  pop.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
  return true;
}

function reposition() {
  if (open) placeNear(open.btn, open.pop);
}

function listen() {
  if (listening) return;
  listening = true;
  // Capture listener: Esc closes the tip before other Esc handlers (cancel take, stop preview).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close({ refocus: true });
      }
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (open && !open.btn.contains(e.target) && !open.pop.contains(e.target)) close();
    },
    true,
  );
  document.addEventListener('focusin', (e) => {
    if (open && e.target !== open.btn && !open.pop.contains(e.target)) close();
  });
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
}

export function closeHelp() {
  return close();
}

/** Small "?" button with its popover. */
export function helpTip(key) {
  const entry = HELP[key];
  if (!entry) throw new Error(`Missing help text: ${key}`);
  listen();
  const id = `rk-help-${key}-${++uid}`;
  const btn = el('button', {
    type: 'button',
    class: 'rk-help__btn',
    'aria-expanded': 'false',
    'aria-controls': id,
    'aria-label': `What is ${entry.term}?`,
    'data-help': key,
  }, [el('span', { 'aria-hidden': 'true', text: '?' })]);
  const pop = el('span', { id, class: 'rk-help__pop', role: 'note', hidden: true }, [
    el('strong', { class: 'rk-help__term', text: entry.term }),
    el('span', { text: entry.text }),
  ]);
  btn.addEventListener('click', () => {
    if (open?.btn === btn) return void close();
    close();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    open = { btn, pop };
    placeNear(btn, pop);
  });
  return el('span', { class: 'rk-help' }, [btn, pop]);
}

/**
 * Silkscreen label: real term, optional subtitle, "?" button.
 * `forId` makes the term a <label> for that control; `tag` ('h3'...) makes it a heading.
 * The "?" sits outside the term element so it never joins a label's or heading's name.
 */
export function helpLabel(key, { forId, id, sub = true, term, tag, className = '' } = {}) {
  const entry = HELP[key];
  if (!entry) throw new Error(`Missing help text: ${key}`);
  const name = el(tag || (forId ? 'label' : 'span'), { class: 'rk-label__term', for: forId, id }, [
    el('span', { text: term ?? entry.term }),
    sub && entry.sub ? el('span', { class: 'rk-label__sub', text: entry.sub }) : null,
  ]);
  return el(tag ? 'div' : 'span', { class: `rk-label ${className}`.trim() }, [name, helpTip(key)]);
}
