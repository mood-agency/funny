/**
 * Thread routes for the central server.
 *
 * Intercepts thread creation and deletion to register/unregister
 * threads in the central DB (for routing and listing).
 * All other thread operations are proxied to the runner.
 */

import { Hono } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { findRunnerForProject, getRunnerHttpUrl } from '../services/runner-manager.js';
import * as runnerResolver from '../services/runner-resolver.js';
import * as threadRegistry from '../services/thread-registry.js';

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET!;

/**
 * Resolve a runner URL for a project, falling back to DEFAULT_RUNNER_URL
 * when no runner is registered in the DB.
 */
async function resolveRunnerUrlForProject(
  projectId: string,
): Promise<{ httpUrl: string; runnerId: string | null } | null> {
  // Try DB-registered runner first
  const runnerResult = await findRunnerForProject(projectId);
  if (runnerResult) {
    const httpUrl = await getRunnerHttpUrl(runnerResult.runner.runnerId);
    if (httpUrl) return { httpUrl, runnerId: runnerResult.runner.runnerId };
  }

  // Fallback to the resolver (which checks DEFAULT_RUNNER_URL)
  const fallbackUrl = await runnerResolver.resolveRunnerUrl('/api/threads', { projectId });
  if (fallbackUrl) return { httpUrl: fallbackUrl, runnerId: null };

  return null;
}

export const threadRoutes = new Hono<ServerEnv>();

/**
 * POST /api/threads — Create a new thread.
 * 1. Resolve which runner should handle this project
 * 2. Proxy the creation request to the runner
 * 3. Register the thread in the central DB for routing
 */
threadRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json();
  const projectId = body.projectId;

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  // Find a runner for this project (with DEFAULT_RUNNER_URL fallback)
  const resolved = await resolveRunnerUrlForProject(projectId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  const { httpUrl: runnerHttpUrl, runnerId } = resolved;

  // Proxy the thread creation to the runner
  try {
    const runnerResponse = await fetch(`${runnerHttpUrl}/api/threads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': userId,
        'X-Runner-Auth': RUNNER_AUTH_SECRET,
        ...(c.get('organizationId')
          ? { 'X-Forwarded-Org': c.get('organizationId') as string }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!runnerResponse.ok) {
      const errorBody = await runnerResponse.text();
      return c.json({ error: `Runner error: ${errorBody}` }, runnerResponse.status as any);
    }

    const threadData = (await runnerResponse.json()) as any;

    // Register the thread in the central DB
    const threadId = threadData.id || threadData.thread?.id;
    if (threadId && runnerId) {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId,
        userId,
        title: body.title || threadData.title,
        model: body.model,
        mode: body.mode,
        branch: body.branch,
      });

      runnerResolver.cacheThreadRunner(threadId, runnerId, runnerHttpUrl);
    }

    return c.json(threadData, 201);
  } catch (err) {
    log.error('Failed to create thread on runner', {
      namespace: 'threads',
      error: (err as Error).message,
    });
    return c.json({ error: 'Runner unreachable' }, 502);
  }
});

/**
 * POST /api/threads/idle — Create an idle thread.
 * Same logic as POST /api/threads but for the idle thread endpoint.
 */
threadRoutes.post('/idle', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json();
  const projectId = body.projectId;

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const resolved = await resolveRunnerUrlForProject(projectId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  const { httpUrl: runnerHttpUrl, runnerId } = resolved;

  try {
    const runnerResponse = await fetch(`${runnerHttpUrl}/api/threads/idle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': userId,
        'X-Runner-Auth': RUNNER_AUTH_SECRET,
        ...(c.get('organizationId')
          ? { 'X-Forwarded-Org': c.get('organizationId') as string }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!runnerResponse.ok) {
      const errorBody = await runnerResponse.text();
      return c.json({ error: `Runner error: ${errorBody}` }, runnerResponse.status as any);
    }

    const threadData = (await runnerResponse.json()) as any;

    const threadId = threadData.id || threadData.thread?.id;
    if (threadId && runnerId) {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId,
        userId,
        title: body.title || threadData.title,
        model: body.model,
        mode: body.mode,
        branch: body.branch,
      });

      runnerResolver.cacheThreadRunner(threadId, runnerId, runnerHttpUrl);
    }

    return c.json(threadData, 201);
  } catch (err) {
    log.error('Failed to create idle thread on runner', {
      namespace: 'threads',
      error: (err as Error).message,
    });
    return c.json({ error: 'Runner unreachable' }, 502);
  }
});

/**
 * DELETE /api/threads/:id — Delete a thread.
 * Unregister from the central DB, then proxy the delete to the runner.
 */
threadRoutes.delete('/:id', async (c) => {
  const threadId = c.req.param('id');
  const userId = c.get('userId') as string;

  // Find which runner handles this thread
  const runnerInfo = await threadRegistry.getRunnerForThread(threadId);

  // Unregister from central DB and cache
  await threadRegistry.unregisterThread(threadId);
  runnerResolver.uncacheThread(threadId);

  // Proxy the delete to the runner
  if (runnerInfo) {
    try {
      await fetch(`${runnerInfo.httpUrl}/api/threads/${threadId}`, {
        method: 'DELETE',
        headers: {
          'X-Forwarded-User': userId,
          'X-Runner-Auth': RUNNER_AUTH_SECRET,
          ...(c.get('organizationId')
            ? { 'X-Forwarded-Org': c.get('organizationId') as string }
            : {}),
        },
      });
    } catch {
      // Runner may be offline — that's ok, we already cleaned up the central DB
    }
  }

  return c.json({ ok: true });
});
