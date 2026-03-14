/**
 * Universal server entry point.
 *
 * Standalone mode (default): mounts runtime in-process (Client → Server → Runtime, same process).
 * Team mode (TEAM_SERVER_URL set): acts as coordination server, proxies to remote runners.
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { ServerEnv } from './lib/types.js';

/** Data attached to each WebSocket connection. */
type WSData = {
  type: 'browser' | 'runner';
  req?: Request;
  userId?: string;
  runnerId?: string;
  organizationId?: string | null;
  isTranscribe?: boolean;
};

import { log } from './lib/logger.js';
import { authMiddleware, setAuthInstance } from './middleware/auth.js';

const isTeamMode = !!process.env.TEAM_SERVER_URL;
const isStandalone = !isTeamMode;

// ── Init ────────────────────────────────────────────────

let runtimeApp: Awaited<
  ReturnType<typeof import('@ironmussa/funny-runtime/app').createRuntimeApp>
> | null = null;

// Auth instance — populated during init, used by middleware and route handlers.
// Uses `any` because the runtime and server auth instances have slightly different types
// (different access control statements, different plugin configurations).
let authInstance: any;

if (isStandalone) {
  // ── Standalone: mount runtime in-process ─────────────────
  if (!process.env.RUNNER_AUTH_SECRET) {
    const crypto = await import('crypto');
    process.env.RUNNER_AUTH_SECRET = crypto.randomUUID();
  }

  const { createRuntimeApp } = await import('@ironmussa/funny-runtime/app');
  runtimeApp = await createRuntimeApp({
    skipStaticServing: true, // Server handles static files
    skipAuthSetup: true, // Server handles all auth (Better Auth)
  });
  await runtimeApp.init();

  // Initialize Better Auth using the runtime's auth module (supports both SQLite and PG)
  const runtimeAuth = await import('@ironmussa/funny-runtime/lib/auth');
  await runtimeAuth.initBetterAuth();
  authInstance = runtimeAuth.auth;
  setAuthInstance(authInstance);

  log.info('Runtime mounted in-process (standalone mode)', { namespace: 'server' });
} else {
  // ── Team mode: initialize central server DB ─────────────
  if (!process.env.RUNNER_AUTH_SECRET) {
    log.error('RUNNER_AUTH_SECRET is required. Set it in your .env file.', { namespace: 'server' });
    process.exit(1);
  }

  const { initDatabase } = await import('./db/index.js');
  const { autoMigrate } = await import('./db/migrate.js');
  const { initBetterAuth, auth } = await import('./lib/auth.js');

  await initDatabase();
  await autoMigrate();
  await initBetterAuth();
  authInstance = auth;
  setAuthInstance(authInstance);
}

// ── App ─────────────────────────────────────────────────

const app = new Hono<ServerEnv>();

// Middleware
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

app.use('*', cors({ origin: corsOrigins, credentials: true }));
app.use('*', logger());

// Health check (before auth)
app.get('/api/health', (c) => {
  if (isStandalone) {
    return c.json({ status: 'ok', mode: 'standalone', timestamp: new Date().toISOString() });
  }
  const wsRelay = require('./services/ws-relay.js') as typeof import('./services/ws-relay.js');
  const stats = wsRelay.getRelayStats();
  return c.json({ status: 'ok', service: 'funny-server', mode: 'team', ...stats });
});

// Bootstrap endpoint (public — minimal, no token)
app.get('/api/bootstrap', (c) => {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  return c.json({});
});

