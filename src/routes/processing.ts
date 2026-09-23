import { Hono } from 'hono';
import { z } from 'zod';
import { billingRepository } from '../repositories/billing.repository.js';
import { billingService } from '../services/billing.service.js';
import { bookRepository } from '../repositories/book.repository.js';
import { bookService } from '../services/book.service.js';
import { processingLogRepository } from '../repositories/processing-log.repository.js';
import { db } from '../db/index.js';
import { nibCache, processingJobs } from '../db/schema.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { sectionRepository } from '../repositories/section.repository.js';
import { eq } from 'drizzle-orm';
import { storageService } from '../services/storage.service.js';
import { ACTIVE_JOB_CONFLICT, AppError, Errors, isUniqueViolation } from '../lib/errors.js';
import { hasFreeAiAccess } from '../lib/billing-access.js';
import { assertUuidPathParam } from '../lib/query-guards.js';

export const processingRoutes = new Hono();

// idx_processing_jobs_active_file_hash is a partial unique index on file_hash
// alone — not user-scoped — and file_hash is content-addressed, so an active job
// started by ANY user for the same file blocks this insert. Turn the resulting
// 23505 into an actionable 409 instead of an opaque 500 (KAN-302). The copy now
// lives in lib/errors.ts so the upload path raises the same class of 409 for the
// same index (KAN-322).
async function createJobOrConflict(data: Parameters<typeof billingRepository.createJob>[0]) {
  try {
    return await billingRepository.createJob(data);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw Errors.conflict(ACTIVE_JOB_CONFLICT);
  }
}

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
    const job = await createJobOrConflict({
      fileHash: catalog.fileHash,
      userId: user.id,
      bookId: book.id,
      status: 'pending',
      processingCostCents: 0,
      paid: true,
    });
    await bookRepository.update(book.id, { processingStatus: 'pending' });
    return c.json({ jobId: job.id, free: true });
  }

  // Regular users pay via Stripe. createPaymentIntent rejects a 0-page catalog
  // with a 500, so bail out first — otherwise we leave a zero-cost job row
  // behind and strand the book on processingStatus 'pending'.
  if (!catalog.totalPages || catalog.totalPages <= 0) {
    throw Errors.badRequest('Book has no page count yet — wait for processing to finish before paying');
  }
  const job = await createJobOrConflict({
    fileHash: catalog.fileHash,
    userId: user.id,
    bookId: book.id,
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
  assertUuidPathParam(jobId, 'jobId');

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
  assertUuidPathParam(jobId, 'jobId');

  // Claim + deletes + insert all run in ONE transaction. The claim flips the
  // source row out of 'failed', which is both the mutex against a concurrent
  // /retry and a terminal state — so if anything below it fails, the claim has
  // to roll back with it or the book is left with a job that can never be
  // retried again (KAN-302).
  let outcome: { kind: 'claim-failed' } | { kind: 'no-book' } | { kind: 'created'; newJob: typeof processingJobs.$inferSelect; bookId: string; fileHash: string };
  try {
    outcome = await db.transaction(async (tx) => {
      const claimed = await processingLogRepository.claimFailedForRetry(jobId, user.id, tx);
      if (!claimed) return { kind: 'claim-failed' as const };
      if (!claimed.bookId) return { kind: 'no-book' as const };

      const book = await bookRepository.findById(claimed.bookId);
      if (!book) throw Errors.notFound('Book');

      // idx_processing_jobs_active_file_hash is global, not user-scoped, so
      // another user's in-flight job for this same content-addressed file would
      // make the insert below raise 23505. Bail out before we spend the claim.
      const active = await processingLogRepository.findActiveJobByFileHash(claimed.fileHash, tx);
      if (active) throw Errors.conflict(ACTIVE_JOB_CONFLICT);

      // Soft-delete old chapters/sections from the failed attempt so sync ships
      // deletedAt tombstones to other devices instead of leaving them with stale
      // structure that they could resurrect on their next push (KAN-229 / KAN-254).
      await sectionRepository.softDeleteByBookId(book.id, tx);
      await chapterRepository.softDeleteByBookId(book.id, tx);

      // Create a new processing job
      const [createdJob] = await tx.insert(processingJobs).values({
        fileHash: claimed.fileHash,
        userId: user.id,
        bookId: book.id,
        status: 'pending',
      }).returning();

      return { kind: 'created' as const, newJob: createdJob, bookId: book.id, fileHash: claimed.fileHash };
    });
  } catch (err) {
    // The pre-check above can still lose to an insert that committed after our
    // select. The tx (claim included) is already rolled back at this point, so
    // the job is back in 'failed' and the user's Retry button still works.
    if (!isUniqueViolation(err)) throw err;
    throw Errors.conflict(ACTIVE_JOB_CONFLICT);
  }

  if (outcome.kind === 'claim-failed') {
    const existing = await processingLogRepository.getJob(jobId);
    if (!existing || existing.userId !== user.id) throw Errors.notFound('Processing job');
    if (existing.status === 'failed') {
      // Shouldn't happen: claim returned null but row is still 'failed'.
      return c.json({ error: 'Could not claim job for retry' }, 409);
    }
    if (existing.status === 'superseded') {
      return c.json({ error: 'Job already retried' }, 409);
    }
    return c.json({ error: 'Only failed jobs can be retried' }, 400);
  }

  if (outcome.kind === 'no-book') {
    return c.json({ error: 'No book associated with this job' }, 400);
  }

  const { newJob, bookId, fileHash } = outcome;
  await bookRepository.update(bookId, { processingStatus: 'processing' });

  // Fire-and-forget pipeline
  setTimeout(async () => {
    try {
      const { processingService } = await import('../services/processing.service.js');
      await processingService.orchestratePipeline(newJob.id, fileHash, bookId);
    } catch (err: any) {
      console.error('Retry processing pipeline failed:', err);
      const errorMessage = err?.message ?? 'Unknown error';
      await processingLogRepository.failJob(newJob.id, errorMessage).catch(() => {});
      await bookRepository.update(bookId, { processingStatus: 'error' }).catch(() => {});
    }
  }, 0);

  return c.json({ jobId: newJob.id });
});

// Check processing status
processingRoutes.get('/:jobId', async (c) => {
  const user = c.get('user');
  const jobId = c.req.param('jobId');
  assertUuidPathParam(jobId, 'jobId');

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
  assertUuidPathParam(jobId, 'jobId');

  const job = await processingLogRepository.getJob(jobId);
  if (!job || job.userId !== user.id) throw Errors.notFound('Processing job');

  const sinceSchema = z.string().datetime().optional();
  const parsed = sinceSchema.safeParse(c.req.query('since'));
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'since must be an ISO 8601 datetime', 400);
  }
  const since = parsed.data ? new Date(parsed.data) : undefined;

  const logs = await processingLogRepository.getByJobId(jobId, since);
  return c.json({ logs });
});

// Download full log as text/plain
processingRoutes.get('/:jobId/logs/download', async (c) => {
  const user = c.get('user');
  const jobId = c.req.param('jobId');
  assertUuidPathParam(jobId, 'jobId');

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
