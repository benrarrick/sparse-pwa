// IndexedDB with three object stores: `kv` (settings, history, queue), `results` and `pages`.
// An installed home-screen app on iOS keeps its IndexedDB, so this is the offline cache.
// Falls back to memory when IndexedDB is unavailable, so the app still works for the session.

const STORES = ['kv', 'results', 'pages'];
let dbp;

function memoryDb() {
  const maps = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  return { memory: maps };
}

function open() {
  return (dbp ??= new Promise((resolve) => {
    let r;
    try {
      r = indexedDB.open('sparse-pwa', 1);
    } catch {
      return resolve(memoryDb());
    }
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(memoryDb());
  }));
}

async function run(store, mode, fn) {
  const db = await open();
  if (db.memory) return fn(null, db.memory[store]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    // Requests are made synchronously inside fn, so the transaction stays open for them.
    const out = Promise.resolve(fn(tx.objectStore(store), null));
    out.catch(() => {}); // reported through tx.onerror instead
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export function get(store, key) {
  return run(store, 'readonly', (os, mem) => (mem ? mem.get(key) : req(os.get(key))));
}

export function put(store, key, value) {
  return run(store, 'readwrite', (os, mem) => {
    if (mem) mem.set(key, value);
    else os.put(value, key);
  });
}

export function del(store, key) {
  return run(store, 'readwrite', (os, mem) => {
    if (mem) mem.delete(key);
    else os.delete(key);
  });
}

export function clear(store) {
  return run(store, 'readwrite', (os, mem) => {
    if (mem) mem.clear();
    else os.clear();
  });
}

/** All [key, value] pairs of a store. */
export function entries(store) {
  return run(store, 'readonly', async (os, mem) => {
    if (mem) return [...mem];
    const [keys, values] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
    return keys.map((k, i) => [k, values[i]]);
  });
}

export async function kvGet(key, fallback) {
  return (await get('kv', key)) ?? fallback;
}

export function kvSet(key, value) {
  return put('kv', key, value);
}

const DAY = 24 * 60 * 60 * 1000;

/** Keeps the cache small: results for 30 days (at most 300), unsaved pages for 30 days (at most 100). */
export async function evict(now = Date.now()) {
  const results = (await entries('results')).sort((a, b) => b[1].at - a[1].at);
  for (const [i, [k, v]] of results.entries()) if (i >= 300 || v.at < now - 30 * DAY) await del('results', k);
  const pages = (await entries('pages')).filter(([, v]) => !v.saved).sort((a, b) => b[1].at - a[1].at);
  for (const [i, [k, v]] of pages.entries()) if (i >= 100 || v.at < now - 30 * DAY) await del('pages', k);
}
