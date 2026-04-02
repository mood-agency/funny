/**
 * Git status summary with caching, binary detection, and sync state derivation.
 */

import { join } from 'path';

import type { GitSyncState } from '@funny/shared';
import { processError, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { getNativeGit } from './native.js';
import { gitRead } from './process.js';

// ─── Types ──────────────────────────────────────────────

export interface GitStatusSummary {
  dirtyFileCount: number;
  unpushedCommitCount: number;
  unpulledCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
  linesAdded: number;
  linesDeleted: number;
}

// ─── Result cache for expensive git queries ─────────────

const STATUS_CACHE_TTL = 1_000; // 1 second
const STATUS_CACHE_MAX_ENTRIES = 1_000;

const statusCache = new Map<string, { data: GitStatusSummary; ts: number }>();

function statusCacheKey(cwd: string, baseBranch?: string, projectCwd?: string): string {
  return `${cwd}|${baseBranch ?? ''}|${projectCwd ?? ''}`;
}

/** Evict oldest entries when the cache exceeds the max size. Map iteration order is insertion order. */
function evictStatusCacheIfNeeded(): void {
  if (statusCache.size <= STATUS_CACHE_MAX_ENTRIES) return;
  const toRemove = statusCache.size - STATUS_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of statusCache.keys()) {
    if (removed >= toRemove) break;
    statusCache.delete(key);
    removed++;
  }
}

/** Invalidate status cache for a specific worktree path, or all entries. */
export function invalidateStatusCache(cwd?: string): void {
  if (cwd) {
    for (const key of statusCache.keys()) {
      if (key.startsWith(cwd + '|')) statusCache.delete(key);
    }
  } else {
    statusCache.clear();
  }
}

// ─── Binary detection helpers ───────────────────────────

const MAX_UNTRACKED_TO_COUNT = 200;
const MAX_UNTRACKED_FILE_SIZE = 512 * 1024; // 512 KB

/**
 * Batch-check `.gitattributes` for a list of paths, returning the set of
 * paths that should be treated as binary (binary=set OR diff=unset).
 *
 * Uses `git check-attr -z --stdin` for NUL-separated I/O to handle paths
 * with special characters. One process spawn for all files.
 */
async function getBinaryAttrPaths(cwd: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();

  const result = await gitRead(['check-attr', '-z', '--stdin', 'binary', 'diff'], {
    cwd,
    reject: false,
    stdin: paths.join('\0'),
  });

  const binaryPaths = new Set<string>();
  if (result.exitCode !== 0 || !result.stdout) return binaryPaths;

  // NUL-separated output format: path\0attr\0value\0path\0attr\0value\0...
  const parts = result.stdout.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const path = parts[i];
    const attr = parts[i + 1];
    const value = parts[i + 2];

    if (attr === 'binary' && value === 'set') {
      binaryPaths.add(path);
    } else if (attr === 'diff' && value === 'unset') {
      binaryPaths.add(path);
    }
  }

  return binaryPaths;
}

/** Unquote a path from git's porcelain output (C-style escaping inside double quotes). */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  return inner.replace(/\\([tnr"\\])|\\([0-7]{3})/g, (_, esc, oct) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    switch (esc) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return esc;
    }
  });
}

// ─── Public API ─────────────────────────────────────────

/**
 * Get a summary of the git status for a worktree.
 */
