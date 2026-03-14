import { Hono } from 'hono';
import { z } from 'zod';
import { billingRepository } from '../repositories/billing.repository.js';
import { billingService } from '../services/billing.service.js';
import { bookRepository } from '../repositories/book.repository.js';
import { bookService } from '../services/book.service.js';
import { processingLogRepository } from '../repositories/processing-log.repository.js';
import { db } from '../db/index.js';
import { nibCache } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { storageService } from '../services/storage.service.js';
import { Errors } from '../lib/errors.js';
import { hasFreeAiAccess } from '../lib/billing-access.js';

export const processingRoutes = new Hono();

// Start AI processing for an existing book (triggers payment or free bypass)
processingRoutes.post('/start', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { bookId } = z.object({ bookId: z.string() }).parse(body);

  // Verify book ownership
  const book = await bookService.getBook(bookId, user.id);

  // Get catalog entry for total pages
  const catalog = await bookRepository.findCatalogById(book.catalogId);
  if (!catalog) throw Errors.notFound('Catalog entry');

  // Check if already processed
  if (book.processingStatus === 'complete') {
    return c.json({ error: 'Book already processed' }, 400);
  }

  // Check for existing .nib cache
  const [existing] = await db.select().from(nibCache).where(eq(nibCache.fileHash, catalog.fileHash)).limit(1);
  if (existing) {
    await bookRepository.update(book.id, { processingStatus: 'complete', structureSource: 'ai' });
    const nibUrl = await storageService.getNibUrl(existing.r2Key);
    return c.json({ status: 'already_processed', nibUrl });
  }

  // Free users bypass Stripe
  if (hasFreeAiAccess(user)) {
    const job = await billingRepository.createJob({
      fileHash: catalog.fileHash,
      userId: user.id,
      status: 'pending',
      processingCostCents: 0,
      paid: true,
    });
    await bookRepository.update(book.id, { processingStatus: 'pending' });
    return c.json({ jobId: job.id, free: true });
  }

  // Regular users pay via Stripe
  const job = await billingRepository.createJob({
    fileHash: catalog.fileHash,
    userId: user.id,
    status: 'pending',
    processingCostCents: (catalog.totalPages ?? 0) * 5,
  });
  await bookRepository.update(book.id, { processingStatus: 'pending' });
  const payment = await billingService.createPaymentIntent(user.id, job.id, catalog.totalPages ?? 0);
  return c.json({ jobId: job.id, ...payment });
});

// Cancel a processing job
processingRoutes.post('/:jobId/cancel', async (c) => {
  const user = c.get('user');
  const jobId = c.req.param('jobId');

  const job = await processingLogRepository.getJob(jobId);
  if (!job || job.userId !== user.id) throw Errors.notFound('Processing job');

  if (job.status === 'completed') {
    return c.json({ error: 'Job already completed' }, 400);
  }

  const { processingService } = await import('../services/processing.service.js');
  await processingService.cancelJob(jobId);
  return c.json({ cancelled: true });
});

// Check processing status
processingRoutes.get('/:jobId', async (c) => {
  const user = c.get('user');
  const jobId = c.req.param('jobId');

  const job = await processingLogRepository.getJob(jobId);
  if (!job || job.userId !== user.id) throw Errors.notFound('Processing job');

  let nibUrl: string | undefined;
  if (job.status === 'completed') {
    const [cache] = await db.select().from(nibCache).where(eq(nibCache.fileHash, job.fileHash)).limit(1);
    if (cache) {
      nibUrl = await storageService.getNibUrl(cache.r2Key);
    }
  }

  return c.json({
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    error: job.error,
    bookId: job.bookId,
    nibUrl,
  });
});

// Get log entries for a processing job
processingRoutes.get('/:jobId/logs', async (c) => {
  const user = c.get('user');
  const jobId = c.req.param('jobId');

  const job = await processingLogRepository.getJob(jobId);
  if (!job || job.userId !== user.id) throw Errors.notFound('Processing job');

  const sinceParam = c.req.query('since');
  const since = sinceParam ? new Date(sinceParam) : undefined;

  const logs = await processingLogRepository.getByJobId(jobId, since);
  return c.json(logs);
});

// Download full log as text/plain
processingRoutes.get('/:jobId/logs/download', async (c) => {
  const user = c.get('user');
  const jobId = c.req.param('jobId');

  const job = await processingLogRepository.getJob(jobId);
  if (!job || job.userId !== user.id) throw Errors.notFound('Processing job');

  const logs = await processingLogRepository.getByJobId(jobId);

  const logText = logs
    .map(log => `[${log.timestamp.toISOString()}] [${log.level.toUpperCase()}] [${log.stage}] ${log.message}`)
    .join('\n');

  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="processing-${jobId}.log"`);
  return c.body(logText);
});
