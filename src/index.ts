import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './lib/config.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';

const app = new Hono().basePath('/api');

// Global middleware
app.use('*', corsMiddleware);
app.onError(errorHandler);

// Public routes
app.route('/health', healthRoutes);

// Auth-protected routes will be mounted here in later tasks

serve({ fetch: app.fetch, port: config.PORT }, () => {
  console.log(`nibble-api running on port ${config.PORT}`);
});

export default app;
