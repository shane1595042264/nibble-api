import { eq, and, isNull, gte, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { books, bookCatalog, chapters, sections, vocabulary } from '../db/schema.js';

export const bookRepository = {
  // ─── User books ────────────────────────────────────────────────

  async findById(id: string) {
    const [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.id, id), isNull(books.deletedAt)))
      .limit(1);
    return book ?? null;
  },

  async findByUserId(userId: string) {
    return db
      .select()
      .from(books)
      .where(and(eq(books.userId, userId), isNull(books.deletedAt)));
  },

  async findByUserIdAndCatalogId(userId: string, catalogId: string) {
    const [book] = await db
      .select()
      .from(books)
      .where(
        and(
          eq(books.userId, userId),
          eq(books.catalogId, catalogId),
          isNull(books.deletedAt),
        ),
      )
      .limit(1);
    return book ?? null;
  },

  async create(data: {
    userId: string;
    catalogId: string;
    customTitle?: string;
    coverUrl?: string;
    structureSource?: string;
    processingStatus?: string;
  }) {
    const [created] = await db.insert(books).values(data).returning();
    return created;
  },

  async update(
    id: string,
    data: Partial<{
      customTitle: string;
      coverUrl: string;
      structureSource: string;
      processingStatus: string;
      lastReadAt: Date;
      lastAccessedSectionId: string;
      lastAccessedScrollProgress: number;
      lastAccessedWordIndex: number;
    }>,
  ) {
    const [updated] = await db
      .update(books)
      .set(data)
      .where(eq(books.id, id))
      .returning();
    return updated ?? null;
  },

  async softDelete(id: string) {
    const [deleted] = await db
      .update(books)
      .set({ deletedAt: new Date() })
      .where(eq(books.id, id))
      .returning();
    return deleted ?? null;
  },

  /** Hard delete book + chapters + sections + vocab + processing jobs/logs. Catalog entry (marketplace) is preserved. */
  async hardDelete(id: string) {
    // Delete processing logs first (FK → processing_jobs)
    const { processingJobs, processingLogs } = await import('../db/schema.js');
    const jobs = await db.select({ id: processingJobs.id }).from(processingJobs).where(eq(processingJobs.bookId, id));
    for (const job of jobs) {
      await db.delete(processingLogs).where(eq(processingLogs.jobId, job.id));
    }
    await db.delete(processingJobs).where(eq(processingJobs.bookId, id));
    await db.delete(sections).where(eq(sections.bookId, id));
    await db.delete(chapters).where(eq(chapters.bookId, id));
    await db.delete(vocabulary).where(eq(vocabulary.bookId, id));
    await db.delete(books).where(eq(books.id, id));
  },

  async findByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(books)
      .where(and(inArray(books.id, ids), isNull(books.deletedAt)));
  },

  async findModifiedSince(userId: string, since: Date) {
    return db
      .select()
      .from(books)
      .where(and(eq(books.userId, userId), gte(books.updatedAt, since)));
  },

  // ─── Book catalog ─────────────────────────────────────────────

  async findCatalogById(id: string) {
    const [catalog] = await db
      .select()
      .from(bookCatalog)
      .where(eq(bookCatalog.id, id))
      .limit(1);
    return catalog ?? null;
  },

  async findCatalogByHash(hash: string) {
    const [catalog] = await db
      .select()
      .from(bookCatalog)
      .where(eq(bookCatalog.fileHash, hash))
      .limit(1);
    return catalog ?? null;
  },

  async findCatalogByFuzzyTitle(title: string) {
    return db
      .select()
      .from(bookCatalog)
      .where(sql`similarity(${bookCatalog.title}, ${title}) > 0.3`)
      .orderBy(desc(sql`similarity(${bookCatalog.title}, ${title})`));
  },

  async createCatalog(data: {
    title: string;
    author?: string;
    description?: string;
    coverUrl?: string;
    isbn?: string;
    language?: string;
    publisher?: string;
    publishYear?: number;
    categories?: string[];
    fileHash: string;
    totalPages?: number;
    metadataSource?: string;
  }) {
    const [created] = await db.insert(bookCatalog).values(data).returning();
    return created;
  },

  async updateCatalog(
    id: string,
    data: Partial<{
      title: string;
      author: string;
      description: string;
      coverUrl: string;
      isbn: string;
      language: string;
      publisher: string;
      publishYear: number;
      categories: string[];
      totalPages: number;
      userCount: number;
      metadataSource: string;
    }>,
  ) {
    const [updated] = await db
      .update(bookCatalog)
      .set(data)
      .where(eq(bookCatalog.id, id))
      .returning();
    return updated ?? null;
  },
};
