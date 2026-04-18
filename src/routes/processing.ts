import { Hono } from 'hono';
import { z } from 'zod';
import { billingRepository } from '../repositories/billing.repository.js';
import { billingService } from '../services/billing.service.js';
import { bookRepository } from '../repositories/book.repository.js';
import { bookService } from '../services/book.service.js';
import { processingLogRepository } from '../repositories/processing-log.repository.js';
import { db } from '../db/index.js';
import { nibCache, processingJobs, sections, chapters } from '../db/schema.js';
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
  const payment = await billingService.createPaymentIntent(user.id, job.id);
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

// Retry a failed processing job
processingRoutes.post('/:jobId/retry', async (c) => {
  const user = c.get('user');
  const jobId = c.req.param('jobId');

  const job = await processingLogRepository.getJob(jobId);
  if (!job || job.userId !== user.id) throw Errors.notFound('Processing job');

  if (job.status !== 'failed') {
    return c.json({ error: 'Only failed jobs can be retried' }, 400);
  }

  if (!job.bookId) {
    return c.json({ error: 'No book associated with this job' }, 400);
  }

  const book = await bookRepository.findById(job.bookId);
  if (!book) throw Errors.notFound('Book');

  // Wrap deletes + insert in a transaction to prevent data loss if any step fails
  const { newJob } = await db.transaction(async (tx) => {
    // Clean up old chapters/sections from the failed attempt
    await tx.delete(sections).where(eq(sections.bookId, book.id));
    await tx.delete(chapters).where(eq(chapters.bookId, book.id));

    // Create a new processing job
    const [createdJob] = await tx.insert(processingJobs).values({
      fileHash: job.fileHash,
      userId: user.id,
      bookId: book.id,
      status: 'pending',
    }).returning();

    return { newJob: createdJob };
  });

  await bookRepository.update(book.id, { processingStatus: 'processing' });

  // Fire-and-forget pipeline
  setTimeout(async () => {
    try {
      const { processingService } = await import('../services/processing.service.js');
      await processingService.orchestratePipeline(newJob.id, job.fileHash, book.id);
    } catch (err: any) {
      console.error('Retry processing pipeline failed:', err);
      const errorMessage = err?.message ?? 'Unknown error';
      await processingLogRepository.failJob(newJob.id, errorMessage).catch(() => {});
      await bookRepository.update(book.id, { processingStatus: 'error' }).catch(() => {});
    }
  }, 0);

  return c.json({ jobId: newJob.id });
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
  return c.json({ logs });
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
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
  c.header('Content-Disposition', `attachment; filename="processing-${safeJobId}.log"`);
  return c.body(logText);
});
