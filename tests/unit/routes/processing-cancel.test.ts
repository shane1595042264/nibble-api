import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// cancelJob soft-deletes every chapter/section of the job's BOOK. After a retry
// the old job is 'superseded' while a new job runs for the same book, so a
// cancel aimed at the old id must be refused or it wipes the new run's
// structure while that pipeline keeps going (KAN-347).
const procLogRepo = vi.hoisted(() => ({ getJob: vi.fn() }));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({
  processingLogRepository: procLogRepo,
}));

const procSvc = vi.hoisted(() => ({ cancelJob: vi.fn() }));
vi.mock('../../../src/services/processing.service.js', () => ({ processingService: procSvc }));

// Pulled in at module scope by processing.ts; the cancel handler touches none of them.
vi.mock('../../../src/db/index.js', () => ({ db: {} }));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: {} }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: {} }));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: {} }));
vi.mock('../../../src/repositories/billing.repository.js', () => ({ billingRepository: {} }));
vi.mock('../../../src/services/billing.service.js', () => ({ billingService: {} }));
vi.mock('../../../src/services/book.service.js', () => ({ bookService: {} }));
vi.mock('../../../src/services/storage.service.js', () => ({ storageService: {} }));

const { processingRoutes } = await import('../../../src/routes/processing.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';

function cancel() {
  const app = new Hono();
  app.onError(errorHandler);
  // Mirrors src/index.ts, where authMiddleware sets the user before /processing/*.
  app.use('/processing/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/processing', processingRoutes);
  return app.request(`/processing/${JOB_ID}/cancel`, { method: 'POST' });
}

const jobWith = (status: string) => ({ id: JOB_ID, userId: USER_ID, bookId: BOOK_ID, status });

beforeEach(() => {
  vi.clearAllMocks();
  procSvc.cancelJob.mockResolvedValue(undefined);
});

describe('POST /processing/:jobId/cancel', () => {
  it.each(['superseded', 'failed'])('refuses a %s job without touching the book', async (status) => {
    procLogRepo.getJob.mockResolvedValue(jobWith(status));

    const res = await cancel();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Job is not running' });
    expect(procSvc.cancelJob).not.toHaveBeenCalled();
  });

  it('keeps refusing a completed job with 400', async () => {
    procLogRepo.getJob.mockResolvedValue(jobWith('completed'));

    const res = await cancel();

    expect(res.status).toBe(400);
    expect(procSvc.cancelJob).not.toHaveBeenCalled();
  });

  it.each(['pending', 'processing'])('cancels a %s job', async (status) => {
    procLogRepo.getJob.mockResolvedValue(jobWith(status));

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(procSvc.cancelJob).toHaveBeenCalledWith(JOB_ID);
  });

  it("404s another user's job", async () => {
    procLogRepo.getJob.mockResolvedValue({ ...jobWith('processing'), userId: 'someone-else' });

    const res = await cancel();

    expect(res.status).toBe(404);
    expect(procSvc.cancelJob).not.toHaveBeenCalled();
  });
});
