import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppError } from '../../../src/lib/errors.js';

// Mock the repositories that book.service imports. Only createBook is exercised here,
// so we stub the handful of methods it touches.
const bookRepo = vi.hoisted(() => ({
  findByUserIdAndCatalogId: vi.fn(),
  findCatalogById: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: bookRepo }));

// The remaining repos / db imports are unused by createBook but must resolve.
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: {} }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: {} }));
vi.mock('../../../src/repositories/vocabulary.repository.js', () => ({ vocabularyRepository: {} }));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({ processingLogRepository: {} }));
vi.mock('../../../src/db/index.js', () => ({ db: {} }));

const { bookService } = await import('../../../src/services/book.service.js');

const USER_ID = 'user-1';
const CATALOG_ID = '00000000-0000-0000-0000-000000000000';

describe('bookService.createBook', () => {
  beforeEach(() => {
    bookRepo.findByUserIdAndCatalogId.mockReset();
    bookRepo.findCatalogById.mockReset();
    bookRepo.create.mockReset();
  });

  it('throws a 404 NOT_FOUND when catalogId references no catalog row (no FK 500)', async () => {
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue(null);
    bookRepo.findCatalogById.mockResolvedValue(null); // valid UUID, absent from book_catalog

    await expect(bookService.createBook(USER_ID, { catalogId: CATALOG_ID })).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(bookRepo.create).not.toHaveBeenCalled();
  });

  it('creates the book when the catalog exists', async () => {
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue(null);
    bookRepo.findCatalogById.mockResolvedValue({ id: CATALOG_ID, title: 'Real Book' });
    bookRepo.create.mockResolvedValue({ id: 'book-1', userId: USER_ID, catalogId: CATALOG_ID });

    const result = await bookService.createBook(USER_ID, { catalogId: CATALOG_ID });

    expect(result).toMatchObject({ id: 'book-1', catalogId: CATALOG_ID });
    expect(bookRepo.create).toHaveBeenCalledWith({ catalogId: CATALOG_ID, userId: USER_ID });
  });

  it('still throws duplicateBook (409) when the user already owns the book', async () => {
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue({ id: 'existing-book' });

    await expect(bookService.createBook(USER_ID, { catalogId: CATALOG_ID })).rejects.toBeInstanceOf(AppError);
    await expect(bookService.createBook(USER_ID, { catalogId: CATALOG_ID })).rejects.toMatchObject({
      status: 409,
      code: 'DUPLICATE_BOOK',
    });
    // Duplicate short-circuits before the catalog lookup and insert.
    expect(bookRepo.findCatalogById).not.toHaveBeenCalled();
    expect(bookRepo.create).not.toHaveBeenCalled();
  });
});
