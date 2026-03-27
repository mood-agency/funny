import { join } from 'path';

import { execute } from '@funny/core/git';

/**
 * Run `git ls-files` in a directory and return the raw file list.
 * Entries ending with '/' indicate nested git repos / submodules whose
 * contents aren't listed by the parent repo.
 */
export async function gitLsFiles(cwd: string): Promise<string[]> {
  const result = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
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
 * When an entry ends with '/' (nested git repo), run `git ls-files` inside it
 * and prefix the results with the directory name.
 */
export async function resolveGitFiles(cwd: string, prefix = ''): Promise<string[]> {
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
      nestedDirs.map((dir) => resolveGitFiles(join(cwd, dir), prefix + dir + '/')),
    );
    for (const files of nested) {
      resolved.push(...files);
    }
  }

  return resolved;
}
