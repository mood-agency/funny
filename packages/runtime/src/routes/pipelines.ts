/**
 * Pipeline routes for the runtime.
 *
 * Only exposes operations that touch runtime-side resources (the in-memory
 * approval store, the WS broker). Pipeline CRUD lives in the server package.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { pipelineApprovalStore } from '../services/pipeline-approval-store.js';
import type { HonoEnv } from '../types/hono-env.js';

export const pipelineRuntimeRoutes = new Hono<HonoEnv>();

// ── Approval respond ────────────────────────────────────────
//
// Modeled on Archon's CLI commands `workflow approve <id> [text]` and
// `workflow reject <id> <reason>`, collapsed into a single REST endpoint
// that takes the decision in the body so the same UI handles both.

const respondSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  /** On approve: optional comment. On reject: rejection reason (recommended). */
  text: z.string().max(4000).optional(),
});

// POST /api/pipelines/approvals/:approvalId/respond
pipelineRuntimeRoutes.post('/approvals/:approvalId/respond', async (c) => {
  const approvalId = c.req.param('approvalId');
  const userId = c.get('userId');

  if (!userId) {
    return c.json({ error: 'Unauthenticated' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = respondSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid request body',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      400,
    );
  }

  // Reject decisions should carry a reason — block empty submissions to
  // protect against accidental UI clicks. Approve comments stay optional.
  if (parsed.data.decision === 'reject' && !parsed.data.text?.trim()) {
    return c.json({ error: 'A rejection reason is required' }, 400);
  }

  const result = pipelineApprovalStore.respond(approvalId, userId, {
    decision: parsed.data.decision,
    text: parsed.data.text,
  });

  if (!result.ok) {
    log.warn('Pipeline approval respond rejected', {
      namespace: 'pipeline-routes',
      approvalId,
      userId,
      reason: result.error,
    });
    return c.json(
      {
        error:
          result.error === 'forbidden' ? 'Forbidden' : 'Approval not found or already resolved',
      },
      result.error === 'forbidden' ? 403 : 404,
    );
  }

  log.info('Pipeline approval resolved', {
    namespace: 'pipeline-routes',
    approvalId,
    userId,
    decision: parsed.data.decision,
  });

  return c.json({ ok: true });
});

// GET /api/pipelines/approvals/pending — list approvals waiting for THIS user.
pipelineRuntimeRoutes.get('/approvals/pending', async (c) => {
  const userId = c.get('userId');
  if (!userId) {
    return c.json({ error: 'Unauthenticated' }, 401);
  }

  const pending = pipelineApprovalStore
    .list()
    .filter((entry) => entry.userId === userId)
    .map(({ approvalId, gateId, threadId, requestedAt }) => ({
      approvalId,
      gateId,
      threadId,
      requestedAt,
    }));

  return c.json({ pending });
});
