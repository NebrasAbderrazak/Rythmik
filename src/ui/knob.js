// Rotary knob (role="slider"): drag, arrow keys, PageUp/PageDown, Home/End, Delete/0 resets.

const SWEEP = 270; // degrees from min to max
const DRAG_PX = 160; // pixels of drag for the full range

export function createKnob({
  label,
  caption = '',
  min = 0,
  max = 100,
  value = 0,
  step = 1,
  bigStep = 10,
  defaultValue = value,
  format = (v) => `${v}%`,
  size = 'md',
  showReadout = !!caption,
  labelledBy = '',
  onInput = () => {},
}) {
  const root = document.createElement('div');
  root.className = `rk-knob rk-knob--${size}`;

  const dial = document.createElement('div');
  dial.className = 'rk-knob__dial';
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  if (labelledBy) dial.setAttribute('aria-labelledby', labelledBy);
  else dial.setAttribute('aria-label', label);
  dial.setAttribute('aria-valuemin', String(min));
  dial.setAttribute('aria-valuemax', String(max));
  dial.setAttribute('aria-orientation', 'vertical');
  dial.setAttribute('aria-description', 'Delete, double-click or double-tap resets it.');

  const ring = document.createElement('span');
  ring.className = 'rk-knob__ring';
  ring.setAttribute('aria-hidden', 'true');
  const cap = document.createElement('span');
  cap.className = 'rk-knob__cap';
  cap.setAttribute('aria-hidden', 'true');
  dial.append(ring, cap);
  root.append(dial);

  let readout = null;
  if (caption) {
    const cap2 = document.createElement('span');
    cap2.className = 'rk-knob__caption';
    cap2.setAttribute('aria-hidden', 'true');
    cap2.textContent = caption;
    root.append(cap2);
  }
  if (showReadout) {
    readout = document.createElement('span');
    readout.className = 'rk-knob__readout';
    readout.setAttribute('aria-hidden', 'true');
    root.append(readout);
  }

  let current = NaN;

  function clamp(v) {
    const n = Math.round(Number(v) / step) * step;
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function paint(v) {
    const pct = (v - min) / (max - min || 1);
    dial.style.setProperty('--pct', pct.toFixed(4));
    dial.style.setProperty('--rot', `${(pct * SWEEP - SWEEP / 2).toFixed(2)}deg`);
    dial.setAttribute('aria-valuenow', String(v));
    dial.setAttribute('aria-valuetext', format(v));
    if (readout) readout.textContent = format(v);
  }

  function set(v, emit) {
    const next = clamp(v);
    if (next === current) return;
    current = next;
    paint(next);
    if (emit) onInput(next);
  }

  dial.addEventListener('keydown', (e) => {
    let next = current;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight': next = current + (e.shiftKey ? bigStep : step); break;
      case 'ArrowDown':
      case 'ArrowLeft': next = current - (e.shiftKey ? bigStep : step); break;
      case 'PageUp': next = current + bigStep; break;
      case 'PageDown': next = current - bigStep; break;
      case 'Home': next = min; break;
      case 'End': next = max; break;
      case 'Delete':
      case 'Backspace':
      case '0': next = defaultValue; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    set(next, true);
  });

  let drag = null;
  dial.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dial.focus({ preventScroll: true });
    dial.setPointerCapture?.(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: current };
    root.classList.add('is-dragging');
  });
  dial.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const delta = (e.clientX - drag.x) - (e.clientY - drag.y);
    const fine = e.shiftKey ? 0.25 : 1;
    set(drag.start + (delta / DRAG_PX) * (max - min) * fine, true);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    root.classList.remove('is-dragging');
  };
  // Touch and pen don't get a reliable dblclick, so detect two short taps
  // within 300 ms.
  let lastTap = 0;
  dial.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' || !drag || e.pointerId !== drag.id) return;
    const moved = Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
    if (moved > 8) {
      lastTap = 0;
      return;
    }
    if (e.timeStamp - lastTap < 300) {
      lastTap = 0;
      set(defaultValue, true);
    } else {
      lastTap = e.timeStamp;
    }
  });
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);
  dial.addEventListener('lostpointercapture', endDrag);
  dial.addEventListener('dblclick', () => set(defaultValue, true));

  set(value, false);

  return {
    el: root,
    dial,
    /** Doesn't fire onInput. Ignored mid-drag. */
    setValue(v) {
      if (!drag) set(v, false);
    },
    getValue: () => current,
  };
}
