import { describe, it, expect } from 'vitest';
import { assertUuidQueryParam, assertUuidPathParam } from '../../../src/lib/query-guards.js';
import { AppError } from '../../../src/lib/errors.js';

const validUuid = '11111111-1111-4111-8111-111111111111';

describe('assertUuidQueryParam', () => {
  it('returns the value unchanged for a valid UUID', () => {
    expect(assertUuidQueryParam(validUuid, 'bookId')).toBe(validUuid);
  });

  it('throws a 400 VALIDATION_ERROR for a non-UUID value', () => {
    try {
      assertUuidQueryParam('not-a-uuid', 'bookId');
      throw new Error('expected assertUuidQueryParam to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('VALIDATION_ERROR');
      expect(appErr.status).toBe(400);
      expect(appErr.message).toContain('bookId');
    }
  });

  it('includes the given param name in the error message', () => {
    try {
      assertUuidQueryParam('123', 'chapterId');
      throw new Error('expected assertUuidQueryParam to throw');
    } catch (err) {
      expect((err as AppError).message).toBe('chapterId must be a valid UUID');
    }
  });

  it('rejects a truncated UUID', () => {
    expect(() => assertUuidQueryParam(validUuid.slice(0, 30), 'bookId')).toThrow(AppError);
  });

  it('rejects an empty string', () => {
    expect(() => assertUuidQueryParam('', 'bookId')).toThrow(AppError);
  });
});

describe('assertUuidPathParam', () => {
  it('returns the value unchanged for a valid UUID', () => {
    expect(assertUuidPathParam(validUuid, 'id')).toBe(validUuid);
  });

  it('throws a 400 VALIDATION_ERROR for a non-UUID value', () => {
    try {
      assertUuidPathParam('not-a-uuid', 'id');
      throw new Error('expected assertUuidPathParam to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('VALIDATION_ERROR');
      expect(appErr.status).toBe(400);
      expect(appErr.message).toBe('id must be a valid UUID');
    }
  });

  it('rejects a truncated UUID', () => {
    expect(() => assertUuidPathParam(validUuid.slice(0, 30), 'id')).toThrow(AppError);
  });

  it('rejects an empty string', () => {
    expect(() => assertUuidPathParam('', 'id')).toThrow(AppError);
  });
});
