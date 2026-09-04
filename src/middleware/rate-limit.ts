import type { Context, Next } from 'hono';
import { Errors } from '../lib/errors.js';

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Cleanup eviction must respect the longest configured window so per-request
// filtering still has timestamps to inspect. Otherwise long-window limiters
// (e.g. 5/hour) degrade to ~5/cleanup-interval.
let maxWindowMs = 60000;

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter(t => now - t < maxWindowMs);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}, 60000);

// Every rateLimiter() instance gets its own namespace in the shared store.
// Without it all limiters read/write one timestamp array per user, so a
// long-window limiter counts unrelated traffic (spurious 429s) and a
// short-window limiter's write-back below erases the long-window history
// (silently defeated caps). An instance id rather than a maxRequests:windowMs
// prefix keeps the several rateLimiter(120) registrations independent too.
let limiterInstances = 0;

export function rateLimiter(maxRequests: number = 120, windowMs: number = 60000) {
  if (windowMs > maxWindowMs) maxWindowMs = windowMs;
  const keyPrefix = `rl${++limiterInstances}:`;
  return async (c: Context, next: Next) => {
    const user = c.get('user');
    const identity = user?.id ?? c.req.header('x-forwarded-for') ?? 'anonymous';
    const key = keyPrefix + identity;

    const now = Date.now();
    const entry = store.get(key) ?? { timestamps: [] };

    // Remove timestamps outside window
    entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      throw Errors.rateLimited();
    }

    entry.timestamps.push(now);
    store.set(key, entry);

    await next();
  };
}

// Failure-only counter for endpoints where the limit should only tick on a real
// auth failure (e.g. wrong password) — not on schema validation errors. Uses the
// same store + cleanup as rateLimiter, with a key prefix to avoid collisions.
const FAILURE_KEY_PREFIX = 'fail:';

export function checkFailureLockout(
  key: string,
  maxFailures: number,
  windowMs: number,
): { locked: boolean; retryAfterMs: number } {
  if (windowMs > maxWindowMs) maxWindowMs = windowMs;
  const k = FAILURE_KEY_PREFIX + key;
  const now = Date.now();
  const entry = store.get(k) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
  store.set(k, entry);
  if (entry.timestamps.length >= maxFailures) {
    const oldest = entry.timestamps[0]!;
    return { locked: true, retryAfterMs: windowMs - (now - oldest) };
  }
  return { locked: false, retryAfterMs: 0 };
}

export function recordFailure(key: string, windowMs: number): void {
  if (windowMs > maxWindowMs) maxWindowMs = windowMs;
  const k = FAILURE_KEY_PREFIX + key;
  const now = Date.now();
  const entry = store.get(k) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
  entry.timestamps.push(now);
  store.set(k, entry);
}
