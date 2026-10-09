import { jobQueue } from './queue.js';
import { processingService, markBookErrored } from '../services/processing.service.js';
import { billingService } from '../services/billing.service.js';

let running = false;

async function runJob(job: { id: string; fileHash: string; bookId: string | null }) {
  try {
    await processingService.orchestratePipeline(job.id, job.fileHash, job.bookId!);
    console.log(`Job ${job.id} completed`);
  } catch (error: any) {
    console.error(`Job ${job.id} failed:`, error.message);
    await jobQueue.markFailed(job.id, error.message);
    if (job.bookId) await markBookErrored(job.bookId, job.id);

    // Backstop net, not the main refund path. Neither pipeline rethrows, so a
    // stage failure (Mathpix/OCR/R2/pdf.js/DB) refunds itself inside
    // processing.service's catch and never arrives here. What DOES arrive is a
    // throw from before either pipeline's try block — e.g. findCatalogByHash in
    // the dispatcher. Refunding again is safe: billingService.refund is
    // idempotent, so this can never double-refund a job the pipeline handled.
    await billingService.refundFailedJob(job.id);
  }
}

async function processNextJob() {
  if (running) return;
  running = true;

  try {
    // Recover jobs orphaned by a dead process (typically a redeploy mid-pipeline):
    // re-run the recent ones, auto-fail the rest — refund those that had a charge.
    const { resumed, autoFailed } = await jobQueue.recoverStuckJobs();
    for (const failed of autoFailed) {
      console.log(`Job ${failed.id} auto-failed after exceeding retry window`);
      // Without this the book keeps showing 'Processing...' and never gets the
      // Retry button, which keys off processingStatus 'error' (KAN-340).
      if (failed.bookId) await markBookErrored(failed.bookId, failed.id);
      if (failed.stripePaymentIntentId) {
        try {
          await billingService.refund(failed.stripePaymentIntentId);
          console.log(`Refunded auto-failed job ${failed.id}`);
        } catch (refundError) {
          console.error(`Refund failed for auto-failed job ${failed.id}:`, refundError);
        }
      }
    }
    for (const job of resumed) {
      console.log(`Resuming stuck job ${job.id} for file ${job.fileHash}`);
      await runJob(job);
    }

    // Poll for next job
    const jobs = await jobQueue.pollForJobs();
    if (jobs.length === 0) return;

    const job = jobs[0];
    console.log(`Processing job ${job.id} for file ${job.fileHash}`);

    await jobQueue.markProcessing(job.id);
    await runJob(job);
  } finally {
    running = false;
  }
}

export function startWorker(intervalMs = 5000) {
  console.log('Processing worker started');
  setInterval(processNextJob, intervalMs);
}
