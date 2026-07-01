import { z } from 'zod';
import { AppError } from './errors.js';

export const MAX_LIST_ROWS = 5000;

const uuidQuerySchema = z.string().uuid();

/**
 * Validate a query-param value as a UUID before it reaches a Postgres uuid
 * column. An unvalidated non-UUID value triggers Postgres error 22P02
 * ('invalid input syntax for type uuid'), which is not an AppError/ZodError/
 * SyntaxError and so surfaces as an opaque 500 'Unhandled error'. Throw a
 * 400 VALIDATION_ERROR naming the param instead — mirroring the z.string().uuid()
 * guards the POST handlers already use.
 */
export function assertUuidQueryParam(value: string, paramName: string): string {
  if (!uuidQuerySchema.safeParse(value).success) {
    throw new AppError('VALIDATION_ERROR', `${paramName} must be a valid UUID`, 400);
  }
  return value;
}

interface CapWarnContext {
  entity: string;
  userId?: string;
  scope?: Record<string, unknown>;
}

export function warnIfCapped<T>(rows: T[], context: CapWarnContext): T[] {
  if (rows.length >= MAX_LIST_ROWS) {
    console.warn(
      '[query-cap] result truncated at MAX_LIST_ROWS ' +
        JSON.stringify({
          entity: context.entity,
          userId: context.userId,
          scope: context.scope,
          cap: MAX_LIST_ROWS,
          returned: rows.length,
        }),
    );
  }
  return rows;
}
