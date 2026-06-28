import { describe, it, expect, vi } from 'vitest';
import { ZodError, z } from 'zod';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import { AppError } from '../../../src/lib/errors.js';

// Minimal stub of the Hono context: only c.json(body, status) is used.
function makeCtx() {
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
  return { json } as any;
}

describe('errorHandler', () => {
  it('maps a SyntaxError (malformed JSON body) to 400 VALIDATION_ERROR', () => {
    const c = makeCtx();
    const res: any = errorHandler(new SyntaxError('Unexpected end of JSON input'), c);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body', status: 400 },
    });
  });

  it('does not log a SyntaxError as an unhandled error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorHandler(new SyntaxError('bad'), makeCtx());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('passes through an AppError with its own code and status', () => {
    const c = makeCtx();
    const res: any = errorHandler(new AppError('NOT_FOUND', 'Book not found', 404), c);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Book not found', status: 404 },
    });
  });

  it('maps a ZodError to 400 VALIDATION_ERROR', () => {
    const c = makeCtx();
    let zErr: ZodError;
    try {
      z.object({ name: z.string() }).parse({ name: 123 });
      throw new Error('expected zod to throw');
    } catch (e) {
      zErr = e as ZodError;
    }
    const res: any = errorHandler(zErr!, c);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('falls through to 500 INTERNAL_ERROR for an unknown error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = makeCtx();
    const res: any = errorHandler(new Error('boom'), c);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
