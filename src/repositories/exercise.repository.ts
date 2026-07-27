import { eq, and, isNull, gte, inArray } from 'drizzle-orm';
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
    // Atomic upsert via INSERT ... ON CONFLICT (user_id, exercise_id). Replaces the
    // previous check-then-act (SELECT then INSERT/UPDATE), which raced the composite
    // UNIQUE index idx_exercise_progress_unique(user_id, exercise_id): two concurrent
    // first-writes both missed the SELECT, both took the INSERT branch, and the second
    // threw a UNIQUE violation. Mirrors the KAN-274 settings.repository fix.
    const { bookId: _bookId, ...updateData } = data;
    // On conflict, do NOT overwrite bookId (matches the prior update branch which
    // stripped it), reset deletedAt: null to un-tombstone on re-upsert, and set
    // updatedAt explicitly — $onUpdate fires on .update() but NOT on
    // onConflictDoUpdate, so without this findProgressModifiedSince would miss the
    // change and break cross-device pull.
    const [row] = await db
      .insert(exerciseProgress)
      .values({
        userId,
        exerciseId,
        ...data,
      })
      .onConflictDoUpdate({
        target: [exerciseProgress.userId, exerciseProgress.exerciseId],
        set: { ...updateData, deletedAt: null, updatedAt: new Date() },
      })
      .returning();
    return row ?? null;
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

  async findByCatalogIds(catalogIds: string[]) {
    if (catalogIds.length === 0) return [];
    return db
      .select()
      .from(exercises)
      .where(inArray(exercises.catalogId, catalogIds));
  },
};
