import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { WebhookAdapter } from '../infrastructure/webhook-adapter.js';
import type { PipelineEvent } from '../core/types.js';

// ── Test event factory ──────────────────────────────────────────

function makeEvent(eventType = 'pipeline.completed' as any): PipelineEvent {
  return {
    event_type: eventType,
    request_id: 'req-1',
    timestamp: new Date().toISOString(),
    data: { branch: 'feature/test' },
  };
}

// ── Mock fetch ──────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

describe('WebhookAdapter', () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() => Promise.resolve(new Response('OK', { status: 200 })));
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('delivers event via POST', async () => {
    const adapter = new WebhookAdapter({ url: 'https://example.com/webhook' });
    const event = makeEvent();

    await adapter.deliver(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/webhook');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toHaveProperty('Content-Type', 'application/json');
    expect(JSON.parse(opts.body as string)).toEqual(event);
  });

  it('includes secret header when configured', async () => {
    const adapter = new WebhookAdapter({
      url: 'https://example.com/webhook',
      secret: 'my-secret',
    });

    await adapter.deliver(makeEvent());

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['X-Webhook-Secret']).toBe('my-secret');
  });

  it('filters events by allow-list', async () => {
    const adapter = new WebhookAdapter({
      url: 'https://example.com/webhook',
      events: ['pipeline.failed'],
    });

    // This event is pipeline.completed, not in the allow-list
    await adapter.deliver(makeEvent('pipeline.completed'));
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // This event is pipeline.failed, in the allow-list
    await adapter.deliver(makeEvent('pipeline.failed'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('delivers all events when no filter is configured', async () => {
    const adapter = new WebhookAdapter({ url: 'https://example.com/webhook' });

    await adapter.deliver(makeEvent('pipeline.completed'));
    await adapter.deliver(makeEvent('pipeline.failed'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on non-OK response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Server Error', { status: 500, statusText: 'Internal Server Error' })),
    ) as any;

    const adapter = new WebhookAdapter({ url: 'https://example.com/webhook' });

    await expect(adapter.deliver(makeEvent())).rejects.toThrow('Webhook delivery failed: 500');
  });

  it('sets name from URL host', () => {
    const adapter = new WebhookAdapter({ url: 'https://hooks.slack.com/services/abc' });
    expect(adapter.name).toBe('webhook-hooks.slack.com-80');
  });

  it('handles invalid URL gracefully for name', () => {
    const adapter = new WebhookAdapter({ url: 'not-a-valid-url' });
    expect(adapter.name).toBe('webhook-not-a-valid-url');
  });
});
