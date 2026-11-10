import { describe, it, expect, beforeEach, vi } from 'vitest';

// A job orphaned by a redeploy is re-run by recoverStuckJobs. Only the upload
// knew the user's 'TOC Only' choice, so the re-run used to fall back to full
// paid processing (KAN-396). The mode now travels on the recovered job.
vi.mock('../../../src/repositories/billing.repository.js', () => ({ billingRepository: {} }));

const procLogRepo = vi.hoisted(() => ({ getJobMode: vi.fn() }));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({ processingLogRepository: procLogRepo }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: { softDeleteByBookId: vi.fn() } }));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: { softDeleteByBookId: vi.fn() } }));

const JOB_ID = 'job-stuck';
const stuckRow = {
  id: JOB_ID,
  status: 'processing',
  createdAt: new Date(),
  processingCostCents: null,
  stripePaymentIntentId: null,
};

// tx.update(...).set(...).where(...) is awaited for the books write and
// .returning()'d for the job claim, so where() yields both.
const tx = {
  update: () => ({
    set: () => ({
      where: () => Object.assign(Promise.resolve(undefined), {
        returning: () => Promise.resolve([{ id: JOB_ID, fileHash: 'hash-1', bookId: 'book-1' }]),
      }),
    }),
  }),
};
const dbMock = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ db: dbMock }));

const { jobQueue } = await import('../../../src/jobs/queue.js');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([stuckRow]) }) });
  dbMock.transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
});

describe('jobQueue.recoverStuckJobs processing mode (KAN-396)', () => {
  it('dispatches a recovered toc-only job as toc-only', async () => {
    procLogRepo.getJobMode.mockResolvedValue('toc-only');

    const { resumed } = await jobQueue.recoverStuckJobs();
    expect(procLogRepo.getJobMode).toHaveBeenCalledWith(JOB_ID, tx);
    expect(resumed).toEqual([{ id: JOB_ID, fileHash: 'hash-1', bookId: 'book-1', mode: 'toc-only' }]);
  });

  it('dispatches a legacy job with no recorded mode as full', async () => {
    procLogRepo.getJobMode.mockResolvedValue('full');

    const { resumed } = await jobQueue.recoverStuckJobs();
    expect(resumed[0].mode).toBe('full');
  });
});
