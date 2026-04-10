import { eq, and, isNull, gte, count, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { vocabulary } from '../db/schema.js';

export const vocabularyRepository = {
  async findById(id: string) {
    const [word] = await db
      .select()
      .from(vocabulary)
      .where(and(eq(vocabulary.id, id), isNull(vocabulary.deletedAt)))
      .limit(1);
    return word ?? null;
  },

  async findByUserId(userId: string) {
    return db
      .select()
      .from(vocabulary)
      .where(
        and(eq(vocabulary.userId, userId), isNull(vocabulary.deletedAt)),
      );
  },

  async findByBookId(userId: string, bookId: string) {
    return db
      .select()
      .from(vocabulary)
      .where(
        and(
          eq(vocabulary.userId, userId),
          eq(vocabulary.bookId, bookId),
          isNull(vocabulary.deletedAt),
        ),
      );
  },

  async create(data: {
    userId: string;
    bookId?: string;
    word: string;
    pronunciation?: string;
    translation?: string;
    targetLanguage?: string;
    definition?: string;
    contextSentence?: string;
    explanation?: string;
    bookTitle?: string;
    sectionTitle?: string;
    page?: number;
  }) {
    const [created] = await db.insert(vocabulary).values(data).returning();
    return created;
  },

  async update(
    id: string,
    data: Partial<{
      word: string;
      pronunciation: string;
      translation: string;
      targetLanguage: string;
      definition: string;
      contextSentence: string;
      explanation: string;
      bookTitle: string;
      sectionTitle: string;
      page: number;
      reviewCount: number;
      lastReviewedAt: Date;
    }>,
  ) {
    const [updated] = await db
      .update(vocabulary)
      .set(data)
      .where(eq(vocabulary.id, id))
      .returning();
    return updated ?? null;
  },

  async softDelete(id: string) {
    const [deleted] = await db
      .update(vocabulary)
      .set({ deletedAt: new Date() })
      .where(eq(vocabulary.id, id))
      .returning();
    return deleted ?? null;
  },

  async countByUserId(userId: string): Promise<number> {
    const [result] = await db
      .select({ value: count() })
      .from(vocabulary)
      .where(and(eq(vocabulary.userId, userId), isNull(vocabulary.deletedAt)));
    return result?.value ?? 0;
  },

  async findByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(vocabulary)
      .where(and(inArray(vocabulary.id, ids), isNull(vocabulary.deletedAt)));
  },

  async findModifiedSince(userId: string, since: Date) {
    return db
      .select()
      .from(vocabulary)
      .where(
        and(eq(vocabulary.userId, userId), gte(vocabulary.updatedAt, since)),
      );
  },
};
