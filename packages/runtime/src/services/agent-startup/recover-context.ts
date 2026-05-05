import { log } from '../../lib/logger.js';
import type { IThreadManager } from '../server-interfaces.js';
import { buildThreadContext, needsContextRecovery } from '../thread-context-builder.js';

interface Args {
  threadId: string;
  prompt: string;
  thread:
    | { sessionId?: string | null; mergedAt?: string | null; contextRecoveryReason?: string | null }
    | null
    | undefined;
  threadManager: IThreadManager;
}

interface Result {
  effectivePrompt: string;
  effectiveSessionId: string | undefined;
  needsRecovery: boolean;
}

/**
 * If the thread needs context recovery (post-merge or model/provider
 * change), prepend the rebuilt context to the prompt and clear the session
 * id so the orchestrator starts a fresh agent run.
 *
 * Pulled out of agent-lifecycle so the parent doesn't import
 * thread-context-builder directly.
 */
export async function recoverThreadContext({
  threadId,
  prompt,
  thread,
  threadManager,
}: Args): Promise<Result> {
  let effectivePrompt = prompt;
  let effectiveSessionId = thread?.sessionId ?? undefined;
  const needsRecovery = await needsContextRecovery(threadId);

  if (needsRecovery) {
    const recoveryReason = thread?.contextRecoveryReason ?? 'post-merge';
    log.info('Thread needs context recovery', {
      namespace: 'agent',
      threadId,
      isPostMerge: !!thread?.mergedAt,
      reason: recoveryReason,
    });
    const context = await buildThreadContext(threadId);
    if (context) {
      effectivePrompt = `${context}\n\nUSER (new message):\n${prompt}`;
    }
    await threadManager.updateThread(threadId, {
      sessionId: null,
      contextRecoveryReason: null,
    });
    effectiveSessionId = undefined;
  }

  return { effectivePrompt, effectiveSessionId, needsRecovery };
}
