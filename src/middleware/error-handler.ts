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
  // The reader went away mid-call: src/ai/providers.ts rethrows the request's
  // own abort untouched. A route that didn't catch it answers 499 (client
  // closed request), not a logged 500 (KAN-366). Provider failures never get
  // here as raw errors: src/ai/service.ts turns them into AI_* AppErrors
  // (BYOK, 2026-11-17; the Anthropic SDK branches that were here are gone with
  // the server key).
  if (err.name === 'AbortError') {
    return new Response(null, { status: 499 });
  }
  // A chunked body that ran past bodyLimit's cap (middleware/body-limit.ts).
  // The middleware swaps in its own 413 after this returns; answering here
  // just keeps a rejected oversized upload out of the error log (KAN-404).
  if (err.name === 'BodyLimitError') {
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large', status: 413 } }, 413);
  }
  console.error('Unhandled error:', err);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', status: 500 } },
    500
  );
};
