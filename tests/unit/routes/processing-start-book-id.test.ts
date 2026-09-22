import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// processing_jobs.book_id is nullable (src/db/schema.ts), so nothing at the DB
// level catches a job row born without one. A NULL book_id makes the job
// permanently un-retryable (the /retry gate returns 400 'No book associated'),
// skips cancel's structure cleanup, and survives book hard-delete. Both
// /processing/start branches must set it — free and paid alike (KAN-319).
const billingRepo = vi.hoisted(() => ({ createJob: vi.fn() }));
vi.mock('../../../src/repositories/billing.repository.js', () => ({ billingRepository: billingRepo }));

const bookRepo = vi.hoisted(() => ({ findCatalogById: vi.fn(), update: vi.fn(), findById: vi.fn() }));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: bookRepo }));

const bookSvc = vi.hoisted(() => ({ getBook: vi.fn() }));
vi.mock('../../../src/services/book.service.js', () => ({ bookService: bookSvc }));

const billingSvc = vi.hoisted(() => ({ createPaymentIntent: vi.fn() }));
vi.mock('../../../src/services/billing.service.js', () => ({ billingService: billingSvc }));

const freeAccess = vi.hoisted(() => ({ hasFreeAiAccess: vi.fn() }));
vi.mock('../../../src/lib/billing-access.js', () => freeAccess);

// The .nib cache lookup runs before either branch; keep it empty so we reach them.
const dbMock = vi.hoisted(() => ({
  select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
}));
vi.mock('../../../src/db/index.js', () => ({ db: dbMock }));

// Pulled in at module scope by processing.ts; the /start handler touches none of them.
vi.mock('../../../src/services/storage.service.js', () => ({ storageService: {} }));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({ processingLogRepository: {} }));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: {} }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: {} }));

const { processingRoutes } = await import('../../../src/routes/processing.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const CATALOG_ID = '55555555-5555-4555-8555-555555555555';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const FILE_HASH = 'a'.repeat(64);

function start() {
  const app = new Hono();
  app.onError(errorHandler);
  // Mirrors src/index.ts, where authMiddleware sets the user before /processing/*.
  app.use('/processing/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/processing', processingRoutes);
  return app.request('/processing/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId: BOOK_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bookSvc.getBook.mockResolvedValue({ id: BOOK_ID, catalogId: CATALOG_ID, processingStatus: 'idle' });
  // catalogId is deliberately different from BOOK_ID: the job must carry the
  // book's own id, not the catalog's.
  bookRepo.findCatalogById.mockResolvedValue({ id: CATALOG_ID, fileHash: FILE_HASH, totalPages: 10 });
  bookRepo.update.mockResolvedValue(undefined);
  billingRepo.createJob.mockResolvedValue({ id: JOB_ID });
  billingSvc.createPaymentIntent.mockResolvedValue({ clientSecret: 'cs_test' });
});

describe('POST /processing/start sets book_id on the job', () => {
  it('free branch persists the book id', async () => {
    freeAccess.hasFreeAiAccess.mockReturnValue(true);

    const res = await start();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: JOB_ID, free: true });
    expect(billingRepo.createJob).toHaveBeenCalledTimes(1);
    expect(billingRepo.createJob.mock.calls[0][0]).toMatchObject({
      bookId: BOOK_ID,
      fileHash: FILE_HASH,
      userId: USER_ID,
      paid: true,
    });
  });

  it('paid branch persists the book id', async () => {
    freeAccess.hasFreeAiAccess.mockReturnValue(false);

    const res = await start();

    expect(res.status).toBe(200);
    expect(billingRepo.createJob).toHaveBeenCalledTimes(1);
    expect(billingRepo.createJob.mock.calls[0][0]).toMatchObject({
      bookId: BOOK_ID,
      fileHash: FILE_HASH,
      userId: USER_ID,
      processingCostCents: 50,
    });
  });

  it.each([
    ['free', true],
    ['paid', false],
  ])('%s branch never sends a null or undefined bookId', async (_label, free) => {
    freeAccess.hasFreeAiAccess.mockReturnValue(free);

    await start();

    const data = billingRepo.createJob.mock.calls[0][0];
    expect(data.bookId).toBeTruthy();
    expect(data.bookId).not.toBe(CATALOG_ID);
  });
});
