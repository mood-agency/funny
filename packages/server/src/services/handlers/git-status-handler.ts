/**
 * Git Status handler — emits git status via WebSocket when file-modifying
 * tools are executed, ensuring the UI stays in sync with git state.
 */

import type { EventHandler } from './types.js';
import type { GitChangedEvent } from '../thread-event-bus.js';
import { getStatusSummary, deriveGitSyncState } from '@funny/core/git';

export const gitStatusHandler: EventHandler<'git:changed'> = {
  name: 'emit-git-status-on-change',
  event: 'git:changed',

  // Only emit for worktree threads
  filter(event: GitChangedEvent) {
    return event.worktreePath !== null;
  },

  async action(event: GitChangedEvent, ctx) {
    const { threadId, worktreePath, userId } = event;

    if (!worktreePath) return;

    const thread = ctx.getThread(threadId);
    if (!thread) return;

    const project = ctx.getProject(thread.projectId);
    if (!project) return;

    console.log(`[git-status-handler] Emitting git status for thread=${threadId} after tool=${event.toolName}`);

    const summaryResult = await getStatusSummary(
      worktreePath,
      thread.baseBranch ?? undefined,
      project.path
    );

    if (summaryResult.isErr()) {
      console.error(`[git-status-handler] Failed to get status: ${summaryResult.error}`);
      return;
    }

    const summary = summaryResult.value;

    ctx.emitToUser(userId, {
      type: 'git:status',
      threadId,
      data: {
        statuses: [{
          threadId,
          state: deriveGitSyncState(summary),
          ...summary,
        }],
      },
    });
  },
};
