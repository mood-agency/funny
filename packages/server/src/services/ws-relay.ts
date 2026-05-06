/**
 * WebSocket relay for the central server.
 * Routes events between runners and browser clients.
 *
 * Now backed by Socket.IO rooms instead of manual Maps.
 * The runnerSockets map is kept as a lightweight index for quick lookups
 * (isRunnerConnected, getAnyConnectedRunnerId).
 */

import type { Server as SocketIOServer } from 'socket.io';

import { log } from '../lib/logger.js';

// ── Socket.IO reference ─────────────────────────────────
// Set by socketio.ts after initialization to avoid circular imports

let _io: SocketIOServer | null = null;

export function setIO(io: SocketIOServer): void {
  _io = io;
}

// ── Connection tracking (lightweight index) ──────────────

/** runnerId → {socketId, userId} (for quick lookups + per-user readiness) */
const runnerSockets = new Map<string, { socketId: string; userId: string | null }>();
/** userId → Set<runnerId> — reverse index for `userHasConnectedRunner`. */
const runnersByUser = new Map<string, Set<string>>();

function addToUserIndex(runnerId: string, userId: string | null): void {
  if (!userId) return;
  let set = runnersByUser.get(userId);
  if (!set) {
    set = new Set();
    runnersByUser.set(userId, set);
  }
  set.add(runnerId);
}

function removeFromUserIndex(runnerId: string, userId: string | null): void {
  if (!userId) return;
  const set = runnersByUser.get(userId);
  if (!set) return;
  set.delete(runnerId);
  if (set.size === 0) runnersByUser.delete(userId);
}

// ── Runner client management ────────────────────────────

/**
 * Register a runner's current socket, returning the socketId that was
 * previously registered (or null). The caller is expected to disconnect
 * the returned socket, which prevents the room from briefly holding two
 * sockets during a reconnect — the race that caused duplicate emits.
 *
 * `userId` is cached so we can answer `userHasConnectedRunner(userId)`
 * without a DB hit (used by the runner-readiness channel).
 */
export function addRunnerClient(
  runnerId: string,
  socketId: string,
  userId: string | null,
): string | null {
  const previous = runnerSockets.get(runnerId) ?? null;
  if (previous) removeFromUserIndex(runnerId, previous.userId);
  runnerSockets.set(runnerId, { socketId, userId });
  addToUserIndex(runnerId, userId);
  log.info('Runner connected', {
    namespace: 'ws-relay',
    runnerId,
    replaced: previous?.socketId ?? undefined,
  });
  return previous?.socketId ?? null;
}

/**
 * Remove a runner's socket. If `socketId` is provided we only clear the
 * entry when it still matches — so a stale socket's delayed disconnect
 * cannot unregister a freshly-connected replacement socket.
 */
export function removeRunnerClient(runnerId: string, socketId?: string): void {
  const current = runnerSockets.get(runnerId);
  if (!current) return;
  if (socketId !== undefined && current.socketId !== socketId) {
    log.info('Skipping stale runner disconnect — replaced by newer socket', {
      namespace: 'ws-relay',
      runnerId,
      disconnectingSocket: socketId,
      currentSocket: current.socketId,
    });
    return;
  }
  runnerSockets.delete(runnerId);
  removeFromUserIndex(runnerId, current.userId);
  log.info('Runner disconnected', { namespace: 'ws-relay', runnerId });
}

/** Check if a runner is connected via Socket.IO. */
export function isRunnerConnected(runnerId: string): boolean {
  return runnerSockets.has(runnerId);
}

/** Return the currently-registered socketId for a runner, or null. */
export function getRunnerSocketId(runnerId: string): string | null {
  return runnerSockets.get(runnerId)?.socketId ?? null;
}

/**
 * True when the given user has at least one connected runner.
 * O(1) lookup — backs the `runner:status` readiness channel without a DB hit.
 */
export function userHasConnectedRunner(userId: string): boolean {
  const set = runnersByUser.get(userId);
  return !!set && set.size > 0;
}

// ── Event relay ─────────────────────────────────────────

/**
 * Relay an event from a runner to all browser clients of a specific user.
 * Uses Socket.IO rooms for delivery.
 */
export function relayToUser(userId: string, event: Record<string, unknown>): void {
  if (!_io) return;
  const eventType = (event.type as string) || 'event';
  _io.of('/').to(`user:${userId}`).emit(eventType, event);
}

/**
 * Relay an event to all browser clients (broadcast).
 */
export function broadcast(event: Record<string, unknown>): void {
  if (!_io) return;
  const eventType = (event.type as string) || 'event';
  _io.of('/').emit(eventType, event);
}

/**
 * Send a command to a specific runner via Socket.IO.
 *
 * Emits to the current registered socketId rather than the runner's room.
 * During a reconnect window both the old and new sockets may briefly live
 * in the same room; addressing a specific socketId keeps us delivering to
 * exactly one endpoint (the most recent one) and avoids duplicate emits.
 */
export function sendToRunner(runnerId: string, command: Record<string, unknown>): boolean {
  if (!_io) return false;
  const entry = runnerSockets.get(runnerId);
  if (!entry) return false;
  const eventType = (command.type as string) || 'command';
  _io.of('/runner').to(entry.socketId).emit(eventType, command);
  return true;
}

/**
 * Forward a browser WS message to a runner for local handling.
 * Used for PTY commands and other browser → runner real-time messages.
 */
export function forwardBrowserMessageToRunner(
  runnerId: string,
  userId: string,
  organizationId: string | undefined,
  data: unknown,
): boolean {
  return sendToRunner(runnerId, {
    type: 'central:browser_ws',
    userId,
    organizationId,
    data,
  });
}

/**
 * Get the ID of any connected runner.
 * Used as a fallback when no project/thread context is available.
 */
export function getAnyConnectedRunnerId(): string | null {
  const first = runnerSockets.keys().next();
  return first.done ? null : first.value;
}

/**
 * Get all connected browser user IDs.
 * Uses Socket.IO rooms to find user rooms.
 */
export function getConnectedBrowserUserIds(): string[] {
  if (!_io) return [];
  const rooms = _io.of('/').adapter.rooms;
  const userIds: string[] = [];
  for (const [room] of rooms) {
    if (room.startsWith('user:')) userIds.push(room.slice(5));
  }
  return userIds;
}

/**
 * Get stats about connected clients.
 */
export function getRelayStats(): {
  browserClients: number;
  browserUsers: number;
  runners: number;
} {
  let browserClients = 0;
  let browserUsers = 0;
  if (_io) {
    browserClients = _io.of('/').sockets.size;
    const rooms = _io.of('/').adapter.rooms;
    for (const [room] of rooms) {
      if (room.startsWith('user:')) browserUsers++;
    }
  }
  return {
    browserClients,
    browserUsers,
    runners: runnerSockets.size,
  };
}
