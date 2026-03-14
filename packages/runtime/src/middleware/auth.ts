/**
 * @domain subdomain: Authentication
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Runtime auth middleware.
 *
 * Two modes of operation:
 * 1. **Standalone** (runtime runs directly): validates Better Auth sessions or
 *    team-mode central server sessions.
 * 2. **Mounted by server** (in-process): trusts X-Forwarded-User headers set by
 *    the server's auth middleware. Use `createForwardedAuthMiddleware()`.
 */

import type { Context, Next } from 'hono';

import { log } from '../lib/logger.js';

/** Paths that skip authentication entirely */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/mode',
  '/api/bootstrap',
  '/api/setup/status',
]);

/**
 * Forwarded auth middleware — trusts X-Forwarded-User headers from the server.
 *
 * Used when the runtime is mounted in-process by the server. The server has
 * already validated the session (via Better Auth) and sets these headers:
 * - X-Forwarded-User: userId
 * - X-Forwarded-Role: userRole
 * - X-Forwarded-Org: organizationId
 */
export async function forwardedAuthMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PATHS.has(path)) return next();
  if (path.startsWith('/api/auth/')) return next();
  if (path === '/api/mcp/oauth/callback') return next();

  const userId = c.req.header('X-Forwarded-User');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  c.set('userId', userId);
  c.set('userRole', c.req.header('X-Forwarded-Role') || 'user');
  c.set('organizationId', c.req.header('X-Forwarded-Org') || null);
  return next();
}

// ── Standalone auth (used when runtime runs its own server) ──────

const TEAM_SERVER_URL = process.env.TEAM_SERVER_URL;

// Cache validated sessions: cookie hash → { userId, role, orgId, expiresAt }
const sessionCache = new Map<
  string,
  { userId: string; role: string; orgId: string | null; expiresAt: number }
>();
const SESSION_CACHE_TTL = 60_000; // 1 minute

/**
 * Standalone auth middleware — validates sessions directly.
 *
 * Priority:
 * 1. Team mode session validation (browser → runtime with central server cookie)
 * 2. Better Auth session (default for all browser requests)
 */
export async function authMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  if (PUBLIC_PATHS.has(path)) return next();

  // ── Team mode — validate with central server ───────────────────
  if (TEAM_SERVER_URL && c.req.header('Cookie')) {
    const cookie = c.req.header('Cookie')!;
    const cacheKey = cookie.slice(0, 128);

    const cached = sessionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      c.set('userId', cached.userId);
      c.set('userRole', cached.role);
      c.set('organizationId', cached.orgId);
      return next();
    }

    try {
      const forwardCookie = cookie.replace(/\bbetter-auth\./g, '__Secure-better-auth.');
      const res = await fetch(`${TEAM_SERVER_URL}/api/auth/get-session`, {
        headers: { Cookie: forwardCookie },
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
    // Fall through to local Better Auth
  }

  // ── Better Auth session ────────────────────────────────────────
  if (path.startsWith('/api/auth/')) return next();
  if (path === '/api/mcp/oauth/callback') return next();

  const { auth } = await import('../lib/auth.js');
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  c.set('userId', session.user.id);
  c.set('userRole', (session.user as any).role || 'user');
  c.set('organizationId', (session.session as any).activeOrganizationId ?? null);

  return next();
}

/**
 * Middleware that requires admin role.
 */
export async function requireAdmin(c: Context, next: Next) {
  const role = c.get('userRole');
  if (role !== 'admin') {
    return c.json({ error: 'Forbidden: admin required' }, 403);
  }
  return next();
}

/**
 * Middleware factory that checks if the user has a specific permission
 * in their active organization.
 */
export function requirePermission(resource: string, action: string) {
  return async (c: Context, next: Next) => {
    const orgId = c.get('organizationId');
    if (!orgId) return next();

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
      // If permission check fails, allow through
    }

    return next();
  };
}
