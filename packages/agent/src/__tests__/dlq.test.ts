import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DeadLetterQueue, type DLQConfig } from '../infrastructure/dlq.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import type { PipelineEvent } from '../core/types.js';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tmp-dlq');

const DEFAULT_DLQ_CONFIG: DLQConfig = {
  enabled: true,
  path: '.pipeline/dlq',
  max_retries: 3,
  base_delay_ms: 100,
  backoff_factor: 2,
};

function makeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    event_type: 'pipeline.failed',
    request_id: 'req-dlq-001',
    timestamp: new Date().toISOString(),
    data: { branch: 'feature/test' },
    ...overrides,
  };
}

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

describe('DeadLetterQueue', () => {
  // ── enqueue() adds entries ──────────────────────────────────

  it('enqueue() creates a JSONL file for the adapter', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);
    const event = makeEvent();

    await dlq.enqueue('webhook', event, new Error('Connection refused'));

    const filePath = join(TEST_DIR, '.pipeline', 'dlq', 'webhook', `${event.request_id}.jsonl`);
    expect(existsSync(filePath)).toBe(true);
  });

  it('enqueue() stores the error message', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);
    const event = makeEvent();

    await dlq.enqueue('webhook', event, new Error('Timeout'));

    const pending = await dlq.getPending('webhook');
    expect(pending.length).toBe(1);
    expect(pending[0].error).toBe('Timeout');
  });

  it('enqueue() sets retry_count to 0', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);
    await dlq.enqueue('webhook', makeEvent(), new Error('fail'));

    const pending = await dlq.getPending('webhook');
    expect(pending[0].retry_count).toBe(0);
  });

  it('enqueue() is a no-op when DLQ is disabled', async () => {
    const config = { ...DEFAULT_DLQ_CONFIG, enabled: false };
    const dlq = new DeadLetterQueue(config, TEST_DIR);

    await dlq.enqueue('webhook', makeEvent(), new Error('fail'));

    const pending = await dlq.getPending('webhook');
    expect(pending.length).toBe(0);
  });

  it('enqueue() multiple events for same adapter', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);

    await dlq.enqueue('webhook', makeEvent({ request_id: 'req-1' }), new Error('fail-1'));
    await dlq.enqueue('webhook', makeEvent({ request_id: 'req-2' }), new Error('fail-2'));

    const pending = await dlq.getPending('webhook');
    expect(pending.length).toBe(2);
  });

  // ── getPending() returns pending entries ─────────────────────

  it('getPending() returns empty array for unknown adapter', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);
    const pending = await dlq.getPending('nonexistent');
    expect(pending).toEqual([]);
  });

  it('getPending() returns empty array when DLQ is disabled', async () => {
    const config = { ...DEFAULT_DLQ_CONFIG, enabled: false };
    const dlq = new DeadLetterQueue(config, TEST_DIR);
    const pending = await dlq.getPending('webhook');
    expect(pending).toEqual([]);
  });

  it('getPending() returns the latest entry per request_id file', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);
    const event = makeEvent({ request_id: 'req-latest' });

    await dlq.enqueue('webhook', event, new Error('first error'));

    const pending = await dlq.getPending('webhook');
    expect(pending.length).toBe(1);
    expect(pending[0].event.request_id).toBe('req-latest');
    expect(pending[0].error).toBe('first error');
  });

  // ── Exponential backoff calculation ─────────────────────────

  it('calculates exponential backoff on retry failure', async () => {
    const config: DLQConfig = {
      enabled: true,
      path: '.pipeline/dlq',
      max_retries: 5,
      base_delay_ms: 100,
      backoff_factor: 2,
    };
    const dlq = new DeadLetterQueue(config, TEST_DIR);
    const event = makeEvent({ request_id: 'req-backoff' });

    // Enqueue with next_retry_at in the past so processRetries picks it up
    await dlq.enqueue('webhook', event, new Error('initial'));

    // Manually set next_retry_at to the past to trigger retry
    const filePath = join(TEST_DIR, '.pipeline', 'dlq', 'webhook', 'req-backoff.jsonl');
    const content = await Bun.file(filePath).text();
    const entry = JSON.parse(content.trim());
    entry.next_retry_at = new Date(Date.now() - 1000).toISOString();
    await Bun.write(filePath, JSON.stringify(entry) + '\n');

    // Process retries with a failing deliverFn
    const beforeRetry = Date.now();
    await dlq.processRetries('webhook', async () => {
      throw new Error('still failing');
    });

    const pending = await dlq.getPending('webhook');
    expect(pending.length).toBe(1);
    expect(pending[0].retry_count).toBe(1);

    // Verify next_retry_at is in the future (base_delay * backoff^retry_count)
    const nextRetry = new Date(pending[0].next_retry_at).getTime();
    // Expected delay for retry_count=0: base_delay_ms * backoff_factor^0 = 100 * 1 = 100
    expect(nextRetry).toBeGreaterThan(beforeRetry);
  });

  // ── Max retries enforcement ─────────────────────────────────

  it('marks entries as exhausted when max_retries exceeded', async () => {
    const config: DLQConfig = {
      enabled: true,
      path: '.pipeline/dlq',
      max_retries: 2,
      base_delay_ms: 100,
      backoff_factor: 2,
    };
    const dlq = new DeadLetterQueue(config, TEST_DIR);
    const event = makeEvent({ request_id: 'req-exhaust' });

    // Create an entry that already exhausted retries
    const dir = join(TEST_DIR, '.pipeline', 'dlq', 'webhook');
    mkdirSync(dir, { recursive: true });

    const entry = {
      event,
      error: 'initial',
      enqueued_at: new Date().toISOString(),
      retry_count: 2, // Already at max_retries
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    };

    await Bun.write(join(dir, 'req-exhaust.jsonl'), JSON.stringify(entry) + '\n');

    const result = await dlq.processRetries('webhook', async () => {
      throw new Error('should not be called');
    });

    expect(result.exhausted).toBe(1);
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(0);
  });

  // ── processRetries() with successful delivery ───────────────

  it('processRetries() delivers and clears entry on success', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);
    const event = makeEvent({ request_id: 'req-success' });

    await dlq.enqueue('webhook', event, new Error('initial failure'));

    // Set next_retry_at to the past
    const filePath = join(TEST_DIR, '.pipeline', 'dlq', 'webhook', 'req-success.jsonl');
    const content = await Bun.file(filePath).text();
    const parsed = JSON.parse(content.trim());
    parsed.next_retry_at = new Date(Date.now() - 1000).toISOString();
    await Bun.write(filePath, JSON.stringify(parsed) + '\n');

    let deliveredEvent: PipelineEvent | null = null;
    const result = await dlq.processRetries('webhook', async (evt) => {
      deliveredEvent = evt;
    });

    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.exhausted).toBe(0);
    expect(deliveredEvent).not.toBeNull();
    expect(deliveredEvent!.request_id).toBe('req-success');
  });

  // ── processRetries() with failed delivery ───────────────────

  it('processRetries() increments retry_count on failure', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);
    const event = makeEvent({ request_id: 'req-fail-retry' });

    await dlq.enqueue('webhook', event, new Error('initial'));

    // Set next_retry_at to the past
    const filePath = join(TEST_DIR, '.pipeline', 'dlq', 'webhook', 'req-fail-retry.jsonl');
    const content = await Bun.file(filePath).text();
    const parsed = JSON.parse(content.trim());
    parsed.next_retry_at = new Date(Date.now() - 1000).toISOString();
    await Bun.write(filePath, JSON.stringify(parsed) + '\n');

    const result = await dlq.processRetries('webhook', async () => {
      throw new Error('still broken');
    });

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);

    const pending = await dlq.getPending('webhook');
    expect(pending.length).toBe(1);
    expect(pending[0].retry_count).toBe(1);
    expect(pending[0].last_error).toBe('still broken');
  });

  it('processRetries() returns zeros for disabled DLQ', async () => {
    const config = { ...DEFAULT_DLQ_CONFIG, enabled: false };
    const dlq = new DeadLetterQueue(config, TEST_DIR);

    const result = await dlq.processRetries('webhook', async () => {});
    expect(result).toEqual({ delivered: 0, failed: 0, exhausted: 0 });
  });

  it('processRetries() returns zeros for unknown adapter', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);

    const result = await dlq.processRetries('nonexistent', async () => {});
    expect(result).toEqual({ delivered: 0, failed: 0, exhausted: 0 });
  });

  // ── Multiple adapters are independent ───────────────────────

  it('different adapters are isolated', async () => {
    const dlq = new DeadLetterQueue(DEFAULT_DLQ_CONFIG, TEST_DIR);

    await dlq.enqueue('webhook-a', makeEvent({ request_id: 'req-a' }), new Error('fail-a'));
    await dlq.enqueue('webhook-b', makeEvent({ request_id: 'req-b' }), new Error('fail-b'));

    const pendingA = await dlq.getPending('webhook-a');
    const pendingB = await dlq.getPending('webhook-b');

    expect(pendingA.length).toBe(1);
    expect(pendingA[0].event.request_id).toBe('req-a');
    expect(pendingB.length).toBe(1);
    expect(pendingB[0].event.request_id).toBe('req-b');
  });
});
