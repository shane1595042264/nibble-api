import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimiter } from '../../../src/middleware/rate-limit.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

// Mirrors the /users registration in src/index.ts. The password route is the
// expensive one — bcryptjs is pure JS, so compare + hash at rounds=12 blocks the
// single Node process for ~375ms — and users.ts's failure-only lockout never
// ticks when the caller replays its OWN correct password, leaving the replay
// uncapped before KAN-317. Order matters: the two specific paths must be
// registered before the broad /users/* line.
function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);

  const auth = (c: any, next: any) => {
    c.set('user', { id: 'user-kan317' });
    return next();
  };

  app.use('/users/me/avatar', auth, rateLimiter(5, 3_600_000));
  app.use('/users/me/password', auth, rateLimiter(10, 3_600_000));
  app.use('/users/*', auth, rateLimiter(30));

  const routes = new Hono();
  routes.get('/me', (c) => c.json({ id: 'user-kan317' }));
  routes.put('/me', (c) => c.json({ updated: true }));
  routes.post('/me/password', (c) => c.json({ success: true }));
  routes.post('/me/avatar', (c) => c.json({ avatarUrl: 'x' }));
  app.route('/users', routes);

  return app;
}

const postPassword = (app: Hono) =>
  app.request('/users/me/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The abuse shape: same value both sides, so the request always succeeds
    // and records zero failures against the lockout.
    body: JSON.stringify({ currentPassword: 'admin123', newPassword: 'admin123' }),
  });

describe('/users rate limits', () => {
  it('caps a correct-password replay that the failure lockout never sees', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      expect((await postPassword(app)).status).toBe(200);
    }
    const blocked = await postPassword(app);
    expect(blocked.status).toBe(429);
  });

  it('answers the 429 with a Retry-After the settings form can render', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) await postPassword(app);

    const blocked = await postPassword(app);
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get('Retry-After'));
    // The hour-long window, not a defaulted minute — the form divides by 60.
    expect(retryAfter).toBeGreaterThan(3500);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(await blocked.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests', status: 429 },
    });
  });

  it('still allows the handful of genuine password changes a year needs', async () => {
    const app = makeApp();
    // A real change is fill-in-the-form once; even a few typo retries fit.
    for (let i = 0; i < 5; i++) {
      expect((await postPassword(app)).status).toBe(200);
    }
  });

  it('does not let profile reads spend the password budget', async () => {
    const app = makeApp();
    // Settings mount + avatar resolution + saves, all under the broad limiter.
    for (let i = 0; i < 25; i++) {
      expect((await app.request('/users/me')).status).toBe(200);
    }
    expect((await postPassword(app)).status).toBe(200);
  });

  it('does not let the password route starve GET /users/me', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) await postPassword(app);
    expect((await postPassword(app)).status).toBe(429);

    // The profile read is cheap and must survive the password route's lockdown.
    expect((await app.request('/users/me')).status).toBe(200);
  });

  it('caps the rest of /users/* too, so no verb is left unlimited', async () => {
    const app = makeApp();
    for (let i = 0; i < 30; i++) {
      expect((await app.request('/users/me')).status).toBe(200);
    }
    const blocked = await app.request('/users/me', { method: 'PUT' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
  });

  it('leaves the avatar limiter independent of the new ones', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) await postPassword(app);
    expect((await postPassword(app)).status).toBe(429);

    // 5/hour of its own, untouched by the password traffic above.
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/users/me/avatar', { method: 'POST' })).status).toBe(200);
    }
    expect((await app.request('/users/me/avatar', { method: 'POST' })).status).toBe(429);
  });
});
