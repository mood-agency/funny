import type { WSEvent } from '@funny/shared';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../lib/telemetry.js', () => ({
  metric: vi.fn(),
}));

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';

/**
 * We cannot easily reset the singleton exported by ws-broker.ts, so we
 * import the module and grab the class constructor to create fresh instances
 * for each test.  The module also exports `wsBroker` (singleton) but we
 * avoid it here so tests are isolated.
 *
 * Because the file only exports the singleton and the class is not directly
 * exported, we re-import via the module and construct new instances by
 * reaching into the prototype.  A simpler approach: just import the singleton
 * and call removeClient for cleanup.  However, to keep tests truly isolated
 * we dynamically import a fresh module each time.
 */

/** Helper: create a mock ServerWebSocket */
function makeMockWs(overrides: Record<string, any> = {}) {
  return {
    send: vi.fn(),
    ping: vi.fn(),
    ...overrides,
  } as any;
}

/** Helper: create a minimal WSEvent */
function makeEvent(type = 'agent:message', threadId = 'thread-1'): WSEvent {
  return { type, threadId } as any;
}

/** Helper: create a string of a given byte size (ASCII so 1 char = 1 byte) */
function makePayloadEvent(byteSize: number): WSEvent {
  // We will rely on JSON.stringify(event) to produce the payload.
  // The overhead of JSON.stringify({ type: '...', threadId: '...', data: '...' }) is ~40 bytes.
  // We pad `data` to reach the target size.
  const overhead = Buffer.byteLength(
    JSON.stringify({ type: 'agent:message', threadId: 't', data: '' }),
    'utf8',
  );
  const padding = 'x'.repeat(Math.max(0, byteSize - overhead));
  return { type: 'agent:message', threadId: 't', data: padding } as any;
}

