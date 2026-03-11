import { billingRepository } from '../repositories/billing.repository.js';

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

  async retryStuckJobs() {
    // Find jobs stuck in 'processing' for > 10 minutes
    const { db } = await import('../db/index.js');
    const { processingJobs } = await import('../db/schema.js');
    const { eq, lt, and } = await import('drizzle-orm');

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await db.update(processingJobs)
      .set({ status: 'pending' })
      .where(
        and(
          eq(processingJobs.status, 'processing'),
          lt(processingJobs.updatedAt, tenMinutesAgo)
        )
      );
  },
};
