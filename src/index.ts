import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { config } from './lib/config.js';
import { db } from './db/index.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { authMiddleware } from './middleware/auth.js';
import { adminMiddleware } from './middleware/admin.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { aiAccessMiddleware } from './middleware/ai-access.js';
import { healthRoutes } from './routes/health.js';
import { bookRoutes } from './routes/books.js';
import { chapterRoutes } from './routes/chapters.js';
import { sectionRoutes } from './routes/sections.js';
import { vocabularyRoutes } from './routes/vocabulary.js';
import { settingsRoutes } from './routes/settings.js';
import { syncRoutes } from './routes/sync.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';
import { aiRoutes } from './routes/ai.js';
import { processingRoutes } from './routes/processing.js';
import { userRoutes } from './routes/users.js';
import { runCleanup } from './jobs/cleanup.js';
import { startWorker } from './jobs/process-pdf.js';

// Run database migrations on startup
console.log('Running database migrations...');
await migrate(db, { migrationsFolder: './dist/db/migrations' });
console.log('Migrations complete.');

const app = new Hono().basePath('/api');

// Global middleware
app.use('*', corsMiddleware);
app.onError(errorHandler);

// Public routes
app.route('/health', healthRoutes);

// Stripe webhook (no auth — verified by Stripe signature)
app.post('/billing/webhook', async (c) => {
  const { billingService } = await import('./services/billing.service.js');
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'Missing signature' }, 400);
  const body = await c.req.text();
  await billingService.handleWebhook(body, signature);
  return c.json({ received: true });
});

// Auth-protected routes
app.use('/books/*', authMiddleware);
app.use('/chapters/*', authMiddleware);
app.use('/sections/*', authMiddleware);
app.use('/vocabulary/*', authMiddleware);
app.use('/settings/*', authMiddleware);
app.use('/sync/*', authMiddleware, rateLimiter(30));
app.use('/ai/*', authMiddleware, rateLimiter(60), aiAccessMiddleware);
app.use('/processing/*', authMiddleware);
app.use('/billing/*', authMiddleware);
app.use('/users/me/avatar', authMiddleware, rateLimiter(5, 3600000));
app.use('/users/*', authMiddleware);
app.use('/admin/*', authMiddleware, adminMiddleware);

app.route('/users', userRoutes);
app.route('/books', bookRoutes);
app.route('/chapters', chapterRoutes);
app.route('/sections', sectionRoutes);
app.route('/vocabulary', vocabularyRoutes);
app.route('/settings', settingsRoutes);
app.route('/sync', syncRoutes);
app.route('/ai', aiRoutes);
app.route('/processing', processingRoutes);
app.route('/billing', billingRoutes);
app.route('/admin', adminRoutes);

// Start background workers
startWorker();
setInterval(runCleanup, 60 * 60 * 1000);

serve({ fetch: app.fetch, port: config.PORT }, () => {
  console.log(`nibble-api running on port ${config.PORT}`);
});

export default app;
