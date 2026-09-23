import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppError } from '../../../src/lib/errors.js';

// Mock the repositories that book.service imports. Only createBook is exercised here,
// so we stub the handful of methods it touches.
const bookRepo = vi.hoisted(() => ({
  findByUserIdAndCatalogId: vi.fn(),
  findCatalogById: vi.fn(),
  create: vi.fn(),
  findCatalogByHash: vi.fn(),
  updateCatalog: vi.fn(),
  touchCatalog: vi.fn(),
  incrementCatalogUserCount: vi.fn(),
  findDeletedByUserIdAndCatalogId: vi.fn(),
  restore: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: bookRepo }));

// The remaining repos / db imports are unused by createBook but must resolve.
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: {} }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: {} }));
vi.mock('../../../src/repositories/vocabulary.repository.js', () => ({ vocabularyRepository: {} }));

// processing-log.repository: startPipelineAsync's catch calls failJob (KAN-279).
const processingLogRepo = vi.hoisted(() => ({ failJob: vi.fn(), findActiveJobByFileHash: vi.fn() }));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({ processingLogRepository: processingLogRepo }));

// processing.service is dynamically imported by startPipelineAsync. Stub
// orchestratePipeline (to reject and exercise the catch) and markBookErrored
// (the KAN-243 rescue net) so we can assert startPipelineAsync's catch path.
const processingSvc = vi.hoisted(() => ({
  orchestratePipeline: vi.fn(),
  markBookErrored: vi.fn(),
}));
vi.mock('../../../src/services/processing.service.js', () => ({
  processingService: { orchestratePipeline: processingSvc.orchestratePipeline },
  markBookErrored: processingSvc.markBookErrored,
}));

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
    bookRepo.touchCatalog.mockReset().mockResolvedValue(undefined);
    bookRepo.incrementCatalogUserCount.mockReset().mockResolvedValue(undefined);
    bookRepo.findByUserIdAndCatalogId.mockReset();
    bookRepo.findDeletedByUserIdAndCatalogId.mockReset();
    bookRepo.restore.mockReset();
    processingLogRepo.findActiveJobByFileHash.mockReset().mockResolvedValue(null);
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

// Flush the fire-and-forget setTimeout(0) plus the chain of awaits inside the
// catch (dynamic import, failJob, markBookErrored). A few real macrotask ticks
// drain them — fake timers can't reliably resolve the first dynamic import.
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('startPipelineAsync failure net (KAN-279)', () => {
  const FILE_HASH = 'hash-fail';
  const CAT = { id: 'cat-2', userCount: 1 };
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bookRepo.findCatalogByHash.mockReset().mockResolvedValue(CAT);
    bookRepo.updateCatalog.mockReset().mockResolvedValue(undefined);
    bookRepo.touchCatalog.mockReset().mockResolvedValue(undefined);
    bookRepo.incrementCatalogUserCount.mockReset().mockResolvedValue(undefined);
    bookRepo.update.mockReset().mockResolvedValue(undefined);
    bookRepo.findByUserIdAndCatalogId.mockReset();
    db.select.mockReset();
    processingLogRepo.failJob.mockReset().mockResolvedValue(undefined);
    processingLogRepo.findActiveJobByFileHash.mockReset().mockResolvedValue(null);
    processingSvc.orchestratePipeline.mockReset();
    processingSvc.markBookErrored.mockReset().mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // pdf_files row already present → skip R2 upload.
    db.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'file-2' }]) }) }),
    });
    // Active (non-complete) book exists → take the existing-book restart path.
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue({ id: 'book-existing', processingStatus: 'pending' });
    // Transaction: no active job, insert returns a fresh job, then set status:processing.
    (db as any).transaction = vi.fn(async (cb: (tx: any) => unknown) =>
      cb({
        select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'job-new' }]) }) }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes the pipeline failure through markBookErrored and never silently swallows', async () => {
    // orchestratePipeline rejects OUTSIDE the inner nets → startPipelineAsync's catch fires.
    processingSvc.orchestratePipeline.mockRejectedValue(new Error('catalog lookup: connection terminated'));

    const result = await bookService.handleUpload(USER_ID, FILE_HASH, Buffer.from('x'), 10, 'Test Book');
    expect(result.jobId).toBe('job-new');

    // Flush the setTimeout(0) + all awaited work inside the fire-and-forget catch.
    await flush();

    // The book is rescued via the KAN-243 net (retry + loud logging), not a bare update.
    expect(processingSvc.markBookErrored).toHaveBeenCalledWith('book-existing', 'job-new');
    // The pipeline failure itself is logged (not swallowed).
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.some(([m]) => String(m).includes('Processing pipeline failed'))).toBe(true);
  });

  it('logs (does not swallow) when the failJob write also fails', async () => {
    processingSvc.orchestratePipeline.mockRejectedValue(new Error('pipeline blew up'));
    processingLogRepo.failJob.mockRejectedValue(new Error('failJob write failed'));

    await bookService.handleUpload(USER_ID, FILE_HASH, Buffer.from('x'), 10, 'Test Book');
    await flush();

    // failJob failure is traced with the jobId instead of vanishing via .catch(() => {}).
    expect(errorSpy.mock.calls.some(([m]) => String(m).includes('job-new'))).toBe(true);
    // Book rescue still runs despite the failJob failure.
    expect(processingSvc.markBookErrored).toHaveBeenCalledWith('book-existing', 'job-new');
  });
});

