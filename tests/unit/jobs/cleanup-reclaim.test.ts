import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { isForeignKeyViolation } from '../../../src/lib/errors.js';

// db.select() is only used for the pdf_files lookup; db.delete() for the three
// row deletes. Both are chainable builders that resolve when awaited.
const db = vi.hoisted(() => ({ select: vi.fn(), delete: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ db }));

const storage = vi.hoisted(() => ({ deleteObject: vi.fn() }));
vi.mock('../../../src/services/storage.service.js', () => ({ storageService: storage }));

const { reclaimCatalogStorage, reclaimOrphanedStorage } = await import('../../../src/jobs/cleanup.js');

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

/**
 * Walk a drizzle SQL predicate and pull out the column names and bound
 * parameters it references, so a test can assert the WHERE clause really
 * carries the age bound instead of just asserting the mock was called.
 */
function inspectPredicate(predicate: unknown): { columns: string[]; params: unknown[] } {
  const columns: string[] = [];
  const params: unknown[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Record<string, unknown>;
    if (n.name && n.table) columns.push(n.name as string);
    if (n.value !== undefined && n.encoder) params.push(n.value);
    if (n.queryChunks) walk(n.queryChunks);
  };
  walk((predicate as { queryChunks?: unknown }).queryChunks);
  return { columns, params };
}

/**
 * db.select() as a chainable builder covering all three shapes the job uses:
 * the orphan scan (.from().leftJoin().where().limit()), the deferred count
 * (.from().leftJoin().where(), awaited directly) and reclaimCatalogStorage's
 * pdf_files lookup. Resolves the queued result sets in call order and records
 * every where() argument for inspection.
 */
function mockSelectQueue(resultSets: unknown[][]): unknown[] {
  const wheres: unknown[] = [];
  db.select.mockImplementation(() => {
    const rows = resultSets.shift() ?? [];
    const builder: Record<string, unknown> = {
      from: () => builder,
      leftJoin: () => builder,
      where: (w: unknown) => {
        wheres.push(w);
        return builder;
      },
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return builder;
  });
  return wheres;
}

describe('reclaimOrphanedStorage', () => {
  beforeEach(() => {
    db.select.mockReset();
    db.delete.mockReset();
    storage.deleteObject.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('bounds the orphan scan by both catalog timestamps, roughly an hour back', async () => {
    const wheres = mockSelectQueue([[], [{ total: 0 }]]);
    const before = Date.now();

    await reclaimOrphanedStorage();

    const { columns, params } = inspectPredicate(wheres[0]);
    // isNull(books.id) plus the two age bounds — without these the predicate
    // matches an upload that is still mid-flight.
    expect(columns).toEqual(['id', 'created_at', 'updated_at']);

    const cutoffs = params.filter((v): v is Date => v instanceof Date);
    expect(cutoffs).toHaveLength(2);
    for (const cutoff of cutoffs) {
      const age = before - cutoff.getTime();
      expect(age).toBeGreaterThanOrEqual(60 * 60 * 1000);
      expect(age).toBeLessThan(60 * 60 * 1000 + 60_000);
    }
  });

  it('reports catalogs inside the grace period as deferred and never touches them', async () => {
    mockSelectQueue([[], [{ total: 3 }]]);

    await expect(reclaimOrphanedStorage()).resolves.toEqual({
      reclaimed: 0,
      skipped: 0,
      deferred: 3,
    });

    // No R2 delete and no row delete for an in-flight upload.
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('still reclaims a settled orphan and logs it by identity (KAN-131 behaviour)', async () => {
    mockSelectQueue([
      [{ catalogId: CATALOG_ID, fileHash: FILE_HASH, title: 'Old Book' }],
      [{ total: 0 }],
      [{ r2Key: PDF_KEY }],
    ]);
    storage.deleteObject.mockResolvedValue(undefined);
    const deleted: string[] = [];
    mockDeletes(deleted);

    await expect(reclaimOrphanedStorage()).resolves.toEqual({
      reclaimed: 1,
      skipped: 0,
      deferred: 0,
    });
    expect(deleted).toEqual(['pdf_files', 'nib_cache', 'book_catalog']);

    // Hard deletes with no other audit trail must be identifiable after the fact.
    const logged = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls
      .map((c) => c[0])
      .join(' | ');
    expect(logged).toContain(CATALOG_ID);
    expect(logged).toContain(FILE_HASH);
    expect(logged).toContain('Old Book');
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
