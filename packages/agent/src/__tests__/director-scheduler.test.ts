import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Director } from '../core/director.js';
import type { ManifestManager } from '../core/manifest-manager.js';
import type { Integrator } from '../core/integrator.js';
import type { EventBus } from '../infrastructure/event-bus.js';

// ── Mocks ───────────────────────────────────────────────────────

function createMockManifestManager(): ManifestManager {
  return {
    read: mock(() => Promise.resolve({
      ready: [],
      pending_merge: [],
      merge_history: [],
      main_head: '',
    })),
    updateMainHead: mock(() => Promise.resolve()),
  } as unknown as ManifestManager;
}

function createMockIntegrator(): Integrator {
  return {} as unknown as Integrator;
}

function createMockEventBus(): EventBus {
  return {
    publish: mock(() => Promise.resolve()),
    on: mock(),
    off: mock(),
    emit: mock(),
  } as unknown as EventBus;
}

// ── Tests ───────────────────────────────────────────────────────

describe('Director scheduler', () => {
  let director: Director;
  let mm: ManifestManager;
  let eb: EventBus;

  beforeEach(() => {
    mm = createMockManifestManager();
    const integrator = createMockIntegrator();
    eb = createMockEventBus();
    director = new Director(mm, integrator, eb, '/tmp/test');
  });

  afterEach(() => {
    director.stopSchedule();
  });

  it('startSchedule with 0 does nothing', () => {
    director.startSchedule(0);
    // Should not throw or create a timer
  });

  it('startSchedule with negative value does nothing', () => {
    director.startSchedule(-1);
    // Should not throw
  });

  it('stopSchedule is safe to call without prior start', () => {
    director.stopSchedule();
    // Should not throw
  });

  it('scheduled cycle runs automatically', async () => {
    // Start with a very short interval
    director.startSchedule(50);

    // Wait for at least one cycle to fire
    await new Promise((r) => setTimeout(r, 150));

    director.stopSchedule();

    // Verify runCycle was triggered (read manifest + emit events)
    expect((mm.read as any).mock.calls.length).toBeGreaterThan(0);
  });

  it('scheduled cycle skips if already running', async () => {
    // Simulate a long-running cycle by making read() wait
    let readCallCount = 0;
    (mm.read as any).mockImplementation(() => {
      readCallCount++;
      if (readCallCount === 1) {
        // First call blocks for a while
        return new Promise((resolve) =>
          setTimeout(() => resolve({
            ready: [],
            pending_merge: [],
            merge_history: [],
            main_head: '',
          }), 200),
        );
      }
      return Promise.resolve({
        ready: [],
        pending_merge: [],
        merge_history: [],
        main_head: '',
      });
    });

    // Trigger first cycle manually (will block)
    const cyclePromise = director.runCycle('manual');

    // Start scheduler — should skip because cycle is running
    director.startSchedule(50);
    await new Promise((r) => setTimeout(r, 100));

    // The scheduled cycle should have been skipped
    // Only the manual cycle should have called read
    expect(readCallCount).toBe(1);

    await cyclePromise;
    director.stopSchedule();
  });

  it('runCycle accepts "scheduled" trigger', async () => {
    await director.runCycle('scheduled');

    // Should have published director.activated with trigger='scheduled'
    const publishCalls = (eb.publish as any).mock.calls;
    const activatedEvent = publishCalls.find(
      (call: any[]) => call[0]?.event_type === 'director.activated',
    );
    expect(activatedEvent).toBeDefined();
    expect(activatedEvent![0].data.trigger).toBe('scheduled');
  });
});
