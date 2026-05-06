/**
 * Tests for ws-relay.ts — the in-memory runner index that backs the
 * `runner:status` readiness channel.
 *
 * Regression context: the original "black-screen-on-refresh" terminal bug
 * was rooted in clients dispatching `pty:list` before the runner had
 * reconnected. The fix introduced a per-user runner index so the server
 * can answer `userHasConnectedRunner(userId)` in O(1) and emit a
 * deterministic `runner:status` event. These tests pin that contract.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  addRunnerClient,
  removeRunnerClient,
  isRunnerConnected,
  getRunnerSocketId,
  userHasConnectedRunner,
} from '../../services/ws-relay.js';

/**
 * Reset the in-memory maps between tests by removing any runners that
 * leaked from previous cases. We don't export the maps directly (and
 * shouldn't), so we rely on the module-level state being a clean slate
 * once we remove every runnerId we registered in the test.
 */
const TEST_RUNNERS = ['r1', 'r2', 'r3', 'r4'];

beforeEach(() => {
  for (const runnerId of TEST_RUNNERS) {
    removeRunnerClient(runnerId);
  }
});

describe('ws-relay runner index', () => {
  test('addRunnerClient registers the runner and its socket', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    expect(isRunnerConnected('r1')).toBe(true);
    expect(getRunnerSocketId('r1')).toBe('sock-1');
  });

  test('addRunnerClient returns the previously-registered socketId', () => {
    expect(addRunnerClient('r1', 'sock-1', 'user-A')).toBeNull();
    expect(addRunnerClient('r1', 'sock-2', 'user-A')).toBe('sock-1');
    expect(getRunnerSocketId('r1')).toBe('sock-2');
  });

  test('removeRunnerClient clears the socket entry', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    removeRunnerClient('r1');
    expect(isRunnerConnected('r1')).toBe(false);
    expect(getRunnerSocketId('r1')).toBeNull();
  });

  test('removeRunnerClient with stale socketId is a no-op', () => {
    // Reproduces the reconnect race: the OLD socket's disconnect arrives
    // AFTER a NEW socket has already taken the map slot. Without the
    // socketId guard, the stale disconnect would unregister the live runner.
    addRunnerClient('r1', 'sock-1', 'user-A');
    addRunnerClient('r1', 'sock-2', 'user-A');
    removeRunnerClient('r1', 'sock-1'); // stale
    expect(isRunnerConnected('r1')).toBe(true);
    expect(getRunnerSocketId('r1')).toBe('sock-2');
  });

  test('removeRunnerClient with matching socketId clears the entry', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    removeRunnerClient('r1', 'sock-1');
    expect(isRunnerConnected('r1')).toBe(false);
  });
});

describe('ws-relay userHasConnectedRunner (readiness signal)', () => {
  test('returns false for unknown user', () => {
    expect(userHasConnectedRunner('user-A')).toBe(false);
  });

  test('returns true while a runner is registered for the user', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    expect(userHasConnectedRunner('user-A')).toBe(true);
  });

  test('returns false after the only runner is removed', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    removeRunnerClient('r1');
    expect(userHasConnectedRunner('user-A')).toBe(false);
  });

  test('stays true when one of multiple runners disconnects', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    addRunnerClient('r2', 'sock-2', 'user-A');
    removeRunnerClient('r1');
    expect(userHasConnectedRunner('user-A')).toBe(true);
    removeRunnerClient('r2');
    expect(userHasConnectedRunner('user-A')).toBe(false);
  });

  test('isolates users from each other', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    addRunnerClient('r2', 'sock-2', 'user-B');
    expect(userHasConnectedRunner('user-A')).toBe(true);
    expect(userHasConnectedRunner('user-B')).toBe(true);
    removeRunnerClient('r1');
    expect(userHasConnectedRunner('user-A')).toBe(false);
    expect(userHasConnectedRunner('user-B')).toBe(true);
  });

  test('ignores runners without an owning userId (legacy/null)', () => {
    addRunnerClient('r1', 'sock-1', null);
    expect(userHasConnectedRunner('user-A')).toBe(false);
  });

  test('re-registering with a new userId migrates the index', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    expect(userHasConnectedRunner('user-A')).toBe(true);
    // A reconnect under a different owner shouldn't leave stale entries
    // pointing to user-A — the readiness signal would lie otherwise.
    addRunnerClient('r1', 'sock-2', 'user-B');
    expect(userHasConnectedRunner('user-A')).toBe(false);
    expect(userHasConnectedRunner('user-B')).toBe(true);
  });

  test('stale-socket disconnect does not flip readiness off', () => {
    // The bug we want to prevent: a delayed disconnect from the OLD
    // socket clears the userId index even though a NEW socket is live.
    // Without proper guarding, the user's browser would briefly see
    // `runner:status: offline` and the terminal panel would fall back
    // to "awaiting runner" — exactly the kind of UX regression that
    // re-introduces the black-screen behavior we just fixed.
    addRunnerClient('r1', 'sock-1', 'user-A');
    addRunnerClient('r1', 'sock-2', 'user-A');
    removeRunnerClient('r1', 'sock-1'); // stale
    expect(userHasConnectedRunner('user-A')).toBe(true);
  });
});
