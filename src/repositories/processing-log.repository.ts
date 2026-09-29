import { eq, gte, desc, and, or, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { processingJobs, processingLogs } from '../db/schema.js';

/**
 * Statuses a job can still make progress from.
 *
 * Everything else is terminal: 'completed', 'failed' (what cancelJob writes) and
 * 'superseded' (what claimFailedForRetry writes). A pipeline that finds its job
 * in a terminal status has lost the race and must stop rather than write over
 * the outcome someone else already recorded — see KAN-332, where an unguarded
 * updateJobProgress flipped a just-cancelled job straight back to 'processing'
 * and let the run finish 'completed'.
 *
 * 'pending' has to stay in here: jobs are inserted with the schema default
 * 'pending' and it is the pipeline's own first progress tick that promotes them
 * to 'processing', so a 'processing'-only guard would stall every stage 1.
 */
const ACTIVE_JOB_STATUSES = ['pending', 'processing'];

export const processingLogRepository = {
  /** Insert a new log entry for a processing job. */
  async append(
    jobId: string,
    stage: string,
    message: string,
    level: string = 'info',
  ) {
    const [log] = await db
      .insert(processingLogs)
      .values({ jobId, stage, message, level })
      .returning();
    return log;
  },

  /** Get logs for a job, optionally filtered by timestamp. Ordered by timestamp ascending. */
  async getByJobId(jobId: string, since?: Date) {
    const conditions = [eq(processingLogs.jobId, jobId)];
    if (since) {
      conditions.push(gte(processingLogs.timestamp, since));
    }
    return db
      .select()
      .from(processingLogs)
      .where(and(...conditions))
      .orderBy(processingLogs.timestamp);
  },

  /**
   * Update a job's progress percentage and current stage.
   *
   * Only advances a job that is still active, so this can never resurrect a
   * cancelled one. Returns null when the job has gone terminal underneath the
   * pipeline — callers treat that as the signal to stop (KAN-332).
   */
  async updateJobProgress(jobId: string, progress: number, stage: string) {
    const [updated] = await db
      .update(processingJobs)
      .set({ progress, stage, status: 'processing' })
      .where(
        and(
          eq(processingJobs.id, jobId),
          inArray(processingJobs.status, ACTIVE_JOB_STATUSES),
        ),
      )
      .returning();
    return updated ?? null;
  },

  /**
   * Mark a job as completed with 100% progress.
   *
   * Active-only, which makes it the atomic gate for finalize: a cancel that
   * lands after the pipeline's last checkpoint still wins, and the caller sees
   * null instead of overwriting the cancel with 'completed' (KAN-332).
   */
  async completeJob(jobId: string) {
    const [updated] = await db
      .update(processingJobs)
      .set({ status: 'completed', progress: 100 })
      .where(
        and(
          eq(processingJobs.id, jobId),
          inArray(processingJobs.status, ACTIVE_JOB_STATUSES),
        ),
      )
      .returning();
    return updated ?? null;
  },

  /**
   * Mark a job as failed with an error message.
   *
   * Active-only: the first terminal outcome wins. A null return means someone
   * else (a user cancel, a retry claim) already owns this job's outcome, and the
   * caller must not run the failure tail again — refundFailedJob is NOT
   * idempotent, so without this a stage error racing a cancel would refund a
   * cancel (against the policy in processing.service cancelJob) or double-refund
   * a job that already got its money back (KAN-332).
   */
  async failJob(jobId: string, error: string) {
    const [updated] = await db
      .update(processingJobs)
      .set({ status: 'failed', error })
      .where(
        and(
          eq(processingJobs.id, jobId),
          inArray(processingJobs.status, ACTIVE_JOB_STATUSES),
        ),
      )
      .returning();
    return updated ?? null;
  },

  /**
   * Cheap read-only liveness check for a job, for cancellation checkpoints that
   * should not also write a progress row — notably inside the paid Mathpix and
   * Anthropic loops, where the goal is to stop spending as early as possible.
   */
  async isJobActive(jobId: string) {
    const [job] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    return !!job && ACTIVE_JOB_STATUSES.includes(job.status);
  },

  /** Get a single processing job by ID. */
  async getJob(jobId: string) {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    return job ?? null;
  },

  /**
   * Atomically claim a failed job for retry by transitioning it to 'superseded'.
   * Returns the row on a successful claim, null if another caller already won
   * the race or the job is not in 'failed' state for this user.
   *
   * 'superseded' is terminal — nothing transitions a job back out of it — so the
   * caller must run this inside the same transaction as the replacement insert.
   * Committing the claim first and failing the insert afterwards burns the
   * book's only retry token permanently (KAN-302).
   */
  async claimFailedForRetry(jobId: string, userId: string, executor: Pick<typeof db, 'update'> = db) {
    const [claimed] = await executor
      .update(processingJobs)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(processingJobs.id, jobId),
          eq(processingJobs.userId, userId),
          eq(processingJobs.status, 'failed'),
        ),
      )
      .returning();
    return claimed ?? null;
  },

  /**
   * Find an active (pending or processing) job for a given file hash.
   *
   * idx_processing_jobs_active_file_hash is keyed on file_hash alone and is not
   * user-scoped, and file_hash is content-addressed (shared across users for
   * catalog dedup), so any active job for this file — whoever owns it — blocks
   * a new insert. Call this inside the inserting transaction.
   */
  async findActiveJobByFileHash(fileHash: string, executor: Pick<typeof db, 'select'> = db) {
    const [job] = await executor
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.fileHash, fileHash),
          or(
            eq(processingJobs.status, 'pending'),
            eq(processingJobs.status, 'processing'),
          ),
        ),
      )
      .orderBy(desc(processingJobs.createdAt))
      .limit(1);
    return job ?? null;
  },
};
