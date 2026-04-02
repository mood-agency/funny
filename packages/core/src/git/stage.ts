/**
 * Staging operations: stage, unstage, revert, gitignore.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

import type { DomainError } from '@funny/shared/errors';
import { internal } from '@funny/shared/errors';
import { ok, err, ResultAsync, type Result } from 'neverthrow';

import { git } from './base.js';
import { toDomainError } from './errors.js';
import { gitRead } from './process.js';

/**
 * Stage files for commit.
 * Filters out gitignored files before running `git add` to prevent
 * the entire operation from failing when ignored files are included.
 */
export function stageFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      // Ask git which of the requested paths are ignored
      const checkResult = await gitRead(['check-ignore', '--stdin'], {
        cwd,
        reject: false,
        stdin: paths.join('\n'),
      });
      const ignoredSet = new Set(
        checkResult.exitCode === 0 && checkResult.stdout.trim()
          ? checkResult.stdout
              .trim()
              .split('\n')
              .map((p) => p.trim())
          : [],
      );

      const filteredPaths = paths.filter((p) => !ignoredSet.has(p));
      if (filteredPaths.length === 0) return;

      const addResult = await git(['add', ...filteredPaths], cwd);
      if (addResult.isErr()) throw addResult.error;
    })(),
    toDomainError,
  );
}

/**
 * Unstage files — batched into a single git command.
 */
export function unstageFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return git(['restore', '--staged', '--', ...paths], cwd).map(() => undefined);
}

/**
 * Revert changes to files.
 * For tracked files, restores to HEAD via `git checkout`.
 * For untracked files, deletes them from the working tree.
 */
export function revertFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      // Identify untracked files so we can handle them differently
      const untrackedResult = await gitRead(['ls-files', '--others', '--exclude-standard'], {
        cwd,
      });
      const untrackedSet = new Set(
        untrackedResult.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );

      // Identify unmerged files (merge conflicts) — these need special handling.
      // Use ls-files --unmerged which catches all conflict types (UU, AA, AU, UA, DD, etc.)
      // Output format: "<mode> <hash> <stage>\t<path>" — extract the path after the tab
      const unmergedResult = await gitRead(['ls-files', '--unmerged'], { cwd });
      const unmergedSet = new Set(
        unmergedResult.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.split('\t').pop() ?? ''),
      );

      for (const path of paths) {
        if (untrackedSet.has(path)) {
          // Untracked file: delete it (there's no git version to restore)
          const fullPath = join(cwd, path);
          if (existsSync(fullPath)) rmSync(fullPath);
        } else if (unmergedSet.has(path)) {
          // Unmerged file (merge conflict): check if file exists in HEAD to decide strategy
          const fullPath = join(cwd, path);
          const headCheck = await gitRead(['cat-file', '-e', `HEAD:${path}`], {
            cwd,
            reject: false,
          });
          const existsInHead = headCheck.exitCode === 0;

          if (existsInHead) {
            // File exists in HEAD — restore to HEAD version, resolving the conflict
            const result = await git(['checkout', 'HEAD', '--', path], cwd);
            if (result.isErr()) throw result.error;
          } else {
            // File is new (only from the merge/incoming branch) — remove from index and disk
            await git(['rm', '--cached', '--force', '--', path], cwd);
            if (existsSync(fullPath)) rmSync(fullPath);
          }
        } else {
          const result = await git(['checkout', '--', path], cwd);
          if (result.isErr()) throw result.error;
        }
      }
    })(),
    toDomainError,
  );
}

/**
 * Add a pattern to .gitignore. Creates the file if it doesn't exist.
 * Avoids adding duplicate entries.
 */
export function addToGitignore(cwd: string, pattern: string): Result<void, DomainError> {
  try {
    const gitignorePath = join(cwd, '.gitignore');
    let content = '';
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, 'utf-8');
    }
    const lines = content.split('\n');
    if (lines.some((l) => l.trim() === pattern.trim())) {
      return ok(undefined);
    }
    const newContent =
      content.endsWith('\n') || content === ''
        ? content + pattern + '\n'
        : content + '\n' + pattern + '\n';
    writeFileSync(gitignorePath, newContent, 'utf-8');
    return ok(undefined);
  } catch (e) {
    return err(internal(`Failed to update .gitignore: ${String(e)}`));
  }
}
