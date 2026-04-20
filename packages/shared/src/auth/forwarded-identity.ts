/**
 * HMAC-signed forwarded identity for server → runtime proxy requests.
 *
 * The server proxies authenticated requests to a runtime over either a WS tunnel
 * or direct HTTP. Historically the runtime trusted plaintext `X-Forwarded-User`
 * headers whenever `X-Runner-Auth` matched the shared secret. Any client able to
 * present the shared secret (e.g. leak, reused runner secret, direct connection
 * to a runner's HTTP port) could impersonate any user, including admin.
 *
 * The signature binds the forwarded identity to the shared secret: the server
 * computes an HMAC over `userId | role | orgId | orgName | timestamp` and the
 * runtime recomputes it to verify authenticity. Replay is bounded by rejecting
 * timestamps outside a small skew window.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Name of the signature header */
export const SIGNATURE_HEADER = 'X-Forwarded-Signature';
/** Name of the timestamp header (unix ms) */
export const TIMESTAMP_HEADER = 'X-Forwarded-Timestamp';

/** Accept signatures within ±5 minutes of the server's clock. */
export const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export interface ForwardedIdentity {
  userId: string;
  role?: string | null;
  orgId?: string | null;
  orgName?: string | null;
}

function canonicalize(identity: ForwardedIdentity, timestamp: number): string {
  return [
    identity.userId,
    identity.role ?? '',
    identity.orgId ?? '',
    identity.orgName ?? '',
    String(timestamp),
  ].join('|');
}

/**
 * Sign a forwarded identity. Returns the headers the proxy should attach.
 */
export function signForwardedIdentity(
  identity: ForwardedIdentity,
  secret: string,
  timestamp: number = Date.now(),
): { signature: string; timestamp: number } {
  const payload = canonicalize(identity, timestamp);
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return { signature, timestamp };
}

/**
 * Verify a forwarded identity signature. Returns `true` iff the signature is
 * valid and the timestamp is within the allowed skew.
 *
 * Uses constant-time comparison to avoid side-channels on the HMAC.
 */
export function verifyForwardedIdentity(
  identity: ForwardedIdentity,
  secret: string,
  signature: string | undefined,
  timestamp: string | number | undefined,
  now: number = Date.now(),
  maxSkewMs: number = SIGNATURE_MAX_SKEW_MS,
): boolean {
  if (!signature || timestamp === undefined || timestamp === null) return false;

  const ts = typeof timestamp === 'string' ? Number.parseInt(timestamp, 10) : timestamp;
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > maxSkewMs) return false;

  const expected = createHmac('sha256', secret).update(canonicalize(identity, ts)).digest('hex');

  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
