/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { git } from '@funny/core/git';
import { ok } from 'neverthrow';

import * as tm from '../../services/thread-manager.js';
import { requireProject } from '../../utils/route-helpers.js';

// computeBranchKey is imported from utils/git-status-helpers.ts

// In-memory cache for bulk git status to avoid spawning excessive git processes.
export const _gitStatusCache = new Map<string, { data: any; ts: number }>();
export const GIT_STATUS_CACHE_TTL_MS = 2_000; // 2 seconds

// Throttled fetch: track last fetch time per project so we don't hammer the remote.
export const _lastFetchTs = new Map<string, number>();
export const FETCH_THROTTLE_MS = 30_000; // 30 seconds

/** Invalidate cached git status for a project after mutating git operations. */
export async function invalidateGitStatusCache(threadId: string) {
  const thread = await tm.getThread(threadId);
  if (thread) _gitStatusCache.delete(thread.projectId);
}

/** Invalidate cached git status by project ID directly. Exported for use by event handlers. */
export function invalidateGitStatusCacheByProject(projectId: string) {
  _gitStatusCache.delete(projectId);
}

/** Count unpushed commits on a branch vs its remote tracking branch. */
export async function countUnpushedCommits(projectPath: string, branch: string): Promise<number> {
  try {
    const result = await git(['rev-list', '--count', `origin/${branch}..${branch}`], projectPath);
    if (result.isOk()) return parseInt(result.value.trim(), 10) || 0;
  } catch {
    /* remote tracking branch may not exist */
  }
  return 0;
}

/** Count unpulled commits on a branch (commits on origin not yet in local). */
export async function countUnpulledCommits(projectPath: string, branch: string): Promise<number> {
  try {
    const result = await git(['rev-list', '--count', `${branch}..origin/${branch}`], projectPath);
    if (result.isOk()) return parseInt(result.value.trim(), 10) || 0;
  } catch {
    /* remote tracking branch may not exist */
  }
  return 0;
}

/** Resolve project path from projectId and verify ownership. */
export async function requireProjectCwd(
  projectId: string,
  userId?: string,
  organizationId?: string | null,
): Promise<import('neverthrow').Result<string, import('@funny/shared/errors').DomainError>> {
  const projectResult = await requireProject(projectId, userId, organizationId ?? undefined);
  if (projectResult.isErr()) return projectResult.map(() => '');
  return ok(projectResult.value.path);
}
