#!/usr/bin/env bun
/**
 * Fitness function: package-layering rules.
 *
 * Rules:
 *  - packages/server/** must not import from @funny/runtime
 *  - packages/core/**   must not import hono or drizzle-orm
 *  - packages/shared/** must not import from @funny/core or @funny/runtime
 *
 * Exits non-zero on violation.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

type Rule = {
  name: string;
  pkgDir: string;
  forbidden: RegExp;
};

const RULES: Rule[] = [
  {
    name: 'server must not import @funny/runtime',
    pkgDir: 'packages/server/src',
    forbidden: /from\s+['"]@funny\/runtime(\/|['"])/,
  },
  {
    name: 'core must not import hono',
    pkgDir: 'packages/core/src',
    forbidden: /from\s+['"]hono(\/|['"])/,
  },
  {
    name: 'core must not import drizzle-orm',
    pkgDir: 'packages/core/src',
    forbidden: /from\s+['"]drizzle-orm(\/|['"])/,
  },
  {
    name: 'shared must not import @funny/core',
    pkgDir: 'packages/shared/src',
    forbidden: /from\s+['"]@funny\/core(\/|['"])/,
  },
  {
    name: 'shared must not import @funny/runtime',
    pkgDir: 'packages/shared/src',
    forbidden: /from\s+['"]@funny\/runtime(\/|['"])/,
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

const violations: string[] = [];

for (const rule of RULES) {
  const abs = join(ROOT, rule.pkgDir);
  try {
    for (const file of walk(abs)) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (rule.forbidden.test(line)) {
          violations.push(`[${rule.name}] ${relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
  } catch {
    // dir missing — skip
  }
}

if (violations.length > 0) {
  console.error('Layering violations:\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s)`);
  process.exit(1);
}

console.log('layering ok — all package boundaries respected');