if (isStandalone) {
  // ── Standalone routes ─────────────────────────────────────
  // Better Auth routes (server handles auth for both modes)
  app.on(['POST', 'GET'], '/api/auth/*', (c) => authInstance.handler(c.req.raw));

  // Auth middleware for standalone mode
  app.use('/api/*', authMiddleware);

  // Forward to runtime with user identity headers
  if (runtimeApp) {
    app.all('*', async (c) => {
      const userId = c.get('userId') || '';
      const userRole = c.get('userRole') || 'user';
      const orgId = c.get('organizationId') || '';

      // Create a new request with forwarded user headers
      const headers = new Headers(c.req.raw.headers);
      headers.set('X-Forwarded-User', userId);
      headers.set('X-Forwarded-Role', userRole);
      if (orgId) headers.set('X-Forwarded-Org', orgId);

      const forwardedReq = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers,
        body: c.req.raw.body,
        // @ts-expect-error -- Bun supports duplex
        duplex: c.req.raw.body ? 'half' : undefined,
      });

      return runtimeApp.app.fetch(forwardedReq);
    });
  }
} else {
  // ── Team mode routes ──────────────────────────────────────
  const { inviteLinkPublicRoutes, inviteLinkRoutes } = await import('./routes/invite-links.js');
  const { authRoutes } = await import('./routes/auth.js');
  const { projectRoutes } = await import('./routes/projects.js');
  const { runnerRoutes } = await import('./routes/runners.js');
  const { profileRoutes } = await import('./routes/profile.js');
  const { threadRoutes } = await import('./routes/threads.js');
  const { proxyToRunner } = await import('./middleware/proxy.js');

  // Public invite-link routes (before auth middleware)
  app.route('/api/invite-links', inviteLinkPublicRoutes);

  // Better Auth routes
  app.on(['POST', 'GET'], '/api/auth/*', (c) => authInstance.handler(c.req.raw));

  app.use('*', authMiddleware);

  // Server-managed routes
  app.route('/api/auth', authRoutes);
  app.route('/api/projects', projectRoutes);
  app.route('/api/runners', runnerRoutes);
  app.route('/api/profile', profileRoutes);
  app.route('/api/threads', threadRoutes);
  app.route('/api/invite-links', inviteLinkRoutes);

  // Setup status — central server doesn't run agents locally
  app.get('/api/setup/status', (c) => {
    return c.json({
      providers: {},
      claudeCli: { available: true, path: null, error: null, version: null },
      agentSdk: { available: true },
    });
  });

  // Proxy catch-all: forward everything else to the appropriate runner
  app.all('/api/*', proxyToRunner);
}

// Serve static files from client build (only if dist exists)
const clientDistDir = resolve(import.meta.dir, '..', '..', 'client', 'dist');

if (existsSync(clientDistDir)) {
  app.use('/*', serveStatic({ root: clientDistDir }));
  app.get('*', async (c) => {
    return c.html(await Bun.file(join(clientDistDir, 'index.html')).text());
  });
  log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
}

