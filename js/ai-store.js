// IndexedDB for the on-device AI, separate from the app's own database so that "Remove all AI
// data" can delete it whole. Used by the page and by the AI worker. Stores:
//   pkgs     package records: status, variant, progress, crashes, last load and run figures
//   files    one record per downloaded file: { pkg, path, size, have, chunks, done }
//   chunks   the file contents, in pieces of up to 8 MB (Blobs), keyed "pkg/path#000012"
//   vectors  BGE vectors for saved passages: { h (text hash), v (Float32Array) }
//   notes    summaries and recent questions
//   log      the AI diagnostics log (auto-numbered)
const NAME = 'sparse-ai';
const STORES = ['pkgs', 'files', 'chunks', 'vectors', 'notes'];
let dbp = null;

export function open() {
  return (dbp ??= new Promise((resolve, reject) => {
    let r;
    try {
      r = indexedDB.open(NAME, 1);
    } catch (e) {
      dbp = null;
      return reject(e);
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { autoIncrement: true });
    };
    r.onsuccess = () => {
      const db = r.result;
      // Lets "Remove all AI data" delete the database while a worker still has it open.
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      resolve(db);
    };
    r.onerror = () => {
      dbp = null;
      reject(r.error ?? new Error('IndexedDB could not be opened'));
    };
    r.onblocked = () => {};
  }));
}

const done = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(...[stores].flat().map((s) => t.objectStore(s)))).then((v) => (out = v), reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => done(s.get(key)));
export const put = (store, key, value) => tx(store, 'readwrite', (s) => void s.put(value, key));
export const del = (store, key) => tx(store, 'readwrite', (s) => void s.delete(key));
export const all = (store) =>
  tx(store, 'readonly', async (s) => {
    const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
    return keys.map((k, i) => [k, values[i]]);
  });

const prefixRange = (prefix) => IDBKeyRange.bound(prefix, `${prefix}￿`);
export const fileKey = (pkg, path) => `${pkg}/${path}`;
const chunkKey = (pkg, path, i) => `${pkg}/${path}#${String(i).padStart(6, '0')}`;

/** Appends one piece of a file and updates its record, in one transaction. */
export function appendChunk(rec, blob) {
  return tx(['files', 'chunks'], 'readwrite', (files, chunks) => {
    chunks.put(blob, chunkKey(rec.pkg, rec.path, rec.chunks));
    rec.chunks += 1;
    rec.have += blob.size;
    files.put(rec, fileKey(rec.pkg, rec.path));
  });
}

/** Deletes a file's pieces and record (to restart it). */
export function resetFile(pkg, path) {
  return tx(['files', 'chunks'], 'readwrite', (files, chunks) => {
    chunks.delete(prefixRange(`${fileKey(pkg, path)}#`));
    files.delete(fileKey(pkg, path));
  });
}

/** Deletes every file of a package, and its record. */
export function removePackage(pkg) {
  return tx(['pkgs', 'files', 'chunks'], 'readwrite', (pkgs, files, chunks) => {
    chunks.delete(prefixRange(`${pkg}/`));
    files.delete(prefixRange(`${pkg}/`));
    pkgs.delete(pkg);
  });
}

/** A complete downloaded file as one Blob (backed by the stored pieces), or null. */
export async function fileBlob(pkg, path) {
  const rec = await get('files', fileKey(pkg, path));
  if (!rec?.done) return null;
  const parts = await tx('chunks', 'readonly', (s) => done(s.getAll(prefixRange(`${fileKey(pkg, path)}#`))));
  const blob = new Blob(parts);
  if (blob.size !== rec.size) throw new Error(`${path} is damaged on this device: ${blob.size} of ${rec.size} bytes`);
  return blob;
}

export const delPrefix = (store, prefix) => tx(store, 'readwrite', (s) => void s.delete(prefixRange(prefix)));

export function clearStore(store) {
  return tx(store, 'readwrite', (s) => void s.clear());
}

// ---------- log ----------

export const addLog = (entry) => tx('log', 'readwrite', (s) => void s.add(entry));

/** The newest `limit` entries, newest first. */
export function readLog(limit = 300) {
  return tx('log', 'readonly', (s) =>
    new Promise((resolve, reject) => {
      const out = [];
      const r = s.openCursor(null, 'prev');
      r.onsuccess = () => {
        const c = r.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      r.onerror = () => reject(r.error);
    }),
  );
}

/** Keeps the newest `keep` entries. */
export function trimLog(keep = 500) {
  return tx('log', 'readwrite', async (s) => {
    const keys = await done(s.getAllKeys());
    if (keys.length > keep) s.delete(IDBKeyRange.upperBound(keys[keys.length - keep - 1]));
  });
}

/** Deletes the whole database. Open connections close themselves (onversionchange). */
export async function destroy() {
  if (dbp) {
    try {
      (await dbp).close();
    } catch {
      // never opened
    }
    dbp = null;
  }
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => setTimeout(resolve, 2000); // a connection is closing; the delete completes after it
  });
}
