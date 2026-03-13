/**
 * User profile routes for the central server.
 *
 * Most profile data (git identity, GitHub token) is managed locally.
 * Endpoints that require runtime-side logic (e.g. transcribe-token)
 * are proxied to the runner.
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import * as ps from '../services/profile-service.js';
import { resolveRunnerUrl } from '../services/runner-resolver.js';

export const profileRoutes = new Hono<ServerEnv>();

/** Proxy transcribe-token to the runtime (AssemblyAI logic lives there) */
profileRoutes.get('/transcribe-token', proxyToRunner);

/** Get current user's profile — merge server + runtime data */
profileRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const serverProfile = await ps.getProfile(userId);

  // Fetch runtime profile for runtime-specific fields (hasAssemblyaiKey, etc.)
  let runtimeProfile: Record<string, any> = {};
  const runnerUrl = await resolveRunnerUrl('/api/profile', {});
  if (runnerUrl) {
    try {
      const res = await fetch(`${runnerUrl}/api/profile`, {
        headers: {
          'X-Forwarded-User': userId,
          'X-Runner-Auth': process.env.RUNNER_AUTH_SECRET!,
        },
      });
      if (res.ok) runtimeProfile = await res.json();
    } catch {
      // Runtime unavailable — return what we have
    }
  }

  return c.json({
    ...(serverProfile ?? { userId, gitName: null, gitEmail: null, hasGithubToken: false }),
    hasAssemblyaiKey: runtimeProfile.hasAssemblyaiKey ?? false,
    setupCompleted: true,
  });
});

/** Update current user's profile — save locally and forward to runtime */
profileRoutes.put('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json<{
    gitName?: string;
    gitEmail?: string;
    githubToken?: string;
    assemblyaiApiKey?: string | null;
  }>();

  // Save server-side fields (git identity, github token)
  const profile = await ps.upsertProfile(userId, body);

  // Forward to runtime so it stores runtime-specific fields (assemblyaiApiKey, etc.)
  // Fire-and-forget — don't block the response on runtime availability
  const runnerUrl = await resolveRunnerUrl('/api/profile', {});
  if (runnerUrl) {
    fetch(`${runnerUrl}/api/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': userId,
        'X-Runner-Auth': process.env.RUNNER_AUTH_SECRET!,
      },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  return c.json({
    ...profile,
    hasAssemblyaiKey: body.assemblyaiApiKey !== undefined ? !!body.assemblyaiApiKey : false,
  });
});
