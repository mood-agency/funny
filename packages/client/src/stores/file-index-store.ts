import { create } from 'zustand';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { loadCachedFileIndex, saveCachedFileIndex } from '@/lib/file-index-db';

const log = createClientLogger('file-index-store');

interface FileIndexEntry {
  files: string[];
  version: number;
  /** Loaded from IDB but not yet revalidated against the server. */
  stale: boolean;
}

interface FileIndexState {
  byPath: Record<string, FileIndexEntry>;
  inflight: Record<string, Promise<FileIndexEntry | null>>;
  /**
   * Ensure an index for `basePath` is loaded. Hydrates from IndexedDB
   * synchronously if available, then revalidates against the server in the
   * background. Returns the current entry (which may still be marked stale).
   */
  ensureIndex: (basePath: string) => Promise<FileIndexEntry | null>;
  /** Force a server fetch (e.g. user pressed refresh). */
  refresh: (basePath: string) => Promise<FileIndexEntry | null>;
}

async function fetchFromServer(
  basePath: string,
  sinceVersion?: number,
): Promise<{ files: string[]; version: number } | null> {
  const result = await api.getFileIndex(basePath, sinceVersion);
  if (result.isErr()) {
    log.warn('file-index fetch failed', {
      basePath,
      error: result.error.message,
    });
    return null;
  }
  if ('unchanged' in result.value && result.value.unchanged) {
    return null; // signal: caller should keep current cache
  }
  // Type narrowed: must have files when not unchanged
  if ('files' in result.value) {
    return { files: result.value.files, version: result.value.version };
  }
  return null;
}

export const useFileIndexStore = create<FileIndexState>((set, get) => ({
  byPath: {},
  inflight: {},

  ensureIndex: async (basePath) => {
    const state = get();
    const existing = state.byPath[basePath];
    if (existing && !existing.stale) return existing;

    const inflight = state.inflight[basePath];
    if (inflight) return inflight;

    const op = (async (): Promise<FileIndexEntry | null> => {
      // 1. Try IDB cache for instant cold-start
      let cached: FileIndexEntry | null = null;
      const idbHit = await loadCachedFileIndex(basePath);
      if (idbHit) {
        cached = { files: idbHit.files, version: idbHit.version, stale: true };
        set((s) => ({ byPath: { ...s.byPath, [basePath]: cached! } }));
      }

      // 2. Revalidate against server (delta if possible)
      const fresh = await fetchFromServer(basePath, cached?.version);

      if (fresh) {
        const entry: FileIndexEntry = { ...fresh, stale: false };
        set((s) => ({ byPath: { ...s.byPath, [basePath]: entry } }));
        void saveCachedFileIndex(basePath, fresh.files, fresh.version);
        return entry;
      }

      // No fresh data — either server said unchanged, or fetch failed
      if (cached) {
        const entry: FileIndexEntry = { ...cached, stale: false };
        set((s) => ({ byPath: { ...s.byPath, [basePath]: entry } }));
        return entry;
      }
      return null;
    })().finally(() => {
      set((s) => {
        const next = { ...s.inflight };
        delete next[basePath];
        return { inflight: next };
      });
    });

    set((s) => ({ inflight: { ...s.inflight, [basePath]: op } }));
    return op;
  },

  refresh: async (basePath) => {
    set((s) => {
      if (!s.byPath[basePath]) return s;
      return { byPath: { ...s.byPath, [basePath]: { ...s.byPath[basePath], stale: true } } };
    });
    return get().ensureIndex(basePath);
  },
}));
