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

export function rateLimiter(maxRequests: number = 120, windowMs: number = 60000) {
  if (windowMs > maxWindowMs) maxWindowMs = windowMs;
  return async (c: Context, next: Next) => {
    const user = c.get('user');
    const key = user?.id ?? c.req.header('x-forwarded-for') ?? 'anonymous';

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
