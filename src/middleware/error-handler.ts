import type { ErrorHandler } from 'hono';
import { AppError } from '../lib/errors.js';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message, status: err.status } },
      err.status as any
    );
  }
  console.error('Unhandled error:', err);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', status: 500 } },
    500
  );
};
