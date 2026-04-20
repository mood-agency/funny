/**
 * Security L3 regression test.
 *
 * Asserts that the Hono `secureHeaders()` middleware — wired into both the
 * server (`src/index.ts`) and the runner (`packages/runtime/src/app.ts`) —
 * emits `X-Content-Type-Options: nosniff` by default, and that the CSP
 * override we apply in the server does not disable that default.
 *
 * If this test starts failing, a future refactor of the secure-headers
 * config has dropped the `xContentTypeOptions` default and static-served
 * client assets are at risk of MIME sniffing. Re-enable the default or
 * set the header explicitly.
 */

import { describe, expect, it } from 'bun:test';

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

describe('static-file security headers (L3)', () => {
  it('sets X-Content-Type-Options: nosniff by default', async () => {
    const app = new Hono();
    app.use('*', secureHeaders());
    app.get('/asset.js', (c) => c.text('console.log(1)', 200));

    const res = await app.request('/asset.js');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('keeps nosniff when a CSP override is supplied (matches server config)', async () => {
    const app = new Hono();
    app.use(
      '*',
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
        },
        strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      }),
    );
    app.get('/asset.js', (c) => c.text('console.log(1)', 200));

    const res = await app.request('/asset.js');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
