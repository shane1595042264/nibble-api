import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppError } from '../../../src/lib/errors.js';

// Mock the repositories that book.service imports. Only createBook is exercised here,
// so we stub the handful of methods it touches.
const bookRepo = vi.hoisted(() => ({
  findByUserIdAndCatalogId: vi.fn(),
  findCatalogById: vi.fn(),
  create: vi.fn(),
  findCatalogByHash: vi.fn(),
  updateCatalog: vi.fn(),
  findDeletedByUserIdAndCatalogId: vi.fn(),
  restore: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: bookRepo }));

// The remaining repos / db imports are unused by createBook but must resolve.
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: {} }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: {} }));
vi.mock('../../../src/repositories/vocabulary.repository.js', () => ({ vocabularyRepository: {} }));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({ processingLogRepository: {} }));

// db is used by handleUpload. delete() returns a thenable-ish chain; select() the pdf_files lookup.
const db = vi.hoisted(() => ({
  select: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../../src/db/index.js', () => ({ db }));

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

describe('bookService.handleUpload re-upload-after-delete restore edge', () => {
  const FILE_HASH = 'hash-abc';
  const CAT = { id: 'cat-1', userCount: 3 };

  beforeEach(() => {
    bookRepo.findCatalogByHash.mockReset();
    bookRepo.updateCatalog.mockReset();
    bookRepo.findByUserIdAndCatalogId.mockReset();
    bookRepo.findDeletedByUserIdAndCatalogId.mockReset();
    bookRepo.restore.mockReset();
    db.select.mockReset();
    db.delete.mockReset();

    // Existing catalog for this hash → skip metadata lookup.
    bookRepo.findCatalogByHash.mockResolvedValue(CAT);
    bookRepo.updateCatalog.mockResolvedValue(undefined);
    // pdf_files row already present → skip R2 upload/insert.
    db.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'file-1' }]) }) }),
    });
    // db.delete(table).where(...) for the old sections/chapters cleanup.
    db.delete.mockReturnValue({ where: () => Promise.resolve(undefined) });
    // No active book, but a soft-deleted one exists → take the restore path.
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue(null);
    bookRepo.findDeletedByUserIdAndCatalogId.mockResolvedValue({ id: 'deleted-book-1' });
  });

  it('throws PROCESSING_FAILED (500) instead of returning { book: null } when restore() yields no row', async () => {
    bookRepo.restore.mockResolvedValue(null); // UPDATE ... .returning() found nothing

    await expect(
      bookService.handleUpload(USER_ID, FILE_HASH, Buffer.from('x'), 10, 'Test Book'),
    ).rejects.toMatchObject({ status: 500, code: 'PROCESSING_FAILED' });

    // The throw fires before the processing-job transaction, so no pipeline is kicked off.
    expect(bookRepo.restore).toHaveBeenCalledWith('deleted-book-1', { processingStatus: 'pending' });
  });
});
