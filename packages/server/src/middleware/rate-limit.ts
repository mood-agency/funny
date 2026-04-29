/**
 * Simple in-memory sliding-window rate limiter for the server.
 *
 * Bucketing strategy (security H6):
 *   - Authenticated requests key on the userId first, and additionally on the
 *     caller IP when one is available. Sharing the IP bucket with all other
 *     anonymous callers would let one abuser lock every logged-in user out.
 *   - Anonymous requests key on IP only. `X-Forwarded-For` is trusted
 *     strictly when `TRUST_PROXY=true` is set in the environment — otherwise
 *     we rely on the socket remote address so a client cannot spoof its
 *     rate-limit bucket by attaching its own header.
 *   - If neither a userId nor a resolvable IP is present (e.g. a unix-socket
 *     transport), the request is allowed through: it is better to fail open
 *     than to merge every such request into a single shared `'unknown'`
 *     bucket, which is itself a denial-of-service vector.
 */

import type { Context, Next } from 'hono';
import { getConnInfo } from 'hono/bun';

import { log } from '../lib/logger.js';

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  /** Also enforce a per-user limit (uses userId from context). Defaults to false. */
  perUser?: boolean;
}) {
  const { windowMs, max, perUser } = opts;
  const hits = new Map<string, number[]>();

  // Periodically prune stale entries to prevent memory growth
  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, windowMs);
  pruneTimer.unref();

  function check(key: string, now: number): boolean {
    const timestamps = hits.get(key) ?? [];
    const valid = timestamps.filter((t) => now - t < windowMs);
    if (valid.length >= max) return true; // rate limited
    valid.push(now);
    hits.set(key, valid);
    return false;
  }

  function resolveIp(c: Context): string | null {
    if (TRUST_PROXY) {
      const xff = c.req.header('x-forwarded-for');
      if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
      }
    }
    try {
      const info = getConnInfo(c);
      const addr = info.remote.address;
      if (typeof addr === 'string' && addr.length > 0) return addr;
    } catch {
      // getConnInfo throws when the runtime adapter isn't Bun (e.g. in tests).
    }
    return null;
  }

  return async (c: Context, next: Next) => {
    const now = Date.now();
    const userId = c.get('userId') as string | undefined;
    const ip = resolveIp(c);

    // Authenticated: userId is the primary bucket so a single abusive IP
    // cannot exhaust the limit for every legitimate user.
    if (userId) {
      if (check(`user:${userId}`, now)) {
        c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
        return c.json({ error: 'Too many requests' }, 429);
      }
      // Apply an IP-scoped limit as a secondary defense when we can identify
      // the caller's IP. Only runs when `perUser` is enabled to match the
      // prior behaviour of the authenticated catch-all.
      if (perUser && ip && check(`ip:${ip}`, now)) {
        c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
        return c.json({ error: 'Too many requests' }, 429);
      }
      return next();
    }

    // Anonymous: rate-limit on IP when we have one, otherwise allow through.
    // We explicitly refuse to fall back to a shared `'unknown'` bucket.
    if (ip) {
      if (check(`ip:${ip}`, now)) {
        c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
        return c.json({ error: 'Too many requests' }, 429);
      }
    } else {
      log.debug('Rate limit skipped — no identifiable IP for anonymous request', {
        namespace: 'rate-limit',
        path: c.req.path,
        trustProxy: TRUST_PROXY,
      });
    }

    return next();
  };
}
