/**
 * Static-analysis tests for socketio.ts — pin the runner-readiness
 * contract that backs the terminal restore flow.
 *
 * Regression context: the "black screen on refresh" bug was rooted in
 * three pieces of behavior that, if any one is removed, re-opens the
 * race window:
 *
 *   1. Browser sockets must receive the *current* `runner:status` on
 *      connect (so a refresh learns "online" before emitting `pty:list`).
 *   2. Runner connect must broadcast `runner:status: online` to the
 *      owning user's room.
 *   3. Runner disconnect must broadcast `runner:status: offline` only
 *      when the user has no remaining connected runners (gated by
 *      `userHasConnectedRunner`).
 *
 * On top of that, `pty:list` must be served as a deterministic ack-based
 * RPC with the four documented responses (`ok`, `no-runner`, `timeout`,
 * `error`) — a fire-and-forget regression here would re-introduce the
 * 15-second hung loading state.
 *
 * These checks are textual on purpose: a true integration test would
 * need to spin up the BunEngine + auth and a runner socket, which is
 * far heavier than the surface we want to protect.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SOCKETIO_PATH = resolve(import.meta.dir, '../../services/socketio.ts');
const source = readFileSync(SOCKETIO_PATH, 'utf-8');

describe('socketio runner-readiness channel', () => {
  test('browser connect emits current runner:status to the new socket', () => {
    // The newly connected socket must be told whether a runner is online
    // RIGHT NOW — otherwise a refresh after the runner is already up would
    // sit in `unknown` until something else nudges the channel.
    expect(source).toMatch(/socket\.emit\(\s*['"]runner:status['"]/);
    expect(source).toMatch(/userHasConnectedRunner\(\s*userId\s*\)/);
  });

  test('runner connect emits runner:status: online to the user room', () => {
    // The pattern relies on the `user:${runnerUserId}` room — the same
    // room the browser joined on connect. Anything else (broadcast, runner
    // room) would either leak across tenants or never reach the browser.
    expect(source).toMatch(
      /to\(\s*`user:\$\{runnerUserId\}`\s*\)\s*\.emit\(\s*['"]runner:status['"][\s\S]*?status:\s*['"]online['"]/,
    );
  });

  test('runner disconnect emits runner:status: offline gated on user index', () => {
    // The gate is what keeps the channel honest when a user has multiple
    // runners: a single disconnect must NOT flip the browser to "offline"
    // if other runners are still alive.
    expect(source).toMatch(
      /!wsRelay\.userHasConnectedRunner\(\s*runnerUserId\s*\)[\s\S]*?status:\s*['"]offline['"]/,
    );
  });
});

describe('socketio pty:list RPC contract', () => {
  test('exposes a dedicated ack-based handler', () => {
    expect(source).toMatch(/function setupBrowserPtyListRpc/);
    // The RPC handler must use an ack callback — not a fire-and-forget
    // `socket.emit('pty:sessions', ...)` like the previous design.
    expect(source).toMatch(/socket\.on\(\s*['"]pty:list['"]\s*,\s*async\s*\([^)]*ack[^)]*\)/);
  });

  test('responds with no-runner when the user has no connected runner', () => {
    // Three places can short-circuit to no-runner: no runner registered,
    // no socketId for that runner, runner socket vanished. All three must
    // ack with status:'no-runner' so the browser exits its loading state.
    const noRunnerHits = source.match(/status:\s*['"]no-runner['"]/g) ?? [];
    expect(noRunnerHits.length).toBeGreaterThanOrEqual(3);
  });

  test('forwards to runner with central:pty_list ack', () => {
    expect(source).toMatch(/emitWithAck\(\s*['"]central:pty_list['"]/);
    expect(source).toMatch(/status:\s*['"]ok['"][\s\S]*?sessions/);
  });

  test('produces a timeout response on runner ack timeout', () => {
    expect(source).toMatch(/runnerSocket[\s\S]*?\.timeout\(/);
    expect(source).toMatch(/status:\s*['"]timeout['"]/);
  });

  test('produces an error response on internal failure', () => {
    expect(source).toMatch(/status:\s*['"]error['"]/);
  });

  test('keeps pty:list OUT of the fire-and-forget forwarder', () => {
    // The ptyEvents array is the fire-and-forget forwarder. Including
    // `pty:list` there would re-create the original race condition —
    // the request would be relayed without correlation, and a missing
    // response (no runner / runner not yet up) would silently strand
    // the client just like before the RPC fix.
    const arrayMatch = source.match(/const ptyEvents\s*=\s*\[([\s\S]*?)\]/);
    expect(arrayMatch).not.toBeNull();
    const events = [...(arrayMatch?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(events).not.toContain('pty:list');
  });
});
