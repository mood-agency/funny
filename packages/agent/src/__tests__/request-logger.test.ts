import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { RequestLogger, type LogEntry } from '../infrastructure/request-logger.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tmp-logger');

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

describe('RequestLogger', () => {
  it('creates logs directory on construction', () => {
    new RequestLogger(TEST_DIR);
    expect(existsSync(join(TEST_DIR, '.pipeline', 'logs'))).toBe(true);
  });

  it('writes per-request log entries', async () => {
    const rl = new RequestLogger(TEST_DIR);
    await rl.info('pipeline.runner', 'req-001', 'accepted', 'Pipeline started', { branch: 'feature/test' });

    const entries = await rl.queryLogs('req-001');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].source).toBe('pipeline.runner');
    expect(entries[0].request_id).toBe('req-001');
    expect(entries[0].action).toBe('accepted');
    expect(entries[0].message).toBe('Pipeline started');
    expect(entries[0].data?.branch).toBe('feature/test');
    expect(entries[0].timestamp).toBeDefined();
  });

  it('writes system log for director/integrator sources', async () => {
    const rl = new RequestLogger(TEST_DIR);
    await rl.info('director', 'system', 'cycle_started', 'Director cycle running');

    const systemEntries = await rl.querySystemLogs();
    expect(systemEntries).toHaveLength(1);
    expect(systemEntries[0].source).toBe('director');
  });

  it('does NOT write system log for pipeline.runner source', async () => {
    const rl = new RequestLogger(TEST_DIR);
    await rl.info('pipeline.runner', 'req-001', 'accepted', 'Pipeline started');

    const systemEntries = await rl.querySystemLogs();
    expect(systemEntries).toHaveLength(0);
  });

  it('filters by level', async () => {
    const rl = new RequestLogger(TEST_DIR);
    await rl.info('pipeline.runner', 'req-002', 'start', 'Starting');
    await rl.warn('pipeline.runner', 'req-002', 'slow', 'Slow operation');
    await rl.error('pipeline.runner', 'req-002', 'fail', 'Failed');

    const warnAndAbove = await rl.queryLogs('req-002', { level: 'warn' });
    expect(warnAndAbove).toHaveLength(2);
    expect(warnAndAbove.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('filters by source', async () => {
    const rl = new RequestLogger(TEST_DIR);
    await rl.info('pipeline.runner', 'req-003', 'start', 'Starting');
    await rl.info('pipeline.agent', 'req-003', 'agent_start', 'Agent started');

    const agentOnly = await rl.queryLogs('req-003', { source: 'pipeline.agent' });
    expect(agentOnly).toHaveLength(1);
    expect(agentOnly[0].source).toBe('pipeline.agent');
  });

  it('filters by time range', async () => {
    const rl = new RequestLogger(TEST_DIR);

    const before = new Date().toISOString();
    await rl.info('pipeline.runner', 'req-004', 'first', 'First entry');

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    const middle = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));

    await rl.info('pipeline.runner', 'req-004', 'second', 'Second entry');

    const afterMiddle = await rl.queryLogs('req-004', { from: middle });
    expect(afterMiddle).toHaveLength(1);
    expect(afterMiddle[0].action).toBe('second');
  });

  it('applies limit and offset', async () => {
    const rl = new RequestLogger(TEST_DIR);

    for (let i = 0; i < 5; i++) {
      await rl.info('pipeline.runner', 'req-005', `step-${i}`, `Step ${i}`);
    }

    const limited = await rl.queryLogs('req-005', { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].action).toBe('step-0');

    const offsetted = await rl.queryLogs('req-005', { offset: 3, limit: 10 });
    expect(offsetted).toHaveLength(2);
    expect(offsetted[0].action).toBe('step-3');
  });

  it('respects minimum log level', async () => {
    const rl = new RequestLogger(TEST_DIR, 'warn');
    await rl.log({ level: 'debug', source: 'pipeline.runner', request_id: 'req-006', action: 'test', message: 'debug msg' });
    await rl.log({ level: 'info', source: 'pipeline.runner', request_id: 'req-006', action: 'test', message: 'info msg' });
    await rl.log({ level: 'warn', source: 'pipeline.runner', request_id: 'req-006', action: 'test', message: 'warn msg' });
    await rl.log({ level: 'error', source: 'pipeline.runner', request_id: 'req-006', action: 'test', message: 'error msg' });

    const entries = await rl.queryLogs('req-006');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('returns empty array for non-existent request', async () => {
    const rl = new RequestLogger(TEST_DIR);
    const entries = await rl.queryLogs('non-existent');
    expect(entries).toEqual([]);
  });

  it('lists request IDs with logs', async () => {
    const rl = new RequestLogger(TEST_DIR);
    await rl.info('pipeline.runner', 'req-A', 'test', 'A');
    await rl.info('pipeline.runner', 'req-B', 'test', 'B');

    const ids = await rl.listRequestIds();
    expect(ids).toContain('req-A');
    expect(ids).toContain('req-B');
    expect(ids).not.toContain('system'); // system.jsonl excluded
  });
});
