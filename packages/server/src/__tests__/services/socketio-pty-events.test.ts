/**
 * Verifies that socketio.ts registers all required PTY event handlers.
 *
 * This is a static analysis test — it reads the source file and checks
 * that the ptyEvents array includes every event the runtime expects to
 * receive from the browser. This catches regressions where a new PTY
 * event is handled by the runtime but never forwarded by the server.
 *
 * Background: the `pty:restore` event was missing from the ptyEvents
 * array, causing terminals to fail to restore after browser refresh.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SOCKETIO_PATH = resolve(import.meta.dir, '../../services/socketio.ts');

/**
 * All PTY events that the runtime (app.ts) handles in its
 * central:browser_ws switch. If the server doesn't forward
 * one of these, the runtime never receives it.
 */
const REQUIRED_PTY_EVENTS = [
  'pty:list',
  'pty:spawn',
  'pty:write',
  'pty:resize',
  'pty:close',
  'pty:kill',
  'pty:rename',
  'pty:reconnect',
  'pty:restore',
];

describe('socketio PTY event forwarding', () => {
  const source = readFileSync(SOCKETIO_PATH, 'utf-8');

  // Extract the ptyEvents array from the source code
  const ptyEventsMatch = source.match(/const ptyEvents\s*=\s*\[([\s\S]*?)\]/);
  const ptyEventsBlock = ptyEventsMatch?.[1] ?? '';

  // Parse the event names from the array literal
  const registeredEvents = [...ptyEventsBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  test('ptyEvents array is found in socketio.ts', () => {
    expect(ptyEventsMatch).not.toBeNull();
    expect(registeredEvents.length).toBeGreaterThan(0);
  });

  for (const event of REQUIRED_PTY_EVENTS) {
    test(`ptyEvents includes '${event}'`, () => {
      expect(registeredEvents).toContain(event);
    });
  }

  test('all required PTY events are registered', () => {
    const missing = REQUIRED_PTY_EVENTS.filter((e) => !registeredEvents.includes(e));
    expect(missing).toEqual([]);
  });
});
