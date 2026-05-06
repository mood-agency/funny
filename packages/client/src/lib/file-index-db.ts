/**
 * Tiny IndexedDB wrapper for caching file-index snapshots between sessions.
 * Keyed by `basePath` so each project/worktree gets its own row. Storing the
 * full file list in localStorage isn't viable (5 MB cap) — IDB easily handles
 * 100k+ paths.
 */

interface DBSchema {
  basePath: string;
  files: string[];
  version: number;
  /** Wall-clock time when the row was written. */
  cachedAt: number;
}

const DB_NAME = 'funny-file-index';
const DB_VERSION = 1;
const STORE = 'indexes';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'basePath' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function loadCachedFileIndex(
  basePath: string,
): Promise<{ files: string[]; version: number; cachedAt: number } | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(basePath);
      req.onsuccess = () => {
        const row = req.result as DBSchema | undefined;
        resolve(row ? { files: row.files, version: row.version, cachedAt: row.cachedAt } : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveCachedFileIndex(
  basePath: string,
  files: string[],
  version: number,
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const row: DBSchema = { basePath, files, version, cachedAt: Date.now() };
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Silently ignore — IDB write failure is non-fatal, in-memory store still works
  }
}

export async function clearCachedFileIndex(basePath: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(basePath);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}
