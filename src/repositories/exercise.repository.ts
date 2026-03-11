import { eq, and, isNull, gte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { exercises, exerciseProgress } from '../db/schema.js';

export const exerciseRepository = {
  // ─── Exercises (shared catalog entries) ────────────────────────

  async findByCatalogId(catalogId: string) {
    return db
      .select()
      .from(exercises)
      .where(eq(exercises.catalogId, catalogId));
  },

  async create(data: {
    catalogId: string;
    chapterTitle?: string;
    exerciseNumber?: string;
    content: string;
    contentLatex?: string;
    page?: number;
    exerciseType?: string;
    difficulty?: string;
    hints?: unknown;
    solutionPage?: number;
    sortOrder?: number;
    metadata?: Record<string, unknown>;
  }) {
    const [created] = await db.insert(exercises).values(data).returning();
    return created;
  },

  async bulkCreate(
    data: Array<{
      catalogId: string;
      chapterTitle?: string;
      exerciseNumber?: string;
      content: string;
      contentLatex?: string;
      page?: number;
      exerciseType?: string;
      difficulty?: string;
      hints?: unknown;
      solutionPage?: number;
      sortOrder?: number;
      metadata?: Record<string, unknown>;
    }>,
  ) {
    if (data.length === 0) return [];
    return db.insert(exercises).values(data).returning();
  },

  // ─── Exercise progress (per-user) ─────────────────────────────

  async findProgressByUserId(userId: string) {
    return db
      .select()
      .from(exerciseProgress)
      .where(
        and(
          eq(exerciseProgress.userId, userId),
          isNull(exerciseProgress.deletedAt),
        ),
      );
  },

  async findProgressByBookId(userId: string, bookId: string) {
    return db
      .select()
      .from(exerciseProgress)
      .where(
        and(
          eq(exerciseProgress.userId, userId),
          eq(exerciseProgress.bookId, bookId),
          isNull(exerciseProgress.deletedAt),
        ),
      );
  },

  async upsertProgress(
    userId: string,
    exerciseId: string,
    data: {
      bookId: string;
      status?: string;
      notes?: string;
      completedAt?: Date | null;
      timeSpentSeconds?: number;
      metadata?: Record<string, unknown>;
    },
  ) {
    const [existing] = await db
      .select()
      .from(exerciseProgress)
      .where(
        and(
          eq(exerciseProgress.userId, userId),
          eq(exerciseProgress.exerciseId, exerciseId),
        ),
      )
      .limit(1);

    if (existing) {
      const { bookId: _bookId, ...updateData } = data;
      const [updated] = await db
        .update(exerciseProgress)
        .set({ ...updateData, deletedAt: null })
        .where(eq(exerciseProgress.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(exerciseProgress)
      .values({
        userId,
        exerciseId,
        ...data,
      })
      .returning();
    return created;
  },

  async softDeleteProgress(id: string) {
    const [deleted] = await db
      .update(exerciseProgress)
      .set({ deletedAt: new Date() })
      .where(eq(exerciseProgress.id, id))
      .returning();
    return deleted ?? null;
  },

  async findProgressModifiedSince(userId: string, since: Date) {
    return db
      .select()
      .from(exerciseProgress)
      .where(
        and(
          eq(exerciseProgress.userId, userId),
          gte(exerciseProgress.updatedAt, since),
        ),
      );
  },
};
