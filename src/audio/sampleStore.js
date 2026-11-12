// IndexedDB persistence for the sampler. Every call resolves, never throws:
// without IndexedDB (private mode, blocked storage, Node) load() gives
// { ok: false } and save() gives false, and the sampler keeps working in memory.
// A failed open is retried on the next call.

const DB_NAME = 'rythmik-sampler';
const DB_VERSION = 1;
const STORE = 'library';
const KEY = 'current';

/**
 * @param [opts] indexedDB (factory to use; null = none), dbName
 * @returns {{ load(): Promise<{ ok: boolean, data: object|null }>, save(data): Promise<boolean>,
 *   clear(): Promise<boolean> }} load: ok false = could not read; ok true with data null = nothing stored
 */
export function createSampleStore(opts = {}) {
  const name = opts.dbName || DB_NAME;
  let opening = null;

  function factory() {
    try {
      return 'indexedDB' in opts ? opts.indexedDB : globalThis.indexedDB;
    } catch {
      return null; // some browsers throw on access when storage is blocked
    }
  }

  function open() {
    if (opening) return opening;
    const attempt = new Promise((resolve) => {
      const idb = factory();
      if (!idb || typeof idb.open !== 'function') { resolve(null); return; }
      let req;
      try {
        req = idb.open(name, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        } catch { /* the open request fails on its own */ }
      };
      req.onsuccess = () => {
        const db = req.result;
        // another tab upgrading: let go, reopen on the next call
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; }; // closed by the browser (storage cleared)
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    opening = attempt;
    attempt.then((db) => { if (!db && opening === attempt) opening = null; });
    return attempt;
  }

  async function run(mode, fn) {
    const db = await open();
    if (!db) return { ok: false };
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve({ ok: true, value: req?.result });
        tx.onerror = () => resolve({ ok: false });
        tx.onabort = () => resolve({ ok: false }); // quota exceeded ends up here
      } catch {
        resolve({ ok: false });
      }
    });
  }

  return {
    async load() {
      const r = await run('readonly', (s) => s.get(KEY));
      return r.ok ? { ok: true, data: r.value ?? null } : { ok: false, data: null };
    },
    async save(data) {
      return (await run('readwrite', (s) => s.put(data, KEY))).ok;
    },
    async clear() {
      return (await run('readwrite', (s) => s.delete(KEY))).ok;
    },
  };
}
