// UI preferences in localStorage. Every access is guarded: storage can throw in privacy modes.
export const ADVANCED_KEY = 'rythmik:advanced';
export const TOURED_KEY = 'rythmik:toured';

export function loadFlag(storage, key, fallback = false) {
  try {
    const v = storage?.getItem(key);
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  } catch {
    // fall through
  }
  return fallback;
}

export function saveFlag(storage, key, on) {
  try {
    storage?.setItem(key, on ? '1' : '0');
    return !!storage;
  } catch {
    return false;
  }
}

export const loadAdvanced = (storage) => loadFlag(storage, ADVANCED_KEY, false);
export const saveAdvanced = (storage, on) => saveFlag(storage, ADVANCED_KEY, on);
export const hasToured = (storage) => loadFlag(storage, TOURED_KEY, false);
export const markToured = (storage) => saveFlag(storage, TOURED_KEY, true);
