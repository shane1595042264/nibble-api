import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { AppError, Errors } from '../lib/errors.js';

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
  // Anthropic SDK errors are not AppErrors. A 429/529/5xx or a connection
  // timeout is routine upstream load, not a server bug — answer 503 so the
  // reader can say "try again" and log it as a warning. Anything else (400,
  // 401, 404...) means our request or key is wrong: 502 and a real error log.
  // A client abort that reached here (route didn't catch it) is a 499 (KAN-366).
  if (err instanceof APIUserAbortError) {
    return new Response(null, { status: 499 });
  }
  if (err instanceof APIError) {
    if (err instanceof APIConnectionError || err.status === 429 || (err.status ?? 0) >= 500) {
      console.warn('Anthropic unavailable:', err.status ?? err.name, err.message);
      const e = Errors.aiUnavailable();
      return c.json({ error: { code: e.code, message: e.message, status: e.status } }, 503);
    }
    console.error('Anthropic API error:', err);
    const e = Errors.aiError('The AI service rejected the request');
    return c.json({ error: { code: e.code, message: e.message, status: e.status } }, 502);
  }
  console.error('Unhandled error:', err);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', status: 500 } },
    500
  );
};
