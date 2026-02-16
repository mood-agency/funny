/**
 * WebhookAdapter — delivers pipeline events via HTTP POST.
 *
 * Supports optional event filtering and HMAC secret for verification.
 */

import type { IOutboundAdapter } from './adapter.js';
import type { PipelineEvent } from '../core/types.js';

export interface WebhookConfig {
  url: string;
  secret?: string;
  events?: string[];
  timeout_ms?: number;
}

export class WebhookAdapter implements IOutboundAdapter {
  readonly name: string;
  private url: string;
  private secret?: string;
  private events?: Set<string>;
  private timeoutMs: number;

  constructor(config: WebhookConfig) {
    this.url = config.url;
    this.secret = config.secret;
    this.events = config.events?.length ? new Set(config.events) : undefined;
    this.timeoutMs = config.timeout_ms ?? 10_000;

    // Name includes the host for identification.
    // Replace colons with dashes so the name is safe for directory paths (DLQ on Windows).
    try {
      const u = new URL(config.url);
      this.name = `webhook-${u.hostname}-${u.port || '80'}`;
    } catch {
      this.name = `webhook-${config.url.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    }
  }

  async deliver(event: PipelineEvent): Promise<void> {
    // Filter: skip events not in the allow-list
    if (this.events && !this.events.has(event.event_type)) {
      return;
    }

    console.log(`[webhook:${this.name}] Delivering ${event.event_type} for request=${event.request_id}`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.secret) {
      headers['X-Webhook-Secret'] = this.secret;
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed: ${response.status} ${response.statusText}`);
    }
    console.log(`[webhook:${this.name}] Delivered ${event.event_type} → ${response.status}`);
  }
}
