import { eq, and, isNull, gte, gt, asc, inArray } from 'drizzle-orm';
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

  async softDeleteByBookId(bookId: string, executor: Pick<typeof db, 'update'> = db) {
    await executor
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

  // One page of the sync pull, keyed on id so a page boundary can never drop a
  // row: the caller passes back nextAfterId until it is null. Fetches limit + 1
  // to tell "exactly limit rows" from "more to come" without an empty extra page.
  async findModifiedSinceForBooks(bookIds: string[], since: Date, afterId?: string, limit = MAX_LIST_ROWS) {
    if (bookIds.length === 0) return { rows: [], nextAfterId: null };
    const rows = await db
      .select()
      .from(chapters)
      .where(and(
        inArray(chapters.bookId, bookIds),
        gte(chapters.updatedAt, since),
        afterId ? gt(chapters.id, afterId) : undefined,
      ))
      .orderBy(asc(chapters.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { rows: page, nextAfterId: hasMore ? page[page.length - 1].id : null };
  },

  // includeDeleted: sync must see tombstones, or a pushed id that exists only as a
  // soft-deleted row looks new and its INSERT hits the primary key.
  async findByIds(ids: string[], opts: { includeDeleted?: boolean } = {}) {
    if (ids.length === 0) return [];
    const rows = await db
      .select()
      .from(chapters)
      .where(opts.includeDeleted ? inArray(chapters.id, ids) : and(inArray(chapters.id, ids), isNull(chapters.deletedAt)))
      .limit(MAX_LIST_ROWS);
    return warnIfCapped(rows, { entity: 'chapters', scope: { idsRequested: ids.length } });
  },
};
