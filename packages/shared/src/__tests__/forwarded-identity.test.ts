import { describe, test, expect } from 'bun:test';

import {
  SIGNATURE_MAX_SKEW_MS,
  signForwardedIdentity,
  verifyForwardedIdentity,
} from '../auth/forwarded-identity.js';

const SECRET = 'super-secret-value-0123456789abcdef';

describe('forwarded-identity', () => {
  test('sign/verify round-trips a full identity', () => {
    const now = 1_700_000_000_000;
    const identity = {
      userId: 'user_1',
      role: 'admin',
      orgId: 'org_9',
      orgName: 'Acme',
    };
    const { signature, timestamp } = signForwardedIdentity(identity, SECRET, now);
    expect(verifyForwardedIdentity(identity, SECRET, signature, timestamp, now)).toBe(true);
  });

  test('verify fails when the secret differs', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'u', role: 'user', orgId: null, orgName: null };
    const { signature, timestamp } = signForwardedIdentity(identity, SECRET, now);
    expect(verifyForwardedIdentity(identity, SECRET + 'x', signature, timestamp, now)).toBe(false);
  });

  test('verify fails if any identity field is tampered', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'alice', role: 'user', orgId: null, orgName: null };
    const { signature, timestamp } = signForwardedIdentity(identity, SECRET, now);
    // Attacker swaps userId while keeping the signature.
    expect(
      verifyForwardedIdentity({ ...identity, userId: 'admin' }, SECRET, signature, timestamp, now),
    ).toBe(false);
    // Attacker escalates role.
    expect(
      verifyForwardedIdentity({ ...identity, role: 'admin' }, SECRET, signature, timestamp, now),
    ).toBe(false);
  });

  test('verify rejects timestamps outside the skew window', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'u', role: 'user', orgId: null, orgName: null };
    const { signature } = signForwardedIdentity(identity, SECRET, now);
    const staleTs = now - SIGNATURE_MAX_SKEW_MS - 1;
    expect(verifyForwardedIdentity(identity, SECRET, signature, staleTs, now)).toBe(false);
  });

  test('verify rejects missing signature or timestamp', () => {
    const identity = { userId: 'u' };
    expect(verifyForwardedIdentity(identity, SECRET, undefined, Date.now())).toBe(false);
    expect(verifyForwardedIdentity(identity, SECRET, 'abc', undefined)).toBe(false);
  });

  test('verify rejects a non-hex signature of wrong length', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'u' };
    expect(verifyForwardedIdentity(identity, SECRET, 'nothex', now, now)).toBe(false);
  });

  test('null and undefined identity fields produce the same signature', () => {
    const now = 1_700_000_000_000;
    const a = signForwardedIdentity({ userId: 'u' }, SECRET, now);
    const b = signForwardedIdentity(
      { userId: 'u', role: null, orgId: null, orgName: null },
      SECRET,
      now,
    );
    expect(a.signature).toBe(b.signature);
  });
});
