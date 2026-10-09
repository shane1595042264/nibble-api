import { billingRepository } from '../repositories/billing.repository.js';

type StuckJobRow = {
  id: string;
  status: string;
  createdAt: Date;
  processingCostCents: number | null;
  stripePaymentIntentId: string | null;
};

export type StuckJobAction =
  | { id: string; action: 'retry' }
  | { id: string; action: 'auto-fail'; stripePaymentIntentId: string | null };

export type RecoveredJob = { id: string; fileHash: string; bookId: string | null };
export type AutoFailedJob = { id: string; bookId: string | null; stripePaymentIntentId: string | null };

const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const RETRY_WINDOW_MS = 60 * 60 * 1000;
const AUTO_FAIL_ERROR = 'Auto-failed: stuck > 1h with no completion';
const ACTIVE_STATUSES = ['pending', 'processing'];

/**
 * Decide what to do with each stale active job (no update for STUCK_THRESHOLD_MS).
 *
 * Skipped entirely:
 * - jobs whose pipeline is still running in this process — a slow stage, not a
 *   dead one, so re-running it would double-run the pipeline;
 * - 'pending' jobs with a processing cost. That is a Stripe job awaiting payment
 *   or a free /processing/start job the worker polls on its own; neither is stuck.
 *
 * Everything else is an orphan of a process that died mid-pipeline: a
 * 'processing' job, or an upload/retry job (NULL cost) that died before its
 * first progress write. Younger than the retry window it is re-run, older it is
 * failed (KAN-340).
 */
export function planStuckJobActions(
  stuck: StuckJobRow[],
  now: Date = new Date(),
  retryWindowMs: number = RETRY_WINDOW_MS,
  inFlight: ReadonlySet<string> = new Set(),
): StuckJobAction[] {
  const cutoff = now.getTime() - retryWindowMs;
  return stuck
    .filter((job) => !inFlight.has(job.id))
    .filter((job) => job.status !== 'pending' || job.processingCostCents === null)
    .map((job) =>
      job.createdAt.getTime() > cutoff
        ? { id: job.id, action: 'retry' }
        : { id: job.id, action: 'auto-fail', stripePaymentIntentId: job.stripePaymentIntentId },
    );
}

export const jobQueue = {
  async pollForJobs() {
    return billingRepository.findPendingPaid();
  },

  async markProcessing(jobId: string) {
    await billingRepository.updateJobStatus(jobId, { status: 'processing' });
  },

  async markCompleted(jobId: string) {
    await billingRepository.updateJobStatus(jobId, { status: 'completed', progress: 100 });
  },

  async markFailed(jobId: string, error: string) {
    await billingRepository.updateJobStatus(jobId, { status: 'failed', error });
  },

  /**
   * Sweep orphaned jobs. Returns the jobs claimed for a re-run (the caller must
   * dispatch them — nothing polls for an unpaid 'pending' job, so resetting one
   * to 'pending' would strand it) and the jobs that were auto-failed.
   */
  async recoverStuckJobs(): Promise<{ resumed: RecoveredJob[]; autoFailed: AutoFailedJob[] }> {
    const { db } = await import('../db/index.js');
    const { processingJobs, books } = await import('../db/schema.js');
    const { eq, lt, and, inArray } = await import('drizzle-orm');
    const { inFlightJobIds } = await import('./in-flight.js');
    const { sectionRepository } = await import('../repositories/section.repository.js');
    const { chapterRepository } = await import('../repositories/chapter.repository.js');

    const stuckThreshold = new Date(Date.now() - STUCK_THRESHOLD_MS);
    // Re-checked on every claim: whichever sweeper flips the row first bumps
    // updated_at, so a second container mid-redeploy can't also claim it.
    const stillStuck = (id: string) => and(
      eq(processingJobs.id, id),
      inArray(processingJobs.status, ACTIVE_STATUSES),
      lt(processingJobs.updatedAt, stuckThreshold),
    );

    const stuck = await db
      .select({
        id: processingJobs.id,
        status: processingJobs.status,
        createdAt: processingJobs.createdAt,
        processingCostCents: processingJobs.processingCostCents,
        stripePaymentIntentId: processingJobs.stripePaymentIntentId,
      })
      .from(processingJobs)
      .where(
        and(
          inArray(processingJobs.status, ACTIVE_STATUSES),
          lt(processingJobs.updatedAt, stuckThreshold),
        ),
      );

    const actions = planStuckJobActions(stuck, new Date(), RETRY_WINDOW_MS, inFlightJobIds);
    const resumed: RecoveredJob[] = [];
    const autoFailed: AutoFailedJob[] = [];

    for (const a of actions) {
      if (a.action === 'retry') {
        const claimed = await db.transaction(async (tx) => {
          const [job] = await tx
            .update(processingJobs)
            .set({ status: 'processing', progress: 0 })
            .where(stillStuck(a.id))
            .returning();
          if (!job) return null;
          if (job.bookId) {
            // The dead run may have built part of the structure already; the
            // re-run builds it from scratch. Soft-delete, as the /retry route does,
            // so other devices get tombstones (KAN-229 / KAN-254).
            await sectionRepository.softDeleteByBookId(job.bookId, tx);
            await chapterRepository.softDeleteByBookId(job.bookId, tx);
            await tx.update(books).set({ processingStatus: 'processing' })
              .where(eq(books.id, job.bookId));
          }
          return job;
        });
        if (claimed) resumed.push({ id: claimed.id, fileHash: claimed.fileHash, bookId: claimed.bookId });
      } else {
        const [job] = await db
          .update(processingJobs)
          .set({ status: 'failed', error: AUTO_FAIL_ERROR })
          .where(stillStuck(a.id))
          .returning({ id: processingJobs.id, bookId: processingJobs.bookId });
        if (job) autoFailed.push({ id: job.id, bookId: job.bookId, stripePaymentIntentId: a.stripePaymentIntentId });
      }
    }

    return { resumed, autoFailed };
  },
};
