import { bookRepository } from '../repositories/book.repository.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { sectionRepository } from '../repositories/section.repository.js';
import { vocabularyRepository } from '../repositories/vocabulary.repository.js';
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
      // Mark the job failed. Log (don't swallow) if the write itself fails, so a
      // failed job-status write is traceable instead of vanishing (KAN-279).
      await processingLogRepository.failJob(jobId, errorMessage).catch((failErr) => {
        console.error(`[book.service] failed to mark job ${jobId} failed after pipeline error:`, failErr);
      });
      // Reliably set the book to 'error' via the KAN-243 net: markBookErrored
      // retries a couple times and logs CRITICAL on final failure, and never
      // rejects. This catch fires only for failures OUTSIDE the inner pipeline
      // nets (catalog lookup / dynamic import throwing), where this is the ONLY
      // thing that can rescue the book from a permanent 'processing' state.
      try {
        const { markBookErrored } = await import('./processing.service.js');
        await markBookErrored(bookId, jobId);
      } catch (importErr) {
        // The dynamic import itself failed — one of the exact cases this catch
        // guards. Fall back to a direct status write, logging loudly rather than
        // swallowing, so the stuck book is at least traceable in server logs.
        console.error(
          `[book.service] CRITICAL: could not load markBookErrored to rescue book ${bookId} (job ${jobId}); attempting direct status write.`,
          importErr,
        );
        await bookRepository.update(bookId, { processingStatus: 'error' }).catch((updateErr) => {
          console.error(
            `[book.service] CRITICAL: failed to set book ${bookId} to 'error' (job ${jobId}). Book may be stuck showing 'processing' — manual intervention required.`,
            updateErr,
          );
        });
      }
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
    // catalogId is a well-formed UUID (Zod) but may reference no book_catalog row.
    // Without this check the NOT NULL FK (onDelete: 'restrict') raises Postgres 23503,
    // which falls through the global error handler as an opaque 500 'Unhandled error'.
    // Surface a clean 404 instead.
    const catalog = await bookRepository.findCatalogById(data.catalogId);
    if (!catalog) throw Errors.notFound('Catalog entry');
    return bookRepository.create({ ...data, userId });
  },

  async updateBook(id: string, userId: string, data: Record<string, unknown>) {
    const book = await this.getBook(id, userId);
    return bookRepository.update(book.id, data);
  },

  async deleteBook(id: string, userId: string) {
    const book = await this.getBook(id, userId);
    // Cascade soft-delete: chapters, sections, vocabulary for this book.
    // The WHERE deletedAt IS NULL guard inside each helper keeps re-runs idempotent.
    // Soft-deleted vocab rows flow back to clients as tombstones via the existing
    // findModifiedSince path, so every device cleans up its local vocab on next sync.
    await chapterRepository.softDeleteByBookId(book.id);
    await sectionRepository.softDeleteByBookId(book.id);
    await vocabularyRepository.softDeleteByBookId(book.id);
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

    // 2. If no exact match and title given, fuzzy search.
    // Cap at top 25 — the upload UI only surfaces a handful of duplicate candidates.
    let fuzzyMatches: any[] = [];
    if (title) {
      fuzzyMatches = await bookRepository.findCatalogByFuzzyTitle(title, 25);
    }

    return { exactMatch: null, fuzzyMatches };
  },

  async handleUpload(
    userId: string,
    fileHash: string,
    fileBuffer: Buffer,
    totalPages: number,
    title: string,
    author?: string,
    mode: string = 'full',
    format: 'pdf' | 'epub' = 'pdf',
  ) {
    // 1. Check if catalog entry exists for this hash
    let catalogEntry = await bookRepository.findCatalogByHash(fileHash);

    if (catalogEntry) {
      // Increment user count
      await bookRepository.updateCatalog(catalogEntry.id, {
        userCount: catalogEntry.userCount + 1,
      });
    } else {
      // 2. Look up metadata from Google Books (PDF-friendly metadata source)
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
        format,
        metadataSource: metadata ? 'google_books' : 'manual',
      });
    }

    // 4. Upload the source file to R2 (skip if already stored). The pdf_files
    // table stores both PDFs and EPUBs (naming is historical) — the r2Key
    // carries the actual extension.
    const [existingFile] = await db.select().from(pdfFiles).where(eq(pdfFiles.fileHash, fileHash)).limit(1);

    if (!existingFile) {
      const { storageService } = await import('./storage.service.js');
      const r2Key = await storageService.uploadBookFile(fileHash, fileBuffer, format);
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
      // restore() is genuinely nullable: the UPDATE ... .returning() yields no row if the
      // target vanished between the find and the update. Fail loud here instead of asserting
      // non-null and shipping { book: null } to a client that dereferences data.book.id.
      if (!restoredBook) {
        throw Errors.processingFailed('Failed to restore previously deleted book during re-upload');
      }

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

      return { book: restoredBook, catalogEntry, jobId, isNew: false };
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
