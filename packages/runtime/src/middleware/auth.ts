/**
 * @domain subdomain: Authentication
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: AuthService, AuthMode
 */

import type { Context, Next } from 'hono';

import { getAuthMode } from '../lib/auth-mode.js';
import { log } from '../lib/logger.js';
import { validateToken } from '../services/auth-service.js';

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET;
const TEAM_SERVER_URL = process.env.TEAM_SERVER_URL;

// Cache validated sessions: cookie hash → { userId, role, orgId, expiresAt }
const sessionCache = new Map<
  string,
  { userId: string; role: string; orgId: string | null; expiresAt: number }
>();
const SESSION_CACHE_TTL = 60_000; // 1 minute

/** Paths that skip authentication entirely */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/mode', '/api/bootstrap']);

/**
 * Dual-mode authentication middleware.
 * - local mode: validates bearer token from file (existing behavior)
 * - multi mode: validates Better Auth session cookie + extracts org context
 * - team mode (proxied): trusts X-Forwarded-User from the central server
 */
export async function authMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  // Public endpoints — always allowed
  if (PUBLIC_PATHS.has(path)) return next();

  // Proxied requests from the central server carry X-Runner-Auth + X-Forwarded-User.
  // Check this regardless of isTeamModeActive() — the server may be proxying via
  // DEFAULT_RUNNER_URL before the runtime has formally registered.
  const runnerAuth = c.req.header('X-Runner-Auth');
  if (RUNNER_AUTH_SECRET && runnerAuth === RUNNER_AUTH_SECRET) {
    const forwardedUser = c.req.header('X-Forwarded-User');
    if (!forwardedUser) return c.json({ error: 'Unauthorized: missing X-Forwarded-User' }, 401);

    c.set('userId', forwardedUser);
    c.set('userRole', 'user');
    c.set('organizationId', c.req.header('X-Forwarded-Org') || null);
    return next();
  }

  // Direct browser→runtime requests in team mode: validate session cookie with the central server.
  // This allows the client to talk to the runtime directly without the server proxying.
  if (TEAM_SERVER_URL && c.req.header('Cookie')) {
    const cookie = c.req.header('Cookie')!;
    const cacheKey = cookie.slice(0, 128); // Use prefix as cache key

    // Check cache first
    const cached = sessionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      c.set('userId', cached.userId);
      c.set('userRole', cached.role);
      c.set('organizationId', cached.orgId);
      return next();
    }

    // Validate with the central server
    try {
      const res = await fetch(`${TEAM_SERVER_URL}/api/auth/get-session`, {
        headers: { Cookie: cookie },
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.user?.id) {
          const entry = {
            userId: data.user.id as string,
            role: (data.user.role as string) || 'user',
            orgId: (data.session?.activeOrganizationId as string) ?? null,
            expiresAt: Date.now() + SESSION_CACHE_TTL,
          };
          sessionCache.set(cacheKey, entry);
          c.set('userId', entry.userId);
          c.set('userRole', entry.role);
          c.set('organizationId', entry.orgId);
          return next();
        }
      }
    } catch (err) {
      log.warn('Failed to validate session with central server', {
        namespace: 'auth',
        error: String(err),
      });
    }
    // Fall through to other auth modes if session validation fails
  }

  if (getAuthMode() === 'local') {
    // Local mode: existing bearer token auth
    if (path.startsWith('/api/auth/')) return next();
    if (path === '/api/mcp/oauth/callback') return next();

    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.json({ error: 'Unauthorized' }, 401);

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return c.json({ error: 'Unauthorized' }, 401);
    if (!validateToken(parts[1])) return c.json({ error: 'Unauthorized' }, 401);

    c.set('userId', '__local__');
    c.set('userRole', 'admin');
    // No org context in local mode
    c.set('organizationId', null);
    return next();
  }

  // Multi mode: Better Auth session validation
  if (path.startsWith('/api/auth/')) return next(); // Better Auth handles its own routes
  if (path === '/api/mcp/oauth/callback') return next();

  const { auth } = await import('../lib/auth.js');
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  c.set('userId', session.user.id);
  c.set('userRole', (session.user as any).role || 'user');

  // Extract active organization from session (set by Better Auth org plugin)
  const activeOrgId = (session.session as any).activeOrganizationId ?? null;
  c.set('organizationId', activeOrgId);

  return next();
}

/**
 * Middleware that requires admin role.
 * In local mode, everyone is effectively admin.
 */
export async function requireAdmin(c: Context, next: Next) {
  if (getAuthMode() === 'local') return next();

  const role = c.get('userRole');
  if (role !== 'admin') {
    return c.json({ error: 'Forbidden: admin required' }, 403);
  }
  return next();
}

/**
 * Middleware factory that checks if the user has a specific permission
 * in their active organization. Skips in local mode.
 *
 * Usage: `app.post('/api/projects', requirePermission('project', 'create'), handler)`
 */
export function requirePermission(resource: string, action: string) {
  return async (c: Context, next: Next) => {
    if (getAuthMode() === 'local') return next();

    const orgId = c.get('organizationId');
    if (!orgId) {
      // No active org — allow if it's a user-scoped action
      return next();
    }

    const { auth } = await import('../lib/auth.js');
    try {
      const hasPermission = await auth.api.hasPermission({
        headers: c.req.raw.headers,
        body: {
          permission: {
            [resource]: [action],
          },
        },
      });

      if (!hasPermission) {
        return c.json({ error: `Forbidden: ${resource}:${action} permission required` }, 403);
      }
    } catch {
      // If permission check fails (e.g. org plugin not fully initialized), allow through
    }

    return next();
  };
}
