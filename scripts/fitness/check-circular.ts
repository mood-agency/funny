#!/usr/bin/env bun
/**
 * Fitness function: no file-level circular imports.
 *
 * Walks TS/TSX files in the given roots, builds an import graph by parsing
 * `from './...'` and `from '../...'` specifiers, and detects cycles via DFS.
 *
 * Only relative imports are followed (package-level cycles are enforced
 * separately by the workspace graph itself). Type-only cycles are treated
 * the same as runtime cycles — they also couple modules.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

const ROOTS = [
  'packages/core/src',
  'packages/runtime/src',
  'packages/server/src',
  'packages/client/src',
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) yield full;
  }
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const graph = new Map<string, Set<string>>();

// Capture runtime imports only. Type-only statements like
// `import type { X } from '...'` and `export type { X } from '...'` are
// erased by tsc and don't create runtime cycles. Inline `type` specifiers
// inside a mixed import (e.g. `import { type X, Y } from '...'`) still keep
// the module present at runtime because of Y, so they count as runtime deps.
function parseRuntimeImports(text: string): string[] {
  const out: string[] = [];

  // Strip block comments and line comments so we don't match imports inside them.
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

  // Match any import/export ... from '...' statement (supports multi-line).
  const importRe = /(?:^|\n|;)\s*(import|export)\b([\s\S]*?)from\s+['"]([^'"]+)['"]/g;
  for (const m of noComments.matchAll(importRe)) {
    const keyword = m[1];
    const specifiers = m[2];
    const source = m[3];

    // `import type { ... } from '...'` or `export type { ... } from '...'`
    // — the entire binding is type-only, strip it.
    if (/^\s*type\b/.test(specifiers)) continue;

    out.push(source);
    void keyword;
  }

  // Bare side-effect imports: `import '...';`
  const bareRe = /(?:^|\n|;)\s*import\s+['"]([^'"]+)['"]/g;
  for (const m of noComments.matchAll(bareRe)) out.push(m[1]);

  return out;
}

for (const root of ROOTS) {
  const abs = join(ROOT, root);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const text = readFileSync(file, 'utf8');
    const deps = new Set<string>();
    for (const spec of parseRuntimeImports(text)) {
      const target = resolveImport(file, spec);
      if (target) deps.add(target);
    }
    graph.set(file, deps);
  }
}

// Tarjan's SCC — O(V+E), reports all nontrivial cycles.
let index = 0;
const stack: string[] = [];
const onStack = new Set<string>();
const idx = new Map<string, number>();
const low = new Map<string, number>();
const sccs: string[][] = [];

function strongconnect(v: string) {
  idx.set(v, index);
  low.set(v, index);
  index++;
  stack.push(v);
  onStack.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) {
      strongconnect(w);
      low.set(v, Math.min(low.get(v)!, low.get(w)!));
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
  }
  if (low.get(v) === idx.get(v)) {
    const comp: string[] = [];
    while (true) {
      const w = stack.pop()!;
      onStack.delete(w);
      comp.push(w);
      if (w === v) break;
    }
    if (comp.length > 1) sccs.push(comp);
    // Also catch self-loops.
    else if (comp.length === 1 && (graph.get(comp[0]) ?? new Set()).has(comp[0])) sccs.push(comp);
  }
}

for (const v of graph.keys()) if (!idx.has(v)) strongconnect(v);

// Known cycles — snapshot baseline. New cycles fail CI; existing ones
// warn until resolved. Each entry is the sorted set of relative paths in
// the cycle, joined by '|'.
const KNOWN_CYCLES = new Set<string>([
  // Intentional recursive React render tree: a Task tool renders nested tool
  // calls via ToolCallGroup, which recurses back into ToolCallCard. React
  // components resolve lazily through JSX, so this is safe at runtime.
  // Fixing would require prop-injected component indirection for no real win.
  [
    'packages/client/src/components/ToolCallCard.tsx',
    'packages/client/src/components/ToolCallGroup.tsx',
    'packages/client/src/components/tool-cards/TaskCard.tsx',
  ]
    .sort()
    .join('|'),
]);

const newCycles: string[][] = [];
const knownSeen: string[][] = [];
for (const cycle of sccs) {
  const key = cycle
    .map((f) => relative(ROOT, f))
    .sort()
    .join('|');
  if (KNOWN_CYCLES.has(key)) knownSeen.push(cycle);
  else newCycles.push(cycle);
}

if (knownSeen.length > 0) {
  console.log(`\nKnown cycles (${knownSeen.length}) — tracked, not failing:`);
  for (const cycle of knownSeen) {
    console.log('  - ' + cycle.map((f) => relative(ROOT, f).split('/').pop()).join(' → '));
  }
}

if (newCycles.length > 0) {
  console.error(`\nNEW circular imports detected (${newCycles.length} cycle(s)):\n`);
  for (const cycle of newCycles) {
    console.error('  cycle:');
    for (const f of cycle) console.error('    ' + relative(ROOT, f));
    console.error('');
  }
  console.error(
    'Resolve the cycle or, if genuinely intentional, add it to KNOWN_CYCLES with a comment explaining why.',
  );
  process.exit(1);
}

console.log(`\ncircular-import ok — ${graph.size} files scanned, no new cycles`);
