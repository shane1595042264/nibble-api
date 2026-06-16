import { eq, and, isNull, gte, asc, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chapters } from '../db/schema.js';
import { MAX_LIST_ROWS, warnIfCapped } from '../lib/query-guards.js';

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
    const rows = await db
      .select()
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), isNull(chapters.deletedAt)))
      .orderBy(asc(chapters.sortOrder))
      .limit(MAX_LIST_ROWS);
    return warnIfCapped(rows, { entity: 'chapters', scope: { bookId } });
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

  async softDeleteByBookId(bookId: string) {
    await db
      .update(chapters)
      .set({ deletedAt: new Date() })
      .where(and(eq(chapters.bookId, bookId), isNull(chapters.deletedAt)));
  },

  async countByBookIds(bookIds: string[]): Promise<Map<string, number>> {
    if (bookIds.length === 0) return new Map();
    const rows = await db
      .select({ bookId: chapters.bookId })
      .from(chapters)
      .where(and(inArray(chapters.bookId, bookIds), isNull(chapters.deletedAt)));
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.bookId, (counts.get(row.bookId) ?? 0) + 1);
    }
    return counts;
  },

  async findModifiedSince(bookId: string, since: Date) {
    const rows = await db
      .select()
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), gte(chapters.updatedAt, since)))
      .limit(MAX_LIST_ROWS);
    return warnIfCapped(rows, { entity: 'chapters', scope: { bookId, since: since.toISOString() } });
  },

  async findModifiedSinceForBooks(bookIds: string[], since: Date) {
    if (bookIds.length === 0) return [];
    const rows = await db
      .select()
      .from(chapters)
      .where(and(inArray(chapters.bookId, bookIds), gte(chapters.updatedAt, since)))
      .limit(MAX_LIST_ROWS);
    return warnIfCapped(rows, { entity: 'chapters', scope: { bookCount: bookIds.length, since: since.toISOString() } });
  },

  async findByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await db
      .select()
      .from(chapters)
      .where(and(inArray(chapters.id, ids), isNull(chapters.deletedAt)))
      .limit(MAX_LIST_ROWS);
    return warnIfCapped(rows, { entity: 'chapters', scope: { idsRequested: ids.length } });
  },
};
