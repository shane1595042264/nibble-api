import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// processing.service.ts pulls in a large graph (storage/pdf/epub services, db,
// repositories). We only exercise markBookErrored here, so stub out everything
// that has import-time side effects or needs real config/network.

const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock('../../../src/lib/config.js', () => ({
  config: {
    DATABASE_URL: 'postgres://test',
    R2_BUCKET_NAME: 'test-bucket',
    R2_ENDPOINT: 'https://test.r2',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
  },
}));
vi.mock('../../../src/db/index.js', () => ({ db: {} }));
vi.mock('../../../src/services/storage.service.js', () => ({ storageService: {} }));
vi.mock('../../../src/services/pdf.service.js', () => ({ pdfService: {} }));
vi.mock('../../../src/services/epub.service.js', () => ({ parseEpub: vi.fn() }));
vi.mock('../../../src/repositories/book.repository.js', () => ({
  bookRepository: { update: updateMock },
}));
vi.mock('../../../src/repositories/processing-log.repository.js', () => ({
  processingLogRepository: {},
}));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: {} }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: {} }));

import { markBookErrored } from '../../../src/services/processing.service.js';

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
