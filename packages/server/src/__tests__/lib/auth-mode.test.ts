import { describe, test, expect, afterEach } from 'bun:test';
import { getAuthMode } from '../../lib/auth-mode.js';

describe('getAuthMode', () => {
  const originalAuthMode = process.env.AUTH_MODE;

  afterEach(() => {
    // Restore original value
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  test('returns "local" by default when AUTH_MODE is not set', () => {
    delete process.env.AUTH_MODE;
    expect(getAuthMode()).toBe('local');
  });

  test('returns "local" when AUTH_MODE is empty string', () => {
    process.env.AUTH_MODE = '';
    expect(getAuthMode()).toBe('local');
  });

  test('returns "multi" when AUTH_MODE is "multi"', () => {
    process.env.AUTH_MODE = 'multi';
    expect(getAuthMode()).toBe('multi');
  });

  test('returns "multi" when AUTH_MODE is "MULTI" (case insensitive)', () => {
    process.env.AUTH_MODE = 'MULTI';
    expect(getAuthMode()).toBe('multi');
  });

  test('returns "multi" when AUTH_MODE is "Multi" (mixed case)', () => {
    process.env.AUTH_MODE = 'Multi';
    expect(getAuthMode()).toBe('multi');
  });

  test('returns "local" for unrecognized values', () => {
    process.env.AUTH_MODE = 'invalid';
    expect(getAuthMode()).toBe('local');
  });

  test('returns "local" when AUTH_MODE is "local"', () => {
    process.env.AUTH_MODE = 'local';
    expect(getAuthMode()).toBe('local');
  });

  test('returns "local" when AUTH_MODE is "LOCAL"', () => {
    process.env.AUTH_MODE = 'LOCAL';
    expect(getAuthMode()).toBe('local');
  });

  test('returns "local" when AUTH_MODE is whitespace', () => {
    process.env.AUTH_MODE = '   ';
    expect(getAuthMode()).toBe('local');
  });

  test('return type is "local" or "multi"', () => {
    delete process.env.AUTH_MODE;
    const result = getAuthMode();
    expect(['local', 'multi']).toContain(result);
  });
});
