#!/usr/bin/env bun
/**
 * Fitness function: file-growth budget.
 *
 * For any file that is already over MAX_LINES on the base branch, a PR may
 * not add more than MAX_GROWTH net lines to it. Decomposition PRs (which
 * shrink the file) are always allowed.
 *
 * Usage:
 *   bun scripts/fitness/check-file-growth.ts            # compares HEAD vs origin/master
 *   bun scripts/fitness/check-file-growth.ts main       # compares HEAD vs main
 *   BASE_REF=origin/main bun .../check-file-growth.ts
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LINES = 1500;
const MAX_GROWTH = 100;
const ROOT = join(import.meta.dir, '..', '..');

const baseRef = process.argv[2] ?? process.env.BASE_REF ?? 'origin/master';

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`);
  }
  return r.stdout;
}

function verifyRef(ref: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--verify', ref], { cwd: ROOT });
  return r.status === 0;
}

if (!verifyRef(baseRef)) {
  console.log(
    `base ref ${baseRef} not found — skipping growth check (likely a shallow clone or local-only branch)`,
  );
  process.exit(0);
}

// Files changed between baseRef and HEAD
const changedRaw = run('git', ['diff', '--name-only', `${baseRef}...HEAD`]);
const changed = changedRaw
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && f.startsWith('packages/'));

const violations: string[] = [];

for (const file of changed) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue; // deleted
  const nowLines = readFileSync(abs, 'utf8').split('\n').length;

  let baseLines = 0;
  const blob = spawnSync('git', ['show', `${baseRef}:${file}`], { cwd: ROOT, encoding: 'utf8' });
  if (blob.status === 0) baseLines = blob.stdout.split('\n').length;

  if (baseLines < MAX_LINES) continue; // not yet a hotspot
  const delta = nowLines - baseLines;
  if (delta > MAX_GROWTH) {
    violations.push(
      `${file}: ${baseLines} → ${nowLines} (+${delta}); budget is +${MAX_GROWTH} for files already over ${MAX_LINES}`,
    );
  }
}

if (violations.length > 0) {
  console.error(`\nFile-growth budget exceeded:`);
  for (const v of violations) console.error('  ' + v);
  console.error('\nEither split the file in this PR, or land the change in a smaller slice.');
  process.exit(1);
}

console.log(`file-growth ok — no hotspot grew more than ${MAX_GROWTH} lines vs ${baseRef}`);
