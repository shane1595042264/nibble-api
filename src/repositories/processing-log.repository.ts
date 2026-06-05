import { eq, gte, desc, and, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { processingJobs, processingLogs } from '../db/schema.js';

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

  /** Update a job's progress percentage and current stage. */
  async updateJobProgress(jobId: string, progress: number, stage: string) {
    const [updated] = await db
      .update(processingJobs)
      .set({ progress, stage, status: 'processing' })
      .where(eq(processingJobs.id, jobId))
      .returning();
    return updated ?? null;
  },

  /** Mark a job as completed with 100% progress. */
  async completeJob(jobId: string) {
    const [updated] = await db
      .update(processingJobs)
      .set({ status: 'completed', progress: 100 })
      .where(eq(processingJobs.id, jobId))
      .returning();
    return updated ?? null;
  },

  /** Mark a job as failed with an error message. */
  async failJob(jobId: string, error: string) {
    const [updated] = await db
      .update(processingJobs)
      .set({ status: 'failed', error })
      .where(eq(processingJobs.id, jobId))
      .returning();
    return updated ?? null;
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
   */
  async claimFailedForRetry(jobId: string, userId: string) {
    const [claimed] = await db
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

  /** Find an active (pending or processing) job for a given file hash. */
  async findActiveJobByFileHash(fileHash: string) {
    const [job] = await db
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
