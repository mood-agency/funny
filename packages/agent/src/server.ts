/**
 * Bun server bootstrap for the Pipeline Service.
 */

import { app, runner, integrator, adapterManager, director, containerManager } from './index.js';

const port = parseInt(process.env.PORT ?? '3002', 10);

console.log(`[pipeline] Starting on port ${port}...`);

// Kill orphaned containers from previous runs (crash, closed terminal, etc.)
containerManager.killOrphans().then((count) => {
  if (count > 0) {
    console.log(`[pipeline] Cleaned up ${count} orphaned container(s) from a previous run`);
  }
}).catch((err) => {
  console.warn(`[pipeline] Failed to clean up orphaned containers: ${err.message}`);
});

// ── Graceful shutdown ────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // prevent double-shutdown
  shuttingDown = true;
  console.log(`[pipeline] Shutting down (${signal})...`);
  director.stopSchedule();
  adapterManager.stop();
  await Promise.allSettled([runner.stopAll(), integrator.stopAll(), containerManager.cleanupAll()]);
  console.log('[pipeline] Shutdown complete');
  process.exit(0);
}

// Unix signals (also work for Ctrl+C on Windows via Bun)
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Windows fallback — 'exit' fires when the process is about to exit.
// We can't do async work here, but we can at least log a warning.
// The real cleanup happens via killOrphans() on next startup.
process.on('exit', () => {
  if (!shuttingDown) {
    console.warn('[pipeline] Process exiting without graceful shutdown — containers may be orphaned. They will be cleaned up on next startup.');
  }
});

export default {
  port,
  fetch: app.fetch,
};
