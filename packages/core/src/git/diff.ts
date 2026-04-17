/**
 * Diff operations: full diff, diff summary, single-file diff.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { FileDiff, FileDiffSummary, DiffSummaryResponse } from '@funny/shared';
import { processError, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { getNativeGit } from './native.js';
import { gitRead } from './process.js';

// ─── Helpers ────────────────────────────────────────────

/**
 * Parse git status line to extract file status
 */
function parseStatusLine(line: string): {
  status: FileDiff['status'];
  path: string;
} | null {
  const match = line.match(/^([MADR?U])\s+(.+)$/);
  if (!match) return null;

  const statusMap: Record<string, FileDiff['status']> = {
    A: 'added',
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
    '?': 'added',
    U: 'conflicted',
  };

  return {
    status: statusMap[match[1]] ?? 'modified',
    path: match[2].trim(),
  };
}

/**
 * Split a unified diff blob into per-file chunks.
 * Each chunk starts with "diff --git a/... b/..."
 */
function splitDiffByFile(rawDiff: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!rawDiff) return result;

  const chunks = rawDiff.split(/(?=^diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    // Extract path from "diff --git a/foo b/foo"
    const headerMatch = chunk.match(/^diff --git a\/.+ b\/(.+)/);
    if (headerMatch) {
      result.set(headerMatch[1], chunk.trim());
    }
  }
  return result;
}

/**
 * Normalize a path entry and detect whether it's a submodule / nested git repo.
 * `git ls-files --others --exclude-standard` returns nested repos with a trailing `/`,
 * and `git diff` reports gitlink entries (mode 160000) without content. In both cases
 * the entry represents a whole repo — detect by probing `<cwd>/<path>/.git`.
 */
function classifyPath(cwd: string, rawPath: string): { path: string; isSubmodule: boolean } {
  const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  // `.git` can be a dir (standalone clone) or a file (submodule gitlink pointer).
  const dotGit = join(cwd, path, '.git');
  return { path, isSubmodule: existsSync(dotGit) };
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      if (filePath.startsWith(prefix + '/') || filePath === prefix) return true;
    } else if (pattern.startsWith('*')) {
      if (filePath.endsWith(pattern.slice(1))) return true;
    } else if (filePath === pattern) {
      return true;
    }
  }
  return false;
}

// ─── Size limits ───────────────────────────────────────

/** Maximum diff content size per file in bytes (512 KB). Files exceeding this get a truncation notice. */
const MAX_DIFF_BYTES_PER_FILE = 512 * 1024;
/** Maximum total diff payload size in bytes (10 MB). Beyond this, remaining files get empty diffs. */
const MAX_TOTAL_DIFF_BYTES = 10 * 1024 * 1024;

function truncateDiff(diff: string): string {
  if (Buffer.byteLength(diff, 'utf8') <= MAX_DIFF_BYTES_PER_FILE) return diff;
  // Truncate to the byte limit, then find the last full line
  const truncated = Buffer.from(diff, 'utf8').subarray(0, MAX_DIFF_BYTES_PER_FILE).toString('utf8');
  const lastNewline = truncated.lastIndexOf('\n');
  return (
    (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) +
    '\n\n... [diff truncated — file too large] ...'
  );
}

// ─── Public API ─────────────────────────────────────────

/**
 * Get diff information for all changed files.
 * Uses only 4 git commands total (instead of N+3 per file).
 * Applies per-file and total size limits to prevent OOM on large repos.
 */
