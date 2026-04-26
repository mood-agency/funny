/**
 * Design artifact management — filesystem operations for creating design directories
 * under a project. Each design lives at `<projectPath>/designs/<designId>/`.
 */

import { mkdir, rm } from 'fs/promises';
import { join } from 'path';

import { Result, ok, err } from 'neverthrow';

const DESIGN_ID_REGEX = /^[A-Za-z0-9_-]+$/;

export function validateDesignId(id: string): Result<string, string> {
  if (!id || id.length === 0) return err('Design id is required');
  if (id.length > 64) return err('Design id must be ≤ 64 chars');
  if (!DESIGN_ID_REGEX.test(id)) return err('Design id contains invalid characters');
  return ok(id);
}

/**
 * Create the `designs/<id>/` directory at the resolved project path.
 * Creates the parent `designs/` directory lazily if it doesn't exist.
 */
export async function createDesignDirectory(
  projectPath: string,
  id: string,
): Promise<Result<string, string>> {
  const dir = join(projectPath, 'designs', id);
  try {
    await mkdir(dir, { recursive: true });
    return ok(dir);
  } catch (e) {
    return err(`Failed to create design directory: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Remove the `designs/<id>/` directory if it exists. Best-effort: missing dir is ok.
 */
export async function deleteDesignDirectory(
  projectPath: string,
  id: string,
): Promise<Result<void, string>> {
  const dir = join(projectPath, 'designs', id);
  try {
    await rm(dir, { recursive: true, force: true });
    return ok(undefined);
  } catch (e) {
    return err(`Failed to delete design directory: ${e instanceof Error ? e.message : String(e)}`);
  }
}
