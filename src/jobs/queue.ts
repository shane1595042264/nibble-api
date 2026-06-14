import { billingRepository } from '../repositories/billing.repository.js';

type StuckJobRow = {
  id: string;
  createdAt: Date;
  stripePaymentIntentId: string | null;
};

export type StuckJobAction =
  | { id: string; action: 'retry' }
  | { id: string; action: 'auto-fail'; stripePaymentIntentId: string | null };

const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const RETRY_WINDOW_MS = 60 * 60 * 1000;
const AUTO_FAIL_ERROR = 'Auto-failed: stuck > 1h with no completion';

export function planStuckJobActions(
  stuck: StuckJobRow[],
  now: Date = new Date(),
  retryWindowMs: number = RETRY_WINDOW_MS,
): StuckJobAction[] {
  const cutoff = now.getTime() - retryWindowMs;
  return stuck.map((job) =>
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

  async retryStuckJobs(): Promise<Array<{ id: string; stripePaymentIntentId: string | null }>> {
    const { db } = await import('../db/index.js');
    const { processingJobs } = await import('../db/schema.js');
    const { eq, lt, and } = await import('drizzle-orm');

    const stuckThreshold = new Date(Date.now() - STUCK_THRESHOLD_MS);

    const stuck = await db
      .select({
        id: processingJobs.id,
        createdAt: processingJobs.createdAt,
        stripePaymentIntentId: processingJobs.stripePaymentIntentId,
      })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.status, 'processing'),
          lt(processingJobs.updatedAt, stuckThreshold),
        ),
      );

    const actions = planStuckJobActions(stuck);
    const autoFailed: Array<{ id: string; stripePaymentIntentId: string | null }> = [];

    for (const a of actions) {
      if (a.action === 'retry') {
        await db
          .update(processingJobs)
          .set({ status: 'pending' })
          .where(eq(processingJobs.id, a.id));
      } else {
        await db
          .update(processingJobs)
          .set({ status: 'failed', error: AUTO_FAIL_ERROR })
          .where(eq(processingJobs.id, a.id));
        autoFailed.push({ id: a.id, stripePaymentIntentId: a.stripePaymentIntentId });
      }
    }

    return autoFailed;
  },
};
