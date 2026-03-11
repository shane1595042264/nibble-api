import { eq, and, isNull, gte, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sections } from '../db/schema.js';

export const sectionRepository = {
  async findById(id: string) {
    const [section] = await db
      .select()
      .from(sections)
      .where(and(eq(sections.id, id), isNull(sections.deletedAt)))
      .limit(1);
    return section ?? null;
  },

  async findByBookId(bookId: string) {
    return db
      .select()
      .from(sections)
      .where(and(eq(sections.bookId, bookId), isNull(sections.deletedAt)))
      .orderBy(asc(sections.sortOrder));
  },

  async findByChapterId(chapterId: string) {
    return db
      .select()
      .from(sections)
      .where(
        and(eq(sections.chapterId, chapterId), isNull(sections.deletedAt)),
      )
      .orderBy(asc(sections.sortOrder));
  },

  async create(data: {
    bookId: string;
    chapterId: string;
    title: string;
    startPage?: number;
    endPage?: number;
    isRead?: boolean;
    readAt?: Date;
    lastPageViewed?: number;
    scrollProgress?: number;
    extractedText?: string;
    sectionType?: string;
    sortOrder?: number;
  }) {
    const [created] = await db.insert(sections).values(data).returning();
    return created;
  },

  async bulkCreate(
    data: Array<{
      bookId: string;
      chapterId: string;
      title: string;
      startPage?: number;
      endPage?: number;
      isRead?: boolean;
      extractedText?: string;
      sectionType?: string;
      sortOrder?: number;
    }>,
  ) {
    if (data.length === 0) return [];
    return db.insert(sections).values(data).returning();
  },

  async update(
    id: string,
    data: Partial<{
      title: string;
      startPage: number;
      endPage: number;
      isRead: boolean;
      readAt: Date | null;
      lastPageViewed: number;
      scrollProgress: number;
      extractedText: string;
      sectionType: string;
      sortOrder: number;
    }>,
  ) {
    const [updated] = await db
      .update(sections)
      .set(data)
      .where(eq(sections.id, id))
      .returning();
    return updated ?? null;
  },

  async softDelete(id: string) {
    const [deleted] = await db
      .update(sections)
      .set({ deletedAt: new Date() })
      .where(eq(sections.id, id))
      .returning();
    return deleted ?? null;
  },

  async markAsRead(id: string) {
    const [updated] = await db
      .update(sections)
      .set({ isRead: true, readAt: new Date() })
      .where(eq(sections.id, id))
      .returning();
    return updated ?? null;
  },

  async markAsUnread(id: string) {
    const [updated] = await db
      .update(sections)
      .set({ isRead: false, readAt: null })
      .where(eq(sections.id, id))
      .returning();
    return updated ?? null;
  },

  async findModifiedSince(bookId: string, since: Date) {
    return db
      .select()
      .from(sections)
      .where(
        and(eq(sections.bookId, bookId), gte(sections.updatedAt, since)),
      );
  },
};
