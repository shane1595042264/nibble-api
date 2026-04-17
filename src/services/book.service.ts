import { bookRepository } from '../repositories/book.repository.js';
import { processingLogRepository } from '../repositories/processing-log.repository.js';
import { db } from '../db/index.js';
import { processingJobs, pdfFiles, sections as sectionsTable, chapters as chaptersTable } from '../db/schema.js';
import { eq, or, and } from 'drizzle-orm';
import { Errors } from '../lib/errors.js';

/** Start the processing pipeline in a fire-and-forget manner. */
function startPipelineAsync(jobId: string, fileHash: string, bookId: string, mode: string) {
  setTimeout(async () => {
    try {
      const { processingService } = await import('./processing.service.js');
      await processingService.orchestratePipeline(jobId, fileHash, bookId, mode);
    } catch (err: any) {
      console.error('Processing pipeline failed:', err);
      const errorMessage = err?.message ?? 'Unknown error';
      // Use the repository to properly update job and book status on failure
      await processingLogRepository.failJob(jobId, errorMessage).catch(() => {});
      await bookRepository.update(bookId, { processingStatus: 'error' }).catch(() => {});
    }
  }, 0);
}

export const bookService = {
  async listBooks(userId: string) {
    return bookRepository.findByUserId(userId);
  },

  async getBook(id: string, userId: string) {
    const book = await bookRepository.findById(id);
    if (!book || book.userId !== userId) throw Errors.notFound('Book');
    return book;
  },

  async createBook(userId: string, data: { catalogId: string; customTitle?: string; coverUrl?: string }) {
    const existing = await bookRepository.findByUserIdAndCatalogId(userId, data.catalogId);
    if (existing) throw Errors.duplicateBook();
    return bookRepository.create({ ...data, userId });
  },

  async updateBook(id: string, userId: string, data: Record<string, unknown>) {
    const book = await this.getBook(id, userId);
    return bookRepository.update(book.id, data);
  },

  async deleteBook(id: string, userId: string) {
    const book = await this.getBook(id, userId);
    await bookRepository.softDelete(book.id);
    return { deleted: true };
  },

  async updateBookMetadata(
    bookId: string,
    userId: string,
    data: { title?: string; author?: string; description?: string; coverUrl?: string | null; language?: string; publisher?: string; publishYear?: number | null },
  ) {
    const book = await this.getBook(bookId, userId);
    const catalog = await bookRepository.findCatalogById(book.catalogId);
    if (!catalog) throw Errors.notFound('Catalog entry');

    const updated = await bookRepository.updateCatalog(catalog.id, {
      ...data,
      coverUrl: data.coverUrl ?? undefined,
      publishYear: data.publishYear ?? undefined,
    });
    return { book, catalog: updated };
  },

  async matchBook(fileHash: string, title?: string) {
    // 1. Check exact hash match in book_catalog
    const exactMatch = await bookRepository.findCatalogByHash(fileHash);
    if (exactMatch) return { exactMatch, fuzzyMatches: [] };

    // 2. If no exact match and title given, fuzzy search
    let fuzzyMatches: any[] = [];
    if (title) {
      fuzzyMatches = await bookRepository.findCatalogByFuzzyTitle(title);
    }

    return { exactMatch: null, fuzzyMatches };
  },

  async handleUpload(userId: string, fileHash: string, fileBuffer: Buffer, totalPages: number, title: string, author?: string, mode: string = 'full') {
    // 1. Check if catalog entry exists for this hash
    let catalogEntry = await bookRepository.findCatalogByHash(fileHash);

    if (catalogEntry) {
      // Increment user count
      await bookRepository.updateCatalog(catalogEntry.id, {
        userCount: catalogEntry.userCount + 1,
      });
    } else {
      // 2. Look up metadata from Google Books
      const { metadataService } = await import('./metadata.service.js');
      const metadata = await metadataService.lookupGoogleBooks(title, author);

      // 3. Create catalog entry
      catalogEntry = await bookRepository.createCatalog({
        title: metadata?.title ?? title,
        author: metadata?.author ?? author,
        description: metadata?.description,
        coverUrl: metadata?.coverUrl,
        isbn: metadata?.isbn,
        publisher: metadata?.publisher,
        publishYear: metadata?.publishYear,
        categories: metadata?.categories,
        language: metadata?.language ?? 'en',
        fileHash,
        totalPages,
        metadataSource: metadata ? 'google_books' : 'manual',
      });
    }

    // 4. Upload PDF to R2 (skip if already stored)
    const [existingPdf] = await db.select().from(pdfFiles).where(eq(pdfFiles.fileHash, fileHash)).limit(1);

    if (!existingPdf) {
      const { storageService } = await import('./storage.service.js');
      const r2Key = await storageService.uploadPdf(fileHash, fileBuffer);
      await db.insert(pdfFiles).values({
        fileHash,
        r2Key,
        sizeBytes: fileBuffer.length,
      }).onConflictDoNothing();
    }

    // 5. Find existing book (active or soft-deleted) for this user+catalog.
    // The unique index on (userId, catalogId) covers ALL rows including soft-deleted,
    // so we must handle deleted books to avoid a constraint violation on re-upload.
    const existing = await bookRepository.findByUserIdAndCatalogId(userId, catalogEntry.id);

    if (existing) {
      const { jobId, shouldStartPipeline } = await db.transaction(async (tx) => {
        // Check for active job inside the transaction
        const [activeJob] = await tx
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
          .limit(1);

        if (activeJob) {
          return { jobId: activeJob.id, shouldStartPipeline: false };
        }

        if (existing.processingStatus === 'complete') {
          return { jobId: undefined, shouldStartPipeline: false };
        }

        // Insert new job — partial unique index prevents duplicates
        const [job] = await tx.insert(processingJobs).values({
          fileHash,
          userId,
          bookId: existing.id,
          status: 'pending',
        }).returning();

        await bookRepository.update(existing.id, { processingStatus: 'processing' });
        return { jobId: job.id, shouldStartPipeline: true };
      });

      if (shouldStartPipeline && jobId) {
        startPipelineAsync(jobId, fileHash, existing.id, mode);
      }

      return { book: existing, catalogEntry, jobId, isNew: false };
    }

    // Check for soft-deleted book with the same user+catalog (re-upload after delete)
    const deleted = await bookRepository.findDeletedByUserIdAndCatalogId(userId, catalogEntry.id);

    if (deleted) {
      // Restore the soft-deleted book: clear deletedAt, clean up old structure, re-process
      await db.delete(sectionsTable).where(eq(sectionsTable.bookId, deleted.id));
      await db.delete(chaptersTable).where(eq(chaptersTable.bookId, deleted.id));

      const restoredBook = await bookRepository.restore(deleted.id, { processingStatus: 'pending' });

      const { jobId, shouldStartPipeline } = await db.transaction(async (tx) => {
        const [activeJob] = await tx
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
          .limit(1);

        if (activeJob) {
          return { jobId: activeJob.id, shouldStartPipeline: false };
        }

        const [job] = await tx.insert(processingJobs).values({
          fileHash,
          userId,
          bookId: deleted.id,
          status: 'pending',
        }).returning();

        await bookRepository.update(deleted.id, { processingStatus: 'processing' });
        return { jobId: job.id, shouldStartPipeline: true };
      });

      if (shouldStartPipeline && jobId) {
        startPipelineAsync(jobId, fileHash, deleted.id, mode);
      }

      return { book: restoredBook!, catalogEntry, jobId, isNew: false };
    }

    // Truly new book — create fresh
    const book = await bookRepository.create({
      userId,
      catalogId: catalogEntry.id,
      processingStatus: 'pending',
    });

    // Atomically create processing job for the new book
    const { jobId, shouldStartPipeline } = await db.transaction(async (tx) => {
      const [activeJob] = await tx
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
        .limit(1);

      if (activeJob) {
        return { jobId: activeJob.id, shouldStartPipeline: false };
      }

      const [job] = await tx.insert(processingJobs).values({
        fileHash,
        userId,
        bookId: book.id,
        status: 'pending',
      }).returning();

      await bookRepository.update(book.id, { processingStatus: 'processing' });
      return { jobId: job.id, shouldStartPipeline: true };
    });

    if (shouldStartPipeline && jobId) {
      startPipelineAsync(jobId, fileHash, book.id, mode);
    }

    return { book, catalogEntry, jobId, isNew: true };
  },
};
