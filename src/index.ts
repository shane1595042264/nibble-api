import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './lib/config.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { authMiddleware } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { bookRoutes } from './routes/books.js';
import { chapterRoutes } from './routes/chapters.js';
import { sectionRoutes } from './routes/sections.js';
import { vocabularyRoutes } from './routes/vocabulary.js';
import { settingsRoutes } from './routes/settings.js';

const app = new Hono().basePath('/api');

// Global middleware
app.use('*', corsMiddleware);
app.onError(errorHandler);

// Public routes
app.route('/health', healthRoutes);

// Auth-protected routes
app.use('/books/*', authMiddleware);
app.use('/chapters/*', authMiddleware);
app.use('/sections/*', authMiddleware);
app.use('/vocabulary/*', authMiddleware);
app.use('/settings/*', authMiddleware);

app.route('/books', bookRoutes);
app.route('/chapters', chapterRoutes);
app.route('/sections', sectionRoutes);
app.route('/vocabulary', vocabularyRoutes);
app.route('/settings', settingsRoutes);

serve({ fetch: app.fetch, port: config.PORT }, () => {
  console.log(`nibble-api running on port ${config.PORT}`);
});

export default app;
