export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

export function silk(text, attrs = {}) {
  return el('span', { class: 'rk-silk', ...attrs, text });
}

export function led(extra = '') {
  return el('span', { class: `rk-led ${extra}`.trim(), 'aria-hidden': 'true' });
}

export function text(t) {
  return document.createTextNode(t);
}

// Places a fixed-position box below (or above) an anchor, clamped to the viewport.
export function placeNear(anchor, box, gap = 8) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
  let top = r.bottom + gap;
  if (top + h > vh - 8) {
    const above = r.top - h - gap;
    top = above >= 8 ? above : Math.max(8, vh - h - 8);
  }
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
}

/**
 * Hard: real `disabled` (not available at all). Soft: aria-disabled, so a busy
 * button keeps focus and the click handler ignores it.
 */
export function setUnavailable(btn, { hard = false, soft = false } = {}) {
  btn.disabled = hard;
  if (!hard && soft) btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
}

export const isUnavailable = (btn) => btn.disabled || btn.getAttribute('aria-disabled') === 'true';

export function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName === 'INPUT') {
    const t = target.type;
    return t !== 'range' && t !== 'checkbox' && t !== 'radio' && t !== 'button';
  }
  return false;
}

export function downloadBlob(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking synchronously can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
