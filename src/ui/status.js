// The one general status region. Undo sits next to it, outside the live region.
import { el } from './dom.js';
import { helpTip } from './helptip.js';

const STATUS_MS = 5000;

export function createStatus() {
  const msg = el('p', { class: 'rk-statusline__text', role: 'status' });
  const undoBtn = el('button', { type: 'button', class: 'rk-undo', text: 'Undo' });
  const actions = el('span', { class: 'rk-statusline__actions', hidden: true }, [undoBtn, helpTip('undo')]);
  const node = el('div', { class: 'rk-statusline__msg' }, [msg, actions]);
  let timer = 0;
  let returnFocus = null;
  let undoFn = null;

  function clear() {
    clearTimeout(timer);
    timer = 0;
    undoFn = null;
    const hadFocus = actions.contains(document.activeElement);
    msg.textContent = '';
    node.classList.remove('is-error');
    actions.hidden = true;
    if (hadFocus && returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus();
    returnFocus = null;
  }

  function show(text, { error = false, undo = null, focusBack = null } = {}) {
    clear();
    node.classList.toggle('is-error', error);
    msg.textContent = text;
    if (undo) {
      undoFn = undo;
      returnFocus = focusBack;
      actions.hidden = false;
    }
    timer = setTimeout(clear, error ? STATUS_MS + 3000 : STATUS_MS);
  }

  undoBtn.addEventListener('click', () => {
    const fn = undoFn;
    const back = returnFocus;
    if (!fn) return;
    fn();
    returnFocus = null;
    clear();
    if (back?.isConnected && !back.disabled) back.focus();
    show('Restored your previous pattern.');
  });

  return {
    el: node,
    show,
    clear,
    get undoActive() {
      return !!undoFn;
    },
  };
}
