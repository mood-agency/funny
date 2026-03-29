import { join } from 'path';

import { gitRead } from '@funny/core/git';

// ─── Cache for resolveGitFiles ──────────────────────────────
const GIT_FILES_CACHE_TTL = 5_000; // 5 seconds

interface CacheEntry {
  files: string[];
  ts: number;
}

const fileCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<string[]>>();

/** Invalidate cached file lists for a specific directory, or all entries. */
export function invalidateGitFilesCache(cwd?: string): void {
  if (cwd) {
    fileCache.delete(cwd);
    for (const key of fileCache.keys()) {
      if (key.startsWith(cwd + '/')) fileCache.delete(key);
    }
  } else {
    fileCache.clear();
  }
}

/**
 * Run `git ls-files` in a directory and return the raw file list.
 * Uses gitRead (read pool, limit 20) instead of execute (general pool, limit 6).
 */
export async function gitLsFiles(cwd: string): Promise<string[]> {
  const result = await gitRead(['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd,
    reject: false,
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Recursively resolve files from `git ls-files`.
 * Results are cached with a 5-second TTL. Concurrent requests for the same
 * path coalesce into a single git process.
 */
export async function resolveGitFiles(cwd: string, prefix = ''): Promise<string[]> {
  // Only cache top-level calls; recursive calls are part of the same operation
  if (prefix === '') {
    const cached = fileCache.get(cwd);
    if (cached && Date.now() - cached.ts < GIT_FILES_CACHE_TTL) {
      return cached.files;
    }

    // In-flight deduplication: share the same Promise if already running
    const inflight = inflightRequests.get(cwd);
    if (inflight) return inflight;

    const promise = _resolveGitFilesInner(cwd, prefix)
      .then((files) => {
        fileCache.set(cwd, { files, ts: Date.now() });
        inflightRequests.delete(cwd);
        return files;
      })
      .catch((err) => {
        inflightRequests.delete(cwd);
        throw err;
      });

    inflightRequests.set(cwd, promise);
    return promise;
  }

  return _resolveGitFilesInner(cwd, prefix);
}

/** Inner implementation without caching (handles recursion). */
async function _resolveGitFilesInner(cwd: string, prefix: string): Promise<string[]> {
  const entries = await gitLsFiles(cwd);
  const resolved: string[] = [];
  const nestedDirs: string[] = [];

  for (const entry of entries) {
    if (entry.endsWith('/')) {
      nestedDirs.push(entry.replace(/\/$/, ''));
    } else {
      resolved.push(prefix + entry);
    }
  }

  // Resolve nested git repos in parallel
  if (nestedDirs.length > 0) {
    const nested = await Promise.all(
      nestedDirs.map((dir) => _resolveGitFilesInner(join(cwd, dir), prefix + dir + '/')),
    );
    for (const files of nested) {
      resolved.push(...files);
    }
  }

  return resolved;
}
