// Pattern autosave (localStorage) and JSON export/import.
import { parsePattern, serializePattern } from '../audio/pattern.js';

// Key kept so saved beats keep loading; the pattern format version lives inside the saved pattern.
export const STORAGE_KEY = 'rythmik:pattern:v2';
export const EXPORT_FILENAME = 'rythmik-pattern.json';
export const MAX_IMPORT_BYTES = 256 * 1024;

/** Accessing localStorage can throw in privacy modes. */
export function getDefaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Returns false on any storage error (quota, disabled). */
export function savePattern(pattern, storage = getDefaultStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, serializePattern(pattern));
    return true;
  } catch {
    return false;
  }
}

/** Returns null if nothing is saved or the data is unreadable. Never throws. */
export function loadSavedPattern(storage = getDefaultStorage()) {
  if (!storage) return null;
  let text;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return parsePattern(text);
  } catch {
    return null;
  }
}

/** Debounced: only the last scheduled pattern is written. flush() on pagehide. */
export function createAutosave(storage = getDefaultStorage(), { delay = 300 } = {}) {
  let timer = null;
  let pending = null;

  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending === null) return false;
    const p = pending;
    pending = null;
    return savePattern(p, storage);
  }

  return {
    schedule(pattern) {
      pending = pattern;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

export function downloadPattern(pattern, doc = globalThis.document, url = globalThis.URL) {
  const blob = new Blob([serializePattern(pattern)], { type: 'application/json' });
  const href = url.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = href;
  a.download = EXPORT_FILENAME;
  a.hidden = true;
  doc.body.append(a);
  a.click();
  a.remove();
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => url.revokeObjectURL(href), 1000);
}

export async function readPatternFile(file) {
  if (!file) throw new Error('No file selected.');
  if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is too large to be a pattern.');
  let text;
  try {
    text = await file.text();
  } catch {
    throw new Error('Could not read that file.');
  }
  return parsePattern(text);
}
