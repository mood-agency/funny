/**
 * Resolves the path to the Claude Agent SDK's cli.js executable.
 *
 * When code is bundled (e.g. via Bun.build into dist/index.js), the SDK's
 * default resolution — dirname(import.meta.url)/../cli.js — points to the
 * bundle's directory instead of the SDK package directory.
 *
 * This utility tries createRequire first, then walks up from process.cwd()
 * to find the SDK in node_modules as a fallback.
 */

import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

let cached: string | null = null;

export function resolveSDKCliPath(): string {
  if (cached) return cached;

  // Strategy 1: createRequire from the current module
  try {
    const req = createRequire(import.meta.url);
    const sdkPkgJson = req.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const candidate = join(dirname(sdkPkgJson), 'cli.js');
    if (existsSync(candidate)) {
      cached = candidate;
      return cached;
    }
  } catch {
    // createRequire may fail in bundled contexts — fall through
  }

  // Strategy 2: walk up from cwd to find node_modules
  let dir = process.cwd();
  while (dir) {
    const candidate = join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
    if (existsSync(candidate)) {
      cached = candidate;
      return cached;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    'Could not find @anthropic-ai/claude-agent-sdk/cli.js in any node_modules. ' +
      'Is @anthropic-ai/claude-agent-sdk installed?',
  );
}