export function getDiff(cwd: string): ResultAsync<FileDiff[], DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Run all 5 read commands in parallel — no dependency between them
      const [
        stagedStatusResult,
        unstagedStatusResult,
        untrackedResult,
        stagedDiffResult,
        unstagedDiffResult,
      ] = await Promise.all([
        gitRead(['diff', '--staged', '--name-status'], { cwd, reject: false }),
        gitRead(['diff', '--name-status'], { cwd, reject: false }),
        gitRead(['ls-files', '--others', '--exclude-standard'], { cwd, reject: false }),
        gitRead(['diff', '--staged'], { cwd, reject: false }),
        gitRead(['diff'], { cwd, reject: false }),
      ]);

      const stagedRaw = stagedStatusResult.exitCode === 0 ? stagedStatusResult.stdout.trim() : '';
      const stagedFiles = stagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiff['status']; path: string }[];

      const unstagedRaw =
        unstagedStatusResult.exitCode === 0 ? unstagedStatusResult.stdout.trim() : '';
      const untrackedRaw = untrackedResult.exitCode === 0 ? untrackedResult.stdout.trim() : '';

      const unstagedFiles = unstagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiff['status']; path: string }[];

      const untrackedFiles = untrackedRaw
        .split('\n')
        .filter(Boolean)
        .map((p) => ({ status: 'added' as const, path: p.trim() }));

      const allUnstaged = [...unstagedFiles, ...untrackedFiles];

      // Parse the full diff blobs into per-file maps
      const stagedDiffMap = splitDiffByFile(
        stagedDiffResult.exitCode === 0 ? stagedDiffResult.stdout : '',
      );
      const unstagedDiffMap = splitDiffByFile(
        unstagedDiffResult.exitCode === 0 ? unstagedDiffResult.stdout : '',
      );

      const stagedPaths = new Set(stagedFiles.map((f) => f.path));
      const diffs: FileDiff[] = [];
      let totalBytes = 0;

      const pushEntry = (
        f: { path: string; status: FileDiff['status'] },
        rawDiff: string,
        staged: boolean,
      ) => {
        const { path, isSubmodule } = classifyPath(cwd, f.path);
        let diff = rawDiff;
        if (isSubmodule) {
          // Gitlinks / nested repos don't have meaningful per-line diffs; keep a marker.
          diff = diff || '';
        } else if (totalBytes < MAX_TOTAL_DIFF_BYTES) {
          diff = truncateDiff(diff);
          totalBytes += Buffer.byteLength(diff, 'utf8');
        } else {
          diff = '... [diff omitted — total payload size limit reached] ...';
        }
        diffs.push({
          path,
          status: f.status,
          diff,
          staged,
          ...(isSubmodule && { kind: 'submodule' as const }),
        });
      };

      for (const f of stagedFiles) {
        pushEntry(f, stagedDiffMap.get(f.path) ?? '', true);
      }

      for (const f of allUnstaged) {
        if (stagedPaths.has(f.path)) continue;
        pushEntry(f, unstagedDiffMap.get(f.path) ?? '', false);
      }

      return diffs;
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Get file list without diff content — much faster than getDiff().
 * Only runs name-status and ls-files commands (no full diff).
 * No files are excluded by default — relies on lazy diff loading + virtualization on the client.
 */
