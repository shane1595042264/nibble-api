import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimiter } from '../../../src/middleware/rate-limit.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

// Mirrors the /processing registration in src/index.ts: auth on every method,
// rate limits split by method. The app polls its own GET surface hard (status
// every 3s per processing book + logs every 2s with the dialog open), so the GET
// cap must sit well above that floor while POST mutations stay tight (KAN-293).
function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);

  let authRuns = 0;
  app.use('/processing/*', async (c, next) => {
    authRuns++;
    c.set('user', { id: 'user-kan293' });
    await next();
  });
  app.on(['GET', 'HEAD'], '/processing/*', rateLimiter(240));
  app.on('POST', '/processing/*', rateLimiter(30));

  const routes = new Hono();
  routes.get('/:jobId', (c) => c.json({ status: 'processing' }));
  routes.get('/:jobId/logs', (c) => c.json({ logs: [] }));
  routes.post('/start', (c) => c.json({ started: true }));
  routes.post('/:jobId/retry', (c) => c.json({ retried: true }));
  app.route('/processing', routes);

  return { app, authRuns: () => authRuns };
}

describe('/processing rate limits', () => {
  it('lets the app poll status past the old 30/min cap', async () => {
    const { app } = makeApp();
    // The ticket's direct check: 40 status polls inside one window.
    for (let i = 0; i < 40; i++) {
      const res = await app.request('/processing/job-a');
      expect(res.status).toBe(200);
    }
  });

  it('shares the GET budget across status and logs without exhausting it', async () => {
    const { app } = makeApp();
    // One processing book (20/min) + its open log dialog (30/min) = 50/min.
    for (let i = 0; i < 20; i++) {
      expect((await app.request('/processing/job-b')).status).toBe(200);
    }
    for (let i = 0; i < 30; i++) {
      expect((await app.request('/processing/job-b/logs')).status).toBe(200);
    }
  });

  it('still caps POST mutations at 30 per window', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 30; i++) {
      const res = await app.request('/processing/start', { method: 'POST' });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request('/processing/start', { method: 'POST' });
    expect(blocked.status).toBe(429);
  });

  it('does not let GET polling spend the POST budget', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 100; i++) {
      expect((await app.request('/processing/job-c')).status).toBe(200);
    }
    // Retry must still be available after heavy polling.
    const res = await app.request('/processing/job-c/retry', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('rate limits HEAD too, so the method split leaves no unlimited verb', async () => {
    const { app } = makeApp();
    // Shares the GET budget: 240 allowed, the 241st is refused.
    for (let i = 0; i < 240; i++) {
      const res = await app.request('/processing/job-e', { method: 'HEAD' });
      expect(res.status).not.toBe(429);
    }
    const blocked = await app.request('/processing/job-e', { method: 'HEAD' });
    expect(blocked.status).toBe(429);
  });

  it('keeps auth on every method', async () => {
    const { app, authRuns } = makeApp();
    await app.request('/processing/job-d');
    await app.request('/processing/start', { method: 'POST' });
    await app.request('/processing/job-d', { method: 'DELETE' });
    expect(authRuns()).toBe(3);
  });
});
