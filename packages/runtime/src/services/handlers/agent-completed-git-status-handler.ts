/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: agent:completed
 * @domain emits: git:status
 */

import { emitGitStatusForThread } from '../../utils/git-status-helpers.js';
import type { AgentCompletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const agentCompletedGitStatusHandler: EventHandler<'agent:completed'> = {
  name: 'refresh-git-status-on-agent-completed',
  event: 'agent:completed',

  async action(event: AgentCompletedEvent, ctx) {
    ctx.log(`Refreshing git status after agent ${event.status} for thread ${event.threadId}`);
    await emitGitStatusForThread(event, ctx);
  },
};
