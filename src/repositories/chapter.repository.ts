import { eq, and, isNull, gte, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chapters } from '../db/schema.js';

export const chapterRepository = {
  async findById(id: string) {
    const [chapter] = await db
      .select()
      .from(chapters)
      .where(and(eq(chapters.id, id), isNull(chapters.deletedAt)))
      .limit(1);
    return chapter ?? null;
  },

  async findByBookId(bookId: string) {
    return db
      .select()
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), isNull(chapters.deletedAt)))
      .orderBy(asc(chapters.sortOrder));
  },

  async create(data: {
    bookId: string;
    title: string;
    startPage?: number;
    endPage?: number;
    sortOrder?: number;
  }) {
    const [created] = await db.insert(chapters).values(data).returning();
    return created;
  },

  async bulkCreate(
    data: Array<{
      bookId: string;
      title: string;
      startPage?: number;
      endPage?: number;
      sortOrder?: number;
    }>,
  ) {
    if (data.length === 0) return [];
    return db.insert(chapters).values(data).returning();
  },

  async update(
    id: string,
    data: Partial<{
      title: string;
      startPage: number;
      endPage: number;
      sortOrder: number;
    }>,
  ) {
    const [updated] = await db
      .update(chapters)
      .set(data)
      .where(eq(chapters.id, id))
      .returning();
    return updated ?? null;
  },

  async softDelete(id: string) {
    const [deleted] = await db
      .update(chapters)
      .set({ deletedAt: new Date() })
      .where(eq(chapters.id, id))
      .returning();
    return deleted ?? null;
  },

  async findModifiedSince(bookId: string, since: Date) {
    return db
      .select()
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), gte(chapters.updatedAt, since)));
  },
};
