import { describe, test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { rateLimit } from '../../middleware/rate-limit.js';

describe('rateLimit middleware', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
  });

  test('allows requests under the limit', async () => {
    app.use('*', rateLimit({ windowMs: 60_000, max: 5 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test('allows exactly max requests', async () => {
    app.use('*', rateLimit({ windowMs: 60_000, max: 3 }));
    app.get('/test', (c) => c.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/test');
      expect(res.status).toBe(200);
    }
  });

  test('rejects with 429 when limit is exceeded', async () => {
    app.use('*', rateLimit({ windowMs: 60_000, max: 2 }));
    app.get('/test', (c) => c.json({ ok: true }));

    // First two should succeed
    await app.request('/test');
    await app.request('/test');

    // Third should be rate limited
    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: 'Too many requests' });
  });

  test('includes Retry-After header when rate limited', async () => {
    app.use('*', rateLimit({ windowMs: 30_000, max: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request('/test');

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  test('Retry-After is ceiling of windowMs/1000', async () => {
    app.use('*', rateLimit({ windowMs: 1_500, max: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request('/test');

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('2');
  });

  test('uses x-forwarded-for header for IP (first IP, trimmed)', async () => {
    app.use('*', rateLimit({ windowMs: 60_000, max: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    // First request from IP "1.2.3.4"
    const res1 = await app.request('/test', {
      headers: { 'x-forwarded-for': '  1.2.3.4  , 5.6.7.8' },
    });
    expect(res1.status).toBe(200);

    // Second from same IP should be blocked
    const res2 = await app.request('/test', {
      headers: { 'x-forwarded-for': '1.2.3.4, 9.10.11.12' },
    });
    expect(res2.status).toBe(429);
  });

  test('uses x-real-ip as fallback when x-forwarded-for is missing', async () => {
    app.use('*', rateLimit({ windowMs: 60_000, max: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res1 = await app.request('/test', {
      headers: { 'x-real-ip': '10.0.0.1' },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/test', {
      headers: { 'x-real-ip': '10.0.0.1' },
    });
    expect(res2.status).toBe(429);
  });

  test('falls back to "unknown" when no IP headers present', async () => {
    app.use('*', rateLimit({ windowMs: 60_000, max: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res1 = await app.request('/test');
    expect(res1.status).toBe(200);

    // Second request with no headers should also be keyed as 'unknown' and blocked
    const res2 = await app.request('/test');
    expect(res2.status).toBe(429);
  });

  test('different IPs have independent rate limits', async () => {
    app.use('*', rateLimit({ windowMs: 60_000, max: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res1 = await app.request('/test', {
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(res1.status).toBe(200);

    // Different IP should still be allowed
    const res2 = await app.request('/test', {
      headers: { 'x-forwarded-for': '2.2.2.2' },
    });
    expect(res2.status).toBe(200);

    // Original IP should be blocked
    const res3 = await app.request('/test', {
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(res3.status).toBe(429);
  });

  test('window expiry allows new requests after time passes', async () => {
    // Use a very short window
    app.use('*', rateLimit({ windowMs: 50, max: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res1 = await app.request('/test');
    expect(res1.status).toBe(200);

    const res2 = await app.request('/test');
    expect(res2.status).toBe(429);

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res3 = await app.request('/test');
    expect(res3.status).toBe(200);
  });

  test('calls next() and route handler executes when under limit', async () => {
    let handlerCalled = false;
    app.use('*', rateLimit({ windowMs: 60_000, max: 5 }));
    app.get('/test', (c) => {
      handlerCalled = true;
      return c.json({ reached: true });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(handlerCalled).toBe(true);
  });

  test('does not call next() when limit exceeded', async () => {
    let handlerCallCount = 0;
    app.use('*', rateLimit({ windowMs: 60_000, max: 1 }));
    app.get('/test', (c) => {
      handlerCallCount++;
      return c.json({ ok: true });
    });

    await app.request('/test');
    await app.request('/test');
    await app.request('/test');

    expect(handlerCallCount).toBe(1);
  });

  test('max of 0 rejects all requests', async () => {
    app.use('*', rateLimit({ windowMs: 60_000, max: 0 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(429);
  });
});
