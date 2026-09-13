import { describe, it, expect } from 'vitest';
import { isUniqueViolation, isForeignKeyViolation } from '../../../src/lib/errors.js';

// Drizzle does not rethrow the driver's error: it wraps it in a DrizzleQueryError
// whose own `code` is undefined and hangs the PostgresError off `.cause`. Probed
// against the prod DB — a duplicate insert on idx_processing_jobs_active_file_hash
// produced exactly this shape, and the old top-level `err.code` check returned
// false for it, so every 23505/23503 handler fell through to a 500 (KAN-302).
function drizzleWrapped(sqlState: string) {
  const driverError = Object.assign(new Error(`duplicate key value violates unique constraint`), {
    name: 'PostgresError',
    code: sqlState,
  });
  return Object.assign(new Error('Failed query: insert into "processing_jobs" ...'), {
    name: 'DrizzleQueryError',
    cause: driverError,
  });
}

describe('isUniqueViolation', () => {
  it('sees a 23505 that drizzle buried on .cause', () => {
    expect(isUniqueViolation(drizzleWrapped('23505'))).toBe(true);
  });

  it('still sees a bare driver error with the code on top', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('does not match a different SQLSTATE on the cause chain', () => {
    expect(isUniqueViolation(drizzleWrapped('23503'))).toBe(false);
  });

  it('ignores errors with no SQLSTATE anywhere', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const looped: { code?: string; cause?: unknown } = { code: 'XXXXX' };
    looped.cause = looped;
    expect(isUniqueViolation(looped)).toBe(false);
  });

  it('finds a code nested two wrappers deep', () => {
    const inner = Object.assign(new Error('dup'), { code: '23505' });
    const mid = Object.assign(new Error('mid'), { cause: inner });
    expect(isUniqueViolation(Object.assign(new Error('outer'), { cause: mid }))).toBe(true);
  });
});

describe('isForeignKeyViolation', () => {
  it('sees a 23503 that drizzle buried on .cause', () => {
    expect(isForeignKeyViolation(drizzleWrapped('23503'))).toBe(true);
  });

  it('does not fire on a unique violation', () => {
    expect(isForeignKeyViolation(drizzleWrapped('23505'))).toBe(false);
  });
});
