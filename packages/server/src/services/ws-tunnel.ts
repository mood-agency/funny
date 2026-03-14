/**
 * WebSocket tunnel for proxying HTTP requests to runners.
 *
 * Instead of direct HTTP fetch to the runner (which fails behind NAT),
 * this sends the request through the existing runner WebSocket connection
 * and correlates responses via requestId.
 */

import type { CentralWSTunnelRequest, RunnerWSTunnelResponse } from '@funny/shared/runner-protocol';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import { sendToRunner } from './ws-relay.js';

const TUNNEL_TIMEOUT_MS = 30_000;

interface PendingRequest {
  runnerId: string;
  resolve: (response: TunnelResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/** requestId → pending request */
const pending = new Map<string, PendingRequest>();

/**
 * Send an HTTP request to a runner through the WebSocket tunnel.
 * Returns a Response-like object with status, headers, and body.
 */
export function tunnelFetch(
  runnerId: string,
  opts: { method: string; path: string; headers: Record<string, string>; body?: string | null },
): Promise<TunnelResponse> {
  const requestId = nanoid();

  const message: CentralWSTunnelRequest = {
    type: 'tunnel:request',
    requestId,
    method: opts.method,
    path: opts.path,
    headers: opts.headers,
    body: opts.body ?? null,
  };

  const sent = sendToRunner(runnerId, message as unknown as Record<string, unknown>);
  if (!sent) {
    return Promise.reject(new Error(`Runner ${runnerId} is not connected`));
  }

  return new Promise<TunnelResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(
        new Error(
          `Tunnel request ${requestId} to runner ${runnerId} timed out after ${TUNNEL_TIMEOUT_MS}ms`,
        ),
      );
    }, TUNNEL_TIMEOUT_MS);

    pending.set(requestId, { runnerId, resolve, reject, timer });
  });
}

/**
 * Handle a tunnel:response message from a runner.
 * Called by the server WS message handler.
 */
export function handleTunnelResponse(data: RunnerWSTunnelResponse): void {
  const entry = pending.get(data.requestId);
  if (!entry) {
    log.warn('Received tunnel:response for unknown requestId', {
      namespace: 'ws-tunnel',
      requestId: data.requestId,
    });
    return;
  }

  clearTimeout(entry.timer);
  pending.delete(data.requestId);

  entry.resolve({
    status: data.status,
    headers: data.headers,
    body: data.body,
  });
}

/**
 * Cancel all pending tunnel requests for a runner (e.g. on disconnect).
 */
export function cancelPendingRequests(runnerId: string): void {
  let cancelled = 0;
  for (const [requestId, entry] of pending) {
    if (entry.runnerId !== runnerId) continue;
    clearTimeout(entry.timer);
    entry.reject(new Error(`Runner ${runnerId} disconnected`));
    pending.delete(requestId);
    cancelled++;
  }
  if (cancelled > 0) {
    log.info(`Cancelled ${cancelled} pending tunnel requests for runner ${runnerId}`, {
      namespace: 'ws-tunnel',
    });
  }
}

/**
 * Get the number of pending tunnel requests (for monitoring).
 */
export function getPendingCount(): number {
  return pending.size;
}
