import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { processingJobs, processingCharges } from '../db/schema.js';

export const billingRepository = {
  // ─── Processing jobs ──────────────────────────────────────────

  async findJobById(id: string) {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, id))
      .limit(1);
    return job ?? null;
  },

  async findJobsByUserId(userId: string) {
    return db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.userId, userId))
      .orderBy(desc(processingJobs.createdAt));
  },

  async createJob(data: {
    fileHash: string;
    userId: string;
    status?: string;
    progress?: number;
    processingCostCents?: number;
    paid?: boolean;
    stripePaymentIntentId?: string;
  }) {
    const [created] = await db
      .insert(processingJobs)
      .values(data)
      .returning();
    return created;
  },

  async updateJobStatus(
    id: string,
    data: Partial<{
      status: string;
      progress: number;
      processingCostCents: number;
      paid: boolean;
      stripePaymentIntentId: string;
      error: string;
    }>,
  ) {
    const [updated] = await db
      .update(processingJobs)
      .set(data)
      .where(eq(processingJobs.id, id))
      .returning();
    return updated ?? null;
  },

  async findPendingPaid() {
    return db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.status, 'pending'),
          eq(processingJobs.paid, true),
        ),
      )
      .orderBy(processingJobs.createdAt);
  },

  // ─── Processing charges ───────────────────────────────────────

  async findChargeById(id: string) {
    const [charge] = await db
      .select()
      .from(processingCharges)
      .where(eq(processingCharges.id, id))
      .limit(1);
    return charge ?? null;
  },

  async findChargesByUserId(userId: string) {
    return db
      .select()
      .from(processingCharges)
      .where(eq(processingCharges.userId, userId))
      .orderBy(desc(processingCharges.createdAt));
  },

  async createCharge(data: {
    userId: string;
    jobId: string;
    amountCents: number;
    currency?: string;
    stripePaymentIntentId?: string;
    status?: string;
  }) {
    const [created] = await db
      .insert(processingCharges)
      .values(data)
      .returning();
    return created;
  },

  async updateChargeStatus(
    id: string,
    data: Partial<{
      status: string;
      stripePaymentIntentId: string;
    }>,
  ) {
    const [updated] = await db
      .update(processingCharges)
      .set(data)
      .where(eq(processingCharges.id, id))
      .returning();
    return updated ?? null;
  },
};