export function getDiffSummary(
  cwd: string,
  options?: { excludePatterns?: string[]; maxFiles?: number },
): ResultAsync<DiffSummaryResponse, DomainError> {
  const native = getNativeGit();
  const exclude = options?.excludePatterns ?? [];
  const maxFiles = options?.maxFiles ?? 0;

  return ResultAsync.fromPromise(
    (async () => {
      // 1. Get base file list (either from native or CLI)
      let baseFiles: Array<{ path: string; status: FileDiffSummary['status']; staged: boolean }> =
        [];
      let total = 0;
      let truncated = false;

      let usedNative = false;
      if (native) {
        try {
          const r = await native.getDiffSummary(
            cwd,
            exclude.length > 0 ? exclude : null,
            maxFiles > 0 ? maxFiles : null,
          );
          baseFiles = r.files.map((f) => ({
            path: f.path,
            status: f.status as FileDiffSummary['status'],
            staged: f.staged,
          }));
          total = r.total;
          truncated = r.truncated;
          usedNative = true;
        } catch {
          // Native module failed (e.g., empty repo with no HEAD) — fall through to CLI
        }
      }
      if (!usedNative) {
        const [stagedStatusResult, unstagedStatusResult, untrackedResult] = await Promise.all([
          gitRead(['diff', '--staged', '--name-status'], { cwd, reject: false }),
          gitRead(['diff', '--name-status'], { cwd, reject: false }),
          gitRead(['ls-files', '--others', '--exclude-standard'], { cwd, reject: false }),
        ]);

        const stagedRaw = stagedStatusResult.exitCode === 0 ? stagedStatusResult.stdout.trim() : '';
        const stagedFiles = stagedRaw
          .split('\n')
          .filter(Boolean)
          .map(parseStatusLine)
          .filter(Boolean) as { status: FileDiffSummary['status']; path: string }[];

        const unstagedRaw =
          unstagedStatusResult.exitCode === 0 ? unstagedStatusResult.stdout.trim() : '';
        const untrackedRaw = untrackedResult.exitCode === 0 ? untrackedResult.stdout.trim() : '';

        const unstagedFiles = unstagedRaw
          .split('\n')
          .filter(Boolean)
          .map(parseStatusLine)
          .filter(Boolean) as { status: FileDiffSummary['status']; path: string }[];

        const untrackedFiles = untrackedRaw
          .split('\n')
          .filter(Boolean)
          .map((p) => ({ status: 'added' as const, path: p.trim() }));

        const allUnstaged = [...unstagedFiles, ...untrackedFiles];
        const stagedPaths = new Set(stagedFiles.map((f) => f.path));

        const allFiles: Array<{
          path: string;
          status: FileDiffSummary['status'];
          staged: boolean;
        }> = [];

        for (const f of stagedFiles) {
          if (exclude.length > 0 && matchesAnyPattern(f.path, exclude)) continue;
          allFiles.push({ path: f.path, status: f.status, staged: true });
        }
        for (const f of allUnstaged) {
          if (stagedPaths.has(f.path)) continue;
          if (exclude.length > 0 && matchesAnyPattern(f.path, exclude)) continue;
          allFiles.push({ path: f.path, status: f.status, staged: false });
        }

        total = allFiles.length;
        truncated = maxFiles > 0 && total > maxFiles;
        baseFiles = truncated ? allFiles.slice(0, maxFiles) : allFiles;
      }

      // 2. Enrich with line stats via numstat (staged and unstaged)
      const [stagedNumstat, unstagedNumstat] = await Promise.all([
        gitRead(['diff', '--staged', '--numstat'], { cwd, reject: false }),
        gitRead(['diff', '--numstat'], { cwd, reject: false }),
      ]);

      const statMap = new Map<string, { additions: number; deletions: number; staged: boolean }>();

      const parseNumstat = (stdout: string, staged: boolean) => {
        if (!stdout) return;
        for (const line of stdout.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const additions = parseInt(parts[0], 10);
            const deletions = parseInt(parts[1], 10);
            const path = parts[2].trim();
            if (!isNaN(additions) && !isNaN(deletions)) {
              statMap.set(`${staged ? 's' : 'u'}:${path}`, { additions, deletions, staged });
            }
          }
        }
      };

      if (stagedNumstat.exitCode === 0) parseNumstat(stagedNumstat.stdout, true);
      if (unstagedNumstat.exitCode === 0) parseNumstat(unstagedNumstat.stdout, false);

      // 2b. Untracked files don't appear in `git diff --numstat` because they're not
      // in git's index yet. Compute their line counts via `git diff --no-index` so the
      // UI can show +N for newly added files. Skip nested repos (path ends with "/").
      const untrackedToStat = baseFiles.filter(
        (f) =>
          !f.staged && f.status === 'added' && !f.path.endsWith('/') && !statMap.has(`u:${f.path}`),
      );
      if (untrackedToStat.length > 0) {
        await Promise.all(
          untrackedToStat.map(async (f) => {
            const r = await gitRead(
              ['diff', '--no-index', '--numstat', '--', '/dev/null', f.path],
              { cwd, reject: false },
            );
            // Exit code 1 is expected (differences found); only bail on 2+ (error).
            if (r.exitCode !== 0 && r.exitCode !== 1) return;
            const line = r.stdout.trim().split('\n')[0];
            if (!line) return;
            const parts = line.split('\t');
            if (parts.length < 3) return;
            const additions = parseInt(parts[0], 10);
            const deletions = parseInt(parts[1], 10);
            if (isNaN(additions) || isNaN(deletions)) return; // binary files → "-\t-"
            statMap.set(`u:${f.path}`, { additions, deletions, staged: false });
          }),
        );
      }

      // 3. Merge stats into baseFiles + classify submodules/nested repos.
      const files: FileDiffSummary[] = baseFiles.map((f) => {
        const stats = statMap.get(`${f.staged ? 's' : 'u'}:${f.path}`);
        const { path, isSubmodule } = classifyPath(cwd, f.path);
        return {
          ...f,
          path,
          additions: stats?.additions ?? 0,
          deletions: stats?.deletions ?? 0,
          ...(isSubmodule && { kind: 'submodule' as const }),
        };
      });

      return { files, total, truncated };
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Get the diff content for a single file.
 */
export function getSingleFileDiff(
  cwd: string,
  filePath: string,
  staged: boolean,
): ResultAsync<string, DomainError> {
  const native = getNativeGit();
  return ResultAsync.fromPromise(
    (async () => {
      // Try native module first
      if (native) {
        try {
          const diff = await native.getSingleFileDiff(cwd, filePath, staged);
          if (diff) return diff;
          // Native returned empty — may be an untracked file; fall through to CLI
        } catch {
          // Native module failed — fall through to CLI
        }
      }
      if (staged) {
        const result = await gitRead(['diff', '--staged', '--', filePath], {
          cwd,
          reject: false,
        });
        return result.exitCode === 0 ? result.stdout : '';
      }
      // Check if file is untracked
      const lsResult = await gitRead(
        ['ls-files', '--others', '--exclude-standard', '--', filePath],
        { cwd, reject: false },
      );
      if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
        // Untracked file — use diff --no-index
        const result = await gitRead(['diff', '--no-index', '/dev/null', filePath], {
          cwd,
          reject: false,
        });
        // --no-index exits with 1 when there are differences (expected)
        return result.stdout;
      }
      // Tracked, unstaged
      const result = await gitRead(['diff', '--', filePath], { cwd, reject: false });
      return result.exitCode === 0 ? result.stdout : '';
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Get the diff for a single file with full file context (all lines shown).
 * Uses -U99999 to include the entire file as context around changes.
 */
export function getFullContextFileDiff(
  cwd: string,
  filePath: string,
  staged: boolean,
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (staged) {
        const result = await gitRead(['diff', '--staged', '-U99999', '--', filePath], {
          cwd,
          reject: false,
        });
        return result.exitCode === 0 ? result.stdout : '';
      }
      // Check if file is untracked
      const lsResult = await gitRead(
        ['ls-files', '--others', '--exclude-standard', '--', filePath],
        { cwd, reject: false },
      );
      if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
        // Untracked file — use diff --no-index
        const result = await gitRead(['diff', '--no-index', '-U99999', '/dev/null', filePath], {
          cwd,
          reject: false,
        });
        // --no-index exits with 1 when there are differences (expected)
        return result.stdout;
      }
      // Tracked, unstaged
      const result = await gitRead(['diff', '-U99999', '--', filePath], { cwd, reject: false });
      return result.exitCode === 0 ? result.stdout : '';
    })(),
    (error) => processError(String(error), 1, ''),
  );
}
