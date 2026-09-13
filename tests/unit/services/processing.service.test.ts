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
  dbSelectMock,
  updateJobProgressMock,
  completeJobMock,
  findCatalogByHashMock,
  downloadPdfMock,
  parseEpubMock,
  chapterCreateMock,
  sectionCreateMock,
  refundFailedJobMock,
} = vi.hoisted(() => ({
  updateMock: vi.fn(),
  dbDeleteMock: vi.fn(),
  transactionMock: vi.fn(),
  getJobMock: vi.fn(),
  appendMock: vi.fn(),
  failJobMock: vi.fn(),
  sectionSoftDeleteMock: vi.fn(),
  chapterSoftDeleteMock: vi.fn(),
  dbSelectMock: vi.fn(),
  updateJobProgressMock: vi.fn(),
  completeJobMock: vi.fn(),
  findCatalogByHashMock: vi.fn(),
  downloadPdfMock: vi.fn(),
  parseEpubMock: vi.fn(),
  chapterCreateMock: vi.fn(),
  sectionCreateMock: vi.fn(),
  refundFailedJobMock: vi.fn(),
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
  db: { delete: dbDeleteMock, transaction: transactionMock, select: dbSelectMock },
}));
vi.mock('../../../src/services/storage.service.js', () => ({
  storageService: { downloadPdf: downloadPdfMock },
}));
vi.mock('../../../src/services/pdf.service.js', () => ({ pdfService: {} }));
vi.mock('../../../src/services/epub.service.js', () => ({ parseEpub: parseEpubMock }));
vi.mock('../../../src/services/billing.service.js', () => ({
  billingService: { refundFailedJob: refundFailedJobMock },
}));
vi.mock('../../../src/repositories/book.repository.js', () => ({
  bookRepository: { update: updateMock, findCatalogByHash: findCatalogByHashMock },
}));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({
  processingLogRepository: {
    getJob: getJobMock,
    append: appendMock,
    failJob: failJobMock,
    updateJobProgress: updateJobProgressMock,
    completeJob: completeJobMock,
  },
}));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({
  chapterRepository: { softDeleteByBookId: chapterSoftDeleteMock, create: chapterCreateMock },
}));
vi.mock('../../../src/repositories/section.repository.js', () => ({
  sectionRepository: { softDeleteByBookId: sectionSoftDeleteMock, create: sectionCreateMock },
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

// --- Pipeline failure refunds (KAN-303) -------------------------------------
// Drives the real orchestratePipeline through the EPUB branch (the PDF branch
// needs pdfjs/Mathpix to get off the ground; both branches share the identical
// failJob -> markBookErrored -> refundFailedJob catch tail).
describe('orchestratePipeline - refund on pipeline failure (KAN-303)', () => {
  // db.select().from().where().limit() -> the pdf_files row.
  const selectReturning = (rows: any[]) => () => ({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  });

  beforeEach(() => {
    for (const m of [
      updateMock, dbSelectMock, appendMock, failJobMock, updateJobProgressMock,
      completeJobMock, findCatalogByHashMock, downloadPdfMock, parseEpubMock,
      chapterCreateMock, sectionCreateMock, refundFailedJobMock, getJobMock,
      transactionMock,
    ]) m.mockReset();

    findCatalogByHashMock.mockResolvedValue({ format: 'epub' });
    dbSelectMock.mockImplementation(selectReturning([{ r2Key: 'r2/key', fileHash: 'hash-1' }]));
    downloadPdfMock.mockResolvedValue(Buffer.from('epub-bytes'));
    parseEpubMock.mockReturnValue({
      title: 'Test Book',
      author: 'Test Author',
      chapters: [{ title: 'Ch 1', chapterIndex: 1, plainText: 'hello' }],
    });
    chapterCreateMock.mockResolvedValue({ id: 'chapter-1' });
    sectionCreateMock.mockResolvedValue({ id: 'section-1' });
    updateMock.mockResolvedValue(undefined);
    appendMock.mockResolvedValue(undefined);
    refundFailedJobMock.mockResolvedValue('no-charge');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refunds exactly once when a stage throws, and still fails the job + errors the book', async () => {
    downloadPdfMock.mockRejectedValue(new Error('R2 download failed'));

    await processingService.orchestratePipeline('job-1', 'hash-1', 'book-1');

    // KAN-243 contract must not regress.
    expect(failJobMock).toHaveBeenCalledWith('job-1', 'R2 download failed');
    expect(updateMock).toHaveBeenCalledWith('book-1', { processingStatus: 'error' });
    // KAN-303: the money goes back.
    expect(refundFailedJobMock).toHaveBeenCalledTimes(1);
    expect(refundFailedJobMock).toHaveBeenCalledWith('job-1');
  });

  it('refunds after the book has been errored, so a refund problem cannot strand the book', async () => {
    downloadPdfMock.mockRejectedValue(new Error('R2 download failed'));

    await processingService.orchestratePipeline('job-1', 'hash-1', 'book-1');

    expect(updateMock.mock.invocationCallOrder[0])
      .toBeLessThan(refundFailedJobMock.mock.invocationCallOrder[0]);
  });

  it('still resolves (never rethrows) after a stage failure', async () => {
    downloadPdfMock.mockRejectedValue(new Error('Mathpix timeout'));

    await expect(
      processingService.orchestratePipeline('job-1', 'hash-1', 'book-1'),
    ).resolves.toBeUndefined();
    expect(failJobMock).toHaveBeenCalledWith('job-1', 'Mathpix timeout');
  });

  it('issues no refund when the pipeline completes successfully', async () => {
    findCatalogByHashMock
      .mockResolvedValueOnce({ format: 'epub' }) // dispatcher
      .mockResolvedValueOnce(null);              // cover stage - skip

    await processingService.orchestratePipeline('job-1', 'hash-1', 'book-1');

    expect(completeJobMock).toHaveBeenCalledWith('job-1');
    expect(failJobMock).not.toHaveBeenCalled();
    expect(refundFailedJobMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith('book-1', {
      processingStatus: 'complete',
      structureSource: 'epub',
    });
  });

  it('records the refund outcome on the job log so an owed refund is auditable', async () => {
    downloadPdfMock.mockRejectedValue(new Error('R2 download failed'));
    refundFailedJobMock.mockResolvedValue('refunded');

    await processingService.orchestratePipeline('job-1', 'hash-1', 'book-1');

    expect(appendMock).toHaveBeenCalledWith(
      'job-1', 'refund', 'Processing failed — payment refunded', 'info',
    );
  });

  it('logs an un-issued refund at error level so it can be reconciled by hand', async () => {
    downloadPdfMock.mockRejectedValue(new Error('R2 download failed'));
    refundFailedJobMock.mockResolvedValue('refund-failed');

    await processingService.orchestratePipeline('job-1', 'hash-1', 'book-1');

    expect(appendMock).toHaveBeenCalledWith(
      'job-1', 'refund', 'Processing failed — REFUND FAILED, manual refund required', 'error',
    );
  });

  it('does not rethrow when the refund audit-log write itself fails', async () => {
    downloadPdfMock.mockRejectedValue(new Error('R2 download failed'));
    refundFailedJobMock.mockResolvedValue('refunded');
    // The final append (the refund line) rejects; earlier appends succeed.
    appendMock.mockResolvedValue(undefined);
    appendMock.mockImplementation(async (_id: string, stage: string) => {
      if (stage === 'refund') throw new Error('logs table unavailable');
    });

    await expect(
      processingService.orchestratePipeline('job-1', 'hash-1', 'book-1'),
    ).resolves.toBeUndefined();
    expect(refundFailedJobMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the cancel path free of refunds', async () => {
    getJobMock.mockResolvedValue({ id: 'job-1', bookId: 'book-1' });
    transactionMock.mockImplementation(async (fn: any) => fn({}));

    await processingService.cancelJob('job-1');

    expect(failJobMock).toHaveBeenCalledWith('job-1', 'Cancelled by user');
    expect(refundFailedJobMock).not.toHaveBeenCalled();
  });
});
