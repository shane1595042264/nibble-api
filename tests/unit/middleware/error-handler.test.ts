import { describe, it, expect, vi } from 'vitest';
import { ZodError, z } from 'zod';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import {
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { AppError, Errors } from '../../../src/lib/errors.js';

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

  // KAN-366: Anthropic SDK errors used to fall through to the catch-all, so a
  // routine 429/529 reached the reader as INTERNAL_ERROR 500 raw JSON.
  describe('Anthropic SDK errors (KAN-366)', () => {
    const headers = new Headers();
    const transient: Array<[string, Error]> = [
      ['RateLimitError 429', new RateLimitError(429, undefined, 'rate limited', headers)],
      ['overloaded 529', new InternalServerError(529, undefined, 'overloaded', headers)],
      ['InternalServerError 500', new InternalServerError(500, undefined, 'boom', headers)],
      ['APIConnectionTimeoutError', new APIConnectionTimeoutError()],
    ];

    it.each(transient)('maps %s to 503 AI_UNAVAILABLE and only warns', (_label, err) => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res: any = errorHandler(err, makeCtx());
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('AI_UNAVAILABLE');
      expect(res.body.error.message).toMatch(/try again/);
      expect(errSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('maps a non-transient Anthropic error (401) to 502 AI_ERROR and logs it as an error', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res: any = errorHandler(new AuthenticationError(401, undefined, 'bad key', headers), makeCtx());
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('AI_ERROR');
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('answers an uncaught APIUserAbortError with 499, not 500', () => {
      const res: any = errorHandler(new APIUserAbortError(), makeCtx());
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(499);
    });

    it("passes 'Anthropic not configured' through as 503 AI_UNAVAILABLE", () => {
      const res: any = errorHandler(Errors.aiUnavailable('Anthropic not configured'), makeCtx());
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('AI_UNAVAILABLE');
    });
  });
});
