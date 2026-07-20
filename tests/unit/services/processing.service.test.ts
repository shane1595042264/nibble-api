import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// processing.service.ts pulls in a large graph (storage/pdf/epub services, db,
// repositories). We only exercise markBookErrored here, so stub out everything
// that has import-time side effects or needs real config/network.

const {
  updateMock,
  dbDeleteMock,
  transactionMock,
  getJobMock,
  appendMock,
  failJobMock,
  sectionSoftDeleteMock,
  chapterSoftDeleteMock,
} = vi.hoisted(() => ({
  updateMock: vi.fn(),
  dbDeleteMock: vi.fn(),
  transactionMock: vi.fn(),
  getJobMock: vi.fn(),
  appendMock: vi.fn(),
  failJobMock: vi.fn(),
  sectionSoftDeleteMock: vi.fn(),
  chapterSoftDeleteMock: vi.fn(),
}));

vi.mock('../../../src/lib/config.js', () => ({
  config: {
    DATABASE_URL: 'postgres://test',
    R2_BUCKET_NAME: 'test-bucket',
    R2_ENDPOINT: 'https://test.r2',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
  },
}));
vi.mock('../../../src/db/index.js', () => ({
  db: { delete: dbDeleteMock, transaction: transactionMock },
}));
vi.mock('../../../src/services/storage.service.js', () => ({ storageService: {} }));
vi.mock('../../../src/services/pdf.service.js', () => ({ pdfService: {} }));
vi.mock('../../../src/services/epub.service.js', () => ({ parseEpub: vi.fn() }));
vi.mock('../../../src/repositories/book.repository.js', () => ({
  bookRepository: { update: updateMock },
}));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({
  processingLogRepository: { getJob: getJobMock, append: appendMock, failJob: failJobMock },
}));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({
  chapterRepository: { softDeleteByBookId: chapterSoftDeleteMock },
}));
vi.mock('../../../src/repositories/section.repository.js', () => ({
  sectionRepository: { softDeleteByBookId: sectionSoftDeleteMock },
}));

import { markBookErrored, processingService } from '../../../src/services/processing.service.js';

describe('markBookErrored (KAN-243)', () => {
  beforeEach(() => {
    updateMock.mockReset();
    // Make backoff sleeps instant so the retry test doesn't wait ~600ms.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets the book to error on the first successful write', async () => {
    updateMock.mockResolvedValueOnce(undefined);
    await markBookErrored('book-1', 'job-1');
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith('book-1', { processingStatus: 'error' });
  });

  it('retries a transient failure and recovers — the book is not left in processing', async () => {
    updateMock
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockRejectedValueOnce(new Error('pool exhausted'))
      .mockResolvedValueOnce(undefined);
    await markBookErrored('book-2', 'job-2');
    expect(updateMock).toHaveBeenCalledTimes(3);
  });

  it('logs loudly (does not silently swallow) when every attempt fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateMock.mockRejectedValue(new Error('db down'));
    await markBookErrored('book-3', 'job-3');
    expect(updateMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0];
    expect(String(message)).toContain('book-3');
    expect(String(message)).toContain('job-3');
  });

  it('never rejects, so a failed status write cannot break the pipeline catch', async () => {
    updateMock.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(markBookErrored('book-4', 'job-4')).resolves.toBeUndefined();
  });
});

describe('processingService.cancelJob (KAN-270)', () => {
  beforeEach(() => {
    updateMock.mockReset().mockResolvedValue(undefined);
    dbDeleteMock.mockReset();
    getJobMock.mockReset();
    appendMock.mockReset().mockResolvedValue(undefined);
    failJobMock.mockReset().mockResolvedValue(undefined);
    sectionSoftDeleteMock.mockReset().mockResolvedValue(undefined);
    chapterSoftDeleteMock.mockReset().mockResolvedValue(undefined);
    // Run the transaction callback with a stand-in executor, mirroring db.transaction.
    transactionMock.mockReset().mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ tx: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('soft-deletes chapters/sections (never hard-deletes) so sync ships tombstones', async () => {
    getJobMock.mockResolvedValue({ bookId: 'book-9' });

    await processingService.cancelJob('job-9');

    // The regression this ticket guards against: raw db.delete must NOT be used.
    expect(dbDeleteMock).not.toHaveBeenCalled();
    expect(sectionSoftDeleteMock).toHaveBeenCalledWith('book-9', expect.anything());
    expect(chapterSoftDeleteMock).toHaveBeenCalledWith('book-9', expect.anything());
    // Soft-deletes run inside a transaction, matching the retry path.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // Book status is reset after cleanup.
    expect(updateMock).toHaveBeenCalledWith('book-9', { processingStatus: 'error' });
  });

  it('is a no-op on structure cleanup when the job has no associated book', async () => {
    getJobMock.mockResolvedValue({ bookId: null });

    await processingService.cancelJob('job-10');

    expect(transactionMock).not.toHaveBeenCalled();
    expect(sectionSoftDeleteMock).not.toHaveBeenCalled();
    expect(chapterSoftDeleteMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
