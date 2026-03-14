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
import { resolveRunner } from '../services/runner-resolver.js';
import { tunnelFetch } from '../services/ws-tunnel.js';

export const profileRoutes = new Hono<ServerEnv>();

/** Proxy transcribe-token to the runtime (AssemblyAI logic lives there) */
profileRoutes.get('/transcribe-token', proxyToRunner);

/**
 * Fetch data from a runner — tunnel-first, fallback to direct HTTP.
 */
async function fetchFromRunner(
  runnerId: string,
  httpUrl: string | null,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; data: any }> {
  // For __default__ runnerId, always use direct HTTP
  if (runnerId === '__default__' && httpUrl) {
    try {
      const res = await fetch(`${httpUrl}${path}`, {
        method: opts.method,
        headers: opts.headers,
        body: opts.method !== 'GET' && opts.method !== 'HEAD' ? opts.body : undefined,
      });
      if (res.ok) return { ok: true, data: await res.json() };
    } catch {}
    return { ok: false, data: null };
  }

  try {
    const resp = await tunnelFetch(runnerId, {
      method: opts.method,
      path,
      headers: opts.headers,
      body: opts.body ?? null,
    });
    if (resp.status >= 200 && resp.status < 400 && resp.body) {
      return { ok: true, data: JSON.parse(resp.body) };
    }
  } catch {
    // Try direct HTTP fallback
    if (httpUrl) {
      try {
        const res = await fetch(`${httpUrl}${path}`, {
          method: opts.method,
          headers: opts.headers,
          body: opts.method !== 'GET' && opts.method !== 'HEAD' ? opts.body : undefined,
        });
        if (res.ok) return { ok: true, data: await res.json() };
      } catch {}
    }
  }
  return { ok: false, data: null };
}

/** Get current user's profile — merge server + runtime data */
profileRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const serverProfile = await ps.getProfile(userId);

  // Fetch runtime profile for runtime-specific fields (hasAssemblyaiKey, etc.)
  let runtimeProfile: Record<string, any> = {};
  const resolved = await resolveRunner('/api/profile', {});
  if (resolved) {
    const result = await fetchFromRunner(resolved.runnerId, resolved.httpUrl, '/api/profile', {
      method: 'GET',
      headers: {
        'X-Forwarded-User': userId,
        'X-Runner-Auth': process.env.RUNNER_AUTH_SECRET!,
      },
    });
    if (result.ok) runtimeProfile = result.data;
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
  const resolved = await resolveRunner('/api/profile', {});
  if (resolved) {
    fetchFromRunner(resolved.runnerId, resolved.httpUrl, '/api/profile', {
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
