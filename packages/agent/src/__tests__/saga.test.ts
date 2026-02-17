import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Saga, type SagaLog } from '../core/saga.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tmp-saga');

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe('Saga', () => {
  it('executes all steps in order', async () => {
    const order: string[] = [];

    const saga = new Saga<{ order: string[] }>('test-saga', TEST_DIR);
    saga
      .addStep({
        name: 'step-1',
        action: async (ctx) => { ctx.order.push('action-1'); },
      })
      .addStep({
        name: 'step-2',
        action: async (ctx) => { ctx.order.push('action-2'); },
      })
      .addStep({
        name: 'step-3',
        action: async (ctx) => { ctx.order.push('action-3'); },
      });

    const ctx = { order };
    await saga.execute('req-001', ctx);

    expect(order).toEqual(['action-1', 'action-2', 'action-3']);
  });

  it('runs compensations in reverse on failure at step N', async () => {
    const order: string[] = [];

    const saga = new Saga<{ order: string[] }>('comp-saga', TEST_DIR);
    saga
      .addStep({
        name: 'step-1',
        action: async (ctx) => { ctx.order.push('action-1'); },
        compensate: async (ctx) => { ctx.order.push('comp-1'); },
      })
      .addStep({
        name: 'step-2',
        action: async (ctx) => { ctx.order.push('action-2'); },
        compensate: async (ctx) => { ctx.order.push('comp-2'); },
      })
      .addStep({
        name: 'step-3',
        action: async () => { throw new Error('step-3 failed'); },
        compensate: async (ctx) => { ctx.order.push('comp-3'); },
      });

    const ctx = { order };
    await expect(saga.execute('req-002', ctx)).rejects.toThrow('step-3 failed');

    // step-3 failed, so only step-1 and step-2 completed → compensate step-2, then step-1
    expect(order).toEqual(['action-1', 'action-2', 'comp-2', 'comp-1']);
  });

  it('catches and records compensation failures', async () => {
    const order: string[] = [];

    const saga = new Saga<{ order: string[] }>('comp-fail-saga', TEST_DIR);
    saga
      .addStep({
        name: 'step-1',
        action: async (ctx) => { ctx.order.push('action-1'); },
        compensate: async () => { throw new Error('comp-1 failed'); },
      })
      .addStep({
        name: 'step-2',
        action: async () => { throw new Error('step-2 failed'); },
      });

    const ctx = { order };
    await expect(saga.execute('req-003', ctx)).rejects.toThrow('step-2 failed');

    // step-1 compensation fails but saga still throws original error
    expect(order).toEqual(['action-1']);

    // Check log records the compensation failure
    const log = await saga.loadLog('req-003');
    expect(log).not.toBeNull();
    expect(log!.failed_at_step).toBe('step-2');
    expect(log!.compensations_run).toContain('step-1 (FAILED)');
  });

  it('persists saga log to disk', async () => {
    const saga = new Saga<{}>('persist-saga', TEST_DIR);
    saga.addStep({
      name: 'step-1',
      action: async () => {},
    });

    await saga.execute('req-004', {});

    const log = await saga.loadLog('req-004');
    expect(log).not.toBeNull();
    expect(log!.saga_name).toBe('persist-saga');
    expect(log!.request_id).toBe('req-004');
    expect(log!.steps_completed).toEqual(['step-1']);
    expect(log!.completed_at).toBeDefined();
    expect(log!.failed_at_step).toBeUndefined();
  });

  it('loadLog returns null for non-existent request', async () => {
    const saga = new Saga<{}>('no-log-saga', TEST_DIR);
    const log = await saga.loadLog('non-existent');
    expect(log).toBeNull();
  });

  it('steps without compensate are skipped during rollback', async () => {
    const order: string[] = [];

    const saga = new Saga<{ order: string[] }>('skip-comp-saga', TEST_DIR);
    saga
      .addStep({
        name: 'step-1',
        action: async (ctx) => { ctx.order.push('action-1'); },
        // No compensate
      })
      .addStep({
        name: 'step-2',
        action: async (ctx) => { ctx.order.push('action-2'); },
        compensate: async (ctx) => { ctx.order.push('comp-2'); },
      })
      .addStep({
        name: 'step-3',
        action: async () => { throw new Error('fail'); },
      });

    const ctx = { order };
    await expect(saga.execute('req-005', ctx)).rejects.toThrow('fail');

    // step-1 has no compensate → skipped, only step-2 compensated
    expect(order).toEqual(['action-1', 'action-2', 'comp-2']);
  });
});
