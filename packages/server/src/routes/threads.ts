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
import { findRunnerForProject } from '../services/runner-manager.js';
import * as runnerResolver from '../services/runner-resolver.js';
import type { ResolvedRunner } from '../services/runner-resolver.js';
import * as threadRegistry from '../services/thread-registry.js';
import { tunnelFetch } from '../services/ws-tunnel.js';

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET!;

/**
 * Resolve a runner for a project, returning runnerId and optional httpUrl.
 */
async function resolveRunnerForProject(projectId: string): Promise<ResolvedRunner | null> {
  // Try DB-registered runner first
  const runnerResult = await findRunnerForProject(projectId);
  if (runnerResult) {
    return {
      runnerId: runnerResult.runner.runnerId,
      httpUrl: runnerResult.runner.httpUrl ?? null,
    };
  }

  // Fallback to the resolver (which checks DEFAULT_RUNNER_URL and any online runner)
  return await runnerResolver.resolveRunner('/api/threads', { projectId });
}

/**
 * Send a request to a runner — tunnel-first, fallback to direct HTTP.
 */
async function fetchFromRunner(
  resolved: ResolvedRunner,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  // For __default__ runnerId (DEFAULT_RUNNER_URL), always use direct HTTP
  if (resolved.runnerId === '__default__' && resolved.httpUrl) {
    return await directFetch(resolved.httpUrl, path, opts);
  }

  // Try tunnel first
  try {
    const resp = await tunnelFetch(resolved.runnerId, {
      method: opts.method,
      path,
      headers: opts.headers,
      body: opts.body ?? null,
    });
    return {
      ok: resp.status >= 200 && resp.status < 400,
      status: resp.status,
      body: resp.body ?? '',
    };
  } catch (tunnelErr) {
    // Fallback to direct HTTP if available
    if (resolved.httpUrl) {
      log.warn('Tunnel failed, falling back to direct HTTP', {
        namespace: 'threads',
        runnerId: resolved.runnerId,
        error: (tunnelErr as Error).message,
      });
      return await directFetch(resolved.httpUrl, path, opts);
    }
    throw tunnelErr;
  }
}

async function directFetch(
  baseUrl: string,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method,
    headers: opts.headers,
    body: opts.method !== 'GET' && opts.method !== 'HEAD' ? opts.body : undefined,
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

function buildForwardHeaders(userId: string, orgId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-User': userId,
    'X-Runner-Auth': RUNNER_AUTH_SECRET,
  };
  if (orgId) headers['X-Forwarded-Org'] = orgId;
  return headers;
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

  const resolved = await resolveRunnerForProject(projectId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  try {
    const headers = buildForwardHeaders(userId, c.get('organizationId') as string | undefined);
    const result = await fetchFromRunner(resolved, '/api/threads', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      return c.json({ error: `Runner error: ${result.body}` }, result.status as any);
    }

    const threadData = JSON.parse(result.body);

    // Register the thread in the central DB
    const threadId = threadData.id || threadData.thread?.id;
    if (threadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId: resolved.runnerId,
        userId,
        title: body.title || threadData.title,
        model: body.model,
        mode: body.mode,
        branch: body.branch,
      });

      runnerResolver.cacheThreadRunner(threadId, resolved.runnerId, resolved.httpUrl);
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
 */
threadRoutes.post('/idle', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json();
  const projectId = body.projectId;

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const resolved = await resolveRunnerForProject(projectId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  try {
    const headers = buildForwardHeaders(userId, c.get('organizationId') as string | undefined);
    const result = await fetchFromRunner(resolved, '/api/threads/idle', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      return c.json({ error: `Runner error: ${result.body}` }, result.status as any);
    }

    const threadData = JSON.parse(result.body);

    const threadId = threadData.id || threadData.thread?.id;
    if (threadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId: resolved.runnerId,
        userId,
        title: body.title || threadData.title,
        model: body.model,
        mode: body.mode,
        branch: body.branch,
      });

      runnerResolver.cacheThreadRunner(threadId, resolved.runnerId, resolved.httpUrl);
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
    const resolved: ResolvedRunner = {
      runnerId: runnerInfo.runnerId,
      httpUrl: runnerInfo.httpUrl,
    };
    try {
      const headers = buildForwardHeaders(userId, c.get('organizationId') as string | undefined);
      await fetchFromRunner(resolved, `/api/threads/${threadId}`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      // Runner may be offline — that's ok, we already cleaned up the central DB
    }
  }

  return c.json({ ok: true });
});
