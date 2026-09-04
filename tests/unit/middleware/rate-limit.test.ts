import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rateLimiter } from '../../../src/middleware/rate-limit.js';
import { AppError } from '../../../src/lib/errors.js';

// Minimal stub of the Hono context: the middleware only reads c.get('user')
// and c.req.header('x-forwarded-for').
function makeCtx(userId: string | null) {
  return {
    get: (k: string) => (k === 'user' && userId ? { id: userId } : undefined),
    req: { header: () => undefined },
  } as any;
}

const next = async () => {};

/** Run the middleware once; returns true when allowed, false on a 429. */
async function hit(mw: (c: any, n: any) => Promise<void>, userId: string): Promise<boolean> {
  try {
    await mw(makeCtx(userId), next);
    return true;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(429);
    return false;
  }
}

describe('rateLimiter store namespacing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not spend one limiter budget on another limiter traffic', async () => {
    const reads = rateLimiter(120, 60_000);
    const avatar = rateLimiter(5, 3_600_000);
    const user = 'user-cross-spend';

    // Ten ordinary reads — more than the avatar limiter's whole budget.
    for (let i = 0; i < 10; i++) expect(await hit(reads, user)).toBe(true);

    // The avatar limiter must still have its full 5 allowance.
    for (let i = 0; i < 5; i++) expect(await hit(avatar, user)).toBe(true);
    expect(await hit(avatar, user)).toBe(false);
  });

  it('a short-window limiter does not erase a long-window limiter history', async () => {
    const reads = rateLimiter(120, 60_000);
    const upload = rateLimiter(3, 3_600_000);
    const user = 'user-erosion';

    // Spend the whole long-window budget, interleaving cheap short-window calls.
    for (let i = 0; i < 3; i++) {
      expect(await hit(upload, user)).toBe(true);
      expect(await hit(reads, user)).toBe(true);
      // Advance past the short-window limiter's window so its filter/write-back
      // runs over a fully expired array on the next call.
      vi.advanceTimersByTime(61_000);
      expect(await hit(reads, user)).toBe(true);
    }

    // ~3 minutes in, well inside the 1h window: the budget must still be spent.
    expect(await hit(upload, user)).toBe(false);
  });

  it('expires timestamps once its own window has passed', async () => {
    const limiter = rateLimiter(2, 60_000);
    const user = 'user-window';

    expect(await hit(limiter, user)).toBe(true);
    expect(await hit(limiter, user)).toBe(true);
    expect(await hit(limiter, user)).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(await hit(limiter, user)).toBe(true);
  });

  it('keeps separate users isolated within one limiter', async () => {
    const limiter = rateLimiter(2, 60_000);

    expect(await hit(limiter, 'user-a')).toBe(true);
    expect(await hit(limiter, 'user-a')).toBe(true);
    expect(await hit(limiter, 'user-a')).toBe(false);

    expect(await hit(limiter, 'user-b')).toBe(true);
  });
});
