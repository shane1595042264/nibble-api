import { bookRepository } from '../repositories/book.repository.js';
import { processingLogRepository } from '../repositories/processing-log.repository.js';
import { db } from '../db/index.js';
import { processingJobs } from '../db/schema.js';
import { Errors } from '../lib/errors.js';

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
    await bookRepository.hardDelete(book.id);
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

    // 4. Upload PDF to R2
    const { storageService } = await import('./storage.service.js');
    const r2Key = await storageService.uploadPdf(fileHash, fileBuffer);

    // 5. Create pdf_files record
    const { db } = await import('../db/index.js');
    const { pdfFiles } = await import('../db/schema.js');
    await db.insert(pdfFiles).values({
      fileHash,
      r2Key,
      sizeBytes: fileBuffer.length,
    }).onConflictDoNothing();

    // 6. Create book in user's library
    const existing = await bookRepository.findByUserIdAndCatalogId(userId, catalogEntry.id);
    if (existing) {
      // Check if we should start processing for existing book
      let jobId: string | undefined;
      const activeJob = await processingLogRepository.findActiveJobByFileHash(fileHash);
      if (activeJob) {
        jobId = activeJob.id;
      } else if (existing.processingStatus !== 'complete') {
        const [job] = await db.insert(processingJobs).values({
          fileHash,
          userId,
          bookId: existing.id,
          status: 'pending',
        }).returning();
        jobId = job.id;
        await bookRepository.update(existing.id, { processingStatus: 'processing' });
        // Fire-and-forget pipeline
        setTimeout(async () => {
          try {
            const { processingService } = await import('./processing.service.js');
            await processingService.orchestratePipeline(job.id, fileHash, existing.id, mode);
          } catch (err: any) {
            console.error('Processing pipeline failed:', err);
            const errorMessage = err?.message ?? 'Unknown error';
            await processingLogRepository.failJob(job.id, errorMessage).catch(() => {});
            await bookRepository.update(existing.id, { processingStatus: 'error' }).catch(() => {});
          }
        }, 0);
      }
      return { book: existing, catalogEntry, jobId, isNew: false };
    }

    const book = await bookRepository.create({
      userId,
      catalogId: catalogEntry.id,
      processingStatus: 'pending',
    });

    // Auto-start processing for new books
    let jobId: string | undefined;
    const activeJob = await processingLogRepository.findActiveJobByFileHash(fileHash);
    if (activeJob) {
      jobId = activeJob.id;
    } else {
      const [job] = await db.insert(processingJobs).values({
        fileHash,
        userId,
        bookId: book.id,
        status: 'pending',
      }).returning();
      jobId = job.id;
      await bookRepository.update(book.id, { processingStatus: 'processing' });
      // Fire-and-forget pipeline
      setTimeout(async () => {
        try {
          const { processingService } = await import('./processing.service.js');
          await processingService.orchestratePipeline(job.id, fileHash, book.id);
        } catch (err: any) {
          console.error('Processing pipeline failed:', err);
          const errorMessage = err?.message ?? 'Unknown error';
          await processingLogRepository.failJob(job.id, errorMessage).catch(() => {});
          await bookRepository.update(book.id, { processingStatus: 'error' }).catch(() => {});
        }
      }, 0);
    }

    return { book, catalogEntry, jobId, isNew: true };
  },
};
