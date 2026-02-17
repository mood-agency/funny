import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventBus } from '../infrastructure/event-bus.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import type { PipelineEvent } from '../core/types.js';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tmp-event-bus');

function makeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    event_type: 'pipeline.accepted',
    request_id: 'req-001',
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

describe('EventBus', () => {
  // ── publish() emits events ──────────────────────────────────

  it('publish() emits event to subscribers', async () => {
    const bus = new EventBus(TEST_DIR);
    const received: PipelineEvent[] = [];

    bus.on('event', (evt) => received.push(evt));

    const event = makeEvent();
    await bus.publish(event);

    expect(received.length).toBe(1);
    expect(received[0].event_type).toBe('pipeline.accepted');
    expect(received[0].request_id).toBe('req-001');
  });

  it('publish() emits multiple events in order', async () => {
    const bus = new EventBus(TEST_DIR);
    const received: PipelineEvent[] = [];

    bus.on('event', (evt) => received.push(evt));

    await bus.publish(makeEvent({ event_type: 'pipeline.accepted' }));
    await bus.publish(makeEvent({ event_type: 'pipeline.started' }));
    await bus.publish(makeEvent({ event_type: 'pipeline.completed' }));

    expect(received.length).toBe(3);
    expect(received[0].event_type).toBe('pipeline.accepted');
    expect(received[1].event_type).toBe('pipeline.started');
    expect(received[2].event_type).toBe('pipeline.completed');
  });

  // ── Subscribers receive published events ────────────────────

  it('multiple subscribers all receive the same event', async () => {
    const bus = new EventBus(TEST_DIR);
    const sub1: PipelineEvent[] = [];
    const sub2: PipelineEvent[] = [];

    bus.on('event', (evt) => sub1.push(evt));
    bus.on('event', (evt) => sub2.push(evt));

    const event = makeEvent();
    await bus.publish(event);

    expect(sub1.length).toBe(1);
    expect(sub2.length).toBe(1);
    expect(sub1[0].request_id).toBe(sub2[0].request_id);
  });

  it('subscriber added after publish does not receive past events', async () => {
    const bus = new EventBus(TEST_DIR);
    await bus.publish(makeEvent());

    const received: PipelineEvent[] = [];
    bus.on('event', (evt) => received.push(evt));

    expect(received.length).toBe(0);
  });

  // ── getEvents() reads back persisted events ─────────────────

  it('getEvents() returns empty array for unknown request_id', async () => {
    const bus = new EventBus(TEST_DIR);
    const events = await bus.getEvents('nonexistent-id');
    expect(events).toEqual([]);
  });

  it('getEvents() returns published events for a request_id', async () => {
    const bus = new EventBus(TEST_DIR);

    await bus.publish(makeEvent({ request_id: 'req-abc', event_type: 'pipeline.accepted' }));
    await bus.publish(makeEvent({ request_id: 'req-abc', event_type: 'pipeline.started' }));

    const events = await bus.getEvents('req-abc');
    expect(events.length).toBe(2);
    expect(events[0].event_type).toBe('pipeline.accepted');
    expect(events[1].event_type).toBe('pipeline.started');
  });

  it('getEvents() only returns events for the specified request_id', async () => {
    const bus = new EventBus(TEST_DIR);

    await bus.publish(makeEvent({ request_id: 'req-1', event_type: 'pipeline.accepted' }));
    await bus.publish(makeEvent({ request_id: 'req-2', event_type: 'pipeline.started' }));
    await bus.publish(makeEvent({ request_id: 'req-1', event_type: 'pipeline.completed' }));

    const events1 = await bus.getEvents('req-1');
    expect(events1.length).toBe(2);
    expect(events1[0].event_type).toBe('pipeline.accepted');
    expect(events1[1].event_type).toBe('pipeline.completed');

    const events2 = await bus.getEvents('req-2');
    expect(events2.length).toBe(1);
    expect(events2[0].event_type).toBe('pipeline.started');
  });

  // ── Events are persisted to JSONL files ─────────────────────

  it('creates a JSONL file per request_id', async () => {
    const bus = new EventBus(TEST_DIR);

    await bus.publish(makeEvent({ request_id: 'req-file-test' }));

    const filePath = join(TEST_DIR, 'req-file-test.jsonl');
    expect(existsSync(filePath)).toBe(true);
  });

  it('JSONL file contains valid JSON lines', async () => {
    const bus = new EventBus(TEST_DIR);

    await bus.publish(makeEvent({ request_id: 'req-jsonl', event_type: 'pipeline.accepted' }));
    await bus.publish(makeEvent({ request_id: 'req-jsonl', event_type: 'pipeline.started' }));

    const filePath = join(TEST_DIR, 'req-jsonl.jsonl');
    const content = await Bun.file(filePath).text();
    const lines = content.trim().split('\n');

    expect(lines.length).toBe(2);

    const parsed0 = JSON.parse(lines[0]);
    expect(parsed0.event_type).toBe('pipeline.accepted');

    const parsed1 = JSON.parse(lines[1]);
    expect(parsed1.event_type).toBe('pipeline.started');
  });

  it('persisted events survive across EventBus instances', async () => {
    const bus1 = new EventBus(TEST_DIR);
    await bus1.publish(makeEvent({ request_id: 'req-persist', event_type: 'pipeline.accepted' }));

    // Create a new EventBus pointing to the same directory
    const bus2 = new EventBus(TEST_DIR);
    const events = await bus2.getEvents('req-persist');

    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe('pipeline.accepted');
    expect(events[0].request_id).toBe('req-persist');
  });

  it('preserves event data fields in persisted events', async () => {
    const bus = new EventBus(TEST_DIR);

    await bus.publish(makeEvent({
      request_id: 'req-data',
      data: { branch: 'feature/auth', filesChanged: 5, tier: 'medium' },
    }));

    const events = await bus.getEvents('req-data');
    expect(events.length).toBe(1);
    expect(events[0].data.branch).toBe('feature/auth');
    expect(events[0].data.filesChanged).toBe(5);
    expect(events[0].data.tier).toBe('medium');
  });
});