// ── Server ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || (isStandalone ? '3001' : '3002'), 10);
const HOST = process.env.HOST || (isStandalone ? '127.0.0.1' : '0.0.0.0');

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  reusePort: true,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (isStandalone && runtimeApp) {
      // Standalone: handle WS with runtime's auth + handlers
      if (url.pathname === '/ws' || url.pathname === '/ws/transcribe') {
        const wsData = await runtimeApp.authenticateWs(req);
        if (!wsData) return new Response('Unauthorized', { status: 401 });
        if (server.upgrade(req, { data: { type: 'browser', ...wsData } as any })) return;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
    } else {
      // Team mode: handle WS for browsers and runners
      if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(req, {
          data: { type: 'browser', req } as any,
        });
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
      }

      if (url.pathname === '/ws/runner' && req.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(req, {
          data: { type: 'runner' } as any,
        });
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
      }
    }

    return app.fetch(req, { IP: server.requestIP(req) });
  },
  websocket: {
    async open(ws) {
      const wsData = ws.data as unknown as WSData;

      if (isStandalone && runtimeApp) {
        // Standalone: delegate to runtime WS handler
        runtimeApp.websocket.open(ws);
        return;
      }

      // Team mode
      if (wsData.type === 'browser' && wsData.req) {
        const session = await authInstance.api.getSession({ headers: wsData.req.headers });
        if (!session) {
          ws.close(4001, 'Unauthorized');
          return;
        }
        (ws.data as any).userId = session.user.id;
        const wsRelay = await import('./services/ws-relay.js');
        wsRelay.addBrowserClient(session.user.id, ws);
      }
    },

    async message(ws, message) {
      const wsData = ws.data as unknown as WSData;

      if (isStandalone && runtimeApp) {
        await runtimeApp.websocket.message(ws, message);
        return;
      }

      // Team mode relay logic
      try {
        const data = JSON.parse(typeof message === 'string' ? message : message.toString());
        const rm = await import('./services/runner-manager.js');
        const wsRelay = await import('./services/ws-relay.js');
        const threadRegistry = await import('./services/thread-registry.js');

        if (wsData.type === 'runner') {
          if (data.type === 'runner:auth' && data.token) {
            const runnerId = await rm.authenticateRunner(data.token);
            if (runnerId) {
              (ws.data as any).runnerId = runnerId;
              wsRelay.addRunnerClient(runnerId, ws);
              ws.send(JSON.stringify({ type: 'runner:auth_ok', runnerId }));
            } else {
              ws.close(4001, 'Invalid runner token');
            }
            return;
          }

          if (data.type === 'runner:agent_event') {
            if (!data.userId) return;
            wsRelay.relayToUser(data.userId, data.event);

            if (data.event?.type === 'agent:status' && data.event?.threadId) {
              threadRegistry
                .updateThreadStatus(data.event.threadId, data.event.data?.status || 'running')
                .catch(() => {});
            }
            if (data.event?.type === 'agent:result' && data.event?.threadId) {
              threadRegistry.updateThreadStatus(data.event.threadId, 'completed').catch(() => {});
            }
          }

          if (data.type === 'runner:browser_relay' && data.userId) {
            wsRelay.relayToUser(data.userId, data.data);
          }

          if (data.type === 'tunnel:response' && data.requestId) {
            const wsTunnel = await import('./services/ws-tunnel.js');
            wsTunnel.handleTunnelResponse(data);
          }
        }

        if (wsData.type === 'browser' && (wsData as any).userId) {
          const userId = (wsData as any).userId as string;
          const innerType = data.type as string;
          if (innerType?.startsWith('pty:')) {
            const projectId = data.data?.projectId;
            if (projectId) {
              rm.findRunnerForProject(projectId)
                .then((result) => {
                  if (result) {
                    wsRelay.forwardBrowserMessageToRunner(
                      result.runner.runnerId,
                      userId,
                      undefined,
                      data,
                    );
                  }
                })
                .catch(() => {});
            } else {
              const runnerId = wsRelay.getAnyConnectedRunnerId();
              if (runnerId) {
                wsRelay.forwardBrowserMessageToRunner(runnerId, userId, undefined, data);
              }
            }
          }
        }
      } catch {
        // Invalid JSON — ignore
      }
    },

    close(ws) {
      const d = ws.data as any;

      if (isStandalone && runtimeApp) {
        runtimeApp.websocket.close(ws);
        return;
      }

      if (d.type === 'browser' && d.userId) {
        import('./services/ws-relay.js').then((wsRelay) => {
          wsRelay.removeBrowserClient(d.userId, ws);
        });
      }
      if (d.type === 'runner' && d.runnerId) {
        import('./services/ws-relay.js').then((wsRelay) => {
          wsRelay.removeRunnerClient(d.runnerId);
        });
        import('./services/ws-tunnel.js').then((wsTunnel) => {
          wsTunnel.cancelPendingRequests(d.runnerId);
        });
      }
    },
  },
});

log.info(
  `funny-server running on http://${HOST}:${PORT} (${isStandalone ? 'standalone' : 'team'} mode)`,
  {
    namespace: 'server',
  },
);

export { app, server };
