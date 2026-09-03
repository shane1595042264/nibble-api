import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { isForeignKeyViolation } from '../../../src/lib/errors.js';

// db.select() is only used for the pdf_files lookup; db.delete() for the three
// row deletes. Both are chainable builders that resolve when awaited.
const db = vi.hoisted(() => ({ select: vi.fn(), delete: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ db }));

const storage = vi.hoisted(() => ({ deleteObject: vi.fn() }));
vi.mock('../../../src/services/storage.service.js', () => ({ storageService: storage }));

const { reclaimCatalogStorage } = await import('../../../src/jobs/cleanup.js');

const CATALOG_ID = 'cat-1';
const FILE_HASH = 'hash-abc';
const PDF_KEY = 'pdfs/hash-abc.pdf';
const NIB_KEY = `nibs/${FILE_HASH}.nib.json`;

/** db.select().from().where().limit() resolving to the given pdf_files rows. */
function mockPdfLookup(rows: unknown[]) {
  db.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
}

/** db.delete().where() recording each call so ordering/count can be asserted. */
function mockDeletes(calls: string[]) {
  db.delete.mockImplementation((table: Parameters<typeof getTableName>[0]) => {
    calls.push(getTableName(table));
    return { where: () => Promise.resolve(undefined) };
  });
}

describe('reclaimCatalogStorage', () => {
  beforeEach(() => {
    db.select.mockReset();
    db.delete.mockReset();
    storage.deleteObject.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('deletes both R2 objects, then the three DB rows, and reports success', async () => {
    mockPdfLookup([{ r2Key: PDF_KEY }]);
    storage.deleteObject.mockResolvedValue(undefined);
    const deleted: string[] = [];
    mockDeletes(deleted);

    await expect(reclaimCatalogStorage(CATALOG_ID, FILE_HASH)).resolves.toBe(true);

    // PDF first (unshifted ahead of the .nib key), then the nib cache object.
    expect(storage.deleteObject.mock.calls.map((c) => c[0])).toEqual([PDF_KEY, NIB_KEY]);
    expect(deleted).toEqual(['pdf_files', 'nib_cache', 'book_catalog']);
  });

  it('still deletes the .nib object when no pdf_files row exists', async () => {
    mockPdfLookup([]);
    storage.deleteObject.mockResolvedValue(undefined);
    const deleted: string[] = [];
    mockDeletes(deleted);

    await expect(reclaimCatalogStorage(CATALOG_ID, FILE_HASH)).resolves.toBe(true);

    expect(storage.deleteObject.mock.calls.map((c) => c[0])).toEqual([NIB_KEY]);
    expect(deleted).toEqual(['pdf_files', 'nib_cache', 'book_catalog']);
  });

  it('leaves every DB row intact and returns false when an R2 delete fails', async () => {
    mockPdfLookup([{ r2Key: PDF_KEY }]);
    // The PDF delete fails; the catalog row must survive so the hourly job can
    // rediscover this orphan and retry — it is the only discovery key.
    storage.deleteObject.mockImplementation((key: string) =>
      key === PDF_KEY ? Promise.reject(new Error('R2 down')) : Promise.resolve(undefined),
    );
    const deleted: string[] = [];
    mockDeletes(deleted);

    await expect(reclaimCatalogStorage(CATALOG_ID, FILE_HASH)).resolves.toBe(false);

    // Both keys are still attempted, but no row is dropped.
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual([]);
  });
});

describe('isForeignKeyViolation', () => {
  it('matches a Postgres 23503 driver error', () => {
    expect(isForeignKeyViolation(Object.assign(new Error('violates fk'), { code: '23503' }))).toBe(true);
  });

  it('does not match other errors or non-objects', () => {
    expect(isForeignKeyViolation(Object.assign(new Error('unique'), { code: '23505' }))).toBe(false);
    expect(isForeignKeyViolation(new Error('plain'))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation('23503')).toBe(false);
  });
});