describe('WSBroker', () => {
  let broker: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Dynamic import to get a fresh module (and fresh singleton) each time
    const mod = await import('../../services/ws-broker.js');
    broker = mod.wsBroker;
  });

  afterEach(() => {
    // Clean up any lingering ping timers
    broker.stopPing();
    // Remove all clients so the singleton is clean for next test
    for (const ws of Array.from((broker as any).clients.keys())) {
      broker.removeClient(ws);
    }
    vi.useRealTimers();
  });

  // ───────────────────────── Payload Size Guard ─────────────────────────

  describe('payload size guard', () => {
    test('payloads under 1 MB are sent normally without warnings', () => {
      const ws = makeMockWs();
      broker.addClient(ws, 'user-1');
      vi.clearAllMocks(); // clear addClient logs

      const event = makePayloadEvent(500_000); // ~500 KB
      broker.emitToUser('user-1', event);

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
    });

    test('payloads over 1 MB but under 10 MB log a warning and still send', () => {
      const ws = makeMockWs();
      broker.addClient(ws, 'user-1');
      vi.clearAllMocks();

      const event = makePayloadEvent(2_000_000); // ~2 MB
      broker.emitToUser('user-1', event);

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        'Large WS payload',
        expect.objectContaining({ namespace: 'ws' }),
      );
    });

    test('payloads over 10 MB are dropped and not sent', () => {
      const ws = makeMockWs();
      broker.addClient(ws, 'user-1');
      vi.clearAllMocks();

      const event = makePayloadEvent(11_000_000); // ~11 MB
      broker.emitToUser('user-1', event);

      expect(ws.send).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        'Dropping oversized WS payload',
        expect.objectContaining({ namespace: 'ws' }),
      );
      expect(metric).toHaveBeenCalledWith(
        'ws.payload_dropped',
        1,
        expect.objectContaining({ type: 'sum' }),
      );
    });
  });

  // ───────────────────────── Ping / Pong Heartbeat ─────────────────────

  describe('ping/pong heartbeat', () => {
    test('startPing starts the interval and stopPing clears it', () => {
      broker.startPing();
      expect((broker as any).pingTimer).not.toBeNull();

      broker.stopPing();
      expect((broker as any).pingTimer).toBeNull();
    });

    test('startPing is idempotent — calling twice does not create a second timer', () => {
      broker.startPing();
      const timer1 = (broker as any).pingTimer;
      broker.startPing();
      const timer2 = (broker as any).pingTimer;
      expect(timer1).toBe(timer2);
    });

    test('handlePong resets missed pong count to 0', () => {
      const ws = makeMockWs();
      broker.addClient(ws, 'user-1');

      // Advance so one ping fires, incrementing missedPongs to 1
      vi.advanceTimersByTime(30_000);
      expect((broker as any).missedPongs.get(ws)).toBe(1);

      // handlePong should reset it
      broker.handlePong(ws);
      expect((broker as any).missedPongs.get(ws)).toBe(0);
    });

    test('after MAX_MISSED_PONGS (2) missed pongs, client is removed', () => {
      const ws = makeMockWs();
      broker.addClient(ws, 'user-1');
      expect(broker.clientCount).toBe(1);

      // First ping interval — missedPongs becomes 1
      vi.advanceTimersByTime(30_000);
      expect(broker.clientCount).toBe(1);

      // Second ping interval — missedPongs becomes 2, which equals MAX_MISSED_PONGS
      // At start of third tick the check will see missed >= 2 and remove
      vi.advanceTimersByTime(30_000);
      expect(broker.clientCount).toBe(1); // not yet removed, just incremented to 2

      // Third ping interval — sees missed (2) >= MAX_MISSED_PONGS (2), removes client
      vi.advanceTimersByTime(30_000);
      expect(broker.clientCount).toBe(0);
      expect(log.info).toHaveBeenCalledWith(
        'Removing dead client (missed pongs)',
        expect.objectContaining({ namespace: 'ws' }),
      );
    });

    test('ping auto-starts when first client connects', () => {
      expect((broker as any).pingTimer).toBeNull();

      const ws = makeMockWs();
      broker.addClient(ws, 'user-1');
      expect((broker as any).pingTimer).not.toBeNull();
    });

    test('ping auto-stops when last client disconnects', () => {
      const ws1 = makeMockWs();
      const ws2 = makeMockWs();
      broker.addClient(ws1, 'user-1');
      broker.addClient(ws2, 'user-2');
      expect((broker as any).pingTimer).not.toBeNull();

      broker.removeClient(ws1);
      // Still one client, ping should continue
      expect((broker as any).pingTimer).not.toBeNull();

      broker.removeClient(ws2);
      // No clients left, ping should stop
      expect((broker as any).pingTimer).toBeNull();
    });
  });

  // ───────────────────── Basic Client Management ───────────────────────

  describe('basic client management', () => {
    test('starts with 0 clients', () => {
      expect(broker.clientCount).toBe(0);
    });

    test('addClient / removeClient work correctly', () => {
      const ws1 = makeMockWs();
      const ws2 = makeMockWs();

      broker.addClient(ws1, 'user-1');
      expect(broker.clientCount).toBe(1);

      broker.addClient(ws2, 'user-2');
      expect(broker.clientCount).toBe(2);

      broker.removeClient(ws1);
      expect(broker.clientCount).toBe(1);

      broker.removeClient(ws2);
      expect(broker.clientCount).toBe(0);
    });

    test('removeClient on non-existent client is a no-op', () => {
      const ws = makeMockWs();
      broker.removeClient(ws);
      expect(broker.clientCount).toBe(0);
    });

    test('emitToUser sends only to matching userId', () => {
      const ws1 = makeMockWs();
      const ws2 = makeMockWs();
      broker.addClient(ws1, 'user-A');
      broker.addClient(ws2, 'user-B');

      const event = makeEvent('agent:message', 'thread-1');
      broker.emitToUser('user-A', event);

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();

      const parsed = JSON.parse(ws1.send.mock.calls[0][0]);
      expect(parsed).toEqual(event);
    });

    test('emitToOrg sends only to matching orgId', () => {
      const ws1 = makeMockWs();
      const ws2 = makeMockWs();
      const ws3 = makeMockWs();
      broker.addClient(ws1, 'user-1', 'org-X');
      broker.addClient(ws2, 'user-2', 'org-Y');
      broker.addClient(ws3, 'user-3', 'org-X');

      const event = makeEvent('agent:status', 'thread-2');
      broker.emitToOrg('org-X', event);

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();
      expect(ws3.send).toHaveBeenCalledTimes(1);
    });

    test('dead clients (ws.send throws) are removed automatically', () => {
      const goodWs = makeMockWs();
      const deadWs = makeMockWs({
        send: vi.fn(() => {
          throw new Error('connection closed');
        }),
      });

      broker.addClient(goodWs, 'user-1');
      broker.addClient(deadWs, 'user-1');
      expect(broker.clientCount).toBe(2);

      broker.emitToUser('user-1', makeEvent());

      expect(broker.clientCount).toBe(1);
      expect(goodWs.send).toHaveBeenCalledTimes(1);
    });

    test('emit broadcasts to all connected clients', () => {
      const ws1 = makeMockWs();
      const ws2 = makeMockWs();
      broker.addClient(ws1, 'user-1');
      broker.addClient(ws2, 'user-2');

      const event = makeEvent('agent:result', 'thread-3');
      broker.emit(event);

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });
  });
});
