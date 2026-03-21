/**
 * Shared git-status helpers used by route handlers and event handlers.
 */

import { invalidateStatusCache, getStatusSummary } from '@funny/core/git';

import { deriveGitSyncState } from '../services/git-service.js';
import type { HandlerServiceContext } from '../services/handlers/types.js';

/** Compute a stable cache key that groups threads sharing the same git working state. */
export function computeBranchKey(thread: {
  id: string;
  projectId: string;
  branch?: string | null;
  worktreePath?: string | null;
  baseBranch?: string | null;
  mergedAt?: string | null;
}): string {
  // Merged threads (worktree cleaned up, mergedAt set): unique per thread
  if (!thread.branch && !thread.worktreePath && thread.baseBranch && thread.mergedAt)
    return `tid:${thread.id}`;
  // Threads with a branch (worktree or local): group by project + branch
  if (thread.branch) return `${thread.projectId}:${thread.branch}`;
  // Local threads without a branch: group by project
  return thread.projectId;
}

/**
 * Fetch fresh git status for a thread and emit it via WebSocket.
 * Shared by the debounced git-changed handler, the agent-completed handler,
 * and agent-message-handler's emitGitStatus method.
 */
export async function emitGitStatusForThread(
  opts: {
    threadId: string;
    userId: string;
    worktreePath?: string | null;
    cwd?: string | null;
  },
  ctx: HandlerServiceContext,
): Promise<void> {
  const effectiveCwd = opts.worktreePath ?? opts.cwd;
  if (!effectiveCwd) return;

  const thread = await ctx.getThread(opts.threadId);
  if (!thread) return;

  const project = await ctx.getProject(thread.projectId);
  if (!project) return;

  // Invalidate core-level cache so we get fresh data
  invalidateStatusCache(effectiveCwd);

  const summaryResult = await ctx.getGitStatusSummary(
    effectiveCwd,
    thread.baseBranch ?? undefined,
    project.path,
  );

  if (summaryResult.isErr()) {
    ctx.log(
      `Failed to get git status for thread ${opts.threadId}: [${summaryResult.error.type}] ${summaryResult.error.message}`,
    );
    return;
  }

  const summary = summaryResult.value;

  // Invalidate the HTTP cache so subsequent fetches don't return stale data
  ctx.invalidateGitStatusCache(project.id);

  const branchKey = computeBranchKey(thread);

  ctx.emitToUser(opts.userId, {
    type: 'git:status',
    threadId: opts.threadId,
    data: {
      statuses: [
        {
          threadId: opts.threadId,
          branchKey,
          state: ctx.deriveGitSyncState(summary),
          ...summary,
        },
      ],
    },
  });
}
