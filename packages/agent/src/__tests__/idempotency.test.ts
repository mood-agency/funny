import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { IdempotencyGuard } from '../infrastructure/idempotency.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tmp-idempotency');

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

describe('IdempotencyGuard', () => {
  it('first check returns not duplicate', () => {
    const guard = new IdempotencyGuard(TEST_DIR);
    const result = guard.check('feature/login');
    expect(result.isDuplicate).toBe(false);
    expect(result.existingRequestId).toBeUndefined();
  });

  it('after register, check returns duplicate with correct request_id', () => {
    const guard = new IdempotencyGuard(TEST_DIR);
    guard.register('feature/login', 'req-001');

    const result = guard.check('feature/login');
    expect(result.isDuplicate).toBe(true);
    expect(result.existingRequestId).toBe('req-001');
  });

  it('after release, check returns not duplicate', () => {
    const guard = new IdempotencyGuard(TEST_DIR);
    guard.register('feature/login', 'req-001');
    guard.release('feature/login');

    const result = guard.check('feature/login');
    expect(result.isDuplicate).toBe(false);
  });

  it('different branches are independent', () => {
    const guard = new IdempotencyGuard(TEST_DIR);
    guard.register('feature/a', 'req-001');
    guard.register('feature/b', 'req-002');

    expect(guard.check('feature/a').isDuplicate).toBe(true);
    expect(guard.check('feature/b').isDuplicate).toBe(true);
    expect(guard.check('feature/c').isDuplicate).toBe(false);
  });

  it('releasing one branch does not affect others', () => {
    const guard = new IdempotencyGuard(TEST_DIR);
    guard.register('feature/a', 'req-001');
    guard.register('feature/b', 'req-002');
    guard.release('feature/a');

    expect(guard.check('feature/a').isDuplicate).toBe(false);
    expect(guard.check('feature/b').isDuplicate).toBe(true);
  });

  it('persist and loadFromDisk round-trip', async () => {
    const guard1 = new IdempotencyGuard(TEST_DIR);

    // Register first branch, then wait for persist to complete before next
    guard1.register('feature/a', 'req-001');
    await new Promise((r) => setTimeout(r, 200));

    guard1.register('feature/b', 'req-002');
    await new Promise((r) => setTimeout(r, 200));

    // Verify file has both entries before loading
    const persistPath = join(TEST_DIR, 'active-pipelines.json');
    for (let i = 0; i < 10; i++) {
      if (existsSync(persistPath)) {
        try {
          const data = JSON.parse(await Bun.file(persistPath).text());
          if (data['feature/a'] && data['feature/b']) break;
        } catch { /* file still being written */ }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Second guard: load from disk
    const guard2 = new IdempotencyGuard(TEST_DIR);
    await guard2.loadFromDisk();

    expect(guard2.check('feature/a').isDuplicate).toBe(true);
    expect(guard2.check('feature/a').existingRequestId).toBe('req-001');
    expect(guard2.check('feature/b').isDuplicate).toBe(true);
    expect(guard2.check('feature/b').existingRequestId).toBe('req-002');
    expect(guard2.check('feature/c').isDuplicate).toBe(false);
  });

  it('loadFromDisk with no file is a no-op', async () => {
    const guard = new IdempotencyGuard(join(TEST_DIR, 'nonexistent'));
    await guard.loadFromDisk(); // Should not throw

    expect(guard.check('anything').isDuplicate).toBe(false);
  });

  it('re-registering same branch updates request_id', () => {
    const guard = new IdempotencyGuard(TEST_DIR);
    guard.register('feature/a', 'req-001');
    guard.register('feature/a', 'req-002');

    const result = guard.check('feature/a');
    expect(result.isDuplicate).toBe(true);
    expect(result.existingRequestId).toBe('req-002');
  });
});
