import { jobQueue } from './queue.js';
import { processingService } from '../services/processing.service.js';
import { billingService } from '../services/billing.service.js';

let running = false;

async function processNextJob() {
  if (running) return;
  running = true;

  try {
    // Retry stuck jobs (auto-fails any that exceeded the retry window — refund those that had a charge)
    const autoFailed = await jobQueue.retryStuckJobs();
    for (const failed of autoFailed) {
      console.log(`Job ${failed.id} auto-failed after exceeding retry window`);
      if (failed.stripePaymentIntentId) {
        try {
          await billingService.refund(failed.stripePaymentIntentId);
          console.log(`Refunded auto-failed job ${failed.id}`);
        } catch (refundError) {
          console.error(`Refund failed for auto-failed job ${failed.id}:`, refundError);
        }
      }
    }

    // Poll for next job
    const jobs = await jobQueue.pollForJobs();
    if (jobs.length === 0) return;

    const job = jobs[0];
    console.log(`Processing job ${job.id} for file ${job.fileHash}`);

    await jobQueue.markProcessing(job.id);

    try {
      await processingService.orchestratePipeline(job.id, job.fileHash, job.bookId!);
      console.log(`Job ${job.id} completed`);
    } catch (error: any) {
      console.error(`Job ${job.id} failed:`, error.message);
      await jobQueue.markFailed(job.id, error.message);

      // Auto-refund on failure
      if (job.stripePaymentIntentId) {
        try {
          await billingService.refund(job.stripePaymentIntentId);
        } catch (refundError) {
          console.error('Refund failed:', refundError);
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startWorker(intervalMs = 5000) {
  console.log('Processing worker started');
  setInterval(processNextJob, intervalMs);
}