// KAN-322: file_hash is content-addressed and the catalog row is shared across
// users, so two users uploading the same textbook is designed-for. The upload
// path used to hand uploader B the id of A's in-flight job, which B can never
// read (GET /processing/:jobId 404s on a foreign job) — stranding B's book at
// 'pending' forever behind a dead Retry button. A foreign holder of the global
// index must be an honest 409 that leaves nothing half-built behind.
describe('bookService.handleUpload cross-user active-job collision (KAN-322)', () => {
  const FILE_HASH = 'hash-shared-textbook';
  const CAT = { id: 'cat-shared', userCount: 7 };
  const FOREIGN_JOB = { id: 'job-owned-by-user-2', userId: 'user-2' };
  const OWN_JOB = { id: 'job-owned-by-user-1', userId: USER_ID };
  let activeJobRow: { id: string; userId: string } | null = null;

  beforeEach(() => {
    bookRepo.findCatalogByHash.mockReset().mockResolvedValue(CAT);
    bookRepo.touchCatalog.mockReset().mockResolvedValue(undefined);
    bookRepo.incrementCatalogUserCount.mockReset().mockResolvedValue(CAT);
    bookRepo.findByUserIdAndCatalogId.mockReset().mockResolvedValue(null);
    bookRepo.findDeletedByUserIdAndCatalogId.mockReset().mockResolvedValue(null);
    bookRepo.restore.mockReset();
    bookRepo.create.mockReset().mockResolvedValue({ id: 'book-b', userId: USER_ID, catalogId: CAT.id });
    bookRepo.update.mockReset().mockResolvedValue(undefined);
    processingLogRepo.findActiveJobByFileHash.mockReset().mockResolvedValue(null);
    processingSvc.orchestratePipeline.mockReset().mockResolvedValue(undefined);
    db.select.mockReset();
    db.delete.mockReset().mockReturnValue({ where: () => Promise.resolve(undefined) });
    activeJobRow = null;

    // pdf_files row already present → skip the R2 upload.
    db.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'file-shared' }]) }) }),
    });
    // Default transaction: insert yields a fresh job for this caller. tx.select
    // serves the same row the repository lookup would, so these tests reproduce
    // the pre-fix behaviour (which read the job with its own inline tx.select)
    // rather than passing vacuously against it.
    (db as any).transaction = vi.fn(async (cb: (tx: any) => unknown) =>
      cb({
        select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(activeJobRow ? [activeJobRow] : []) }) }) }),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'job-new' }]) }) }),
      }),
    );
  });

  /** Publish one active job through BOTH readers: the repository lookup the fix
   *  uses and the inline tx.select the pre-fix code used. */
  const setActiveJob = (job: { id: string; userId: string }) => {
    activeJobRow = job;
    processingLogRepo.findActiveJobByFileHash.mockResolvedValue(job);
  };

  const upload = () => bookService.handleUpload(USER_ID, FILE_HASH, Buffer.from('x'), 10, 'Shared Textbook');

  it('rejects with 409 instead of adopting another user\'s job id', async () => {
    setActiveJob(FOREIGN_JOB);

    await expect(upload()).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    await expect(upload()).rejects.toThrow(/already being processed/i);
  });

  it('leaves NO orphan book row or catalog bump behind when it 409s', async () => {
    setActiveJob(FOREIGN_JOB);

    await expect(upload()).rejects.toMatchObject({ status: 409 });

    // The whole point: the guard fires before any book-row mutation, so the
    // uploader is not left with a pending book nobody will ever process.
    expect(bookRepo.create).not.toHaveBeenCalled();
    expect(bookRepo.incrementCatalogUserCount).not.toHaveBeenCalled();
    expect(processingSvc.orchestratePipeline).not.toHaveBeenCalled();
  });

  it('never reaches the destructive restore path when the collision is foreign', async () => {
    // A soft-deleted book exists, so without the early guard this upload would
    // hard-delete its old chapters/sections and clear deletedAt before failing.
    bookRepo.findDeletedByUserIdAndCatalogId.mockResolvedValue({ id: 'deleted-book-b' });
    setActiveJob(FOREIGN_JOB);

    await expect(upload()).rejects.toMatchObject({ status: 409 });

    expect(bookRepo.restore).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('does not touch an existing book\'s status when the collision is foreign', async () => {
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue({ id: 'book-b', processingStatus: 'pending' });
    setActiveJob(FOREIGN_JOB);

    await expect(upload()).rejects.toMatchObject({ status: 409 });

    expect(bookRepo.update).not.toHaveBeenCalled();
    expect(processingSvc.orchestratePipeline).not.toHaveBeenCalled();
  });

  it('keeps re-uploading an already-complete book a no-op, even mid-collision', async () => {
    // Regression guard for the fix's own ordering: the 'complete' short-circuit
    // sits ABOVE the active-job lookup, so a stranger's in-flight job for the
    // same file must not turn a harmless re-upload into an error.
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue({ id: 'book-b', processingStatus: 'complete' });
    setActiveJob(FOREIGN_JOB);

    const result = await upload();

    expect(result.jobId).toBeUndefined();
    expect(processingLogRepo.findActiveJobByFileHash).not.toHaveBeenCalled();
  });

  it('maps a 23505 lost race to the same 409, not an opaque 500', async () => {
    // Pre-check saw nothing, then a concurrent insert committed first. Drizzle
    // hangs the real PostgresError off .cause (KAN-302).
    (db as any).transaction = vi.fn(async () => {
      throw Object.assign(new Error('DrizzleQueryError'), {
        cause: Object.assign(new Error('duplicate key value'), { code: '23505' }),
      });
    });

    await expect(upload()).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('still returns YOUR OWN in-flight job id and starts no second pipeline', async () => {
    setActiveJob(OWN_JOB);

    const result = await upload();

    expect(result.jobId).toBe(OWN_JOB.id);
    await flush();
    expect(processingSvc.orchestratePipeline).not.toHaveBeenCalled();
  });

  it('control arm: an upload with no active job processes normally', async () => {
    processingLogRepo.findActiveJobByFileHash.mockResolvedValue(null);

    const result = await upload();

    expect(result.jobId).toBe('job-new');
    expect(result.isNew).toBe(true);
    await flush();
    expect(processingSvc.orchestratePipeline).toHaveBeenCalledWith('job-new', FILE_HASH, 'book-b', 'full');
  });
});
