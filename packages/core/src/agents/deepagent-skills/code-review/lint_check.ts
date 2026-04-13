#!/usr/bin/env bun
/**
 * Quick lint check helper for the code-review skill.
 *
 * Scans TypeScript/JavaScript files for common issues that a full linter
 * might miss or that are worth flagging during code review:
 *
 * - Functions longer than 50 lines
 * - Bare `catch` clauses (catch without error variable)
 * - Explicit `any` type usage
 * - Bare console logging left in production code (not test files)
 * - TODO/FIXME/HACK comments
 *
 * Usage:
 *   bun lint_check.ts [path ...]
 *
 * If no paths are given, scans the current directory recursively.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

interface Warning {
  file: string;
  line: number;
  message: string;
}

function checkFile(filePath: string): Warning[] {
  const warnings: Warning[] = [];
  let source: string;

  try {
    source = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return [{ file: filePath, line: 0, message: `could not read: ${err}` }];
  }

  const lines = source.split('\n');
  const isTestFile =
    filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__');

  // Track function boundaries for length check
  let functionStart: { name: string; line: number; braceDepth: number } | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip comments and empty lines for some checks
    const isComment =
      trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');

    // Bare catch clause: catch { or catch(e) { where e is unused
    if (/\bcatch\s*\{/.test(trimmed)) {
      warnings.push({
        file: filePath,
        line: lineNum,
        message: "bare 'catch' clause without error variable",
      });
    }

    // Explicit 'any' type (not in comments)
    if (!isComment && /:\s*any\b/.test(line)) {
      warnings.push({
        file: filePath,
        line: lineNum,
        message: "explicit 'any' type — consider using a specific type",
      });
    }

    // Bare console logging in non-test files (not in comments)
    if (!isTestFile && !isComment && /\bconsole\.log\b/.test(line)) {
      warnings.push({
        file: filePath,
        line: lineNum,
        message: 'bare console logging in production code — use a proper logger or remove',
      });
    }

    // TODO/FIXME/HACK comments
    if (isComment && /\b(TODO|FIXME|HACK|XXX)\b/.test(trimmed)) {
      warnings.push({
        file: filePath,
        line: lineNum,
        message: `${trimmed.match(/\b(TODO|FIXME|HACK|XXX)\b/)![0]} comment found`,
      });
    }

    // Function length tracking
    const funcMatch = trimmed.match(
      /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>)/,
    );
    if (funcMatch && !functionStart) {
      const name = funcMatch[1] || funcMatch[2] || 'anonymous';
      functionStart = { name, line: lineNum, braceDepth };
    }

    // Count braces
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    // Check if function ended
    if (functionStart && braceDepth <= functionStart.braceDepth) {
      const length = lineNum - functionStart.line + 1;
      if (length > 50) {
        warnings.push({
          file: filePath,
          line: functionStart.line,
          message: `function '${functionStart.name}' is ${length} lines long (>50)`,
        });
      }
      functionStart = null;
    }
  }

  return warnings;
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...walkDir(fullPath));
        } else if (TS_JS_EXTENSIONS.has(extname(entry))) {
          files.push(fullPath);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return files;
}

function main(paths: string[]): number {
  const targets = paths.length > 0 ? paths : ['.'];
  const allWarnings: Warning[] = [];

  for (const target of targets) {
    try {
      const stat = statSync(target);
      if (stat.isFile() && TS_JS_EXTENSIONS.has(extname(target))) {
        allWarnings.push(...checkFile(target));
      } else if (stat.isDirectory()) {
        const files = walkDir(target);
        for (const file of files.sort()) {
          allWarnings.push(...checkFile(file));
        }
      }
    } catch {
      console.error(`Cannot access: ${target}`);
    }
  }

  for (const w of allWarnings) {
    const rel = relative(process.cwd(), w.file);
    process.stdout.write(`${rel}:${w.line}: ${w.message}\n`);
  }

  if (allWarnings.length > 0) {
    process.stdout.write(`\n${allWarnings.length} warning(s) found.\n`);
    return 1;
  }

  process.stdout.write('No warnings found.\n');
  return 0;
}

const exitCode = main(process.argv.slice(2));
process.exit(exitCode);
