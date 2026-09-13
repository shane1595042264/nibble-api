import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

// idx_processing_jobs_active_file_hash is a partial unique index on file_hash
// ALONE — not user-scoped — and file_hash is content-addressed, so another
// user's in-flight job for the same file blocks the retry insert. The claim that
// flips the source job 'failed' -> 'superseded' (a terminal state) must therefore
// live inside the same transaction as that insert, or a collision burns the
// book's only retry token permanently (KAN-302).
const procLogRepo = vi.hoisted(() => ({
  claimFailedForRetry: vi.fn(),
  findActiveJobByFileHash: vi.fn(),
  getJob: vi.fn(),
  failJob: vi.fn(),
}));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({
  processingLogRepository: procLogRepo,
}));

const bookRepo = vi.hoisted(() => ({ findById: vi.fn(), update: vi.fn(), findCatalogById: vi.fn() }));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: bookRepo }));

const sectionRepo = vi.hoisted(() => ({ softDeleteByBookId: vi.fn() }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: sectionRepo }));

const chapterRepo = vi.hoisted(() => ({ softDeleteByBookId: vi.fn() }));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: chapterRepo }));

// In-memory stand-in for Postgres: db.transaction runs the callback and, when it
// throws, discards every write the callback made — what a ROLLBACK does.
const insertJob = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ db: dbMock }));

// Pulled in at module scope by processing.ts; the retry handler touches none of them.
vi.mock('../../../src/repositories/billing.repository.js', () => ({ billingRepository: { createJob: vi.fn() } }));
vi.mock('../../../src/services/billing.service.js', () => ({ billingService: {} }));
vi.mock('../../../src/services/book.service.js', () => ({ bookService: {} }));
vi.mock('../../../src/services/storage.service.js', () => ({ storageService: {} }));

const { processingRoutes } = await import('../../../src/routes/processing.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const NEW_JOB_ID = '44444444-4444-4444-8444-444444444444';
const FILE_HASH = 'a'.repeat(64);

/** The source job row, mutated by the fake claim so we can assert the rollback. */
let sourceJob: { id: string; userId: string; status: string; fileHash: string; bookId: string | null };

function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);
  // Mirrors src/index.ts, where authMiddleware sets the user before /processing/*.
  app.use('/processing/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/processing', processingRoutes);
  return app;
}

const retry = () => makeApp().request(`/processing/${JOB_ID}/retry`, { method: 'POST' });

const uniqueViolation = () =>
  Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

beforeEach(() => {
  vi.clearAllMocks();
  // The handler kicks the pipeline off in a setTimeout; keep it from running.
  vi.useFakeTimers();
  sourceJob = { id: JOB_ID, userId: USER_ID, status: 'failed', fileHash: FILE_HASH, bookId: BOOK_ID };

  // Mutates the shared row, like the real UPDATE ... WHERE status = 'failed'.
  procLogRepo.claimFailedForRetry.mockImplementation(async () => {
    if (sourceJob.status !== 'failed') return null;
    sourceJob.status = 'superseded';
    return { ...sourceJob };
  });
  procLogRepo.getJob.mockImplementation(async () => ({ ...sourceJob }));
  procLogRepo.findActiveJobByFileHash.mockResolvedValue(null);
  procLogRepo.failJob.mockResolvedValue(undefined);
  bookRepo.findById.mockResolvedValue({ id: BOOK_ID });
  bookRepo.update.mockResolvedValue(undefined);
  sectionRepo.softDeleteByBookId.mockResolvedValue(undefined);
  chapterRepo.softDeleteByBookId.mockResolvedValue(undefined);
  insertJob.mockImplementation(async () => [{ id: NEW_JOB_ID, fileHash: FILE_HASH, bookId: BOOK_ID }]);

  dbMock.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const before = { ...sourceJob };
    const tx = {
      update: () => ({ set: () => ({ where: () => ({ returning: () => [] }) }) }),
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => [] }) }) }) }),
      insert: () => ({ values: () => ({ returning: () => insertJob() }) }),
    };
    try {
      return await fn(tx);
    } catch (err) {
      sourceJob = before; // ROLLBACK
      throw err;
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /processing/:jobId/retry — active-job collision', () => {
  it('returns an actionable 409, not a 500, when another job holds the file_hash', async () => {
    procLogRepo.findActiveJobByFileHash.mockResolvedValue({ id: 'someone-elses-job', status: 'processing' });

    const res = await retry();
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toMatch(/already being processed/i);
  });

  it('leaves the source job retryable after a collision instead of burning it', async () => {
    procLogRepo.findActiveJobByFileHash.mockResolvedValue({ id: 'someone-elses-job', status: 'processing' });

    expect((await retry()).status).toBe(409);
    // The whole point: 'superseded' is terminal, so the claim must have rolled back.
    expect(sourceJob.status).toBe('failed');

    // And the very same POST succeeds once the blocking job clears.
    procLogRepo.findActiveJobByFileHash.mockResolvedValue(null);
    const second = await retry();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ jobId: NEW_JOB_ID });
  });

  it('maps a 23505 that beats the pre-check to the same 409 and still rolls back', async () => {
    // Pre-check sees nothing; a concurrent insert commits before ours lands.
    insertJob.mockRejectedValue(uniqueViolation());

    const res = await retry();
    expect(res.status).toBe(409);
    expect((await res.json() as any).error.message).toMatch(/already being processed/i);
    expect(sourceJob.status).toBe('failed');
  });

  it('does not swallow non-unique driver errors as a conflict', async () => {
    insertJob.mockRejectedValue(Object.assign(new Error('deadlock detected'), { code: '40P01' }));

    const res = await retry();
    expect(res.status).toBe(500);
    expect(sourceJob.status).toBe('failed');
  });

  it('rolls the claim back when the book row is gone', async () => {
    bookRepo.findById.mockResolvedValue(null);

    const res = await retry();
    expect(res.status).toBe(404);
    expect(sourceJob.status).toBe('failed');
  });
});

describe('POST /processing/:jobId/retry — unchanged behaviour', () => {
  it('writes chapter/section tombstones and returns the new job id', async () => {
    const res = await retry();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: NEW_JOB_ID });

    // KAN-229 / KAN-254 must not regress: both tombstone writes ran inside the tx.
    expect(sectionRepo.softDeleteByBookId).toHaveBeenCalledWith(BOOK_ID, expect.anything());
    expect(chapterRepo.softDeleteByBookId).toHaveBeenCalledWith(BOOK_ID, expect.anything());
    expect(bookRepo.update).toHaveBeenCalledWith(BOOK_ID, { processingStatus: 'processing' });
    expect(sourceJob.status).toBe('superseded');
  });

  it('still reports an already-retried job as 409 rather than claiming again', async () => {
    sourceJob.status = 'superseded';

    const res = await retry();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Job already retried' });
  });

  it('still rejects a job with no book without touching the tombstones', async () => {
    sourceJob.bookId = null;

    const res = await retry();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No book associated with this job' });
    expect(sectionRepo.softDeleteByBookId).not.toHaveBeenCalled();
  });
});