export function getStatusSummary(
  worktreeCwd: string,
  baseBranch?: string,
  projectCwd?: string,
): ResultAsync<GitStatusSummary, DomainError> {
  // Check cache first
  const cacheKey = statusCacheKey(worktreeCwd, baseBranch, projectCwd);
  const cached = statusCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < STATUS_CACHE_TTL) {
    return ResultAsync.fromSafePromise(Promise.resolve(cached.data));
  }

  // Try native module first
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(
      native
        .getStatusSummary(worktreeCwd, baseBranch ?? null, projectCwd ?? null)
        .then((result) => {
          statusCache.set(cacheKey, { data: result, ts: Date.now() });
          evictStatusCacheIfNeeded();
          return result;
        }),
      (error) => processError(String(error), 1, ''),
    );
  }

  // Fallback: CLI-based implementation
  return ResultAsync.fromPromise(
    (async () => {
      // Phase 1: three git commands
      //   - `status --porcelain -b`              → branch name + tracked dirty files
      //   - `diff HEAD --numstat`                 → staged + unstaged line stats combined
      //   - `ls-files --others --exclude-standard` → accurate untracked file count
      //     (porcelain collapses untracked dirs into one entry; ls-files expands them)
      const [statusResult, diffResult, untrackedResult] = await Promise.all([
        gitRead(['status', '--porcelain', '-b'], { cwd: worktreeCwd, reject: false }),
        gitRead(['diff', 'HEAD', '--numstat'], { cwd: worktreeCwd, reject: false }),
        gitRead(['ls-files', '--others', '--exclude-standard'], {
          cwd: worktreeCwd,
          reject: false,
        }),
      ]);

      // Parse branch from the first line: "## branch" or "## branch...upstream [ahead N]"
      let branch: string | null = null;
      let dirtyFileCount = 0;
      const untrackedPaths: string[] = [];
      if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
        const lines = statusResult.stdout.trim().split('\n');
        const headerLine = lines[0]; // e.g. "## main...origin/main [ahead 2]"
        if (headerLine.startsWith('## ')) {
          const ref = headerLine.slice(3).split('...')[0].trim();
          // Handle empty repo headers like "## No commits yet on master"
          const noCommitsMatch = ref.match(/^No commits yet on (.+)$/);
          if (noCommitsMatch) {
            branch = noCommitsMatch[1];
          } else if (ref && ref !== 'HEAD (no branch)') {
            branch = ref;
          }
        }
        // Count tracked dirty files (exclude untracked '??' entries — counted separately)
        const fileLines = lines.slice(1).filter(Boolean);
        let trackedDirtyCount = 0;
        for (const line of fileLines) {
          if (line.startsWith('?? ')) {
            untrackedPaths.push(unquoteGitPath(line.slice(3)));
          } else {
            trackedDirtyCount++;
          }
        }

        // Untracked count: prefer ls-files (expands directories) over porcelain (collapses them)
        const untrackedFileCount =
          untrackedResult.exitCode === 0 && untrackedResult.stdout.trim()
            ? untrackedResult.stdout.trim().split('\n').length
            : untrackedPaths.length;

        dirtyFileCount = trackedDirtyCount + untrackedFileCount;
      }

      // Parse combined line stats (working tree)
      let linesAdded = 0;
      let linesDeleted = 0;
      if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
        for (const line of diffResult.stdout.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const added = parseInt(parts[0], 10);
            const deleted = parseInt(parts[1], 10);
            if (!isNaN(added)) linesAdded += added;
            if (!isNaN(deleted)) linesDeleted += deleted;
          }
        }
      }

      // Count lines in untracked files (not covered by git diff HEAD --numstat)
      // Prefer ls-files output (expands directories) over porcelain paths
      const expandedUntrackedPaths =
        untrackedResult.exitCode === 0 && untrackedResult.stdout.trim()
          ? untrackedResult.stdout.trim().split('\n')
          : untrackedPaths;
      if (expandedUntrackedPaths.length > 0) {
        const filesToCount = expandedUntrackedPaths.slice(0, MAX_UNTRACKED_TO_COUNT);
        // Check .gitattributes for binary markers before counting lines
        const attrBinaryPaths = await getBinaryAttrPaths(worktreeCwd, filesToCount);
        const counts = await Promise.all(
          filesToCount.map(async (relPath) => {
            try {
              // Skip files marked as binary in .gitattributes
              if (attrBinaryPaths.has(relPath)) return 0;
              const file = Bun.file(join(worktreeCwd, relPath));
              const size = file.size;
              if (size === 0 || size > MAX_UNTRACKED_FILE_SIZE) return 0;
              const buffer = new Uint8Array(await file.arrayBuffer());
              // Binary detection fallback: null bytes in first 8KB
              const checkLen = Math.min(buffer.length, 8192);
              for (let i = 0; i < checkLen; i++) {
                if (buffer[i] === 0) return 0;
              }
              // Count newlines
              let n = 0;
              for (let i = 0; i < buffer.length; i++) {
                if (buffer[i] === 0x0a) n++;
              }
              if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) n++;
              return n;
            } catch {
              return 0;
            }
          }),
        );
        for (const c of counts) linesAdded += c;
      }

      if (!branch) {
        const result: GitStatusSummary = {
          dirtyFileCount,
          unpushedCommitCount: 0,
          unpulledCommitCount: 0,
          hasRemoteBranch: false,
          isMergedIntoBase: false,
          linesAdded,
          linesDeleted,
        };
        statusCache.set(cacheKey, { data: result, ts: Date.now() });
        evictStatusCacheIfNeeded();
        return result;
      }

      // Phase 2: launch ALL conditional commands in parallel (consolidated from 2 phases)
      const [
        remoteResult,
        mergedResult,
        baseCountResult,
        mergeBaseResult,
        branchTipResult,
        baseDiffResult,
      ] = await Promise.all([
        gitRead(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
          cwd: worktreeCwd,
          reject: false,
        }),
        baseBranch && projectCwd
          ? gitRead(['branch', '--merged', baseBranch, '--format=%(refname:short)'], {
              cwd: projectCwd,
              reject: false,
            })
          : Promise.resolve(null),
        // Speculatively count against baseBranch — used when no remote exists
        baseBranch
          ? gitRead(['rev-list', '--count', `${baseBranch}..HEAD`], {
              cwd: worktreeCwd,
              reject: false,
            })
          : Promise.resolve(null),
        baseBranch && projectCwd
          ? gitRead(['merge-base', baseBranch, branch], { cwd: projectCwd, reject: false })
          : Promise.resolve(null),
        projectCwd
          ? gitRead(['rev-parse', branch], { cwd: projectCwd, reject: false })
          : Promise.resolve(null),
        // Line diff against baseBranch — includes committed changes so diff stats
        // persist after the agent commits (git diff HEAD only shows uncommitted).
        baseBranch
          ? gitRead(['diff', `${baseBranch}...HEAD`, '--numstat'], {
              cwd: worktreeCwd,
              reject: false,
            })
          : Promise.resolve(null),
      ]);

      const remoteBranch = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null;
      const hasRemoteBranch = remoteBranch !== null;

      // If remote exists, we need count against it (two extra commands: ahead + behind).
      // Otherwise, use the speculative baseBranch count from above.
      let unpushedCommitCount = 0;
      let unpulledCommitCount = 0;
      if (hasRemoteBranch) {
        const [remoteCount, behindCount] = await Promise.all([
          gitRead(['rev-list', '--count', `${remoteBranch}..HEAD`], {
            cwd: worktreeCwd,
            reject: false,
          }),
          gitRead(['rev-list', '--count', `HEAD..${remoteBranch}`], {
            cwd: worktreeCwd,
            reject: false,
          }),
        ]);
        unpushedCommitCount =
          remoteCount.exitCode === 0 ? parseInt(remoteCount.stdout.trim(), 10) || 0 : 0;
        unpulledCommitCount =
          behindCount.exitCode === 0 ? parseInt(behindCount.stdout.trim(), 10) || 0 : 0;
      } else if (baseCountResult && baseCountResult.exitCode === 0) {
        unpushedCommitCount = parseInt(baseCountResult.stdout.trim(), 10) || 0;
      }

      const needsMergeCheck =
        mergedResult &&
        mergedResult.exitCode === 0 &&
        mergedResult.stdout.trim() &&
        mergedResult.stdout
          .trim()
          .split('\n')
          .map((b) => b.trim())
          .includes(branch);

      let isMergedIntoBase = false;
      if (needsMergeCheck && mergeBaseResult && branchTipResult) {
        if (mergeBaseResult.exitCode === 0 && branchTipResult.exitCode === 0) {
          isMergedIntoBase = mergeBaseResult.stdout.trim() !== branchTipResult.stdout.trim();
        } else {
          isMergedIntoBase = true;
        }
      }

      // Include committed line changes against baseBranch so diff stats persist
      // after the agent commits. The working-tree diff (git diff HEAD) only shows
      // uncommitted changes; baseDiffResult adds committed-but-diverged changes.
      if (baseDiffResult && baseDiffResult.exitCode === 0 && baseDiffResult.stdout.trim()) {
        let committedAdded = 0;
        let committedDeleted = 0;
        for (const line of baseDiffResult.stdout.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const a = parseInt(parts[0], 10);
            const d = parseInt(parts[1], 10);
            if (!isNaN(a)) committedAdded += a;
            if (!isNaN(d)) committedDeleted += d;
          }
        }
        // Use the larger of working-tree diff and branch diff so stats don't
        // drop to zero when the agent commits its changes.
        if (committedAdded > linesAdded) linesAdded = committedAdded;
        if (committedDeleted > linesDeleted) linesDeleted = committedDeleted;
      }

      const result: GitStatusSummary = {
        dirtyFileCount,
        unpushedCommitCount,
        unpulledCommitCount,
        hasRemoteBranch,
        isMergedIntoBase,
        linesAdded,
        linesDeleted,
      };
      statusCache.set(cacheKey, { data: result, ts: Date.now() });
      evictStatusCacheIfNeeded();
      return result;
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Derive a single sync state from a git status summary.
 */
export function deriveGitSyncState(summary: GitStatusSummary): GitSyncState {
  if (summary.dirtyFileCount > 0) return 'dirty';
  if (summary.unpushedCommitCount > 0) return 'unpushed';
  if (summary.isMergedIntoBase) return 'merged';
  if (summary.hasRemoteBranch) return 'pushed';
  return 'clean';
}
