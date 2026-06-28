import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message, status: err.status } },
      err.status as any
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: err.issues.map((e) => `${String(e.path.join('.'))}: ${e.message}`).join('; '), status: 400 } },
      400
    );
  }
  // A request-time SyntaxError comes from c.req.json() failing to parse a
  // malformed/empty body — that's a client (4xx) error, not a server fault.
  if (err instanceof SyntaxError) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body', status: 400 } },
      400
    );
  }
  console.error('Unhandled error:', err);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', status: 500 } },
    500
  );
};
